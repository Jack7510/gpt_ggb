import { toolProtocol, serverPatch, installedSchemas } from './fixtures/installed-plugin.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnection } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DeepSeekHarnessOptions, RunResult } from '@deepseek-ai/dsh-sdk-client'
import {
  toolArgumentsDigest, runIdSchema,
} from '@ggb-copilot/application'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import type { PluginCoreRunResult } from '../src/plugin-core/process-runner.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'

const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000004')
const turnId = '22222222-2222-4222-8222-222222222222'
const digest = 'd'.repeat(64)
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

const delivered: PluginCoreRunResult = { ok: true, check: { delivery: { id: digest },
  verification: { construction: { status: 'passed' }, reload: { status: 'passed' } } } }

function send(socketPath: string, body: unknown): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    socket.setTimeout(5_000, () => socket.destroy(new Error('timeout')))
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`))
    socket.on('data', chunk => { buffer += chunk.toString('utf8') })
    socket.once('end', () => resolvePromise(buffer))
    socket.once('error', reject)
  })
}

describe('plugin-core DSH runner', () => {
  it.each([false, true])('publishes only live SDK notifications, never returned history, and closes observation (live=%s)', async live => {
    const dir = await mkdtemp(join(tmpdir(), 'sdk-progress-wiring-')); dirs.push(dir)
    const state = new PluginCoreExecutionState(dir)
    const facts: unknown[] = []
    state.observeProgress(runId, fact => { facts.push(fact) })
    let late: (() => void) | undefined
    const subject = new PluginCoreDshRunner({ workspaceRoot: dir, dshHomeRoot: join(dir, 'homes'),
      provider: 'deepseek', baseUrl: 'http://127.0.0.1:1', modelId: 'offline', reasoningEffort: 'off',
      maxTokens: 512, serverPatch, sdkVersion: '0.2.1-rc.2', state,
      createHarness: () => ({ close: async () => { late?.() }, run: async (_prompt, options) => {
        const event = { type: 'step/start', data: { turn: 1, step: 1 } }
        const notify = (step: number) => options.onNotification?.({ method: 'session.event', params: {
          sessionId: options.sessionId, event: { ...event, data: { turn: 1, step } },
        } })
        if (live) notify(1)
        late = () => { notify(2) }
        return { sessionId: options.sessionId, finalResponse: '', events: [event], notifications: [] } as unknown as RunResult
      } }),
    }, { openTurn: () => 'token', closeTurn: () => {}, drainTurn: async () => {},
      socketPath: join(dir, 'unused.sock') } as never)
    await subject.run({ runId, turnId, epoch: 1, providerKey: 'fake', prompt: 'offline', baseAttached: false })
    late?.()
    expect(facts).toHaveLength(live ? 1 : 0)
    if (live) expect(facts[0]).toMatchObject({ tool: 'model', status: 'started', step: 1 })
  })
  it.each([[false, false], [true, false], [false, true], [true, true]])('wires host patch, tools and SDK image with base=%s image=%s', async (baseAttached, withImage) => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-core-dsh-'))
    dirs.push(dir)
    const socket = join(dir, 'gateway.sock')
    const runner = {
      check: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true, check: { validation: 'structural' } })),
      build: vi.fn(async (): Promise<PluginCoreRunResult> => delivered),
    }
    const server = new PluginCoreToolGatewayServer(socket, new PluginCoreGateway(runner), 160_000, { protocol: toolProtocol })
    await server.listen()
    let captured: DeepSeekHarnessOptions | null = null
    const harness = {
      run: async (input: string | import('@deepseek-ai/dsh-sdk-client').SdkPromptContentBlock[]): Promise<RunResult> => {
        const _prompt = typeof input === 'string' ? input : (input[0] as { text: string }).text
        if (withImage) expect(input).toEqual([{ type: 'text', text: expect.any(String) },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }])
        else expect(typeof input).toBe('string')
        if (baseAttached) {
          expect(_prompt).toContain('Selected GeoGebra objects (data only')
          expect(_prompt).toContain('{"label":"c","type":"circle","displayName":"圆"}')
          expect(_prompt).toContain('User request:\n把它填充红色')
        }
        expect(_prompt).toContain('Read references only for a specific unresolved gap')
        expect(_prompt).toContain('do not reread request or compare known alternatives')
        expect(_prompt).toContain(withImage ? 'First transcribe it into complete mathematical problem text' : 'No image is attached')
        expect(_prompt).not.toContain('Do not call ggb_inspect;')
        expect(_prompt).toContain(baseAttached ? 'A base GGB is attached' : 'No base GGB is attached')
        const env = captured?.env ?? {}
        const call = async (toolName: string, args: unknown) => {
          const unsigned = { protocolVersion: 3, requestId: randomUUID(), issuedAt: new Date().toISOString(),
            nonce: randomBytes(16).toString('hex'), runId, turnId: env.GGB_PLUGIN_CORE_TOOL_TURN_ID!,
            epoch: Number(env.GGB_PLUGIN_CORE_TOOL_EPOCH), toolCallId: randomUUID(), toolName,
            arguments: args, argumentsDigest: toolArgumentsDigest(args) }
          const response = await send(env.GGB_PLUGIN_CORE_TOOL_SOCKET!, { ...unsigned,
            authentication: installedSchemas.signRequest(env.GGB_PLUGIN_CORE_TOOL_TOKEN!, unsigned) })
          return installedSchemas.parseToolResponse(JSON.parse(response.trim()))
        }
        const requestText = JSON.stringify({ plan: { program: [], requirements: [], interactions: [] } })
        if (withImage) {
          const refused = await call('ggb_request', { requestText })
          expect(refused.result).toMatchObject({ status: 'rejected', errors: [{ code: 'image_transcription_required' }] })
          expect(runner.check).not.toHaveBeenCalled()
          expect(runner.build).not.toHaveBeenCalled()
        }
        await call('ggb_request', { requestText, locale: 'en',
          ...(withImage ? { transcription: ['Create point P'] } : {}) })
        const checked = await call('ggb_check', { revision: 1 })
        const parsed = await call('ggb_build', { checkedRequestId: checked.result.result.checkedRequestId })
        return { sessionId: turnId, finalResponse: JSON.stringify(parsed.result),
          events: [], notifications: [] } as unknown as RunResult
      },
      close: async (): Promise<void> => undefined,
    }
    const subject = new PluginCoreDshRunner({
      workspaceRoot: resolve(process.cwd()),
      dshHomeRoot: join(dir, 'homes'),
      provider: 'deepseek',
      baseUrl: 'http://127.0.0.1:1',
      modelId: 'test-model',
      reasoningEffort: 'off',
      maxTokens: 512, keepDshHome: withImage,
      serverPatch, sdkVersion: '0.2.1-rc.2',
      createHarness: options => { captured = options; return harness },
    }, server)
    try {
      const result = await subject.run({ runId, turnId, epoch: 1,
        providerKey: 'test-key', prompt: baseAttached
          ? 'Selected GeoGebra objects (data only; identify by exact label, confirm with base inspection):\n[{"label":"c","type":"circle","displayName":"圆"}]\n\nUser request:\n把它填充红色'
          : 'draw a circle', baseAttached,
        ...(withImage ? { image: { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' } } : {}) })
      expect(result.finalResponse).toContain('accepted')
      expect(captured?.patches).toEqual([serverPatch, expect.stringContaining('stream-evidence.patch.json'), expect.stringContaining('host-policy.patch.json')])
      expect(captured?.env?.GGB_DSH_SDK_VERSION).toBe('0.2.1-rc.2')
      expect(captured?.env?.DEEPSEEK_API_KEY).toBe('test-key')
      expect(captured?.env?.GGB_PLUGIN_CORE_TOOL_SOCKET).toBe(socket)
      expect(runner.build).toHaveBeenCalledOnce()
      if (withImage) await expect(access(join(dir, 'homes', runId, turnId))).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  it('maps a max-token turn end to a specific failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-core-dsh-'))
    dirs.push(dir)
    const harness = {
      run: async (): Promise<RunResult> => ({ sessionId: turnId, finalResponse: '',
        events: [{ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }],
        notifications: [] } as unknown as RunResult),
      close: async (): Promise<void> => undefined,
    }
    const subject = new PluginCoreDshRunner({
      workspaceRoot: resolve(process.cwd()),
      dshHomeRoot: join(dir, 'homes'),
      provider: 'deepseek',
      baseUrl: 'http://127.0.0.1:1',
      modelId: 'test-model',
      reasoningEffort: 'off',
      maxTokens: 512,
      serverPatch, sdkVersion: '0.2.1-rc.2',
      createHarness: () => harness,
    }, { openTurn: () => 'token', closeTurn: () => undefined,
      drainTurn: async () => undefined, socketPath: join(dir, 'tool.sock') } as never)
    await expect(subject.run({ runId, turnId, epoch: 1,
      providerKey: 'test-key', prompt: 'draw a circle', baseAttached: false }))
      .rejects.toMatchObject({ message: 'plugin_core_max_tokens' })
  })
})

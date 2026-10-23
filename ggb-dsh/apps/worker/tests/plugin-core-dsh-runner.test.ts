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
        expect(_prompt).toContain('ggb_inspect({reference: topic})')
        expect(_prompt).not.toContain('Do not call ggb_inspect;')
        expect(_prompt).toContain(baseAttached ? 'A base GGB is attached' : 'No base GGB is attached')
        const env = captured?.env ?? {}
        const args = { request: { protocolVersion: 2, prompt: 'draw a circle' } }
        const unsigned = {
          protocolVersion: 2, requestId: randomUUID(), issuedAt: new Date().toISOString(),
          nonce: randomBytes(16).toString('hex'), runId,
          turnId: env.GGB_PLUGIN_CORE_TOOL_TURN_ID!,
          epoch: Number(env.GGB_PLUGIN_CORE_TOOL_EPOCH), toolCallId: randomUUID(),
          toolName: 'ggb_build', arguments: args, argumentsDigest: toolArgumentsDigest(args),
        }
        const response = await send(env.GGB_PLUGIN_CORE_TOOL_SOCKET!,
          { ...unsigned, authentication: installedSchemas.signRequest(
            env.GGB_PLUGIN_CORE_TOOL_TOKEN!, unsigned) })
        const parsed = installedSchemas.parseToolResponse(JSON.parse(response.trim()))
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
        providerKey: 'test-key', prompt: 'draw a circle', baseAttached,
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

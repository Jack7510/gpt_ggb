import { redactEvidence } from '../src/plugin-core/evidence.js'
import { toolProtocol, serverPatch } from './fixtures/installed-plugin.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type DeepSeekHarnessOptions, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { runIdSchema } from '@ggb-copilot/application'
import { EVIDENCE_LIMITS, PluginCoreEvidenceStore } from '../src/plugin-core/evidence.js'
import { PluginCoreDshRunner, PluginCoreTurnError } from '../src/plugin-core/dsh-runner.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreService } from '../src/plugin-core/service.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'

const runId = runIdSchema.parse(`run_${randomUUID()}`)
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ggb-evidence-')); dirs.push(dir); return dir
}
function notification(id: string, type: string, data: unknown): HarnessNotification {
  return { method: 'session.event', params: { sessionId: id, event: { type, data } } }
}

describe('bounded SDK evidence', () => {
  it('keeps partial accounting and the specific redacted failure before close and home deletion', async () => {
    const root = await scratch()
    const evidence = new PluginCoreEvidenceStore(root)
    const gateway = new PluginCoreToolGatewayServer(join(root, 'unused.sock'), new PluginCoreGateway({
      check: vi.fn(), build: vi.fn(),
    }), 1000, { evidence, protocol: toolProtocol })
    let options: DeepSeekHarnessOptions
    let session = ''
    const close = vi.fn(async () => {
      const path = join(root, runId, 'diagnostics', `${session}.json`)
      expect(JSON.parse(await readFile(path, 'utf8')).phase).toBe('sdk_failed')
      expect(existsSync(options.dshHome!)).toBe(true)
    })
    const runner = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: join(root, 'homes'),
      provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:1', modelId: 'fake',
      reasoningEffort: 'off', maxTokens: 1, serverPatch, sdkVersion: '0.2.1-rc.2', evidence,
      createHarness: value => { options = value; return { close, run: async (_prompt, call) => {
        session = call.sessionId
        call.onNotification?.(notification(session, 'step/start', { turn: 1, step: 1 }))
        call.onNotification?.(notification(session, 'assistant/attempt', { turn: 1, step: 1,
          content: 'RAW_MODEL_TRANSCRIPT', apiKey: 'provider-secret' }))
        throw Object.assign(new Error('stream failed provider-secret', { cause: new Error('root cause') }),
          { code: 'STREAM_CLOSED', stderrTail: 'provider-secret transport-tail' })
      } } },
    }, gateway)
    const service = new PluginCoreService(runner, { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'provider-secret', prompt: 'draw' })
    expect(result).toMatchObject({ error: { code: 'plugin_core_failed' },
      usage: { calls: 1, inputTokens: null, outputTokens: null, complete: false },
      diagnostics: { eventTypes: { 'step/start': 1 } },
      modelCalls: [{ outcome: 'attempt_without_message', usageComplete: false }] })
    const path = join(root, runId, 'diagnostics', `${session}.json`)
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('provider-secret')
    expect(text).not.toContain('RAW_MODEL_TRANSCRIPT')
    expect(JSON.parse(text)).toMatchObject({ failure: { code: 'STREAM_CLOSED', cause: { message: 'root cause' } },
      harnessClose: { status: 'closed' } })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(close).toHaveBeenCalledOnce()
    expect(existsSync(options!.dshHome!)).toBe(false)
    expect(evidence.get(session)).toBeUndefined()
  })

  it('limits events and call payloads, retains truncation facts and preserves token counters', async () => {
    const root = await scratch()
    const id = randomUUID()
    const turn = new PluginCoreEvidenceStore(root).begin(runId, id, 1, ['secret-value'])
    turn.notification(notification(id, 'assistant/message', { turn: 1, step: 1,
      usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3 } }))
    for (let i = 0; i < EVIDENCE_LIMITS.events + 50; i += 1) {
      turn.notification(notification(id, 'step/start', { turn: 1, step: i + 2 }))
    }
    const call = await turn.beginCall({ requestId: randomUUID(), toolCallId: randomUUID(),
      arguments: { prompt: 'secret-value'.repeat(20000), apiKey: 'secret-value' } })
    await call.result({ issues: [{ path: 'plan', message: 'exact issue' }], stderrTail: 'secret-value' })
    await turn.checkpoint('sdk_failed', new Error('last root cause'))
    const text = await readFile(join(root, runId, 'diagnostics', `${id}.json`), 'utf8')
    const value = JSON.parse(text)
    expect(value.sdkEvents.length).toBeLessThanOrEqual(EVIDENCE_LIMITS.events)
    expect(value.sdkEventsDropped).toBeGreaterThan(0)
    expect(value.calls[0].arguments.truncated).toBe(true)
    expect(value.calls[0].argumentsBytes).toBeGreaterThan(EVIDENCE_LIMITS.payloadBytes)
    expect(value.sdkEvents[0].data.usage.inputTokens).toBe(12)
    expect(value.sdkEvents[0].observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(value.failure.message).toBe('last root cause')
    expect(text).not.toContain('secret-value')
    expect(Buffer.byteLength(text)).toBeLessThan(400 * 1024)
  })

  it('keeps SDK envelope identity when a payload is truncated and marks array truncation explicitly', async () => {
    const root = await scratch()
    const id = randomUUID()
    const turn = new PluginCoreEvidenceStore(root).begin(runId, id, 1)
    turn.notification(notification(id, 'tool/call', { turn: 1, step: 1,
      callId: 'actual-call', name: 'x'.repeat(100000) }))
    await turn.checkpoint('sdk_failed', new Error('root cause'))
    const value = JSON.parse(await readFile(join(root, runId, 'diagnostics', `${id}.json`), 'utf8'))
    expect(value.sdkEvents[0]).toMatchObject({ method: 'session.event', sessionId: id,
      type: 'tool/call', data: { truncated: true } })
    expect(value.sdkPayloadsTruncated).toBe(1)
    expect(turn.truncated).toBe(true)
    expect(turn.payload({ many: Array.from({ length: 300 }, (_, i) => i) })).toMatchObject({
      many: { truncated: true, originalItems: 300 },
    })
  })

  it('omits malformed SDK message bodies from errors and keeps only numeric usage fields', async () => {
    const root = await scratch()
    const id = randomUUID()
    const turn = new PluginCoreEvidenceStore(root).begin(runId, id, 1)
    turn.notification(notification(id, 'assistant/message', { turn: 1, step: 1,
      usage: { inputTokens: 10, outputTokens: 'RAW_MODEL_BODY', raw: 'RAW_MODEL_BODY' } }))
    const error = Object.assign(new Error('assistant/message malformed content: {"text":"RAW_MODEL_BODY"}'),
      { name: 'SdkProtocolError' })
    await turn.checkpoint('sdk_failed', error)
    const text = await readFile(join(root, runId, 'diagnostics', `${id}.json`), 'utf8')
    expect(text).not.toContain('RAW_MODEL_BODY')
    expect(text).toContain('[payload omitted]')
    expect(JSON.parse(text).sdkEvents[0].data.usage).toEqual({ inputTokens: 10 })
  })

  it('surfaces persistence failure and still closes the Harness without retrying', async () => {
    const root = await scratch()
    const evidence = new PluginCoreEvidenceStore(root)
    const tools = new PluginCoreToolGatewayServer(join(root, 'unused.sock'), new PluginCoreGateway({ check: vi.fn(), build: vi.fn() }), 160_000, { protocol: toolProtocol })
    const close = vi.fn(async () => undefined)
    const run = vi.fn(async () => {
      const path = join(root, runId, 'diagnostics')
      await rm(path, { recursive: true })
      await writeFile(path, 'force mkdir failure')
      throw new Error('original SDK failure')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runner = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: join(root, 'homes'),
      provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:1', modelId: 'fake',
      reasoningEffort: 'off', maxTokens: 1, serverPatch, sdkVersion: '0.2.1-rc.2', evidence,
      createHarness: () => ({ close, run }) }, tools)
    await expect(runner.run({ runId, epoch: 1, providerKey: 'fake-secret', prompt: 'draw', baseAttached: false }))
      .rejects.toMatchObject({ message: 'plugin_core_evidence_write_failed' })
    expect(close).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('[worker] evidence persistence failed', runId, expect.any(String))
  })

  it('records failed close and retains the unconfirmed SDK home', async () => {
    const root = await scratch()
    const id = randomUUID()
    const tools = new PluginCoreToolGatewayServer(join(root, 'unused.sock'), new PluginCoreGateway({ check: vi.fn(), build: vi.fn() }), 160_000, { protocol: toolProtocol })
    const runner = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: join(root, 'homes'),
      provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:1', modelId: 'fake',
      reasoningEffort: 'off', maxTokens: 1, serverPatch, sdkVersion: '0.2.1-rc.2',
      createHarness: () => ({ run: async () => ({ finalResponse: '', events: [] }) as unknown as RunResult,
        close: async () => { throw new Error('close failed') } }) }, tools)
    await expect(runner.run({ runId, turnId: id, epoch: 1, providerKey: 'fake', prompt: 'draw', baseAttached: false }))
      .rejects.toBeInstanceOf(PluginCoreTurnError)
    expect(existsSync(join(root, 'homes', runId, id))).toBe(true)
    const value = JSON.parse(await readFile(join(root, 'homes', runId, 'diagnostics', `${id}.json`), 'utf8'))
    expect(value.harnessClose).toMatchObject({ status: 'failed', error: { message: 'close failed' } })
  })

  it('records timeout and cancellation once, keeping unknown usage unknown', async () => {
    const root = await scratch()
    for (const cancelled of [false, true]) {
      const id = randomUUID()
      const abort = new AbortController()
      const tools = new PluginCoreToolGatewayServer(join(root, 'unused.sock'), new PluginCoreGateway({ check: vi.fn(), build: vi.fn() }), 160_000, { protocol: toolProtocol })
      const close = vi.fn(async () => undefined)
      const runner = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: root,
        provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:1', modelId: 'fake',
        reasoningEffort: 'off', maxTokens: 1, serverPatch, sdkVersion: '0.2.1-rc.2',
        createHarness: () => ({ close, run: async () => {
          if (cancelled) abort.abort()
          return await new Promise<RunResult>(() => undefined)
        } }) }, tools)
      await expect(runner.run({ runId, turnId: id, epoch: 1, providerKey: 'fake', prompt: 'draw',
        baseAttached: false, signal: abort.signal, timeoutMs: 20 }))
        .rejects.toMatchObject({ message: cancelled ? 'plugin_core_cancelled' : 'plugin_core_timeout' })
      expect(close).toHaveBeenCalledOnce()
      expect((await readdir(join(root, runId, 'diagnostics'))).length).toBeGreaterThan(0)
    }
  })

  it('does not treat an SDK error outcome as an empty turn or retry it', async () => {
    const root = await scratch()
    const tools = new PluginCoreToolGatewayServer(join(root, 'unused.sock'), new PluginCoreGateway({ check: vi.fn(), build: vi.fn() }), 160_000, { protocol: toolProtocol })
    const run = vi.fn(async () => ({ finalResponse: '', events: [{ type: 'turn/end', data: {
      reason: { kind: 'error', error: { code: 'STREAM_CLOSED', message: 'specific returned error' } },
    } }] }) as unknown as RunResult)
    const runner = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: root,
      provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:1', modelId: 'fake',
      reasoningEffort: 'off', maxTokens: 1, serverPatch, sdkVersion: '0.2.1-rc.2',
      createHarness: () => ({ run, close: async () => undefined }) }, tools)
    const service = new PluginCoreService(runner, { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'draw' })
    expect(result.error?.code).toBe('plugin_core_failed')
    expect(run).toHaveBeenCalledOnce()
    const [file] = await readdir(join(root, runId, 'diagnostics'))
    const value = JSON.parse(await readFile(join(root, runId, 'diagnostics', file!), 'utf8'))
    expect(value.sdkEvents[0].data.reason.error).toMatchObject({
      code: 'STREAM_CLOSED', message: 'specific returned error',
    })
  })

  it('keeps notifications and stderr from the actual SDK client when its stdio subprocess exits', async () => {
    const root = await scratch()
    const tools = new PluginCoreToolGatewayServer(join(root, 'unused.sock'), new PluginCoreGateway({ check: vi.fn(), build: vi.fn() }), 160_000, { protocol: toolProtocol })
    const runner = new PluginCoreDshRunner({ workspaceRoot: root, dshHomeRoot: root,
      provider: 'deepseek-official', baseUrl: 'http://127.0.0.1:1', modelId: 'fake',
      reasoningEffort: 'off', maxTokens: 1, serverPatch, sdkVersion: '0.2.1-rc.2',
      createHarness: options => new DeepSeekHarness({ ...options,
        env: { ...options.env, NODE_OPTIONS: '' }, // fixture has no provider adapter
        dshBin: fileURLToPath(new URL('./fixtures/sdk-failure-runtime.mjs', import.meta.url)),
        initializeTimeoutMs: 2000, requestTimeoutMs: 2000 }) }, tools)
    const result = await new PluginCoreService(runner, { outputRoot: root })
      .run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake-provider-secret', prompt: 'test fixture only' })
    expect(result).toMatchObject({ error: { code: 'plugin_core_failed' },
      usage: { calls: 1, inputTokens: null, outputTokens: null, complete: false } })
    const [file] = await readdir(join(root, runId, 'diagnostics'))
    const text = await readFile(join(root, runId, 'diagnostics', file!), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ failure: { name: 'TransportClosedError',
      exitCode: 23, stderrTail: 'fixture transport tail [redacted]' },
      harnessClose: { status: 'closed' } })
    expect(text).not.toContain('fake-provider-secret')
  })
  it('preserves an explicit negative process cleanup conclusion', async () => {
    const root = await scratch()
    const turn = new PluginCoreEvidenceStore(root).begin(runId, randomUUID(), 1)
    expect(turn.process({ kind: 'completed', cleanupConfirmed: false, exitCode: 0,
      signal: null, stdoutBytes: 0, stderrBytes: 0 })).toMatchObject({ cleanupConfirmed: false })
  })

})

it('omits SDK, wire and public image bytes from diagnostics, including data URLs', () => {
  const input = { image: { mediaType: 'image/png', dataBase64: 'private-image' },
    sdk: { type: 'image', data: 'private-image', mimeType: 'image/png' },
    wire: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'private-image' } },
    error: 'bad data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==' }
  const text = JSON.stringify(redactEvidence(input))
  expect(text).not.toContain('private-image')
  expect(text).not.toContain('cHJpdmF0ZS1pbWFnZQ==')
  expect(text).toContain('image/png')
})

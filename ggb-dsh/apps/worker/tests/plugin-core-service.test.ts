import { randomUUID } from 'node:crypto'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIdSchema } from '@ggb-copilot/application'
import { PluginCoreBaseRegistry } from '../src/plugin-core/base-registry.js'
import { PluginCoreTurnError, type PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { PluginCoreService } from '../src/plugin-core/service.js'

const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000006')
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.length = 0
})

function fakeDsh(finalResponse = 'done'): PluginCoreDshRunner {
  return { run: async () => ({ finalResponse, events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }) } as unknown as PluginCoreDshRunner
}

function malformedResponse(events: unknown[] = [], eventsTruncated = false) {
  return new PluginCoreTurnError('plugin_core_malformed_response',
    { finalResponse: '', events } as never, eventsTruncated,
    Object.assign(new Error('plugin_core_malformed_response'), { code: 'MALFORMED_RESPONSE' }))
}

function maxTokensFailure() {
  return new PluginCoreTurnError('plugin_core_max_tokens',
    { finalResponse: '', events: [] } as never, false,
    Object.assign(new Error('plugin_core_max_tokens'), { code: 'max-tokens' }))
}

describe('plugin-core service', () => {
  it.each([
    { image: true, suffix: '\n抛物线 y²=4x，作焦点与准线。', accepted: true },
    { image: false, suffix: '\nordinary multiline text', accepted: true },
    { image: true, suffix: '', accepted: true },
    { image: true, suffix: '\nrejected transcription', accepted: false },
  ])('prepends only the accepted image problem: %j', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-image-report-'))
    dirs.push(root)
    const state = new PluginCoreExecutionState(root)
    const prompt = '请根据图片完成构图。'
    const run = vi.fn(async () => {
      state.accept(runId, { id: 'a'.repeat(64), ggbBase64: 'UEtmYWtl', ggbBytes: 6,
        screenshotBase64: null, verification: {} }, { prompt: prompt + scenario.suffix, locale: 'zh-CN' })
      if (!scenario.accepted) state.invalidate(runId)
      return { finalResponse: '构图完成。', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }
    })
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner, { outputRoot: root, state })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt,
      ...(scenario.image ? { image: { mediaType: 'image/png' as const,
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' } } : {}) })
    expect(result.finalResponse).toBe(scenario.image && scenario.accepted && scenario.suffix
      ? `### 原题（图片识别）\n\n> ${scenario.suffix.trim()}\n\n构图完成。` : '构图完成。')
    expect(state.imageProblem(runId)).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('forwards ephemeral image input to the isolated SDK turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-image-'))
    dirs.push(root)
    const run = vi.fn(async () => ({ finalResponse: 'done', events: [] }))
    const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner, { outputRoot: root })
    await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'from image', image })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ image, baseAttached: false }))
  })

  it('reports a turn with no delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const service = new PluginCoreService(fakeDsh('nothing built'), { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    expect(result).toMatchObject({ finalResponse: 'nothing built', delivery: null,
      error: { code: 'plugin_core_no_delivery',
        message: expect.stringMatching(/No build was attempted/u),
        details: { kind: 'not_built', failedChecks: [], reasons: [] } } })
  })

  it('distinguishes and retries an empty model turn once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const run = vi.fn(async () => ({ finalResponse: '', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }))
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    expect(result).toMatchObject({ delivery: null,
      error: { code: 'plugin_core_empty_turn',
        message: expect.stringMatching(/no build was attempted/u) } })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries one malformed response only before any tool call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const run = vi.fn()
      .mockRejectedValueOnce(malformedResponse())
      .mockResolvedValueOnce({ finalResponse: 'done', events: [
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }] })
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root, retryMalformedResponse: true })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1',
      providerKey: 'key', prompt: 'draw' })
    expect(result).toMatchObject({ delivery: null,
      error: { code: 'plugin_core_no_delivery' } })
    expect(run).toHaveBeenCalledTimes(2)

    const executed = vi.fn().mockRejectedValueOnce(malformedResponse([
      { type: 'tool/call', data: { name: 'ggb_build' } }]))
    const blocked = new PluginCoreService({ run: executed } as unknown as PluginCoreDshRunner,
      { outputRoot: root, retryMalformedResponse: true })
    await expect(blocked.run({ runId, deliveryContract: 'receipt-v1',
      providerKey: 'key', prompt: 'draw' })).resolves.toMatchObject({
      error: { code: 'plugin_core_malformed_response' } })
    expect(executed).toHaveBeenCalledTimes(1)

    const inspected = vi.fn()
      .mockRejectedValueOnce(malformedResponse([
        { type: 'tool/call', data: { name: 'ggb_inspect' } }]))
      .mockResolvedValueOnce({ finalResponse: 'done', events: [
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }] })
    const retried = new PluginCoreService({ run: inspected } as unknown as PluginCoreDshRunner,
      { outputRoot: root, retryMalformedResponse: true })
    await expect(retried.run({ runId, deliveryContract: 'receipt-v1',
      providerKey: 'key', prompt: 'draw' })).resolves.toMatchObject({
      error: { code: 'plugin_core_no_delivery' } })
    expect(inspected).toHaveBeenCalledTimes(2)
  })

  it('keeps malformed retry opt-in and refuses truncated evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const defaultRun = vi.fn().mockRejectedValueOnce(malformedResponse())
    const defaultService = new PluginCoreService(
      { run: defaultRun } as unknown as PluginCoreDshRunner, { outputRoot: root })
    await expect(defaultService.run({ runId, deliveryContract: 'receipt-v1',
      providerKey: 'key', prompt: 'draw' })).resolves.toMatchObject({
      error: { code: 'plugin_core_malformed_response' } })
    expect(defaultRun).toHaveBeenCalledTimes(1)

    const truncatedRun = vi.fn().mockRejectedValueOnce(malformedResponse([
      { type: 'assistant/message', data: { turn: 1, step: 1, usage: {
        inputTokens: 10, outputTokens: 5 } } },
    ], true))
    const truncated = new PluginCoreService(
      { run: truncatedRun } as unknown as PluginCoreDshRunner,
      { outputRoot: root, retryMalformedResponse: true })
    const result = await truncated.run({ runId, deliveryContract: 'receipt-v1',
      providerKey: 'key', prompt: 'draw' })
    expect(truncatedRun).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ error: { code: 'plugin_core_malformed_response' },
      usage: { calls: 1, inputTokens: null, outputTokens: null,
        reasoningTokens: null, cacheReadTokens: null, complete: false },
      modelCallsTruncated: true })
  })

  it.each(['empty', 'malformed'] as const)('does not replay a recorded build when SDK %s evidence omits tool calls', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const state = new PluginCoreExecutionState(root)
    const run = vi.fn(async () => {
      state.startBuild(runId, randomUUID())
      if (mode === 'malformed') throw malformedResponse()
      return { finalResponse: '', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }
    })
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root, state, retryMalformedResponse: true })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'draw' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.error?.details).toMatchObject({ kind: 'execution_failed', lastBuildId: expect.any(String) })
    if (mode === 'empty') expect(result.error?.code).toBe('plugin_core_no_delivery')
  })

  it('does not invent a build failure when the SDK fails after a successful build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const state = new PluginCoreExecutionState(root)
    const dsh = { run: async () => {
      const buildId = randomUUID()
      state.startBuild(runId, buildId)
      state.finishBuild(runId, buildId)
      throw maxTokensFailure()
    } } as unknown as PluginCoreDshRunner
    const service = new PluginCoreService(dsh, { outputRoot: root, state })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'draw' })
    expect(result.error?.code).toBe('plugin_core_max_tokens')
    expect(result.error).not.toHaveProperty('details')
  })

  it('surfaces output-token exhaustion as a specific failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const run = vi.fn().mockRejectedValueOnce(maxTokensFailure())
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1',
      providerKey: 'key', prompt: 'draw' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(result.error).toMatchObject({
      code: 'plugin_core_max_tokens',
      message: expect.stringMatching(/output-token limit/),
    })
  })



  it('records token usage and event-type diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const dsh = { run: async () => ({ finalResponse: 'done', events: [
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } } },
      { type: 'tool/start', data: {} },
      { type: 'tool/end', data: {} },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] }) } as unknown as PluginCoreDshRunner
    const service = new PluginCoreService(dsh, { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    expect(result.usage).toEqual({ calls: 1, inputTokens: 12, outputTokens: 5,
      reasoningTokens: null, cacheReadTokens: 2, complete: true })
    expect(result.diagnostics).toMatchObject({ eventTypes: { 'tool/start': 1, 'tool/end': 1 },
      toolCalls: 1 })
    expect(result.error?.code).toBe('plugin_core_no_delivery')
  })

  it('counts a tool call once when its result is also recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const dsh = { run: async () => ({ finalResponse: 'done', events: [
      { type: 'tool/call', data: {} },
      { type: 'tool/result', data: {} },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] }) } as unknown as PluginCoreDshRunner
    const service = new PluginCoreService(dsh, { outputRoot: root })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    expect(result.diagnostics).toMatchObject({
      eventTypes: { 'tool/call': 1, 'tool/result': 1 },
      toolCalls: 1,
    })
  })

  it('cancels an in-flight turn through the Worker signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    let signal: AbortSignal | undefined
    const run = vi.fn(async (request: { signal?: AbortSignal }) => {
      signal = request.signal
      return await new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(new Error('plugin_core_cancelled')), { once: true })
      })
    })
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root })
    const pending = service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(service.cancel(runId)).toBe('cancelled')
    const result = await pending
    expect(result.error?.code).toBe('plugin_core_cancelled')
    expect(service.cancel(runId)).toBe('not_found')
  })

  it('writes and binds the Worker base before the model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const bases = new PluginCoreBaseRegistry()
    const bytes = Buffer.from('PKfake-base')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const run = vi.fn(async () => {
      expect(bases.get(runId)).toMatchObject({ sha256, name: 'base.ggb' })
      return { finalResponse: 'done', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] }
    })
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root, bases })
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'edit',
      base: { dataBase64: bytes.toString('base64'), sha256, name: 'base.ggb' } })
    expect(result.error?.code).toBe('plugin_core_no_delivery')
    await expect(readFile(join(root, runId, 'base.ggb'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(bases.get(runId)).toBeUndefined()
  })

  it('rejects a base digest mismatch before the model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    const run = vi.fn()
    const service = new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root })
    const bytes = Buffer.from('PKfake-base')
    const result = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'edit',
      base: { dataBase64: bytes.toString('base64'), sha256: '0'.repeat(64), name: null } })
    expect(result.error?.code).toBe('base_digest_mismatch')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a second concurrent run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-core-service-'))
    dirs.push(root)
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const dsh = { run: async () => { await gate; return { finalResponse: 'done', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] } } } as unknown as PluginCoreDshRunner
    const service = new PluginCoreService(dsh, { outputRoot: root })
    const first = service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    const second = await service.run({ runId, deliveryContract: 'receipt-v1', providerKey: 'key', prompt: 'draw' })
    expect(second.error?.code).toBe('plugin_core_busy')
    expect(second.cleanup?.confirmed).toBe(false)
    release()
    await first
  })
  it('fails closed when the delivery contract is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-contract-')); dirs.push(root)
    const run = vi.fn()
    const result = await new PluginCoreService({ run } as unknown as PluginCoreDshRunner,
      { outputRoot: root }).run({ runId, providerKey: 'key', prompt: 'draw' })
    expect(result.error?.code).toBe('plugin_core_contract_mismatch')
    expect(run).not.toHaveBeenCalled()
  })

})

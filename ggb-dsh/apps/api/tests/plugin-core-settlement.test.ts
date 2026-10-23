import { trustedDelivery } from './fixtures/trusted-delivery.js'
import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { MemoryPluginCoreStore } from '@ggb-copilot/run-persistence'
import { runIdSchema, toolArgumentsDigest, type ChannelPluginCoreResult } from '@ggb-copilot/application'
import { PluginCoreRunService, type PluginCoreWorkerPort } from '../src/plugin-core/run-service.js'

async function fixture(worker: PluginCoreWorkerPort) {
  const store = new MemoryPluginCoreStore()
  const service = new PluginCoreRunService(store, worker, { engine: 'plugin_core', serverPepper: 'a'.repeat(64),
    maxConcurrentRuns: 1, activeRunTtlMs: 60_000, terminalRunTtlMs: 60_000 })
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  await service.createRun({ runId, runToken: 'token', idempotencyKey: runId, providerKey: 'fake',
    prompt: 'test', base: null, requestDigest: 'a'.repeat(64) })
  return { runId, store, service }
}
function finished(runId: ReturnType<typeof runIdSchema.parse>, cancelled = false): ChannelPluginCoreResult {
  return { type: 'plugin-core.result', requestId: randomUUID(), finalResponse: 'done',
    cleanup: { runId, confirmed: true, completedAt: new Date().toISOString() },
    delivery: cancelled ? null : trustedDelivery(runId, { id: createHash('sha256').update('PKfake').digest('hex'),
      ggbBytes: 6, ggbBase64: Buffer.from('PKfake').toString('base64'), screenshotBase64: null, verification: {} }),
    error: cancelled ? { code: 'plugin_core_cancelled', message: 'cancelled' } : null }
}
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('settlement did not finish')
}

describe('atomic plugin-core settlement', () => {
  it('waits for cleanup after stop, then emits one cancellation', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    await f.service.stop(f.runId, 'token')
    expect((await f.store.getRun(f.runId))?.phase).toBe('running')
    resolve(finished(f.runId, true))
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'cancelled')
    expect((await f.store.listEvents(f.runId, 0, 20)).filter(e => e.payload.type === 'plugin_core.cancelled')).toHaveLength(1)
  })
  it('defers deletion until the execution owner returns cleanup', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    await f.service.deleteRun(f.runId, 'token')
    expect((await f.store.getRun(f.runId))?.phase).toBe('running')
    resolve(finished(f.runId, true))
    await until(async () => await f.store.getRun(f.runId) === null)
  })
  it('retains unknown cleanup after a channel failure even when stop and delete were requested', async () => {
    let reject!: (error: Error) => void
    const f = await fixture({ runPluginCore: () => new Promise((_done, fail) => { reject = fail }) })
    await until(async () => Boolean(reject))
    await f.service.deleteRun(f.runId, 'token')
    reject(new Error('channel closed'))
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure?.code).toBe('plugin_core_worker_unavailable')
    expect(await f.store.deleteRun(f.runId)).toBe(false)
  })
  it.each(['connection closed', 'handshake failed', 'channel timeout', 'invalid protocol'])('classifies %s without inventing cleanup proof', async reason => {
    const f = await fixture({ runPluginCore: async () => { throw new Error(reason) } })
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure?.code).toBe('plugin_core_worker_unavailable')
    expect(await f.store.deleteRun(f.runId)).toBe(false)
    expect((await f.store.listEvents(f.runId, 0, 20)).some(e => e.payload.type === 'plugin_core.cancelled')).toBe(false)
  })
  it.each(['missing', 'mismatched', 'unconfirmed'] as const)('distinguishes %s cleanup from a confirmed cleanup result', async mode => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    if (mode === 'missing') delete result.cleanup
    else if (mode === 'mismatched') result.cleanup!.runId = runIdSchema.parse(`run_${randomUUID()}`)
    else result.cleanup!.confirmed = false
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure?.code).toBe(mode === 'unconfirmed'
      ? 'plugin_core_cleanup_failed' : 'plugin_core_worker_unavailable')
    expect(await f.store.deleteRun(f.runId)).toBe(false)
  })
  it('stores the exact plugin report and manifest bytes with their receipt', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    const report = Buffer.from('{\n  "evidence": "original report"\n}\n')
    const verification = JSON.parse(report.toString())
    const manifest = Buffer.from(JSON.stringify({ sha256: result.delivery!.id }, null, 2) + '\n')
    const bytes = [Buffer.from('PKfake'), report, manifest]
    const kinds = ['result_ggb', 'verification', 'manifest']
    const binding = { runId: f.runId, turnId: randomUUID(), epoch: 1, requestId: randomUUID(),
      toolCallId: randomUUID(), buildId: randomUUID(), domainRequestDigest: 'a'.repeat(64), baseSha256: null,
      pluginName: 'ggb-plugins-dsh', pluginVersion: '0.8.3', packageIntegrity: 'b'.repeat(64), runtimeIdentity: {} }
    const receipt = { receiptSchemaVersion: 2, ...binding, status: 'succeeded', issues: [], verification: { reportSha256: createHash('sha256').update(report).digest('hex'), reportBytes: report.length, summary: verification },
      artifacts: bytes.map((content, i) => ({ kind: kinds[i]!, ref: kinds[i]!, bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        contentType: i === 0 ? 'application/octet-stream' : 'application/json' })) }
    result.delivery = { ...result.delivery!, verification, reportBase64: report.toString('base64'),
      manifestBase64: manifest.toString('base64'), trustedBuild: { binding, receipt, receiptSha256: toolArgumentsDigest(receipt) } }
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'completed')
    const saved = (await f.store.getRun(f.runId))!.delivery!
    expect(saved.trustedBuild?.receiptSha256).toBe(toolArgumentsDigest(receipt))
    for (const [kind, content] of [['verification', report], ['manifest', manifest]] as const) {
      const metadata = saved.artifacts.find(a => a.kind === kind)!
      expect(Buffer.from((await f.store.getArtifact(f.runId, metadata.artifactId))!.contentBase64, 'base64')).toEqual(content)
    }
  })

  it('preserves output-token exhaustion as a specific failure code', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    result.delivery = null
    result.error = { code: 'plugin_core_max_tokens',
      message: 'The model reached the output-token limit before completing the turn.' }
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure).toMatchObject({
      code: 'plugin_core_max_tokens',
      message: expect.stringMatching(/output-token limit/),
    })
  })

  it('preserves malformed tool arguments as a specific failure code', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    result.delivery = null
    result.error = { code: 'plugin_core_malformed_response',
      message: 'The model returned malformed tool arguments; no tool or build was executed.' }
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure?.code).toBe('plugin_core_malformed_response')
  })

  it('preserves the no-delivery failure code and verification hint', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    result.delivery = null
    result.error = { code: 'plugin_core_no_delivery',
      message: 'The last build did not satisfy verification.',
      details: { kind: 'verification_failed', lastBuildId: randomUUID(),
        error: { code: 'verification_failed', message: 'Required checks did not pass' },
        failedChecks: [{ requirementId: 'shape', checkId: 'shape:0', method: 'type', status: 'failed' }],
        reasons: ['shape/shape:0: type failed'] } }
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure).toMatchObject({
      code: 'plugin_core_no_delivery',
      message: 'The last build did not satisfy verification.', details: result.error.details,
    })
  })

  it('preserves build evidence while cleanup failure remains the primary failure', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    result.delivery = null
    result.cleanup!.confirmed = false
    const details = { kind: 'execution_failed' as const, lastBuildId: randomUUID(),
      error: { code: 'cleanup_failed', message: 'Process exit was not confirmed' },
      failedChecks: [], reasons: ['Process exit was not confirmed'] }
    result.error = { code: 'plugin_core_cleanup_failed', message: 'Cleanup failed', details }
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure).toMatchObject({ code: 'plugin_core_cleanup_failed', details })
    expect(await f.store.deleteRun(f.runId)).toBe(false)
  })

  it('settles a nonterminal completion conflict as failed', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    vi.spyOn(f.store, 'completeRun').mockResolvedValueOnce('conflict')
    resolve(finished(f.runId))
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure?.code).toBe('plugin_core_commit_conflict')
    expect((await f.store.listEvents(f.runId, 0, 20)).some(e => e.payload.type === 'plugin_core.delivery')).toBe(false)
  })
  it('classifies mismatched GGB byte length as corrupt delivery rather than a commit conflict', async () => {
    let resolve!: (result: ChannelPluginCoreResult) => void
    const f = await fixture({ runPluginCore: () => new Promise(done => { resolve = done }) })
    await until(async () => Boolean(resolve))
    const result = finished(f.runId)
    result.delivery!.ggbBytes += 1
    const complete = vi.spyOn(f.store, 'completeRun')
    resolve(result)
    await until(async () => (await f.store.getRun(f.runId))?.phase === 'failed')
    expect((await f.store.getRun(f.runId))?.failure?.code).toBe('plugin_core_delivery_invalid')
    expect(complete).not.toHaveBeenCalled()
  })

})

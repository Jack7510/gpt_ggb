import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runIdSchema, toolArgumentsDigest } from '@ggb-copilot/application'
import {
  MemoryPluginCoreStore, SqlitePluginCoreStore, PgPluginCoreStore, createPgPool,
} from '../src/index.js'
import type { PluginCoreCompleteInput, PluginCoreStore } from '../src/index.js'

const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000101')
const now = '2026-10-17T00:00:00.000Z'

function spec(id = runId) {
  return {
    runId: id,
    tokenVerifier: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    prompt: 'draw a circle',
    promptDigest: 'c'.repeat(64),
    baseSha256: null,
    baseName: null,
    executionExpiresAt: '2026-10-17T00:10:00.000Z',
    expiresAt: '2026-10-18T00:00:00.000Z',
  }
}

function baseCompletion(id = runId): PluginCoreCompleteInput {
  return {
    runId: id,
    cleanup: { runId: id, confirmed: true, completedAt: now },
    finalResponse: 'done',
    delivery: {
      id: createHash('sha256').update('PK!!').digest('hex'),
      artifacts: [{
        artifactId: createHash('sha256').update('PK!!').digest('hex'), kind: 'result_ggb', sizeBytes: 4,
        sha256: createHash('sha256').update('PK!!').digest('hex'), contentType: 'application/octet-stream',
      }],
      verification: { construction: { status: 'passed' } },
    },
    usage: {
      calls: 1, inputTokens: 10, outputTokens: 5, reasoningTokens: 0,
      cacheReadTokens: 0, complete: true, source: 'sdk',
    },
    durationMs: 1234,
    modelId: 'deepseek-flash',
    artifacts: [{
      artifactId: createHash('sha256').update('PK!!').digest('hex'), kind: 'result_ggb', sizeBytes: 4,
      sha256: createHash('sha256').update('PK!!').digest('hex'), contentType: 'application/octet-stream',
      contentBase64: Buffer.from('PK!!').toString('base64'),
    }],
    expiresAt: '2026-10-24T00:00:00.000Z',
  }
}

function contract(name: string, factory: () => PluginCoreStore | Promise<PluginCoreStore>,
  cleanup: () => Promise<void>) {
  describe(name, () => {
    it('atomically preserves bounded build failure details and rejects invalid summaries', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        const details = { kind: 'verification_failed' as const, lastBuildId: '11111111-1111-4111-8111-111111111111',
          error: { code: 'verification_failed', message: 'Checks failed' }, failedChecks: [
            { requirementId: 'shape', checkId: 'shape:0', method: 'type', status: 'failed' }], reasons: ['shape:0 type failed'] }
        const input = { runId, failure: { code: 'plugin_core_no_delivery' as const, message: 'Verification failed', details },
          usage: null, durationMs: 1, modelId: 'fake', expiresAt: '2026-10-24T00:00:00.000Z',
          cleanup: { runId, confirmed: true, completedAt: now } }
        expect(await store.failRun({ ...input, failure: { ...input.failure,
          details: { ...details, reasons: ['x'.repeat(513)] } } })).toBe('conflict')
        expect((await store.getRun(runId))?.phase).toBe('running')
        expect(await store.failRun(input)).toBe('committed')
        expect((await store.getRun(runId))?.failure?.details).toEqual(details)
        expect((await store.listEvents(runId, 0, 20)).at(-1)?.payload).toMatchObject({ details })
      } finally { await cleanup() }
    })

    it('atomically rejects stale, stopped and terminal progress', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        const fact = { tool: 'ggb_check' as const, status: 'started' as const,
          callId: '11111111-1111-4111-8111-111111111111', sequence: 1, occurredAt: now }
        const append = (sequence: number) => store.appendEvents(runId, [{ occurredAt: now,
          payload: { type: 'plugin_core.progress', progress: { ...fact, sequence } } }])
        expect(await append(1)).toEqual([])
        await store.markRunning(runId)
        expect(await append(1)).toHaveLength(1)
        expect(await append(1)).toEqual([])
        expect(await append(3)).toHaveLength(1)
        expect(await append(2)).toEqual([])
        await store.requestStop(runId)
        expect(await append(4)).toEqual([])
        await store.cancelRun(runId, '2026-10-24T00:00:00.000Z', { runId, confirmed: true, completedAt: now })
        expect(await append(5)).toEqual([])
        expect((await store.listEvents(runId, 0, 20)).filter(e => e.payload.type === 'plugin_core.progress')).toHaveLength(2)
      } finally { await cleanup() }
    })

    it.each(['completed', 'failed'] as const)('rejects progress after %s commits', async phase => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        if (phase === 'completed') expect(await store.completeRun(completion())).toBe('committed')
        else expect(await store.failRun({ runId, failure: { code: 'plugin_core_failed', message: 'fixture' },
          usage: null, durationMs: 1, modelId: 'fixture', expiresAt: '2026-10-24T00:00:00.000Z',
          cleanup: { runId, confirmed: true, completedAt: now } })).toBe('committed')
        const cursor = await store.latestEventId(runId)
        expect(await store.appendEvents(runId, [{ occurredAt: now, payload: { type: 'plugin_core.progress',
          progress: { tool: 'ggb_check', status: 'started', callId: '11111111-1111-4111-8111-111111111111',
            sequence: 1, occurredAt: now } } }])).toEqual([])
        expect(await store.latestEventId(runId)).toBe(cursor)
        expect((await store.getRun(runId))?.phase).toBe(phase)
      } finally { await cleanup() }
    })

    it('creates, starts, completes and authorizes artifacts', async () => {
      const store = await factory()
      try {
        const created = await store.createRun(spec())
        expect(created.kind).toBe('created')
        expect(created.record.phase).toBe('accepted')
        expect(await store.getRunAccessFacts(runId)).toEqual({
          tokenVerifier: 'a'.repeat(64), requestDigest: 'b'.repeat(64),
        })
        expect((await store.createRun(spec())).kind).toBe('existing')
        expect((await store.markRunning(runId))).toBe('running')
        expect(await store.countActiveRuns()).toBe(1)
        expect(await store.completeRun(completion())).toBe('committed')
        const record = await store.getRun(runId)
        expect(record?.phase).toBe('completed')
        expect(record?.finalResponse).toBe('done')
        expect(record?.usage?.inputTokens).toBe(10)
        expect(await store.countActiveRuns()).toBe(0)
        const artifact = await store.getArtifact(runId, createHash('sha256').update('PK!!').digest('hex'))
        expect(Buffer.from(artifact!.contentBase64, 'base64').toString()).toBe('PK!!')
        const events = await store.listEvents(runId, 0, 20)
        expect(events.map(event => event.payload.type)).toEqual([
          'plugin_core.phase', 'plugin_core.phase', 'plugin_core.delivery',
        ])
      } finally {
        await cleanup()
      }
    })

    it('lets a stop win a completion race and stores no result', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        expect(await store.requestStop(runId)).toBe(true)
        expect(await store.completeRun(completion())).toBe('cancelled')
        expect((await store.getRun(runId))?.phase).toBe('cancelled')
        expect(await store.getArtifact(runId, createHash('sha256').update('PK!!').digest('hex'))).toBeNull()
        const events = await store.listEvents(runId, 0, 20)
        expect(events.at(-1)?.payload.type).toBe('plugin_core.cancelled')
      } finally {
        await cleanup()
      }
    })

    it('rejects tampering and duplicate or late completions atomically', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        const valid = completion()
        const bad = { ...valid, artifacts: valid.artifacts.map(a => ({ ...a,
          contentBase64: Buffer.from('evil').toString('base64') })) }
        expect(await store.completeRun(bad)).toBe('conflict')
        expect((await store.getRun(runId))?.phase).toBe('running')
        expect(await store.completeRun({ ...valid, cleanup: { runId, confirmed: false, completedAt: now } })).toBe('conflict')
        expect(await store.completeRun(valid)).toBe('committed')
        expect(await store.completeRun(valid)).toBe('conflict')
        expect((await store.listEvents(runId, 0, 50)).filter(e => e.payload.type === 'plugin_core.delivery')).toHaveLength(1)
      } finally { await cleanup() }
    })

    it('serializes concurrent stop/completion and duplicate completions without lost updates', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        const outcomes = await Promise.all([store.requestStop(runId), store.completeRun(completion()),
          store.completeRun(completion())])
        expect(outcomes.slice(1).filter(outcome => outcome !== 'conflict')).toHaveLength(1)
        expect(outcomes.slice(1)).toContain('conflict')
        const record = (await store.getRun(runId))!
        expect(['completed', 'cancelled']).toContain(record.phase)
        if (outcomes[0] === true) expect(record.phase).toBe('cancelled')
        const terminal = (await store.listEvents(runId, 0, 50)).filter(e =>
          e.payload.type === 'plugin_core.delivery' || e.payload.type === 'plugin_core.cancelled')
        expect(terminal).toHaveLength(1)
        const artifact = await store.getArtifact(runId, completion().artifacts[0]!.artifactId)
        expect(artifact === null).toBe(record.phase === 'cancelled')
      } finally { await cleanup() }
    })

    it('keeps active deletion and expiry fenced until cleanup is proved', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        expect(await store.cancelRun(runId, completion().expiresAt)).toBe(false)
        expect(await store.deleteRun(runId)).toBe(false)
        await store.sweepExpired('2026-10-20T00:00:00.000Z', 10)
        expect((await store.getRun(runId))?.phase).toBe('running')
        expect((await store.getRun(runId))?.stopRequested).toBe(true)
        expect(await store.cancelRun(runId, completion().expiresAt, completion().cleanup)).toBe(true)
        const terminal = (await store.listEvents(runId, 0, 50)).at(-1)!
        expect(terminal.payload).toMatchObject({ type: 'plugin_core.cancelled', cleanup: { confirmed: true, runId } })
      } finally { await cleanup() }
    })

    it.each(['plugin_core_cleanup_failed', 'plugin_core_worker_unavailable'] as const)('does not cancel or sweep %s without cleanup proof', async code => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        await store.requestStop(runId)
        expect(await store.failRun({ runId, failure: { code, message: 'unconfirmed' },
          usage: null, durationMs: 1, modelId: 'fake', expiresAt: now })).toBe('committed')
        expect((await store.getRun(runId))?.phase).toBe('failed')
        await store.sweepExpired('2026-10-20T00:00:00.000Z', 10)
        expect(await store.deleteRun(runId)).toBe(false)
        expect((await store.getRun(runId))?.failure?.code).toBe(code)
      } finally { await cleanup() }
    })

    it('requires cleanup on failure and lets a valid stop win that failure', async () => {
      const store = await factory()
      try {
        await store.createRun(spec())
        await store.markRunning(runId)
        const failure = { runId, failure: { code: 'plugin_core_failed' as const, message: 'failed' },
          usage: null, durationMs: 1, modelId: 'fake', expiresAt: completion().expiresAt }
        expect(await store.failRun(failure)).toBe('conflict')
        await store.requestStop(runId)
        expect(await store.failRun({ ...failure, cleanup: completion().cleanup! })).toBe('cancelled')
      } finally { await cleanup() }
    })

    it('binds the accepted call, receipt and original artifacts in the same commit', async () => {
      const store = await factory()
      try {
        await store.createRun({ ...spec(), deliveryContract: 'receipt-v1' })
        await store.markRunning(runId)
        const valid = trustedCompletion()
        expect(await store.completeRun(baseCompletion())).toBe('conflict') // no receipt downgrade
        const mismatched = structuredClone(valid)
        mismatched.delivery.trustedBuild!.binding.requestId = crypto.randomUUID()
        expect(await store.completeRun(mismatched)).toBe('conflict')
        const binding = valid.delivery.trustedBuild!.binding
        valid.delivery.construction = { schemaVersion: 1, origin: 'host-accepted-build', buildId: binding.buildId,
          domainRequestDigest: binding.domainRequestDigest, baseSha256: binding.baseSha256, text: 'accepted steps\n' }
        const wrongReport = structuredClone(valid)
        wrongReport.delivery.construction!.buildId = crypto.randomUUID()
        expect(await store.completeRun(wrongReport)).toBe('conflict')
        expect(await store.completeRun(valid)).toBe('committed')
        expect((await store.getRun(runId))?.delivery?.construction).toEqual(valid.delivery.construction)
        expect((await store.listEvents(runId, 0, 20)).at(-1)?.payload).toMatchObject({ delivery: { construction: valid.delivery.construction } })
        expect((await store.getRun(runId))?.delivery?.trustedBuild).toEqual(valid.delivery.trustedBuild)
        for (const artifact of valid.artifacts) {
          expect((await store.getArtifact(runId, artifact.artifactId))?.contentBase64).toBe(artifact.contentBase64)
        }
      } finally { await cleanup() }
    })

    it('fails interrupted runs and removes expired terminals', async () => {
      const store = await factory()
      try {
        const expiring = runIdSchema.parse('run_00000000-0000-4000-8000-000000000102')
        await store.createRun({
          ...spec(expiring), executionExpiresAt: '2026-10-16T00:00:00.000Z',
          expiresAt: '2026-10-16T00:00:00.000Z',
        })
        const done = await store.createRun(spec())
        expect(done.kind).toBe('created')
        await store.markRunning(runId)
        await store.completeRun(completion())
        const swept = await store.sweepExpired(now, 10)
        expect(swept).toBeGreaterThanOrEqual(1)
        expect((await store.getRun(expiring))?.phase).toBe('failed')
        const events = await store.listEvents(expiring, 0, 20)
        expect(events.at(-1)?.payload.type).toBe('plugin_core.failed')
      } finally {
        await cleanup()
      }
    })
  })
}

contract('memory plugin-core store', () => new MemoryPluginCoreStore({ now: () => now }),
  async () => undefined)

const sqliteStores: SqlitePluginCoreStore[] = []
const sqliteDirectories: string[] = []
contract('sqlite plugin-core store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-core-store-'))
  sqliteDirectories.push(directory)
  const store = new SqlitePluginCoreStore(join(directory, 'store.sqlite'))
  sqliteStores.push(store)
  return store
}, async () => {
  for (const store of sqliteStores.splice(0)) store.close()
  for (const directory of sqliteDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

// Dedicated disposable local DB only; never reuse DATABASE_URL or deployment credentials.
if (process.env.GGB_C_TEST_PG_SOCKET) {
  const pools: ReturnType<typeof createPgPool>[] = []
  contract('postgres plugin-core store', async () => {
    const pool = createPgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(process.env.GGB_C_TEST_PG_SOCKET!)}`)
    pools.push(pool)
    await pool.query(await readFile(new URL('../migrations/017_plugin_core.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../migrations/018_plugin_core_delivery_contract.sql', import.meta.url), 'utf8'))
    await pool.query('TRUNCATE plugin_core_runs CASCADE')
    return new PgPluginCoreStore(pool)
  }, async () => { for (const pool of pools.splice(0)) await pool.end() })
}

function trustedCompletion(): PluginCoreCompleteInput {
  const input = baseCompletion()
  const extra = (kind: 'verification' | 'manifest', value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
    return { artifactId: kind, kind, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'application/json', contentBase64: bytes.toString('base64') }
  }
  const artifacts = [...input.artifacts, extra('verification', input.delivery.verification),
    extra('manifest', { sha256: input.delivery.id })]
  const binding = { runId, turnId: crypto.randomUUID(), epoch: 1, requestId: crypto.randomUUID(),
    toolCallId: crypto.randomUUID(), buildId: crypto.randomUUID(), domainRequestDigest: 'a'.repeat(64),
    baseSha256: null, pluginName: 'ggb-plugins-dsh', pluginVersion: '0.8.3', packageIntegrity: 'b'.repeat(64),
    runtimeIdentity: { geogebraVersion: 'test', geogebraSha256: 'c'.repeat(64), playwrightVersion: '1.64.1' } }
  const receipt = { receiptSchemaVersion: 2, ...binding, status: 'succeeded', issues: [],
    verification: { reportSha256: artifacts.find(a => a.kind === 'verification')!.sha256,
      reportBytes: artifacts.find(a => a.kind === 'verification')!.sizeBytes, summary: input.delivery.verification }, artifacts: artifacts.map(a => ({ kind: a.kind,
      ref: a.kind, bytes: a.sizeBytes, sha256: a.sha256, contentType: a.contentType })) }
  return { ...input, artifacts, delivery: { ...input.delivery,
    artifacts: artifacts.map(({ contentBase64: _, ...metadata }) => metadata),
    trustedBuild: { binding, receipt, receiptSha256: toolArgumentsDigest(receipt) } } }
}

function completion(): PluginCoreCompleteInput { return trustedCompletion() }

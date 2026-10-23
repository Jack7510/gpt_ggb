import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIdSchema } from '@ggb-copilot/application'
import { InstalledPluginCoreRunner } from '../src/plugin-core/installed-runner.js'
import { PluginCoreProcessRunner } from '../src/plugin-core/process-runner.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { PluginCoreService } from '../src/plugin-core/service.js'
import type { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { toolProtocol } from './fixtures/installed-plugin.js'

const root = process.env.GGB_PLUGIN_TEST_ROOT
const dirs: string[] = []
const runId = runIdSchema.parse(`run_${randomUUID()}`)
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const synthetic = JSON.parse(await readFile(new URL('./fixtures/verified-build.json', import.meta.url), 'utf8'))
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe.skipIf(!root)('installed receipt and trusted delivery (synthetic facts, no browser)', () => {
  async function fixture(mutate?: (receipt: any, context: any) => Promise<void>, options: { preview?: boolean; padding?: number; badPreview?: 'directory' | 'oversize'; native?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'trusted-build-')); dirs.push(dir)
    const req = createRequire(join(root!, 'package.json'))
    const { executeHostOperation } = await import(pathToFileURL(req.resolve('ggb-plugins-dsh/executor')).href)
    const { loadInstallation } = await import(pathToFileURL(req.resolve('ggb-plugins-dsh/installation')).href)
    const installation = loadInstallation()
    let reportBytes = Buffer.alloc(0)
    const spawn = vi.spyOn(PluginCoreProcessRunner.prototype, 'spawn').mockImplementation(async args => {
      const context = JSON.parse(await readFile(args[args.indexOf('--context') + 1]!, 'utf8'))
      const request = JSON.parse(await readFile(args[args.indexOf('--request') + 1]!, 'utf8'))
      const operation = args[args.indexOf('--operation') + 1]!
      const response = await executeHostOperation(operation, request, context, 'a'.repeat(64), undefined, {
        build: async (input: any) => {
          const delivery = join(input.outputDir, 'title', 'delivery')
          await mkdir(delivery, { recursive: true })
          const file = join(delivery, '任意文件名.ggb')
          await writeFile(file, 'PKsynthetic')
          const requestSha256 = hash(JSON.stringify(input, null, 2) + '\n')
          const phase = structuredClone(synthetic.phase)
          if (options.native) {
            phase.objects[0].expression = '(0,0)'
            for (const result of phase.results) result.evidence = result.evidence.map(() => phase.objects[0])
          }
          const report = { extra: 'x'.repeat(options.padding ?? 0), milestone: 'M6', requestSha256,
            construction: phase, reload: phase,
            interaction: { status: 'passed', samples: [], zoom: { method: 'button', before: 1, after: 2 } } }
          reportBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
          await writeFile(join(delivery, 'verification.json'), reportBytes)
          await writeFile(join(delivery, 'request.json'), JSON.stringify(input, null, 2) + '\n')
          await writeFile(join(delivery, 'manifest.json'), JSON.stringify({ protocolVersion: 2,
            milestone: 'M6', requestSha256, sha256: hash('PKsynthetic'), file: '任意文件名.ggb',
            runtimeVersion: installation.runtimeIdentity.geogebraVersion, objects: synthetic.objects }))
          if (options.preview !== false) await writeFile(join(delivery, 'preview.png'), 'synthetic-preview')
          if (options.badPreview === 'directory') { await rm(join(delivery, 'preview.png')); await mkdir(join(delivery, 'preview.png')) }
          if (options.badPreview === 'oversize') await writeFile(join(delivery, 'preview.png'), Buffer.alloc(3 * 1024 * 1024 + 1))
          return { delivery, file, report: join(delivery, 'verification.json') }
        } })
      const receipt = response.receipt
      if (receipt) {
        await mutate?.(receipt, context)
        response.ok = receipt.status === 'succeeded'
        response.error = response.ok ? null : receipt.issues[0]
      }
      return { kind: 'completed', stdout: JSON.stringify(response),
        evidence: { kind: 'completed', cleanupConfirmed: true, exitCode: 0, signal: null,
          stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' } }
    })
    const state = new PluginCoreExecutionState(dir)
    const runner = await InstalledPluginCoreRunner.load({ pluginRoot: root!, outputRoot: dir,
      packageIntegrity: 'a'.repeat(64), state })
    const gateway = new PluginCoreGateway(runner, { state })
    const call = (request = synthetic.request) => gateway.dispatch({ protocolVersion: 3, runId, turnId: randomUUID(),
      epoch: 1, requestId: randomUUID(), toolCallId: randomUUID(), toolName: 'ggb_build', arguments: request })
    return { dir, state, spawn, call, runner, gateway, reportBytes: () => reportBytes }
  }

  it('executes the installed public entry and returns structural rejection before browser startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'installed-preflight-')); dirs.push(dir)
    const state = new PluginCoreExecutionState(dir)
    const runner = await InstalledPluginCoreRunner.load({ pluginRoot: root!, outputRoot: dir,
      packageIntegrity: 'a'.repeat(64), state })
    const request = { protocolVersion: 2, prompt: 'invalid request: no plan or locale' }
    const result = await runner.build(request, runId, undefined, undefined, {
      protocolVersion: 3, requestId: randomUUID(), toolCallId: randomUUID(), turnId: randomUUID(),
      epoch: 1, runId, buildId: randomUUID(), toolName: 'ggb_build', arguments: request })
    expect(result.ok).toBe(false)
    expect(result.execution).toMatchObject({ kind: 'completed', exitCode: 0, cleanupConfirmed: true })
    expect(result.error?.code).toBe('invalid_input')
    expect(state.candidate(runId)).toBeNull()
  })

  it('refuses desktop CLI envelopes even when they claim safe success', async () => {
    const f = await fixture()
    f.spawn.mockResolvedValueOnce({ kind: 'completed', evidence: {
      kind: 'completed', cleanupConfirmed: true, exitCode: 0, signal: null,
      stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' },
      stdout: JSON.stringify({ protocolVersion: 1, ok: true, data: {} }) })
    await expect(f.runner.check({}, runId)).rejects.toThrow('executor_version')
  })

  it('refunds actual installed preflight rejections and still allows three builds', async () => {
    const f = await fixture()
    for (let i = 0; i < 4; i++) {
      expect(await f.call({ protocolVersion: 2, prompt: 'missing plan' })).toMatchObject({
        status: 'rejected', errors: [{ code: 'invalid_input' }] })
    }
    for (let i = 0; i < 3; i++) expect((await f.call()).status).toBe('accepted')
    expect(await f.call()).toMatchObject({ errors: [{ code: 'build_limit_reached' }] })
    expect(f.spawn).toHaveBeenCalledTimes(7)
  })

  it('charges execution-phase rejection even when its code is invalid_input', async () => {
    const f = await fixture(async receipt => {
      receipt.status = 'rejected'; receipt.artifacts = []; receipt.verification = null
      receipt.issues = [{ code: 'invalid_input', message: 'rejected after dispatch' }]
    })
    for (let i = 0; i < 3; i++) expect((await f.call()).status).toBe('rejected')
    expect(await f.call()).toMatchObject({ errors: [{ code: 'build_limit_reached' }] })
    expect(f.spawn).toHaveBeenCalledTimes(3)
  })

  it('accepts kind-based names and preserves exact checked bytes through Service', async () => {
    const f = await fixture()
    const request = structuredClone(synthetic.request)
    request.plan.program = [{ id: 'P', op: 'native', mode: 'algebra', source: 'P=(0,0)', initial: [0,0] }]
    const dsh = { run: async () => { await f.call(request); return { finalResponse: 'done', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] } } } as unknown as PluginCoreDshRunner
    const result = await new PluginCoreService(dsh, { outputRoot: f.dir, state: f.state })
      .run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'test' })
    expect(result.error).toBeNull()
    expect(result.cleanup?.confirmed).toBe(true)
    expect(result.delivery?.id).toBe(hash('PKsynthetic'))
    expect(Buffer.from(result.delivery!.reportBase64!, 'base64')).toEqual(f.reportBytes())
    expect(result.delivery?.trustedBuild?.binding.runId).toBe(runId)
    expect(result.delivery?.construction).toMatchObject({ origin: 'host-accepted-build',
      buildId: result.delivery!.trustedBuild!.binding.buildId, domainRequestDigest: result.delivery!.trustedBuild!.binding.domainRequestDigest })
    expect(result.delivery?.construction?.text).toBe('P=(0,0)')
    expect(result.delivery?.construction?.text).not.toContain('requirements')
    expect(result.delivery?.trustedBuild?.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(f.state.candidate(runId)).toBeNull() // resources released after projection
  })

  it('does not deliver an accepted candidate after an abnormal SDK outcome', async () => {
    const f = await fixture()
    const dsh = { run: async () => { await f.call(); return { finalResponse: 'done',
      events: [{ type: 'turn/end', data: { reason: { kind: 'error' } } }] } } } as unknown as PluginCoreDshRunner
    const result = await new PluginCoreService(dsh, { outputRoot: f.dir, state: f.state })
      .run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'test' })
    expect(result.delivery).toBeNull()
    expect(result.error?.code).toBe('plugin_core_sdk_completion_missing')
  })

  it('projects CAS materialization and initial coordinates from the exact accepted request and report', async () => {
    const f = await fixture(undefined, { native: true })
    const request = structuredClone(synthetic.request)
    request.plan.program = [{ op: 'native', id: 'P', mode: 'cas', source: '(0,0)', initial: [0,0] }]
    expect((await f.call(request)).status).toBe('accepted')
    const candidate = f.state.candidate(runId)!
    expect(candidate.construction?.text).toBe('P=((0,0))\nSetCoords(P,0,0)')
    expect(candidate.construction?.buildId).toBe(candidate.trustedBuild!.binding.buildId)
    expect(candidate.construction?.domainRequestDigest).toBe(candidate.trustedBuild!.binding.domainRequestDigest)
  })

  it('binds the receipt and delivered script to the final edited draft, never the earlier checked version', async () => {
    const f = await fixture(undefined, { native: true })
    const draftSession = toolProtocol.createDraft(synthetic.request.prompt)
    const turnId = randomUUID()
    const invoke = (toolName: 'ggb_request' | 'ggb_check' | 'ggb_build', args: unknown) => f.gateway.dispatch({
      protocolVersion: 3, runId, turnId, epoch: 1, requestId: randomUUID(), toolCallId: randomUUID(),
      toolName, arguments: args, draftSession })
    await invoke('ggb_request', { action: 'create', locale: 'en' })
    await invoke('ggb_request', { action: 'append', revision: 1, section: 'program',
      items: [{ id: 'P', source: 'P=(1,1)', initial: [0,0] }] })
    await invoke('ggb_request', { action: 'append', revision: 2, section: 'requirements',
      items: [{ id: 'present', source: 'point P' }] })
    await invoke('ggb_request', { action: 'append', revision: 3, section: 'checks',
      items: [{ requirementId: 'present', kind: 'exists', subjects: ['P'], scope: 'initial' }] })
    const first = (await invoke('ggb_check', { revision: 4 })).result as Record<string, unknown>
    await invoke('ggb_request', { action: 'replace', revision: 4, section: 'program', index: 0,
      items: [{ id: 'P', source: '(0,0)', mode: 'cas', initial: [0,0] }] })
    expect(await invoke('ggb_build', { checkedRequestId: first.checkedRequestId }))
      .toMatchObject({ status: 'rejected', errors: [{ code: 'draft_check_required' }] })
    const final = (await invoke('ggb_check', { revision: 5 })).result as Record<string, unknown>
    expect(final.domainRequestDigest).not.toBe(first.domainRequestDigest)
    expect((await invoke('ggb_build', { checkedRequestId: final.checkedRequestId })).status).toBe('accepted')
    const delivery = f.state.candidate(runId)!
    expect(delivery.trustedBuild!.binding.domainRequestDigest).toBe(final.domainRequestDigest)
    expect(delivery.trustedBuild!.receipt.domainRequestDigest).toBe(final.domainRequestDigest)
    expect(delivery.construction?.domainRequestDigest).toBe(final.domainRequestDigest)
    expect(delivery.construction?.text).toBe('P=((0,0))\nSetCoords(P,0,0)')
    expect(f.spawn).toHaveBeenCalledTimes(3) // two structural checks, one build
    await invoke('ggb_request', { action: 'read', revision: 5, section: 'program' })
    expect(f.state.candidate(runId)).not.toBeNull()
    await invoke('ggb_request', { action: 'append', revision: 5, section: 'program',
      items: [{ id: 'Q', source: 'Q=(1,1)' }] })
    expect(f.state.candidate(runId)).toBeNull() // an edited but unbuilt draft cannot deliver stale bytes
  })

  it('invalidates successful A when accepted build B fails, ignoring stale fixed delivery', async () => {
    const f = await fixture()
    await f.call()
    expect(f.state.candidate(runId)).not.toBeNull()
    f.spawn.mockResolvedValueOnce({ kind: 'completed', stdout: '{"ok":true}', evidence: {
      kind: 'completed', cleanupConfirmed: true, exitCode: 1, signal: null,
      stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '' } })
    expect((await f.call()).status).toBe('rejected')
    expect(f.state.candidate(runId)).toBeNull()
    await mkdir(join(f.dir, runId, 'delivery'), { recursive: true })
    await writeFile(join(f.dir, runId, 'delivery/result.ggb'), 'PKstale')
    const result = await new PluginCoreService({ run: async () => ({ finalResponse: 'done' }) } as unknown as PluginCoreDshRunner,
      { outputRoot: f.dir, state: f.state }).run({ runId, deliveryContract: 'receipt-v1', providerKey: 'fake', prompt: 'test' })
    expect(result.delivery).toBeNull()
  })

  it.each(['identity', 'digest', 'symlink', 'report'])('rejects %s substitution before candidate acceptance', async mode => {
    const f = await fixture(async (receipt, context) => {
      if (mode === 'identity') receipt.buildId = randomUUID()
      const ggb = receipt.artifacts.find((a: any) => a.kind === 'result_ggb')
      if (mode === 'digest') await writeFile(join(context.outputRoot, ggb.ref), 'PKtampered')
      if (mode === 'symlink') {
        const outside = join(f.dir, 'outside.ggb'); await writeFile(outside, 'PKsynthetic')
        await rm(join(context.outputRoot, ggb.ref)); await symlink(outside, join(context.outputRoot, ggb.ref))
      }
      if (mode === 'report') {
        const report = receipt.artifacts.find((a: any) => a.kind === 'verification')
        const bad = Buffer.from('{"construction":{"status":"passed"}}')
        await writeFile(join(context.outputRoot, report.ref), bad)
        report.bytes = bad.length; report.sha256 = hash(bad)
      }
    })
    await expect(f.call()).rejects.toThrow()
    expect(f.state.candidate(runId)).toBeNull()
  })
  it('accepts a missing preview and keeps large report content out of receipts', async () => {
    const f = await fixture(undefined, { preview: false, padding: 700_000 })
    expect((await f.call()).status).toBe('accepted')
    const delivery = f.state.candidate(runId)!
    expect(delivery.screenshotBase64).toBeNull()
    expect(JSON.stringify(delivery.trustedBuild!.receipt).length).toBeLessThan(5000)
    expect(JSON.stringify(delivery.verification).length).toBeLessThan(1000)
    expect(Buffer.from(delivery.reportBase64!, 'base64')).toEqual(f.reportBytes())
  })
  it('rejects a declared oversized artifact before reading it', async () => {
    const f = await fixture(async receipt => { receipt.artifacts[0].bytes = 6 * 1024 * 1024 + 1 })
    await expect(f.call()).rejects.toThrow('artifact_size')
    expect(f.state.candidate(runId)).toBeNull()
  })
  it('uses the earlier run deadline in the public execution context', async () => {
    let actual = 0
    const f = await fixture(async (_receipt, context) => { actual = Date.parse(context.deadline) })
    const deadline = Date.now() + 20_000
    f.state.setDeadline(runId, deadline)
    await f.call()
    expect(actual).toBe(deadline)
  })

  it.each(['directory', 'oversize'] as const)('does not treat a present %s preview as absent', async badPreview => {
    const f = await fixture(undefined, { badPreview })
    await expect(f.call()).rejects.toThrow()
    expect(f.state.candidate(runId)).toBeNull()
  })
  it('rejects a report exceeding the shared raw byte limit', async () => {
    const f = await fixture(undefined, { padding: 1024 * 1024 })
    await expect(f.call()).rejects.toThrow('Artifact size')
    expect(f.state.candidate(runId)).toBeNull()
  })
  it('host detects a changed baseline even when the executor returns a bound rejection', async () => {
    const f = await fixture(async (_receipt, context) => { await writeFile(context.baseRef, 'changed') })
    const path = join(f.dir, 'base.ggb')
    const bytes = Buffer.from('PKhost baseline')
    await writeFile(path, bytes)
    const request = { protocolVersion: 2, prompt: 'missing plan' }
    await expect(f.runner.build(request, runId, undefined, { path, sha256: hash(bytes) }, {
      protocolVersion: 3, runId, turnId: randomUUID(), requestId: randomUUID(), toolCallId: randomUUID(),
      epoch: 1, buildId: randomUUID(), toolName: 'ggb_build', arguments: request })).rejects.toThrow('base_changed')
    expect(f.state.candidate(runId)).toBeNull()
  })

  it('returns the checked summary counts unchanged instead of projecting a summary as a report', async () => {
    const f = await fixture()
    const result = await f.call()
    expect(result.result).toMatchObject({ verification: f.state.candidate(runId)!.verification })
    expect((result.result as { verification: { construction: { results: number } } }).verification.construction.results).toBeGreaterThan(0)
  })

})

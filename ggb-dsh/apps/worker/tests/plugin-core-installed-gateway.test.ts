/** Explicit integration: GGB_PLUGIN_TEST_ROOT must be an installed TGZ package. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIdSchema } from '@ggb-copilot/application'
import { PluginCoreEvidenceStore } from '../src/plugin-core/evidence.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'
import { loadInstalledToolProtocol } from '../src/plugin-core/tool-protocol.js'
import type { PluginCoreRunResult } from '../src/plugin-core/process-runner.js'
import { InstalledPluginCoreRunner } from '../src/plugin-core/installed-runner.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'

const installedRoot = process.env.GGB_PLUGIN_TEST_ROOT
const dirs: string[] = []
const servers: PluginCoreToolGatewayServer[] = []
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
interface InstalledTools {
  createTool(name: string): { execute(args: unknown, context: { signal: AbortSignal }): Promise<unknown> }
}
interface InstalledSchemas {
  signRequest(token: string, input: unknown): string
  digestJson(input: unknown): string
}
async function installed() {
  const require = createRequire(join(installedRoot!, 'package.json'))
  const tools = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/server')).href) as InstalledTools
  const schemas = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/schemas')).href) as InstalledSchemas
  const installation = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/installation')).href)
  return { tools, schemas, installation }
}
async function harness(prompt = '') {
  const plugin = await installed()
  const dir = await mkdtemp(join(tmpdir(), 'ggb-host2-')); dirs.push(dir)
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const turnId = randomUUID()
  const evidence = new PluginCoreEvidenceStore(dir)
  const runner = {
    reference: vi.fn(async (topic: string) => ({ topic, content: 'fixed bundled reference' })),
    references: vi.fn(async (topics: string[]) => plugin.installation.loadReferences(topics)),
    check: vi.fn(async (..._args: Parameters<InstalledPluginCoreRunner['check']>): Promise<PluginCoreRunResult> => ({ ok: true, check: { validation: 'structural' } })),
    build: vi.fn(async (): Promise<PluginCoreRunResult> => ({ ok: true })),
  }
  const protocol = { protocol: await loadInstalledToolProtocol(installedRoot!) }
  const server = new PluginCoreToolGatewayServer(join(dir, 'host.sock'),
    new PluginCoreGateway(runner, { evidence }), 2000, { evidence, ...protocol })
  servers.push(server); await server.listen()
  const token = server.openTurn(runId, turnId, 1, undefined, prompt)
  evidence.get(turnId)!.addSecrets(['fake-provider-secret'])
  for (const [key, value] of Object.entries({ GGB_PLUGIN_CORE_TOOL_SOCKET: server.socketPath,
    GGB_PLUGIN_CORE_TOOL_RUN_ID: runId, GGB_PLUGIN_CORE_TOOL_TURN_ID: turnId,
    GGB_PLUGIN_CORE_TOOL_EPOCH: '1', GGB_PLUGIN_CORE_TOOL_TOKEN: token })) vi.stubEnv(key, value)
  const ledger = async () => JSON.parse(await readFile(join(dir, runId, 'diagnostics', `${turnId}.json`), 'utf8'))
  return { dir, runId, turnId, evidence, runner, server, token, ledger, ...plugin }
}
async function send(path: string, value: unknown): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let text = ''
    socket.setTimeout(2000, () => socket.destroy(new Error('test_socket_timeout')))
    socket.once('connect', () => socket.write(JSON.stringify(value) + '\n'))
    socket.on('data', chunk => { text += chunk.toString() })
    socket.once('end', () => resolve(text))
    socket.once('error', reject)
  })
}
const request = { protocolVersion: 2, prompt: '', locale: 'en', plan: { requirements: [], interactions: [] } }
const context = () => ({ signal: new AbortController().signal })
async function prepare(h: Awaited<ReturnType<typeof harness>>) {
  await h.tools.createTool('ggb_request').execute({ action: 'create', locale: 'en' }, context())
  const checked = await h.tools.createTool('ggb_check').execute({ revision: 1 }, context()) as { result: { checkedRequestId: string } }
  return { checkedRequestId: checked.result.checkedRequestId }
}

describe.skipIf(!installedRoot)('installed protocol 2 to the host (no SDK turn/provider)', () => {
  it('returns all six complete references through one authenticated tool call', async () => {
    const h = await harness()
    const topics = ['request', 'program', 'verification', 'interactions', 'patterns', 'naming']
    expect(await h.tools.createTool('ggb_inspect').execute({ references: topics }, context()))
      .toEqual({ status: 'accepted', toolName: 'ggb_inspect', errors: [], result: h.installation.loadReferences(topics) })
    expect(h.runner.references).toHaveBeenCalledOnce()
    expect((await h.ledger()).calls).toHaveLength(1)
    expect(h.runner.build).not.toHaveBeenCalled()
  })
  it('authenticates one complete ordered reference batch and revokes it with the turn', async () => {
    const h = await harness()
    const args = { references: ['request', 'verification', 'request'] }
    const result = await h.tools.createTool('ggb_inspect').execute(args, context())
    expect(result).toEqual({ status: 'accepted', toolName: 'ggb_inspect', errors: [],
      result: h.installation.loadReferences(args.references) })
    expect(h.runner.references).toHaveBeenCalledOnce()
    expect(h.runner.reference).not.toHaveBeenCalled()
    expect((await h.ledger()).calls[0]).toMatchObject({ arguments: args, operation: 'reference', stage: 'accepted' })
    for (const bad of [{ references: [] }, { references: ['../run.json'] },
      { references: Array(7).fill('request') }, { reference: 'request', references: ['request'] }]) {
      await expect(h.tools.createTool('ggb_inspect').execute(bad, context())).rejects.toThrow()
    }
    expect(h.runner.references).toHaveBeenCalledOnce()
    h.server.closeTurn(h.turnId)
    await expect(h.tools.createTool('ggb_inspect').execute(args, context())).rejects.toThrow('unauthorized')
  })

  it('rejects an oversized batch without truncation and permits a smaller next read', async () => {
    const h = await harness()
    h.runner.references.mockRejectedValueOnce(new Error('ggb_reference_response_oversized'))
    expect(await h.tools.createTool('ggb_inspect').execute({ references: ['request'] }, context()))
      .toMatchObject({ status: 'rejected', result: null, errors: [{ code: 'reference_limit_exceeded' }] })
    expect((await h.ledger()).calls[0]).toMatchObject({ stage: 'rejected',
      error: { message: 'ggb_reference_response_oversized' } })
    expect(await h.tools.createTool('ggb_inspect').execute({ references: ['request'] }, context()))
      .toMatchObject({ status: 'accepted', result: { references: [{ topic: 'request', content: expect.any(String) }] } })
  })

  it('returns real executor check arity details to the tool and accepts a corrected revision', async () => {
    const h = await harness('Create point P')
    const root = join(h.dir, 'execution')
    const runner = await InstalledPluginCoreRunner.load({ pluginRoot: installedRoot!, outputRoot: root,
      packageIntegrity: 'a'.repeat(64), state: new PluginCoreExecutionState(root) })
    h.runner.check.mockImplementation((...args) => runner.check(...args))
    const body = { plan: { program: [{ id: 'P', source: 'P=(1,0)' }], interactions: [],
      requirements: [{ id: 'point', source: 'point P', checks: [{ kind: 'exists', subjects: ['P', 'P'], scope: 'initial' }] }] } }
    const saved = await h.tools.createTool('ggb_request').execute({ requestText: JSON.stringify(body) }, context()) as { result: { revision: number } }
    expect(await h.tools.createTool('ggb_check').execute({ revision: saved.result.revision }, context()))
      .toMatchObject({ status: 'rejected', errors: [{ code: 'invalid_input', details: { checkId: 'point:0',
        kind: 'exists', subjects: ['P', 'P'], expectedSubjectCount: 1, actualSubjectCount: 2 } }] })
    body.plan.requirements[0]!.checks[0]!.subjects = ['P']
    const repaired = await h.tools.createTool('ggb_request').execute({ requestText: JSON.stringify(body) }, context()) as { result: { revision: number } }
    expect(await h.tools.createTool('ggb_check').execute({ revision: repaired.result.revision }, context()))
      .toMatchObject({ status: 'accepted', result: { checkedRequestId: expect.any(String) } })
    expect(h.runner.build).not.toHaveBeenCalled()
  })
  it('keeps executing authenticated tools after the call evidence budget is full', async () => {
    const h = await harness()
    for (let i = 0; i < 70; i++) {
      expect(await h.tools.createTool('ggb_inspect').execute({ reference: 'patterns' }, context()))
        .toMatchObject({ status: 'accepted' })
    }
    const ledger = await h.ledger()
    expect(h.runner.reference).toHaveBeenCalledTimes(70)
    expect(ledger.calls).toHaveLength(64)
    expect(ledger).toMatchObject({ callLimitReached: true, callsDropped: 6 })
    expect(ledger.calls[63]).toMatchObject({ stage: 'accepted', sdkCorrelation: 'unavailable', correlationLimited: true })
    expect(h.evidence.get(h.turnId)!.truncated).toBe(true)
  })
  it('authenticates and audits fixed reference topics without requiring a base', async () => {
    const h = await harness()
    const args = { reference: 'patterns' }
    h.evidence.get(h.turnId)!.notification({ method: 'session.event', params: {
      sessionId: h.turnId, event: { type: 'tool/call', data: { callId: 'sdk-reference',
        name: 'ggb_inspect', arguments: JSON.stringify(args) } },
    } })
    expect(await h.tools.createTool('ggb_inspect').execute(args, context()))
      .toMatchObject({ status: 'accepted', result: { topic: 'patterns', content: 'fixed bundled reference' } })
    expect(h.runner.reference).toHaveBeenCalledWith('patterns')
    expect((await h.ledger()).calls[0]).toMatchObject({ stage: 'accepted',
      arguments: args, sdkCallId: 'sdk-reference', sdkCorrelation: 'matched', operation: 'reference' })
    for (const reference of ['../run.json', '/etc/passwd', 'https://example.com']) {
      await expect(h.tools.createTool('ggb_inspect').execute({ reference }, context())).rejects.toThrow()
    }
    expect(h.runner.reference).toHaveBeenCalledTimes(1)
    h.server.closeTurn(h.turnId)
    await expect(h.tools.createTool('ggb_inspect').execute(args, context())).rejects.toThrow()
  })
  it('unwraps the real plugin request and correlates actual SDK identity without equating it', async () => {
    const h = await harness()
    await h.tools.createTool('ggb_request').execute({ action: 'create', locale: 'en' }, context())
    h.evidence.get(h.turnId)!.notification({ method: 'session.event', params: {
      sessionId: h.turnId, event: { type: 'tool/call', data: { turn: 1, step: 1,
        callId: 'sdk-real-call', name: 'ggb_check', arguments: JSON.stringify({ revision: 1 }) } },
    } })
    expect(await h.tools.createTool('ggb_check').execute({ revision: 1 }, context()))
      .toMatchObject({ status: 'accepted', result: { validation: 'structural' } })
    expect(h.runner.check).toHaveBeenCalledWith(request, h.runId, expect.any(AbortSignal), undefined, expect.objectContaining({ toolName: 'ggb_check' }))
    const value = await h.ledger()
    expect(value.calls.find((c: { toolName: string }) => c.toolName === 'ggb_check')).toMatchObject({ stage: 'accepted', protocolVersion: 3,
      arguments: { revision: 1 }, sdkCallId: 'sdk-real-call', sdkCorrelation: 'matched',
      pluginResult: { ok: true, check: { validation: 'structural' } } })
    expect(value.calls.find((c: { toolName: string }) => c.toolName === 'ggb_check').toolCallId).not.toBe('sdk-real-call')
    expect(value.calls.find((c: { toolName: string }) => c.toolName === 'ggb_check').requestId).toMatch(/^[a-f0-9-]{36}$/)
  })

  it('revokes the capability immediately but drains admitted work before returning', async () => {
    const h = await harness()
    let admitted!: () => void
    const started = new Promise<void>(done => { admitted = done })
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    h.runner.build.mockImplementation(async () => {
      admitted(); await gate
      return { ok: false, error: { code: 'plugin_runner_cancelled', message: 'cancelled' } }
    })
    const checked = await prepare(h)
    const call = h.tools.createTool('ggb_build').execute(checked, context())
    await started
    let cleaned = false
    const draining = h.server.drainTurn(h.turnId).then(() => { cleaned = true })
    await expect(h.tools.createTool('ggb_check').execute({ revision: 1 }, context())).rejects.toThrow('unauthorized')
    expect(cleaned).toBe(false)
    release(); await draining; await call
    expect(cleaned).toBe(true)
  })

  it('does not report cleanup success when an admitted tool ignores cancellation', async () => {
    const h = await harness()
    let admitted!: () => void
    const started = new Promise<void>(done => { admitted = done })
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    h.runner.build.mockImplementation(async () => { admitted(); await gate; return { ok: false } })
    const checked = await prepare(h)
    const call = h.tools.createTool('ggb_build').execute(checked, context())
    await started
    await expect(h.server.drainTurn(h.turnId, 25)).rejects.toThrow('plugin_core_cleanup_failed')
    release(); await call
  })

  it('preserves specific refusal issues privately and keeps feedback short and secret/path free', async () => {
    const h = await harness()
    h.runner.build.mockResolvedValue({ ok: false, error: { code: 'plugin_build_rejected',
      message: 'bad label in /server/private/request.json fake-provider-secret', details: {
        issues: [{ code: 'bad_label', path: 'plan.program[0]', message: 'choose another label' }],
        stderrTail: 'fake-provider-secret details', authentication: h.token,
      } } })
    const checked = await prepare(h)
    const result = await h.tools.createTool('ggb_build').execute(checked, context())
    const text = JSON.stringify(result)
    expect(text).not.toContain('fake-provider-secret')
    expect(text).not.toContain(h.token)
    expect(text).not.toContain('/server/private')
    expect(text).not.toContain('stderrTail')
    expect(result).toMatchObject({ status: 'rejected', errors: [{ details: {
      issues: [{ code: 'bad_label', path: 'plan.program[0]' }],
    } }] })
    const value = await h.ledger()
    expect(value.calls.find((c: { toolName: string }) => c.toolName === 'ggb_build').buildId).toMatch(/^[a-f0-9-]{36}$/)
    expect(value.calls.find((c: { toolName: string }) => c.toolName === 'ggb_build').pluginResult.error.details.issues[0].message).toBe('choose another label')
    expect(JSON.stringify(value)).not.toContain('fake-provider-secret')
  })

  it('retains the underlying exception but sends only internal_error to the plugin', async () => {
    const h = await harness()
    await h.tools.createTool('ggb_request').execute({ action: 'create', locale: 'en' }, context())
    h.runner.check.mockRejectedValue(Object.assign(new Error('specific socket failure fake-provider-secret'), { code: 'EPIPE' }))
    await expect(h.tools.createTool('ggb_check').execute({ revision: 1 }, context()))
      .rejects.toThrow('ggb_host_error:internal_error')
    expect((await h.ledger()).calls.at(-1)).toMatchObject({ stage: 'failed', error: {
      code: 'EPIPE', message: 'specific socket failure [redacted]',
    } })
    expect(h.runner.check).toHaveBeenCalledOnce()
  })

  it('rejects stale epochs, bad signatures and duplicate request IDs without repeated effects', async () => {
    const h = await harness()
    await h.tools.createTool('ggb_request').execute({ action: 'create', locale: 'en' }, context())
    const args = { revision: 1 }
    const base = { protocolVersion: 3, runId: h.runId, turnId: h.turnId, epoch: 1,
      requestId: randomUUID(), toolCallId: randomUUID(), issuedAt: new Date().toISOString(),
      nonce: 'a'.repeat(32), toolName: 'ggb_check', arguments: args,
      argumentsDigest: h.schemas.digestJson(args) }
    const wire = (value: unknown, token = h.token) => ({ ...value as object,
      authentication: h.schemas.signRequest(token, value) })
    expect(JSON.parse(await send(h.server.socketPath, wire(base))).type).toBe('tool.result')
    expect(JSON.parse(await send(h.server.socketPath, wire({ ...base, nonce: 'b'.repeat(32) }))).error)
      .toBe('duplicate_request')
    expect(JSON.parse(await send(h.server.socketPath, wire({ ...base, requestId: randomUUID(), epoch: 2 }))).error)
      .toBe('unauthorized')
    expect(JSON.parse(await send(h.server.socketPath, wire({ ...base, requestId: randomUUID() }, 'c'.repeat(64)))).error)
      .toBe('unauthorized')
    expect(h.runner.check).toHaveBeenCalledOnce()
  })

  it('serializes concurrent builds and enforces the shared three-build budget', async () => {
    const h = await harness()
    let active = 0
    let maxActive = 0
    h.runner.build.mockImplementation(async () => {
      active += 1; maxActive = Math.max(maxActive, active)
      await new Promise(done => setTimeout(done, 5))
      active -= 1; return { ok: true }
    })
    const checked = await prepare(h)
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      h.tools.createTool('ggb_build').execute(checked, context())))
    expect(results.filter(result => (result as { status: string }).status === 'rejected'))
      .toEqual([expect.objectContaining({ errors: [{ code: 'build_limit_reached', message: expect.any(String) }] })])
    expect(h.runner.build).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1)
    expect((await h.ledger()).calls.filter((c: { toolName: string }) => c.toolName === 'ggb_build')).toHaveLength(4)
  })

  it('does not execute when the evidence destination fails', async () => {
    const h = await harness()
    await writeFile(join(h.dir, h.runId), 'force mkdir failure')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(h.tools.createTool('ggb_check').execute({ revision: 1 }, context()))
      .rejects.toThrow('ggb_host_error:internal_error')
    expect(h.runner.check).not.toHaveBeenCalled()
  })

})

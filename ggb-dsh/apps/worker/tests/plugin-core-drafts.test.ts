import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIdSchema, toolArgumentsDigest } from '@ggb-copilot/application'
import { installedRoot, installedSchemas, toolProtocol } from './fixtures/installed-plugin.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { InstalledPluginCoreRunner } from '../src/plugin-core/installed-runner.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'

type Tool = 'ggb_request' | 'ggb_check' | 'ggb_build'
interface Result { status: string; result: Record<string, unknown> | null; errors: { code: string }[] }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(prompt = 'Create point P and number n') {
  const root = await mkdtemp(join(tmpdir(), 'small-json-'))
  const runId = runIdSchema.parse(`run_${randomUUID()}`)
  const state = new PluginCoreExecutionState(root)
  const actual = await InstalledPluginCoreRunner.load({ pluginRoot: installedRoot, outputRoot: root,
    packageIntegrity: 'a'.repeat(64), state })
  const build = vi.fn(async (_request: unknown) => ({ ok: false, error: { code: 'verification_failed', message: 'offline fixture' } }))
  const check = vi.fn(actual.check.bind(actual))
  const server = new PluginCoreToolGatewayServer(join(root, 'tools.sock'),
    new PluginCoreGateway({ check, build }, { state }), 3000, { protocol: toolProtocol })
  await server.listen()
  cleanup.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })
  const turnId = randomUUID()
  const token = server.openTurn(runId, turnId, 1, undefined, prompt)
  const argumentsBytes: number[] = []
  async function call(toolName: Tool, args: unknown, turn = turnId, capability = token): Promise<Result> {
    argumentsBytes.push(Buffer.byteLength(JSON.stringify(args)))
    const unsigned = { protocolVersion: 3, runId, turnId: turn, epoch: 1, toolName, arguments: args,
      requestId: randomUUID(), toolCallId: randomUUID(), issuedAt: new Date().toISOString(),
      nonce: randomUUID().replaceAll('-', ''), argumentsDigest: toolArgumentsDigest(args) }
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(server.socketPath)
      let text = ''
      socket.on('error', reject)
      socket.setTimeout(3000, () => socket.destroy(new Error('fixture_socket_timeout')))
      socket.once('connect', () => socket.write(JSON.stringify({ ...unsigned,
        authentication: installedSchemas.signRequest(capability, unsigned) }) + '\n'))
      socket.on('data', data => { text += data.toString() })
      socket.on('end', () => resolve(text))
    })
    const parsed = installedSchemas.parseToolResponse(JSON.parse(response))
    if (parsed.type === 'tool.error') throw new Error(parsed.error)
    return parsed.result as Result
  }
  async function save() {
    await call('ggb_request', { action: 'create', locale: 'en' })
    await call('ggb_request', { action: 'append', revision: 1, section: 'program', items: [
      { id: 'P', source: 'P=(0,0)', initial: [1,2] }, { id: 'n', source: '2+3', mode: 'cas' },
    ] })
    await call('ggb_request', { action: 'append', revision: 2, section: 'requirements',
      items: [{ id: 'point', source: 'Create point P and number n' }] })
    await call('ggb_request', { action: 'append', revision: 3, section: 'checks', items: [
      { requirementId: 'point', kind: 'coordinate', subjects: ['P'], scope: 'initial', coordinates: [1,2] },
      { requirementId: 'point', kind: 'expression', subjects: ['n'], scope: 'initial',
        expression: 'n', mode: 'algebra', expected: 5 },
    ] })
  }
  return { call, save, check, build, server, runId, argumentsBytes }
}

it('checks a complete assembled request with the public executor, then builds the exact checked bytes', async () => {
  const f = await fixture(); await f.save()
  const checked = await f.call('ggb_check', { revision: 4 })
  expect(checked.status).toBe('accepted')
  expect(checked.result?.checkedRequestId).toEqual(expect.any(String))
  await f.call('ggb_build', { checkedRequestId: checked.result!.checkedRequestId })
  const request = f.check.mock.calls[0]![0]
  expect(f.build.mock.calls[0]![0]).toEqual(request)
  expect(toolArgumentsDigest(request)).toBe(checked.result!.domainRequestDigest)
  expect(request).toMatchObject({ protocolVersion: 2, prompt: 'Create point P and number n', plan: {
    program: [{ op: 'native', initial: [1,2] }, { mode: 'cas', source: '2+3' }],
    requirements: [{ checks: [{ coordinates: [1,2] }, { expected: 5 }] }],
  } })
  expect(f.argumentsBytes.every(bytes => bytes <= 2048)).toBe(true)
})

it('rejects an unchecked or stale handle without consuming a build; edits preserve unrelated values', async () => {
  const f = await fixture(); await f.save()
  const checked = await f.call('ggb_check', { revision: 4 })
  await f.call('ggb_request', { action: 'replace', revision: 4, section: 'program', index: 0,
    items: [{ id: 'P', source: 'P=(0,0)', initial: [3,4] }] })
  expect(await f.call('ggb_build', { checkedRequestId: checked.result!.checkedRequestId }))
    .toMatchObject({ status: 'rejected', errors: [{ code: 'draft_check_required' }] })
  expect(f.build).not.toHaveBeenCalled()
  await f.call('ggb_request', { action: 'replace', revision: 5, section: 'checks', index: 0, items: [
    { requirementId: 'point', kind: 'coordinate', subjects: ['P'], scope: 'initial', coordinates: [3,4] },
  ] })
  const next = await f.call('ggb_check', { revision: 6 })
  expect(next.status).toBe('accepted')
  expect(next.result!.domainRequestDigest).not.toBe(checked.result!.domainRequestDigest)
  expect(f.check.mock.calls[1]![0]).toMatchObject({ plan: { requirements: [{ checks: [
    { coordinates: [3,4] }, { expected: 5 },
  ] }] } })
})

it('serializes conflicting revisions and isolates checked IDs across authenticated turns', async () => {
  const f = await fixture(); await f.save()
  const results = await Promise.all([1, 2].map(value => f.call('ggb_request', { action: 'append',
    revision: 4, section: 'program', items: [{ id: `Q${value}`, source: `Q${value}=(1,1)` }] })))
  expect(results.filter(r => r.status === 'accepted')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ errors: [{ code: 'draft_revision_conflict' }] }])
  const checked = await f.call('ggb_check', { revision: 5 })
  const otherTurn = randomUUID()
  const token = f.server.openTurn(f.runId, otherTurn, 1, undefined, 'same run, other turn')
  expect(await f.call('ggb_build', { checkedRequestId: checked.result!.checkedRequestId }, otherTurn, token))
    .toMatchObject({ status: 'rejected', errors: [{ code: 'draft_check_required' }] })
  f.server.closeTurn(otherTurn)
  await expect(f.call('ggb_check', { revision: 5 }, otherTurn, token)).rejects.toThrow('unauthorized')
  expect(f.build).not.toHaveBeenCalled()
})

it('does not issue a build handle when the full checker rejects missing requirements', async () => {
  const f = await fixture()
  await f.call('ggb_request', { action: 'create', locale: 'en' })
  const rejected = await f.call('ggb_check', { revision: 1 })
  expect(rejected.status).toBe('rejected')
  expect(rejected.result?.checkedRequestId).toBeUndefined()
  expect(await f.call('ggb_build', { checkedRequestId: randomUUID() })).toMatchObject({ status: 'rejected' })
  expect(f.build).not.toHaveBeenCalled()
})

it('does not invent expected values or waive sampled checks after local edits', async () => {
  const f = await fixture(); await f.save()
  const first = await f.call('ggb_check', { revision: 4 })
  await f.call('ggb_request', { action: 'replace', revision: 4, section: 'checks', index: 1, items: [
    { requirementId: 'point', kind: 'expression', subjects: ['n'], scope: 'initial', expression: 'n', mode: 'algebra' },
  ] })
  expect((await f.call('ggb_check', { revision: 5 })).status).toBe('rejected')
  expect((await f.call('ggb_build', { checkedRequestId: first.result!.checkedRequestId })).status).toBe('rejected')
  await f.call('ggb_request', { action: 'replace', revision: 5, section: 'checks', index: 1, items: [
    { requirementId: 'point', kind: 'expression', subjects: ['n'], scope: 'sampled', expression: 'n', mode: 'algebra', expected: 5 },
  ] })
  expect((await f.call('ggb_check', { revision: 6 })).status).toBe('rejected')
  expect(f.build).not.toHaveBeenCalled()
})

it('keeps image transcription in small blocks and validates source against the assembled problem', async () => {
  const f = await fixture('Draw the image')
  await f.call('ggb_request', { action: 'create', locale: 'en' })
  await f.call('ggb_request', { action: 'append', revision: 1, section: 'transcription', items: ['Create point P'] })
  await f.call('ggb_request', { action: 'append', revision: 2, section: 'program', items: [{ id: 'P', source: 'P=(0,0)' }] })
  await f.call('ggb_request', { action: 'append', revision: 3, section: 'requirements', items: [{ id: 'point', source: 'Create point P' }] })
  await f.call('ggb_request', { action: 'append', revision: 4, section: 'checks', items: [
    { requirementId: 'point', kind: 'exists', subjects: ['P'], scope: 'initial' },
  ] })
  expect((await f.call('ggb_check', { revision: 5 })).status).toBe('accepted')
  expect(f.check.mock.calls[0]![0]).toMatchObject({ prompt: 'Draw the image\nCreate point P' })
  expect(f.argumentsBytes.every(bytes => bytes <= 2048)).toBe(true)
})


it('keeps a recoverable draft error code separate from its human message', async () => {
  const f = await fixture()
  expect(await f.call('ggb_request', { requestText: '{' })).toMatchObject({
    status: 'rejected', errors: [{ code: 'draft_request_json', message: 'requestText is not valid JSON' }],
  })
  await f.save()
  expect((await f.call('ggb_check', { revision: 4 })).status).toBe('accepted')
  expect(f.build).not.toHaveBeenCalled()
})

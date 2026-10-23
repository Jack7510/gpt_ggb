import { expect, it } from 'vitest'
import { verificationProgramV1Schema, verificationProgramIssuesV1, nativeGeometryQueryV1Schema,
  nativeGeometryQueryResultV1Schema, canvasVersionSchema } from '@ggb-copilot/geometry-contract'
import { runNativeGeometryQueriesV1, evaluateVerificationProgramV1, type RestrictedGeoGebraApiV1 } from '../src/index.js'

const program = verificationProgramV1Schema.parse({ calls: [{ command: 'Distance', arguments: [
  { kind: 'subject', index: 0 }, { kind: 'subject', index: 1 }] }], result: { index: 0, test: 'zero' } })
const version = canvasVersionSchema.parse('canvas_00000000-0000-4000-8000-000000000001')
const query = nativeGeometryQueryV1Schema.parse({ queryId: 'assert_path', kind: 'verificationProgram', program,
  expected: true, scope: 'single_observation', subjects: [
    { objectId: 'obj_00000000-0000-4000-8000-000000000001', label: 'P' },
    { objectId: 'obj_00000000-0000-4000-8000-000000000002', label: 'l' }] })

it('rejects scripts, cycles, unused subjects, wrong types and scope inflation', () => {
  expect(verificationProgramV1Schema.safeParse({ ...program, script: 'Delete(P)' }).success).toBe(false)
  expect(verificationProgramV1Schema.safeParse({ ...program, calls: [{ command: 'SetValue', arguments: [] }] }).success).toBe(false)
  expect(verificationProgramV1Schema.safeParse({ ...program, calls: [{ command: 'Distance', arguments: [
    { kind: 'result', index: 0 }, { kind: 'subject', index: 1 }] }] }).success).toBe(false)
  expect(verificationProgramIssuesV1(program, ['line', 'point'], true, 'single_observation')).toContain('verification_argument_type_mismatch')
  expect(verificationProgramIssuesV1(program, ['point', 'line', 'point'], true, 'single_observation')).toContain('verification_subject_not_checked')
  expect(verificationProgramIssuesV1(program, ['point', 'line'], true, 'finite_samples')).toContain('verification_scope_not_supported')
})

it.each(['line', 'ellipse'])('executes a generated path test on an isolated %s snapshot', async kind => {
  const commands: string[] = []
  const created = new Set<string>()
  let disposed = false
  const api: RestrictedGeoGebraApiV1 = {
    setXML: xml => { expect(xml).toBe('result-snapshot') }, getXML: () => 'result-snapshot', evalCommand: () => false,
    exists: label => ['P', 'l'].includes(label) || created.has(label), isDefined: () => true,
    getObjectType: label => label === 'P' ? 'point' : label === 'l' ? kind : 'numeric',
    evalCommandGetLabels: command => { commands.push(command); const label = command.split('=')[0]!; created.add(label); return label },
    getValue: () => 0,
  }
  const results = await runNativeGeometryQueriesV1({ queries: [query], xml: 'result-snapshot', canvasVersion: version,
    versionOf: async () => version, signal: new AbortController().signal,
    factory: async () => ({ api, dispose: () => { disposed = true } }) })
  expect(commands).toEqual(['GgbQuery1=Distance[P,l]'])
  expect(evaluateVerificationProgramV1(results[0]!)).toMatchObject({ outcome: 'passed' })
  expect(disposed).toBe(true)
})

it('composes primitives and covers all subjects through the final dependency graph', () => {
  const composed = verificationProgramV1Schema.parse({ calls: [
    { command: 'Midpoint', arguments: [{ kind: 'subject', index: 1 }, { kind: 'subject', index: 2 }] },
    { command: 'AreEqual', arguments: [{ kind: 'subject', index: 0 }, { kind: 'result', index: 0 }] },
  ], result: { index: 1, test: 'boolean' } })
  expect(verificationProgramIssuesV1(composed, ['point', 'point', 'point'], true, 'single_observation')).toEqual([])
  const result = nativeGeometryQueryResultV1Schema.parse({ query: { ...query, program: composed,
    subjects: [...query.subjects, { objectId: 'obj_00000000-0000-4000-8000-000000000003', label: 'B' }] },
    method: 'geogebra-verification-program-v1', sourceCanvasVersion: version, values: [null, false], reason: null })
  expect(evaluateVerificationProgramV1(result)).toMatchObject({ outcome: 'failed' })
})

it.each([[0, 'passed'], [1, 'failed'], [1e-8, 'unverified']] as const)('classifies distance %s as %s', (distance, outcome) => {
  const result = nativeGeometryQueryResultV1Schema.parse({ query, sourceCanvasVersion: version,
    method: 'geogebra-verification-program-v1', values: [distance], reason: null })
  expect(evaluateVerificationProgramV1(result)).toMatchObject({ outcome })
})

it('retains missing and stale query evidence as unknown', async () => {
  const results = await runNativeGeometryQueriesV1({ queries: [query], xml: 'result-snapshot', canvasVersion: version,
    versionOf: async () => version, signal: new AbortController().signal })
  expect(evaluateVerificationProgramV1(results[0]!)).toMatchObject({ outcome: 'unverified', reason: 'query_unavailable' })
})

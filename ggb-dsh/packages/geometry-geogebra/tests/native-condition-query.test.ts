import { expect, it } from 'vitest'
import { canvasVersionSchema, nativeGeometryQueryV1Schema, nativeGeometryQueryResultV1Schema } from '@ggb-copilot/geometry-contract'
import { evaluateNativeConditionV1, runNativeGeometryQueriesV1, type RestrictedGeoGebraApiV1 } from '../src/index.js'

const version = canvasVersionSchema.parse('canvas_11111111-1111-4111-8111-111111111111')
const subject = (label: string) => ({ label, objectId: label === 'c'
  ? 'obj_11111111-1111-4111-8111-111111111111' : 'obj_22222222-2222-4222-8222-222222222222' })
const equation = nativeGeometryQueryV1Schema.parse({ kind: 'hasEquation', queryId: 'assert_equation',
  subjects: [subject('c')], expected: 'x^2/9+y^2/5=1' })
const incidence = nativeGeometryQueryV1Schema.parse({ kind: 'pointOnConic', queryId: 'assert_incidence',
  subjects: [subject('P'), subject('c')] })

it.each([true, false, null])('measures frozen equation equality in an isolated snapshot: %s', async equal => {
  const created = new Map<string, string>()
  const calls: string[] = []
  let disposed = false
  const api: RestrictedGeoGebraApiV1 = { setXML: () => {},
    evalCommandGetLabels: command => { calls.push(command); const split = command.indexOf('=');
      const label = command.slice(0, split); created.set(label, command.slice(split + 1)); return label },
    exists: label => label === 'c' || created.has(label), isDefined: label => equal !== null || !created.get(label)?.startsWith('AreEqual'),
    getObjectType: label => created.get(label)?.startsWith('AreEqual') ? 'boolean'
      : created.get(label)?.startsWith('Area') ? 'numeric' : 'ellipse',
    getValue: label => created.get(label)?.startsWith('Area') ? 15 : equal ? 1 : 0 }
  const results = await runNativeGeometryQueriesV1({ queries: [equation], xml: 'frozen snapshot', canvasVersion: version,
    signal: new AbortController().signal, versionOf: async () => version, factory: async () => ({ api, dispose: () => { disposed = true } }) })
  expect(calls).toEqual(['GgbQuery1=x^2/9+y^2/5=1', 'GgbQuery2=Area[c]',
    'GgbQuery3=Area[GgbQuery1]', 'GgbQuery4=AreEqual[c,GgbQuery1]'])
  expect(evaluateNativeConditionV1(results[0]!).outcome).toBe(equal === null ? 'unverified' : equal ? 'passed' : 'failed')
  expect(disposed).toBe(true)
})

it.each([[0, 'passed'], [1e-8, 'unverified'], [0.1, 'failed']] as const)('keeps incidence precision boundaries: %s', (distance, outcome) => {
  const result = nativeGeometryQueryResultV1Schema.parse({ query: incidence, sourceCanvasVersion: version,
    method: 'geogebra-point-conic-distance-v1', distance, reason: null })
  expect(evaluateNativeConditionV1(result).outcome).toBe(outcome)
})

it('executes Distance only for defined point/conic subjects, and rejects unsafe expected equations', async () => {
  const commands: string[] = []
  const api: RestrictedGeoGebraApiV1 = { setXML: () => {},
    evalCommandGetLabels: command => { commands.push(command); return command.split('=')[0]! },
    exists: label => ['P', 'c'].includes(label) || commands.some(command => command.startsWith(`${label}=`)), isDefined: () => true,
    getObjectType: label => label === 'P' ? 'point' : label === 'c' ? 'ellipse' : 'numeric', getValue: () => 0 }
  const input = { queries: [incidence], xml: 'frozen', canvasVersion: version,
    signal: new AbortController().signal, versionOf: async () => version }
  const rows = await runNativeGeometryQueriesV1({ ...input, factory: async () => ({ api, dispose: () => {} }) })
  expect(commands).toEqual(['GgbQuery1=Distance[P,c]'])
  expect(evaluateNativeConditionV1(rows[0]!).outcome).toBe('passed')
  expect((await runNativeGeometryQueriesV1(input))[0]!.reason).toBe('query_unavailable')
  expect(nativeGeometryQueryV1Schema.safeParse({ ...equation, expected: 'x=0\nDelete(c)' }).success).toBe(false)
  const bad = { ...api, getObjectType: () => 'segment' }
  expect((await runNativeGeometryQueriesV1({ ...input, factory: async () => ({ api: bad, dispose: () => {} }) }))[0]!.reason)
    .toBe('unsupported_object')
})


it('does not approve degenerate ellipse references even when native equality would report true', async () => {
  const created = new Map<string, string>()
  const api: RestrictedGeoGebraApiV1 = { setXML: () => {},
    exists: label => label === 'c' || created.has(label), isDefined: () => true,
    evalCommandGetLabels: command => { const i = command.indexOf('=');
      created.set(command.slice(0, i), command.slice(i + 1)); return command.slice(0, i) },
    getObjectType: label => created.get(label)?.startsWith('Area') ? 'numeric' : 'ellipse', getValue: () => 0 }
  const rows = await runNativeGeometryQueriesV1({ queries: [equation], xml: 'frozen', canvasVersion: version,
    signal: new AbortController().signal, versionOf: async () => version, factory: async () => ({ api, dispose: () => {} }) })
  expect(rows[0]!.reason).toBe('unsupported_object')
  expect(evaluateNativeConditionV1(rows[0]!).outcome).toBe('unverified')
  expect([...created.values()].some(expression => expression.startsWith('AreEqual'))).toBe(false)
})

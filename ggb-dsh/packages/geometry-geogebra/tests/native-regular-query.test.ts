import { describe, expect, it } from 'vitest'
import { canvasVersionSchema, nativeGeometryQueryV1Schema, nativeGeometryQueryResultV1Schema,
  type NativeGeometryQueryResultV1 } from '@ggb-copilot/geometry-contract'
import { evaluateNativeRegularPolygonV1, runNativeGeometryQueriesV1, type RestrictedGeoGebraApiV1 } from '../src/index.js'

const version = canvasVersionSchema.parse('canvas_00000000-0000-4000-8000-000000000001')
const query = nativeGeometryQueryV1Schema.options[1].parse({ queryId: 'assert_regular', kind: 'regularPolygon',
  subjects: [{ objectId: 'obj_00000000-0000-4000-8000-000000000001', label: 'poly' }] })
type Result = Extract<NativeGeometryQueryResultV1, { method: 'geogebra-regular-reference-v1' }>
const record = (fields: Partial<Result> = {}): Result => nativeGeometryQueryResultV1Schema.parse({ query, sourceCanvasVersion: version,
  method: 'geogebra-regular-reference-v1', vertexCount: 5, area: 3, sideLength: 1, referenceAreas: [3, 3],
  referenceMatches: [true, false], forwardDistances: [0, 0, 0, 0, 0], reverseDistances: [0, 0, 1, 1, 1], reason: null, ...fields }) as Result

describe('native regular-polygon reference queries', () => {
  it.each([3, 4, 5, 6, 11, 128])('accepts a complete match with %s vertices in either direction', count => {
    for (const reverse of [false, true]) expect(evaluateNativeRegularPolygonV1(record({ vertexCount: count,
      referenceMatches: reverse ? [false, true] : [true, false],
      forwardDistances: Array(count).fill(reverse ? 1 : 0), reverseDistances: Array(count).fill(reverse ? 0 : 1),
    })).outcome).toBe('passed')
  })
  it('requires both native inequality and reliable geometric deviations to reject', () => {
    expect(evaluateNativeRegularPolygonV1(record({ referenceMatches: [false, false],
      forwardDistances: [0, null, 1], reverseDistances: [0, 0, 1] })).outcome).toBe('failed')
    for (const fields of [
      { referenceMatches: [null, false] }, { area: 0 }, { sideLength: 0 },
      { referenceAreas: [0, 3] }, { forwardDistances: [0, 0, 0] },
      { referenceMatches: [false, false], forwardDistances: [0, 0, 1e-8] },
      { reason: 'query_failed' }, { area: null }, { forwardDistances: [0, null, 0, 0, 0] },
    ]) expect(evaluateNativeRegularPolygonV1(record(fields as Partial<Result>)).outcome).toBe('unverified')
  })
  it('captures typed Boolean false, multi-output references and native measurements without coordinate reads', async () => {
    const created = new Map<string, string>()
    const calls: string[] = []
    const references: string[] = []
    let disposed = false
    const api: RestrictedGeoGebraApiV1 = {
      setXML: () => {}, getXML: () => '', evalCommand: () => false,
      exists: label => label === 'poly' || created.has(label), isDefined: () => true,
      getObjectType: label => label === 'poly' || references.includes(label) ? 'polygon'
        : created.get(label)?.startsWith('{') ? 'list' : created.get(label)?.startsWith('AreEqual') ? 'boolean' : 'numeric',
      evalCommandGetLabels: command => {
        calls.push(command)
        const [label, expression] = command.split('=')
        created.set(label!, expression!)
        if (expression!.startsWith('Polygon')) { references.push(label!); return `${label},side1,side2,side3` }
        return label!
      },
      getValue: label => created.get(label)?.startsWith('Length') ? 5
        : created.get(label)?.startsWith('Area') ? 3
          : created.get(label)?.startsWith('AreEqual') ? Number(created.get(label)?.includes(references[0]!))
            : created.get(label)?.includes(`Vertex[${references[1]},`) ? 1
              : created.get(label) === 'Distance[Vertex[poly,1],Vertex[poly,2]]' ? 1 : 0,
    }
    const result = await runNativeGeometryQueriesV1({ queries: [query], xml: '', canvasVersion: version,
      factory: async () => ({ api, dispose: () => { disposed = true } }), versionOf: async () => version,
      signal: new AbortController().signal })
    expect(result[0]).toMatchObject({ referenceMatches: [true, false], vertexCount: 5 })
    expect(evaluateNativeRegularPolygonV1(result[0]!).outcome).toBe('passed')
    expect(calls.some(command => command.includes('Polygon[Vertex[poly,2],Vertex[poly,1],5]'))).toBe(true)
    expect(calls.some(command => command.includes(`Distance[Vertex[poly,3],Vertex[${references[1]},5]]`))).toBe(true)
    expect(disposed).toBe(true)
    api.isDefined = label => !created.get(label)?.startsWith('AreEqual')
    const missing = await runNativeGeometryQueriesV1({ queries: [query], xml: '', canvasVersion: version,
      factory: async () => ({ api, dispose: () => {} }), versionOf: async () => version, signal: new AbortController().signal })
    expect(missing[0]).toMatchObject({ referenceMatches: [null, null] })
    expect(evaluateNativeRegularPolygonV1(missing[0]!).outcome).toBe('unverified')
  })
})

import { describe, expect, it } from 'vitest'
import { canvasVersionSchema, geometryObjectIdSchema, nativeGeometryQueryV1Schema,
  nativeGeometryQueryResultV1Schema } from '@ggb-copilot/geometry-contract'
import { evaluateNativePolygonOnCircleV1, runNativeGeometryQueriesV1,
  type RestrictedGeoGebraApiV1 } from '../src/index.js'

const version = canvasVersionSchema.parse('canvas_00000000-0000-4000-8000-000000000001')
const query = nativeGeometryQueryV1Schema.options[0].parse({ queryId: 'assert_polygon', kind: 'polygonOnCircle', subjects: [
  { objectId: geometryObjectIdSchema.parse('obj_00000000-0000-4000-8000-000000000001'), label: 'poly' },
  { objectId: geometryObjectIdSchema.parse('obj_00000000-0000-4000-8000-000000000002'), label: 'c' },
] })
const record = (distances: (number | null)[], vertexCount = distances.length) => nativeGeometryQueryResultV1Schema.parse({
  query, sourceCanvasVersion: version, method: 'geogebra-vertex-distance-v1', radius: 3,
  vertexCount, distances, reason: null,
})

describe('isolated native geometry queries', () => {
  it('requires a complete pass but preserves a reliable counterexample despite another missing vertex', () => {
    expect(evaluateNativePolygonOnCircleV1(record([0, 1e-15, 0, 0, 0]))).toMatchObject({ outcome: 'passed' })
    expect(evaluateNativePolygonOnCircleV1(record([0, null, 3]))).toMatchObject({ outcome: 'failed' })
    expect(evaluateNativePolygonOnCircleV1(record([0, null, 0]))).toMatchObject({ outcome: 'unverified' })
    expect(evaluateNativePolygonOnCircleV1(record([0, 0, 0], 4))).toMatchObject({ outcome: 'unverified' })
    expect(evaluateNativePolygonOnCircleV1(record([0, 1e-8, 0]))).toMatchObject({ outcome: 'unverified' })
  })
  it('uses actual polygon vertices and native distances; never enumerates or computes coordinates', async () => {
    const calls: string[] = []
    const created = new Map<string, string>()
    let disposed = false
    const api: RestrictedGeoGebraApiV1 = {
      setXML: xml => { expect(xml).toBe('snapshot') }, getXML: () => 'snapshot', evalCommand: () => false,
      exists: label => ['poly', 'c', 'GgbQuery1'].includes(label) || created.has(label), isDefined: () => true,
      getObjectType: label => label === 'poly' ? 'polygon' : label === 'c' ? 'circle'
        : created.get(label)?.startsWith('{') ? 'list' : 'numeric',
      evalCommandGetLabels: command => { calls.push(command); const [label, expression] = command.split('='); created.set(label!, expression!); return label! },
      getValue: label => created.get(label)?.startsWith('Length') ? 5 : created.get(label)?.startsWith('Radius') ? 3 : 0,
    }
    const rows = await runNativeGeometryQueriesV1({ queries: [query], xml: 'snapshot', canvasVersion: version,
      signal: new AbortController().signal, versionOf: async () => version,
      factory: async () => ({ api, dispose: () => { disposed = true } }) })
    expect(rows[0]).toMatchObject({ distances: [0, 0, 0, 0, 0] })
    expect(calls[0]).toBe('GgbQuery2={Vertex[poly]}')
    expect(calls.at(-1)).toContain('Distance[Vertex[poly,5],c]')
    expect(disposed).toBe(true)
  })
  it('missing hosts and stale cloned snapshots remain unknown, and disposal still runs', async () => {
    const input = { queries: [query], xml: 'snapshot', canvasVersion: version,
      signal: new AbortController().signal, versionOf: async () => version }
    expect((await runNativeGeometryQueriesV1(input))[0]?.reason).toBe('query_unavailable')
    let disposed = false
    const api = { setXML: () => {}, evalCommandGetLabels: () => { throw new Error('must not execute') } } as unknown as RestrictedGeoGebraApiV1
    expect((await runNativeGeometryQueriesV1({ ...input,
      versionOf: async () => canvasVersionSchema.parse('canvas_00000000-0000-4000-8000-000000000002'),
      factory: async () => ({ api, dispose: () => { disposed = true } }) }))[0]?.reason).toBe('snapshot_mismatch')
    expect(disposed).toBe(true)
  })
  it('rejects arbitrary script fields and unsafe labels before query execution', () => {
    expect(nativeGeometryQueryV1Schema.safeParse({ ...query, script: 'Delete(c)' }).success).toBe(false)
    expect(nativeGeometryQueryV1Schema.safeParse({ ...query, subjects: [{ ...query.subjects[0], label: 'c];Delete(c)' }, query.subjects[1]] }).success).toBe(false)
  })
})

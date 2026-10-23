import { nativeGeometryQueryResultV1Schema, type NativeGeometryQueryV1,
  type NativeGeometryQueryResultV1, type CanvasVersion } from '@ggb-copilot/geometry-contract'
import type { RestrictedGeoGebraApiV1 } from './applet-adapter.js'
import { encodeGeoGebraCallV1 as call } from './encoder.js'
import { nativeQueryReaderV1, NATIVE_POLYGON_KINDS_V1 } from './native-query-reader.js'

type Query = Extract<NativeGeometryQueryV1, { kind: 'regularPolygon' }>
type Result = Extract<NativeGeometryQueryResultV1, { method: 'geogebra-regular-reference-v1' }>

/** Create a typed unavailable result without treating query failures as geometric counterexamples. */
export function nativeRegularQueryResultV1(query: Query, sourceCanvasVersion: CanvasVersion,
  fields: Partial<Omit<Result, 'query' | 'sourceCanvasVersion' | 'method'>>): Result {
  return nativeGeometryQueryResultV1Schema.parse({ query, sourceCanvasVersion,
    method: 'geogebra-regular-reference-v1', vertexCount: null, sideLength: null, area: null,
    referenceAreas: [null, null], referenceMatches: [null, null], forwardDistances: [], reverseDistances: [], reason: null,
    ...fields }) as Result
}

/** Compare with both native regular polygons on the first edge; all geometry stays in GeoGebra. */
export function measureNativeRegularPolygonV1(query: Query, version: CanvasVersion,
  api: RestrictedGeoGebraApiV1, signal: AbortSignal): Result {
  const polygon = query.subjects[0].label
  const result = (fields: Parameters<typeof nativeRegularQueryResultV1>[2]): Result => nativeRegularQueryResultV1(query, version, fields)
  if (api.exists?.(polygon) !== true || api.isDefined?.(polygon) !== true
    || !NATIVE_POLYGON_KINDS_V1.includes(api.getObjectType?.(polygon)?.toLowerCase() as typeof NATIVE_POLYGON_KINDS_V1[number])) {
    return result({ reason: 'unsupported_object' })
  }
  const read = nativeQueryReaderV1(api, signal)
  const vertices = read.assign(`{${call('Vertex', [polygon])}}`, ['list'])
  const count = vertices === null ? null : read.scalar(call('Length', [vertices]))
  if (count === null || !Number.isInteger(count) || count < 3) return result({ reason: 'query_failed' })
  if (count > 128) return result({ reason: 'vertex_limit' })
  const vertex = (label: string, index: number): string => call('Vertex', [label, String(index)])
  const first = vertex(polygon, 1), second = vertex(polygon, 2)
  const references = [read.assign(call('Polygon', [first, second, String(count)]), NATIVE_POLYGON_KINDS_V1),
    read.assign(call('Polygon', [second, first, String(count)]), NATIVE_POLYGON_KINDS_V1)] as const
  if (references.some(label => label === null)) return result({ vertexCount: count, reason: 'query_failed' })
  const distance = (expression: string): number | null => {
    const value = read.scalar(expression)
    return value !== null && value >= 0 ? value : null
  }
  const distances = (reference: string, reverse: boolean): (number | null)[] => Array.from({ length: count }, (_, index) =>
    distance(call('Distance', [vertex(polygon, index + 1), vertex(reference,
      reverse ? (1 - index + count) % count + 1 : index + 1)])))
  return result({ vertexCount: count, sideLength: distance(call('Distance', [first, second])),
    area: distance(call('Area', [polygon])),
    referenceAreas: [distance(call('Area', [references[0]!])), distance(call('Area', [references[1]!]))],
    referenceMatches: [read.boolean(call('AreEqual', [polygon, references[0]!])), read.boolean(call('AreEqual', [polygon, references[1]!]))],
    forwardDistances: distances(references[0]!, false), reverseDistances: distances(references[1]!, true) })
}

/** Confirm a complete native match; reject only reliable deviations from both valid references. */
export function evaluateNativeRegularPolygonV1(record: NativeGeometryQueryResultV1): {
  readonly outcome: 'passed' | 'failed' | 'unverified'; readonly reason: string | null; readonly tolerance: number | null
} {
  const unknown = (reason: string): { outcome: 'unverified'; reason: string; tolerance: null } => ({ outcome: 'unverified', reason, tolerance: null })
  if (record.method !== 'geogebra-regular-reference-v1') return unknown('native_regularity_method_mismatch')
  if (record.reason !== null) return unknown(record.reason)
  if (record.sideLength === null || record.area === null || record.vertexCount === null
    || record.referenceAreas.some(area => area === null)) return unknown('native_regularity_evidence_incomplete')
  const scale = Math.max(1, record.sideLength)
  if (record.sideLength <= 1e-9 * scale || record.area <= 1e-9 * scale * scale
    || record.referenceAreas.some(area => area! <= 1e-9 * scale * scale)) return unknown('native_polygon_degenerate_or_near_boundary')
  const directions = [record.forwardDistances, record.reverseDistances]
  const tolerance = 1e-7 * scale
  const matched = directions.some((values, index) => record.referenceMatches[index] === true
    && values.length === record.vertexCount && values.every(value => value !== null && value <= 1e-9 * scale))
  if (matched) return { outcome: 'passed', reason: null, tolerance }
  const disproved = directions.every((values, index) => record.referenceMatches[index] === false
    && values.some(value => value !== null && value > tolerance))
  if (disproved) return { outcome: 'failed', reason: 'native_polygon_differs_from_both_regular_references', tolerance }
  return { outcome: 'unverified', reason: 'native_regularity_incomplete_or_near_boundary', tolerance }
}

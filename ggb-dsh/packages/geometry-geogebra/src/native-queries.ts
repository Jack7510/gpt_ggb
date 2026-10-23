import { measureVerificationProgramV1 } from './verification-program.js'
import { measureNativeConditionV1 } from './native-condition-query.js'
import { VERIFICATION_PROGRAM_METHOD_V1 } from '@ggb-copilot/geometry-contract'
import { nativeRegularQueryResultV1, measureNativeRegularPolygonV1 } from './native-regular-query.js'
import { nativeQueryReaderV1, NATIVE_POLYGON_KINDS_V1 } from './native-query-reader.js'
import { nativeGeometryQueryResultV1Schema, type CanvasVersion,
  type NativeGeometryQueryV1, type NativeGeometryQueryResultV1 } from '@ggb-copilot/geometry-contract'
import type { RestrictedGeoGebraApiV1 } from './applet-adapter.js'
import { encodeGeoGebraCallV1 } from './encoder.js'

export interface IsolatedGeoGebraV1 {
  readonly api: RestrictedGeoGebraApiV1
  dispose(): void
}
/** Host creates an independent applet; the query runner loads only the captured construction. */
export type IsolatedGeoGebraFactoryV1 = (signal: AbortSignal) => Promise<IsolatedGeoGebraV1>

/** Evaluate trusted native measurements in one isolated snapshot; query failure never rolls back construction. */
export async function runNativeGeometryQueriesV1(input: {
  readonly queries: readonly NativeGeometryQueryV1[]
  readonly xml: string
  readonly canvasVersion: CanvasVersion
  readonly factory?: IsolatedGeoGebraFactoryV1 | undefined
  readonly versionOf: (api: RestrictedGeoGebraApiV1) => Promise<CanvasVersion>
  readonly signal: AbortSignal
}): Promise<NativeGeometryQueryResultV1[]> {
  if (input.queries.length === 0) return []
  const missing = (reason: NativeGeometryQueryResultV1['reason']): NativeGeometryQueryResultV1[] =>
    input.queries.map(query => unavailable(query, input.canvasVersion, reason))
  if (input.factory === undefined) return missing('query_unavailable')
  let isolated: IsolatedGeoGebraV1 | undefined
  try {
    isolated = await input.factory(input.signal)
    isolated.api.setXML(input.xml)
    if (await input.versionOf(isolated.api) !== input.canvasVersion) return missing('snapshot_mismatch')
    const api = isolated.api
    return input.queries.map(query => {
      try { return query.kind === 'hasEquation' || query.kind === 'pointOnConic'
        ? measureNativeConditionV1(query, input.canvasVersion, api, input.signal)
        : query.kind === 'verificationProgram' ? measureVerificationProgramV1(query, input.canvasVersion, api, input.signal)
        : query.kind === 'regularPolygon' ? measureNativeRegularPolygonV1(query, input.canvasVersion, api, input.signal)
        : measure(query, input.canvasVersion, api, input.signal) }
      catch { return unavailable(query, input.canvasVersion, 'query_failed') }
    })
  } catch { return missing('query_failed') }
  finally { try { isolated?.dispose() } catch { /* Host cleanup cannot reject the construction. */ } }
}

function unavailable(query: NativeGeometryQueryV1, version: CanvasVersion,
  reason: NativeGeometryQueryResultV1['reason']): NativeGeometryQueryResultV1 {
  if (query.kind === 'hasEquation') return nativeGeometryQueryResultV1Schema.parse({ query,
    sourceCanvasVersion: version, method: 'geogebra-equation-equality-v1', equal: null, reason })
  if (query.kind === 'pointOnConic') return nativeGeometryQueryResultV1Schema.parse({ query,
    sourceCanvasVersion: version, method: 'geogebra-point-conic-distance-v1', distance: null, reason })
  if (query.kind === 'verificationProgram') return nativeGeometryQueryResultV1Schema.parse({ query,
    sourceCanvasVersion: version, method: VERIFICATION_PROGRAM_METHOD_V1, values: [], reason })
  return query.kind === 'regularPolygon' ? nativeRegularQueryResultV1(query, version, { reason }) : result(query, version, { reason })
}

type CircleQuery = Extract<NativeGeometryQueryV1, { kind: 'polygonOnCircle' }>
type CircleResult = Extract<NativeGeometryQueryResultV1, { method: 'geogebra-vertex-distance-v1' }>

function result(query: CircleQuery, sourceCanvasVersion: CanvasVersion,
  fields: Partial<Pick<CircleResult, 'reason' | 'vertexCount' | 'radius' | 'distances'>>): CircleResult {
  return nativeGeometryQueryResultV1Schema.parse({ query, sourceCanvasVersion,
    method: 'geogebra-vertex-distance-v1', vertexCount: null, radius: null, distances: [], reason: null, ...fields }) as CircleResult
}

function measure(query: CircleQuery, version: CanvasVersion,
  api: RestrictedGeoGebraApiV1, signal: AbortSignal): NativeGeometryQueryResultV1 {
  const [polygon, circle] = query.subjects
  if (signal.aborted) throw new Error('query_aborted')
  if (api.exists?.(polygon.label) !== true || api.exists?.(circle.label) !== true
    || api.isDefined?.(polygon.label) !== true || api.isDefined?.(circle.label) !== true
    || !NATIVE_POLYGON_KINDS_V1.includes(api.getObjectType?.(polygon.label)?.toLowerCase() as typeof NATIVE_POLYGON_KINDS_V1[number])
    || api.getObjectType?.(circle.label)?.toLowerCase() !== 'circle') {
    return result(query, version, { reason: 'unsupported_object' })
  }
  const { assign, scalar } = nativeQueryReaderV1(api, signal)
  const vertices = assign(`{${encodeGeoGebraCallV1('Vertex', [polygon.label])}}`, ['list'])
  if (vertices === null) return result(query, version, { reason: 'query_failed' })
  const count = scalar(encodeGeoGebraCallV1('Length', [vertices]))
  if (count === null || !Number.isInteger(count) || count < 3) return result(query, version, { reason: 'query_failed' })
  if (count > 128) return result(query, version, { reason: 'vertex_limit' })
  const radius = scalar(encodeGeoGebraCallV1('Radius', [circle.label]))
  const distances = Array.from({ length: count }, (_, index) => {
    const vertex = encodeGeoGebraCallV1('Vertex', [polygon.label, String(index + 1)])
    const value = scalar(encodeGeoGebraCallV1('Distance', [vertex, circle.label]))
    return value !== null && value >= 0 ? value : null
  })
  return result(query, version, { vertexCount: count, radius: radius !== null && radius > 0 ? radius : null, distances })
}

/** Aggregate native distances only. A complete pass needs all vertices; one reliable counterexample disproves it. */
export function evaluateNativePolygonOnCircleV1(record: NativeGeometryQueryResultV1): {
  readonly outcome: 'passed' | 'failed' | 'unverified'; readonly reason: string | null; readonly tolerance: number | null
} {
  if (record.method !== 'geogebra-vertex-distance-v1') {
    return { outcome: 'unverified', reason: 'native_inscription_method_mismatch', tolerance: null }
  }
  if (record.reason !== null || record.radius === null) {
    return { outcome: 'unverified', reason: record.reason ?? 'native_radius_missing', tolerance: null }
  }
  const scale = Math.max(1, record.radius)
  const tolerance = 1e-7 * scale
  if (record.distances.some(value => value !== null && value > tolerance)) {
    return { outcome: 'failed', reason: 'native_vertex_off_circle', tolerance }
  }
  if (record.vertexCount === null || record.distances.length !== record.vertexCount
    || record.distances.some(value => value === null)) {
    return { outcome: 'unverified', reason: 'native_vertex_evidence_incomplete', tolerance }
  }
  if (record.distances.some(value => value! > 1e-9 * scale)) {
    return { outcome: 'unverified', reason: 'native_distance_near_boundary', tolerance }
  }
  return { outcome: 'passed', reason: null, tolerance }
}

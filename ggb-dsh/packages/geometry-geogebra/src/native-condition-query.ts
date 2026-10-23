import { nativeGeometryQueryResultV1Schema, type NativeGeometryQueryV1, type NativeGeometryQueryResultV1,
  type CanvasVersion } from '@ggb-copilot/geometry-contract'
import type { RestrictedGeoGebraApiV1 } from './applet-adapter.js'
import { nativeQueryReaderV1 } from './native-query-reader.js'
import { encodeGeoGebraCallV1 } from './encoder.js'

type Query = Extract<NativeGeometryQueryV1, { kind: 'hasEquation' | 'pointOnConic' }>
const conics = ['ellipse', 'circle', 'hyperbola', 'parabola', 'conic']

/** Measurements are made only in the caller-owned isolated snapshot, never on the user's canvas. */
export function measureNativeConditionV1(query: Query, version: CanvasVersion,
  api: RestrictedGeoGebraApiV1, signal: AbortSignal): NativeGeometryQueryResultV1 {
  const result = (reason: NativeGeometryQueryResultV1['reason'], value: boolean | number | null = null): NativeGeometryQueryResultV1 =>
    nativeGeometryQueryResultV1Schema.parse(query.kind === 'hasEquation'
      ? { query, sourceCanvasVersion: version, method: 'geogebra-equation-equality-v1', equal: value, reason }
      : { query, sourceCanvasVersion: version, method: 'geogebra-point-conic-distance-v1', distance: value, reason })
  if (query.subjects.some(subject => api.exists?.(subject.label) !== true || api.isDefined?.(subject.label) !== true)) {
    return result('unsupported_object')
  }
  const kinds = query.subjects.map(subject => api.getObjectType?.(subject.label)?.toLowerCase() ?? '')
  const read = nativeQueryReaderV1(api, signal)
  if (query.kind === 'hasEquation') {
    // This release supports numeric object equality of a line or a nondegenerate ellipse/circle.
    if (!['line', 'ellipse', 'circle'].includes(kinds[0]!)) return result('unsupported_object')
    const reference = read.assign(query.expected, [kinds[0]!])
    if (reference === null) return result('query_failed')
    if (kinds[0] !== 'line' && [query.subjects[0].label, reference].some(label => {
      const area = read.scalar(encodeGeoGebraCallV1('Area', [label]))
      return area === null || area <= 0
    })) return result('unsupported_object')
    const equal = read.boolean(encodeGeoGebraCallV1('AreEqual', [query.subjects[0].label, reference]))
    return result(equal === null ? 'query_failed' : null, equal)
  }
  if (kinds[0] !== 'point' || !conics.includes(kinds[1]!)) return result('unsupported_object')
  const distance = read.scalar(encodeGeoGebraCallV1('Distance', query.subjects.map(subject => subject.label)))
  return result(distance === null || distance < 0 ? 'query_failed' : null, distance !== null && distance >= 0 ? distance : null)
}

/** Single-snapshot numeric equality is not symbolic equivalence or a dynamic proof. */
export function evaluateNativeConditionV1(record: NativeGeometryQueryResultV1): {
  readonly outcome: 'passed' | 'failed' | 'unverified'; readonly reason: string | null; readonly tolerance: number | null
} {
  if (record.reason !== null) return { outcome: 'unverified', reason: record.reason, tolerance: null }
  if (record.method === 'geogebra-equation-equality-v1' && record.equal !== null) {
    return { outcome: record.equal ? 'passed' : 'failed', reason: record.equal ? null : 'native_equation_mismatch', tolerance: null }
  }
  if (record.method === 'geogebra-point-conic-distance-v1' && record.distance !== null) {
    const distance = record.distance
    const outcome = distance <= 1e-9 ? 'passed' : distance <= 1e-7 ? 'unverified' : 'failed'
    return { outcome, reason: outcome === 'passed' ? null : outcome === 'unverified'
      ? 'native_distance_near_boundary' : 'native_point_not_on_conic', tolerance: 1e-7 }
  }
  return { outcome: 'unverified', reason: 'native_condition_measurement_missing', tolerance: null }
}

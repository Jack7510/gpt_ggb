import { VERIFICATION_PRIMITIVES_V1, VERIFICATION_PROGRAM_METHOD_V1, verificationProgramIssuesV1,
  nativeGeometryQueryResultV1Schema, type NativeGeometryQueryV1, type NativeGeometryQueryResultV1,
  type CanvasVersion } from '@ggb-copilot/geometry-contract'
import type { RestrictedGeoGebraApiV1 } from './applet-adapter.js'
import { nativeQueryReaderV1 } from './native-query-reader.js'
import { encodeGeoGebraCallV1 } from './encoder.js'

type Query = Extract<NativeGeometryQueryV1, { kind: 'verificationProgram' }>
type Result = Extract<NativeGeometryQueryResultV1, { method: typeof VERIFICATION_PROGRAM_METHOD_V1 }>

/** Execute only typed primitives in the caller-owned isolated Result snapshot. */
export function measureVerificationProgramV1(query: Query, version: CanvasVersion,
  api: RestrictedGeoGebraApiV1, signal: AbortSignal): Result {
  const result = (values: Result['values'], reason: Result['reason']): Result =>
    nativeGeometryQueryResultV1Schema.parse({ query, sourceCanvasVersion: version,
      method: VERIFICATION_PROGRAM_METHOD_V1, values, reason }) as Result
  const kinds = query.subjects.map(subject => {
    const kind = api.getObjectType?.(subject.label)?.toLowerCase() ?? 'unknown'
    return ['ellipse', 'hyperbola', 'parabola'].includes(kind) ? 'conic' : kind
  })
  if (query.subjects.some(subject => api.exists?.(subject.label) !== true || api.isDefined?.(subject.label) !== true)
    || verificationProgramIssuesV1(query.program, kinds, query.expected, query.scope).length > 0) {
    return result([], 'unsupported_object')
  }
  const read = nativeQueryReaderV1(api, signal)
  const labels: string[] = []
  const values: Result['values'] = []
  for (const call of query.program.calls) {
    const args = call.arguments.map(arg => arg.kind === 'subject' ? query.subjects[arg.index]!.label : labels[arg.index]!)
    const primitive = VERIFICATION_PRIMITIVES_V1[call.command]
    const label = read.assign(encodeGeoGebraCallV1(call.command, args),
      primitive.result === 'number' ? ['numeric', 'number'] : [primitive.result])
    if (label === null) return result(values, 'query_failed')
    labels.push(label)
    const raw = primitive.result === 'point' ? null : api.getValue?.(label)
    const value = primitive.result === 'boolean' ? raw === 1 ? true : raw === 0 ? false : null
      : typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    if (primitive.result !== 'point' && value === null) return result(values, 'query_failed')
    values.push(value)
  }
  return result(values, null)
}

/** Judge typed measurements against the signed expected value; no model-authored tolerance. */
export function evaluateVerificationProgramV1(record: NativeGeometryQueryResultV1): {
  readonly outcome: 'passed' | 'failed' | 'unverified'; readonly reason: string | null; readonly tolerance: number | null
} {
  const unknown = (reason: string) => ({ outcome: 'unverified' as const, reason, tolerance: null })
  if (record.method !== VERIFICATION_PROGRAM_METHOD_V1) return unknown('verification_method_mismatch')
  if (record.reason !== null) return unknown(record.reason)
  if (record.values.length !== record.query.program.calls.length) return unknown('verification_measurement_missing')
  const { index, test } = record.query.program.result
  const actual = record.values[index]
  const expected = record.query.expected
  if (test === 'boolean') {
    if (typeof actual !== 'boolean' || typeof expected !== 'boolean') return unknown('verification_measurement_type_mismatch')
    return { outcome: actual === expected ? 'passed' : 'failed', reason: actual === expected ? null : 'verification_expected_mismatch', tolerance: null }
  }
  if (typeof actual !== 'number' || (test === 'zero' ? typeof expected !== 'boolean' : typeof expected !== 'number')) {
    return unknown('verification_measurement_type_mismatch')
  }
  const target = test === 'zero' ? 0 : expected as number
  const error = Math.abs(actual - target)
  const scale = Math.max(1, Math.abs(actual), Math.abs(target))
  if (error > 1e-9 * scale && error <= 1e-7 * scale) return unknown('verification_measurement_near_boundary')
  const equal = error <= 1e-9 * scale
  const holds = test === 'zero' ? equal === expected : equal
  return { outcome: holds ? 'passed' : 'failed', reason: holds ? null : 'verification_expected_mismatch', tolerance: 1e-7 * scale }
}

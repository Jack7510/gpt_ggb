import { verificationProgramIssuesV1 } from '@ggb-copilot/geometry-contract'
import type { GeometryAssertionV1, GeometryErrorV1, MathPlanningPlanV1 } from '@ggb-copilot/geometry-contract'

type ObjectKind = MathPlanningPlanV1['objects'][number]['kind']
type AssertionKind = GeometryAssertionV1['kind']
type ExpectedKind = 'boolean' | 'number' | 'string'

export interface AssertionCapabilityV1 {
  readonly expected: ExpectedKind
  /** Each signature lists accepted kinds by subject position. An empty list accepts any declared kind. */
  readonly signatures: readonly (readonly (readonly ObjectKind[])[])[]
}

const point = ['point'] as const
const line = ['line'] as const
const lineLike = ['line', 'segment', 'vector'] as const
const lengthObject = ['segment', 'vector'] as const
const circle = ['circle'] as const
const conic = ['conic'] as const
const plane = ['plane'] as const
const sphere = ['sphere'] as const
const slider = ['slider'] as const
const polygon = ['polygon'] as const
const any = [] as const
const objectKinds: readonly ObjectKind[] = [
  'point', 'line', 'segment', 'vector', 'circle', 'conic', 'curve', 'polygon',
  'plane', 'sphere', 'polyhedron', 'solid', 'slider', 'object',
]

/** Condition vocabulary and operand signatures. This table does not claim runtime verification support. */
export const ASSERTION_CAPABILITIES_V1: Readonly<Record<AssertionKind, AssertionCapabilityV1>> = {
  exists: { expected: 'boolean', signatures: [[any], [any, any], [any, any, any], [any, any, any, any]] },
  hasType: { expected: 'string', signatures: [[any]] },
  hasEquation: { expected: 'string', signatures: [[['line', 'circle', 'conic', 'curve']]] },
  regularPolygon: { expected: 'boolean', signatures: [[polygon]] },
  polygonOnCircle: { expected: 'boolean', signatures: [[polygon, circle]] },
  polygonVertexCount: { expected: 'number', signatures: [[polygon]] },
  dependsOn: { expected: 'boolean', signatures: [[any, any]] },
  collinear: { expected: 'boolean', signatures: [[point, point, point]] },
  parallel: { expected: 'boolean', signatures: [[lineLike, lineLike], [plane, plane]] },
  perpendicular: { expected: 'boolean', signatures: [[lineLike, lineLike], [plane, plane]] },
  equalLength: { expected: 'boolean', signatures: [[lengthObject, lengthObject]] },
  length: { expected: 'number', signatures: [[lengthObject], [point, point]] },
  angle: { expected: 'number', signatures: [[point, point, point]] },
  pointOnLine: { expected: 'boolean', signatures: [[point, line], [line, point], [point, ['segment']], [['segment'], point]] },
  pointOnCircle: { expected: 'boolean', signatures: [[point, circle], [circle, point]] },
  pointOnConic: { expected: 'boolean', signatures: [[point, conic], [conic, point]] },
  pointOnPlane: { expected: 'boolean', signatures: [[point, plane], [plane, point]] },
  pointOnSphere: { expected: 'boolean', signatures: [[point, sphere], [sphere, point]] },
  coplanar: { expected: 'boolean', signatures: [[point, point, point, point]] },
  midpoint: { expected: 'boolean', signatures: [[point, point, point]] },
  concurrent: { expected: 'boolean', signatures: [[line, line, line], [line, line, line, line]] },
  tangent: { expected: 'boolean', signatures: [[line, circle]] },
  dynamicPointOnCircle: { expected: 'boolean', signatures: [[point, circle, slider]] },
  // One observed scalar against a bounded interval. A point carries x/y/z and a slider carries
  // `value`; the evaluator reports `axis_unavailable` when the subject does not expose the axis
  // rather than claiming the bound holds.
  valueInInterval: { expected: 'boolean',
    signatures: [[point], [slider], [['point', 'slider']]] },
}

/** Reject malformed condition operands before a canvas write; unknown mathematical truth is not judged. */
export function preflightAssertionCapabilitiesV1(
  plan: Pick<MathPlanningPlanV1, 'objects' | 'assertions'>,
): readonly GeometryErrorV1[] {
  const kinds = new Map(plan.objects.map(object => [object.objectId, object.kind]))
  return plan.assertions.flatMap(assertion => {
    const capability: AssertionCapabilityV1 | undefined = ASSERTION_CAPABILITIES_V1[assertion.kind]
    if (capability === undefined) return [issue(assertion, 'unsupported_kind')]
    if (typeof assertion.expected !== capability.expected) return [issue(assertion, 'expected_type')]
    if (assertion.kind === 'hasType' && !objectKinds.includes(assertion.expected as ObjectKind)) {
      return [issue(assertion, 'unknown_object_type')]
    }
    const actual = assertion.subjects.map(id => kinds.get(id))
    if (actual.some(kind => kind === undefined)) return [] // Reference validator reports missing subjects.
    const supported = capability.signatures.some(signature => signature.length === actual.length
      && signature.every((accepted, index) => accepted.length === 0 || accepted.includes(actual[index]!)))
    if (!supported) return [issue(assertion, 'subject_types')]
    return assertion.verificationProgram === undefined ? []
      : verificationProgramIssuesV1(assertion.verificationProgram, actual as string[], assertion.expected,
        assertion.scope ?? 'single_observation').map(reason => issue(assertion, reason))
  })
}

function issue(assertion: GeometryAssertionV1, reason: string): GeometryErrorV1 {
  return { schemaVersion: 1, code: 'PLAN_OPERATION_UNSUPPORTED', phase: 'plan', retry: 'after_replan',
    message: 'Condition operands or expected value do not match the declared signature.',
    details: { assertionId: assertion.assertionId, assertionKind: assertion.kind, reason } }
}

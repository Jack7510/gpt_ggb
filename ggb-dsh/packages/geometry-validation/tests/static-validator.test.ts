import { describe, expect, it } from 'vitest'

import type { MathConstructionPlanV1, MathPlanningPlanV1 } from '@ggb-copilot/geometry-contract'

import {
  createGeoGebraVariableNamesV1,
  reviewConstructionVariableNamesV1,
  validateAndOrderPlanV1,
  validatePlanningPlanV1,
} from '../src/index.js'

const uuid = (prefix: string, suffix: string): string => `${prefix}_00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const ids = {
  plan: uuid('plan', '1'), pointA: uuid('obj', '2'), pointB: uuid('obj', '3'), line: uuid('obj', '4'),
  stepA: uuid('step', '5'), stepB: uuid('step', '6'), stepLine: uuid('step', '7'), assertion: uuid('assert', '8'),
}

function plan(): Record<string, unknown> {
  return {
    schemaVersion: 1, planId: ids.plan, problemSummary: 'construct AB.', assumptions: [],
    objects: [
      { objectId: ids.pointA, kind: 'point', variableName: 'A', description: 'A', protected: false },
      { objectId: ids.pointB, kind: 'point', variableName: 'B', description: 'B', protected: false },
      { objectId: ids.line, kind: 'line', variableName: 'f', description: 'AB', protected: false },
    ],
    steps: [
      { stepId: ids.stepLine, dependsOn: [ids.stepB, ids.stepA], explanation: 'Line AB',
        operation: { kind: 'createLineThroughPoints', output: ids.line, points: [ids.pointA, ids.pointB] } },
      { stepId: ids.stepB, dependsOn: [], explanation: 'Point B',
        operation: { kind: 'createPointByCoordinates', output: ids.pointB, x: 2, y: 0 } },
      { stepId: ids.stepA, dependsOn: [], explanation: 'Point A',
        operation: { kind: 'createPointByCoordinates', output: ids.pointA, x: 0, y: 0 } },
    ],
    assertions: [{ assertionId: ids.assertion, kind: 'exists', subjects: [ids.line], expected: true, required: true }],
  }
}

function errorCodes(value: Record<string, unknown>): string[] {
  const result = validateAndOrderPlanV1(value)
  return result.ok ? [] : result.errors.map(error => error.code)
}

function planningPlan(executable: Record<string, unknown>): MathPlanningPlanV1 {
  const steps = executable.steps as Array<Record<string, unknown>>
  return { ...executable, steps: steps.map((step) => {
    const operation = step.operation as Record<string, unknown>
    return {
      stepId: step.stepId, dependsOn: step.dependsOn,
      output: operation.output ?? null, inputs: operation.points ?? [],
      instruction: step.explanation, expectedResult: step.explanation,
    }
  }) } as MathPlanningPlanV1
}

function inscribedPolygonPlan(includeCircleDependency: boolean): MathPlanningPlanV1 {
  const object = (suffix: string, kind: string, label: string): Record<string, unknown> => ({
    objectId: uuid('obj', suffix), kind, variableName: label, description: label, protected: false,
  })
  const center = uuid('obj', '101')
  const pointA = uuid('obj', '102')
  const pointB = uuid('obj', '103')
  const pointC = uuid('obj', '104')
  const circle = uuid('obj', '105')
  const polygon = uuid('obj', '106')
  const stepCenter = uuid('step', '101')
  const stepA = uuid('step', '102')
  const stepB = uuid('step', '103')
  const stepC = uuid('step', '104')
  const stepCircle = uuid('step', '105')
  const stepPolygon = uuid('step', '106')
  return {
    schemaVersion: 1, planId: uuid('plan', '101'), space: '2d', problemSummary: 'Inscribed polygon.', assumptions: [],
    objects: [object('101', 'point', 'O'), object('102', 'point', 'A'), object('103', 'point', 'B'),
      object('104', 'point', 'C'), object('105', 'circle', 'c'), object('106', 'polygon', 'p')],
    steps: [
      { stepId: stepCenter, dependsOn: [], output: center, inputs: [], instruction: 'Create O', expectedResult: 'O exists' },
      { stepId: stepA, dependsOn: [], output: pointA, inputs: [], instruction: 'Create A', expectedResult: 'A exists' },
      { stepId: stepB, dependsOn: [], output: pointB, inputs: [], instruction: 'Create B', expectedResult: 'B exists' },
      { stepId: stepC, dependsOn: [], output: pointC, inputs: [], instruction: 'Create C', expectedResult: 'C exists' },
      { stepId: stepCircle, dependsOn: [stepCenter, stepA], output: circle, inputs: [center, pointA], instruction: 'Create c', expectedResult: 'c exists' },
      { stepId: stepPolygon, dependsOn: includeCircleDependency ? [stepA, stepB, stepC, stepCircle] : [stepA, stepB, stepC],
        output: polygon, inputs: [pointA, pointB, pointC], instruction: 'Create p', expectedResult: 'p exists' },
    ],
    assertions: [{ assertionId: uuid('assert', '101'), kind: 'exists', subjects: [polygon], expected: true, required: true }],
  } as MathPlanningPlanV1
}

describe('validateAndOrderPlanV1', () => {
  it('uses requested readable labels, normalizes prime and preserves existing identities', () => {
    const objects = ["Fprime", 'A', 'P1'].map((variableName, index) => ({
      objectId: uuid('obj', String(201 + index)) as MathConstructionPlanV1['objects'][number]['objectId'],
      kind: 'point' as const, variableName, description: variableName, protected: index === 2,
    }))
    const allocated = createGeoGebraVariableNamesV1(objects)
    expect(allocated.errors).toEqual([])
    expect([...allocated.labels.values()]).toEqual(["F'", 'A', 'P1'])
  })

  it('rejects label/Caption cross collisions without renaming existing objects', () => {
    const objects = [
      { objectId: ids.pointB, kind: 'point' as const, variableName: 'pt1', caption: 'A', description: 'existing', protected: true },
      { objectId: ids.pointA, kind: 'point' as const, variableName: 'A', description: 'new', protected: false },
    ]
    expect(createGeoGebraVariableNamesV1(objects).errors).toMatchObject([{ code: 'PLAN_UNSAFE_VARIABLE_NAME' }])
    expect(objects[0]!.variableName).toBe('pt1')
  })

  it('keeps conventional names during Planning and Codegen', () => {
    const value = plan()
    expect(validatePlanningPlanV1(planningPlan(value)).ok).toBe(true)
    expect(createGeoGebraVariableNamesV1(value.objects).labels.get(ids.line)).toBe('f')
    expect(reviewConstructionVariableNamesV1(value)).toEqual([])
  })

  it('rejects an invalid semantic plan before code generation', () => {
    const executable = plan()
    const planning = planningPlan(executable)
    expect(validatePlanningPlanV1(planning).ok).toBe(true)
    planning.steps[0] = { ...planning.steps[0]!, dependsOn: [uuid('step', '404')] as never }
    const rejected = validatePlanningPlanV1(planning)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.errors.map(item => item.code)).toContain('PLAN_REFERENCE_MISSING')
  })

  it('identifies the semantic planning contract in schema failures', () => {
    const rejected = validatePlanningPlanV1({ schemaVersion: 1 })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.errors[0]?.message).toBe('Plan does not match MathPlanningPlanV1.')
  })

  it('does not apply a closed operation signature table to semantic planning inputs', () => {
    const planning = planningPlan(plan())
    planning.objects[2] = { ...planning.objects[2]!, kind: 'segment' }
    planning.steps[0] = { ...planning.steps[0]!, dependsOn: [], inputs: [] }
    expect(validatePlanningPlanV1(planning).ok).toBe(true)
  })

  it('accepts an opaque protected canvas object for a presentation operation', () => {
    const value = plan()
    const target = uuid('obj', '40')
    const styleStep = uuid('step', '40')
    value.objects = [...value.objects as unknown[], {
      objectId: target, kind: 'object', variableName: 't', description: 'existing canvas triangle t', protected: true,
    }]
    value.steps = [...value.steps as unknown[], { stepId: styleStep, dependsOn: [], explanation: 'Fill t green',
      operation: { kind: 'setStyle', target, style: { color: '#00AA00', opacity: 1 } } }]

    expect(validateAndOrderPlanV1(value).ok).toBe(true)
  })

  it('reserves the opaque object kind for existing protected canvas objects', () => {
    const value = plan()
    const objects = value.objects as Array<Record<string, unknown>>
    objects[0] = { ...objects[0], kind: 'object', protected: false }

    expect(errorCodes(value)).toContain('PLAN_SCHEMA_INVALID')
  })

  it('accepts a zero-input line whose instruction supplies its equation', () => {
    const planning = planningPlan(plan())
    planning.steps[0] = { ...planning.steps[0]!, dependsOn: [], inputs: [],
      instruction: 'Create d: x = -1', expectedResult: 'd has equation x = -1' }
    expect(validatePlanningPlanV1(planning).ok).toBe(true)
  })

  it('accepts a point constrained to one path object', () => {
    const planning = planningPlan(plan())
    planning.steps[0] = { ...planning.steps[0]!, dependsOn: [], inputs: [],
      instruction: 'Create d: x = -1', expectedResult: 'd has equation x = -1' }
    planning.steps[1] = { ...planning.steps[1]!, dependsOn: [ids.stepLine] as never,
      inputs: [ids.line] as never, instruction: 'Choose B on the line', expectedResult: 'B remains on the line' }
    expect(validatePlanningPlanV1(planning).ok).toBe(true)
  })

  it('rejects planning inputs whose producers are absent from dependency closure', () => {
    const planning = planningPlan(plan())
    planning.steps[0] = { ...planning.steps[0]!, dependsOn: [] }
    const rejected = validatePlanningPlanV1(planning)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.errors.map(item => item.code)).toContain('PLAN_DEPENDENCY_MISSING')
  })

  it('does not replace an inscribed condition with an object-lineage requirement', () => {
    expect(validatePlanningPlanV1(inscribedPolygonPlan(false)).ok).toBe(true)
    expect(validatePlanningPlanV1(inscribedPolygonPlan(true)).ok).toBe(true)
  })

  it('accepts explicit goal order without requiring the polygon operation to consume the circle', () => {
    const planning = inscribedPolygonPlan(false)
    const [center, pointA, pointB, slider, circle, polygon] = planning.objects
    planning.objects[3] = { ...slider!, kind: 'slider', variableName: 'n', description: 'side count' }
    const [stepCenter, stepA, stepB, stepSlider, stepCircle, stepPolygon] = planning.steps
    planning.steps[2] = { ...stepB!, dependsOn: [stepCenter!.stepId, stepA!.stepId, stepSlider!.stepId],
      inputs: [pointA!.objectId, center!.objectId, slider!.objectId] }
    planning.steps[5] = { ...stepPolygon!, dependsOn: [stepA!.stepId, stepB!.stepId, stepSlider!.stepId],
      inputs: [pointA!.objectId, pointB!.objectId, slider!.objectId] }
    planning.assertions = [
      ...planning.assertions,
      { assertionId: uuid('assert', '102') as never, kind: 'dynamicPointOnCircle',
        subjects: [pointB!.objectId, circle!.objectId, slider!.objectId], expected: true, required: true },
    ]
    expect(validatePlanningPlanV1(planning).ok).toBe(true)
    planning.steps[5] = { ...planning.steps[5]!, dependsOn: [...planning.steps[5]!.dependsOn, stepCircle!.stepId] }
    expect(validatePlanningPlanV1(planning).ok).toBe(true)
    expect(polygon?.kind).toBe('polygon')
  })

  it('rejects an operation that changes the declared Slider configuration', () => {
    const sliderObject = uuid('obj', '31')
    const sliderStep = uuid('step', '31')
    const slider = { min: 1, max: 10, step: 0.5, initialValue: 3, integer: false }
    const rejected = validateAndOrderPlanV1({
      schemaVersion: 1, planId: uuid('plan', '31'), problemSummary: 'Create a radius slider.', assumptions: [],
      objects: [{ objectId: sliderObject, kind: 'slider', variableName: 'r', description: 'radius', protected: false,
        parameterRole: 'radius', slider }],
      steps: [{ stepId: sliderStep, dependsOn: [], explanation: 'Create radius slider r',
        operation: { kind: 'createSlider', output: sliderObject, ...slider, initialValue: 5 } }], assertions: [],
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PLAN_CODEGEN_MISMATCH',
        message: 'Code generation changed the trusted Slider configuration.' }),
    ]))
  })

  it('returns a deterministic dependency order', () => {
    const result = validateAndOrderPlanV1(plan())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.orderedSteps.map(step => step.stepId)).toEqual([ids.stepB, ids.stepA, ids.stepLine])
  })

  it('accepts a segment as the direction input for GeoGebra PerpendicularLine', () => {
    const value = plan()
    const segment = uuid('obj', '20')
    const perpendicular = uuid('obj', '21')
    const segmentStep = uuid('step', '20')
    const perpendicularStep = uuid('step', '21')
    value.objects = [...value.objects as unknown[],
      { objectId: segment, kind: 'segment', variableName: 's', description: 'AB', protected: false },
      { objectId: perpendicular, kind: 'line', variableName: 'm', description: 'perpendicular', protected: false }]
    value.steps = [...value.steps as unknown[],
      { stepId: segmentStep, dependsOn: [ids.stepA, ids.stepB], explanation: 'segment AB',
        operation: { kind: 'createSegment', output: segment, points: [ids.pointA, ids.pointB] } },
      { stepId: perpendicularStep, dependsOn: [segmentStep, ids.stepA], explanation: 'Perpendicular through A',
        operation: { kind: 'createPerpendicularLine', output: perpendicular, point: ids.pointA, line: segment } }]
    expect(errorCodes(value)).not.toContain('PLAN_REFERENCE_TYPE_MISMATCH')
  })

  it('accepts the intersection of a segment and a line', () => {
    const value = plan()
    const segment = uuid('obj', '30')
    const intersection = uuid('obj', '31')
    const segmentStep = uuid('step', '30')
    const intersectionStep = uuid('step', '31')
    value.objects = [...value.objects as unknown[],
      { objectId: segment, kind: 'segment', variableName: 's', description: 'AB', protected: false },
      { objectId: intersection, kind: 'point', variableName: 'P', description: 'Intersection', protected: false }]
    value.steps = [...value.steps as unknown[],
      { stepId: segmentStep, dependsOn: [ids.stepA, ids.stepB], explanation: 'segment AB',
        operation: { kind: 'createSegment', output: segment, points: [ids.pointA, ids.pointB] } },
      { stepId: intersectionStep, dependsOn: [segmentStep, ids.stepLine], explanation: 'Intersect segment and line',
        operation: { kind: 'createIntersection', output: intersection, objects: [segment, ids.line] } }]
    expect(errorCodes(value)).not.toContain('PLAN_REFERENCE_TYPE_MISMATCH')
  })

  it('collects duplicate ids and missing references without execution', () => {
    const value = plan()
    const objects = value.objects as Array<Record<string, unknown>>
    objects[1]!.objectId = ids.pointA
    const assertions = value.assertions as Array<Record<string, unknown>>
    assertions[0]!.subjects = [uuid('obj', '404')]
    expect(errorCodes(value)).toEqual(expect.arrayContaining(['PLAN_DUPLICATE_ID', 'PLAN_REFERENCE_MISSING']))
  })

  it('rejects dependency cycles', () => {
    const value = plan()
    const steps = value.steps as Array<Record<string, unknown>>
    steps[1]!.dependsOn = [ids.stepLine]
    expect(errorCodes(value)).toContain('PLAN_DEPENDENCY_CYCLE')
  })

  it('rejects missing producer dependencies and output type mismatches', () => {
    const missingDependency = plan()
    const steps = missingDependency.steps as Array<Record<string, unknown>>
    steps[0]!.dependsOn = []
    expect(errorCodes(missingDependency)).toContain('PLAN_DEPENDENCY_MISSING')

    const wrongType = plan()
    const objects = wrongType.objects as Array<Record<string, unknown>>
    objects[2]!.kind = 'circle'
    expect(errorCodes(wrongType)).toContain('PLAN_OUTPUT_MISMATCH')
  })

  it('classifies over-complex and unknown operations', () => {
    const oversized = plan()
    oversized.steps = Array.from({ length: 65 }, () => (oversized.steps as unknown[])[0])
    expect(errorCodes(oversized)).toContain('PLAN_COMPLEXITY_EXCEEDED')
    const unknown = plan()
    ;(((unknown.steps as Array<Record<string, unknown>>)[0]!.operation) as Record<string, unknown>).kind = 'runScript'
    expect(errorCodes(unknown)).toContain('PLAN_OPERATION_UNSUPPORTED')
  })

  it('returns safe field paths and rule codes for an invalid schema', () => {
    const invalid = plan()
    delete invalid.planId
    invalid.untrusted = 'Bearer should-not-appear'
    const result = validateAndOrderPlanV1(invalid)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const details = result.errors[0]?.details
    expect(details).toMatchObject({ issueCodes: expect.any(Array), issuePaths: expect.any(Array) })
    expect(details?.issuePaths).toContain('planId')
    expect(JSON.stringify(details)).not.toContain('should-not-appear')
  })

  it('allows presentation changes to protected canvas objects', () => {
    const value = plan()
    const objects = value.objects as Array<Record<string, unknown>>
    objects[0]!.protected = true
    value.objects = [objects[0]]
    value.steps = [{ stepId: ids.stepLine, dependsOn: [], explanation: 'Hide A',
      operation: { kind: 'setVisibility', target: ids.pointA, visible: false } }]
    value.assertions = []
    expect(errorCodes(value)).not.toContain('PLAN_PROTECTED_OBJECT')
  })

  it('rejects construction output that replaces a protected canvas object', () => {
    const value = plan()
    const objects = value.objects as Array<Record<string, unknown>>
    objects[0]!.protected = true
    expect(errorCodes(value)).toContain('PLAN_PROTECTED_OBJECT')
  })

  it('requires an explicit 3d space for spatial coordinates', () => {
    const value = plan()
    const steps = value.steps as Array<Record<string, unknown>>
    steps[1]!.operation = { kind: 'createPointByCoordinates', output: ids.pointB, x: 2, y: 0, z: 3 }
    expect(errorCodes(value)).toContain('PLAN_SPACE_MISMATCH')
    value.space = '3d'
    expect(errorCodes(value)).not.toContain('PLAN_SPACE_MISMATCH')
  })
})

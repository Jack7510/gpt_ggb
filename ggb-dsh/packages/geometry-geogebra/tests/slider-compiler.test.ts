import { describe, expect, it } from 'vitest'

import { numericExpressionV1Schema, type MathConstructionPlanV1 } from '@ggb-copilot/geometry-contract'
import { validateAndOrderPlanV1 } from '@ggb-copilot/geometry-validation'

import { compileGeometryPlanV1, renderGeoGebraScriptV1 } from '../src/index.js'

const id = (prefix: string, value: number): string =>
  `${prefix}_20000000-0000-4000-8000-${String(value).padStart(12, '0')}`

function object(value: number): MathConstructionPlanV1['objects'][number]['objectId'] {
  return id('obj', value) as MathConstructionPlanV1['objects'][number]['objectId']
}
function step(value: number): MathConstructionPlanV1['steps'][number]['stepId'] {
  return id('step', value) as MathConstructionPlanV1['steps'][number]['stepId']
}
function declaration(value: number, kind: MathConstructionPlanV1['objects'][number]['kind'], label: string): MathConstructionPlanV1['objects'][number] {
  return { objectId: object(value), kind, variableName: label, description: label, protected: false }
}
function construction(value: number, dependencies: readonly number[], operation: MathConstructionPlanV1['steps'][number]['operation']): MathConstructionPlanV1['steps'][number] {
  return { stepId: step(value), dependsOn: dependencies.map(step), operation, explanation: `step ${String(value)}` }
}

function inscribedRegularPolygonPlan(): MathConstructionPlanV1 {
  return {
    schemaVersion: 1, space: '2d', planId: id('plan', 100) as MathConstructionPlanV1['planId'],
    problemSummary: 'Circle with an inscribed regular n-gon.', assumptions: [],
    objects: [
      declaration(1, 'point', 'O'), declaration(2, 'point', 'A'), declaration(3, 'circle', 'c'),
      declaration(4, 'slider', 'n'), declaration(5, 'point', 'B'), declaration(6, 'polygon', 'p'),
    ],
    steps: [
      construction(1, [], { kind: 'createPointByCoordinates', output: object(1), x: 0, y: 0 }),
      construction(2, [], { kind: 'createPointByCoordinates', output: object(2), x: 2, y: 0 }),
      construction(3, [1, 2], { kind: 'createCircleByCenterPoint', output: object(3), center: object(1), point: object(2) }),
      construction(4, [], { kind: 'createSlider', output: object(4), min: 3, max: 12, step: 1, initialValue: 6, integer: true }),
      construction(5, [3, 4], {
        kind: 'createRotatedPoint', output: object(5), point: object(2), center: object(1),
        angleUnit: 'degrees',
        angle: { kind: 'binary', op: '/', left: { kind: 'literal', value: 360 }, right: { kind: 'reference', objectId: object(4) } },
      }),
      construction(6, [3, 4, 5], {
        kind: 'createRegularPolygonBySideCount', output: object(6), points: [object(2), object(5)],
        count: { kind: 'reference', objectId: object(4) },
      }),
    ],
    assertions: [
      { assertionId: id('assert', 1) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'exists', subjects: [object(3), object(6)], expected: true, required: true },
      { assertionId: id('assert', 2) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'dependsOn', subjects: [object(6), object(3)], expected: true, required: true },
      { assertionId: id('assert', 3) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'dynamicPointOnCircle', subjects: [object(5), object(3), object(4)], expected: true, required: true },
    ],
  }
}

describe('slider compiler', () => {
  it('compiles a circle whose radius is controlled by a slider', () => {
    const base = inscribedRegularPolygonPlan()
    const plan: MathConstructionPlanV1 = { ...base,
      objects: base.objects.slice(0, 4),
      steps: [
      base.steps[0]!,
      base.steps[3]!,
      construction(3, [1, 4], { kind: 'createCircleByCenterRadius', output: object(3), center: object(1),
        radius: { kind: 'reference', objectId: object(4) } }),
      ],
      assertions: [{ ...base.assertions[0]!, subjects: [object(3)] }],
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const compiled = compileGeometryPlanV1(validated.value)
    expect(compiled.expectedObjects[object(4)]).toBe('n')
    expect(compiled.commands.find(command => command.name === 'Slider')?.output?.caption).toBe('n')
    expect(renderGeoGebraScriptV1(compiled.commands)).toContain('c=Circle[O,n]')
  })

  it('compiles a slider-driven regular polygon without accepting raw script', () => {
    const validated = validateAndOrderPlanV1(inscribedRegularPolygonPlan())
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const script = renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)
    expect(script).toContain('c=Circle[O,A]')
    expect(script).toContain('n=Slider[3,12,1]')
    expect(script).toContain('SetValue[n,6]')
    expect(script).toContain('B=Rotate[A,(360/n)°,O]')
    expect(script).toContain('p=Polygon[A,B,n]')
  })

  it('defaults legacy rotation expressions to degrees and preserves explicit radians', () => {
    const degreesPlan = inscribedRegularPolygonPlan()
    const rotation = degreesPlan.steps[4]!.operation
    if (rotation.kind !== 'createRotatedPoint') throw new Error('rotation_fixture_missing')
    delete (rotation as { angleUnit?: 'degrees' | 'radians' }).angleUnit
    const degrees = validateAndOrderPlanV1(degreesPlan)
    expect(degrees.ok).toBe(true)
    if (!degrees.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(degrees.value).commands)).toContain('(360/n)°')

    const radiansPlan = inscribedRegularPolygonPlan()
    const radiansRotation = radiansPlan.steps[4]!.operation
    if (radiansRotation.kind !== 'createRotatedPoint') throw new Error('rotation_fixture_missing')
    radiansRotation.angleUnit = 'radians'
    const radians = validateAndOrderPlanV1(radiansPlan)
    expect(radians.ok).toBe(true)
    if (!radians.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(radians.value).commands)).toContain('B=Rotate[A,360/n,O]')
  })

  it('preserves pi in a slider-driven radian rotation through validation and compilation', () => {
    const plan = inscribedRegularPolygonPlan()
    const rotation = plan.steps[4]!.operation
    if (rotation.kind !== 'createRotatedPoint') throw new Error('rotation_fixture_missing')
    rotation.angleUnit = 'radians'
    rotation.angle = { kind: 'binary', op: '/',
      left: { kind: 'binary', op: '*', left: { kind: 'literal', value: 2 },
        right: { kind: 'constant', name: 'pi' } },
      right: { kind: 'reference', objectId: object(4) } }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const script = renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)
    expect(script).toContain('B=Rotate[A,2*pi/n,O]')
    expect(script).not.toContain('3.14159')
  })

  it('compiles official constants and functions without losing grouping or slider dependencies', () => {
    const plan = inscribedRegularPolygonPlan()
    const radius = { kind: 'binary', op: '/',
      left: { kind: 'function', name: 'sqrt', argument: { kind: 'binary', op: '+',
        left: { kind: 'reference', objectId: object(4) }, right: { kind: 'constant', name: 'e' } } },
      right: { kind: 'binary', op: '*', left: { kind: 'constant', name: 'pi' },
        right: { kind: 'constant', name: 'deg' } } } as const
    plan.steps[2]!.operation = { kind: 'createCircleByCenterRadius', output: object(3), center: object(1), radius }
    plan.steps[2]!.dependsOn = [step(1), step(4)]
    plan.steps[4]!.dependsOn = [step(1), step(2), step(3), step(4)]
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const script = renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)
    expect(script).toContain('c=Circle[O,sqrt(n+ℯ)/(pi*deg)]')
    const invalid = { ...plan, steps: plan.steps.map(value => value.stepId === step(3)
      ? { ...value, operation: { ...value.operation, radius: { kind: 'function', name: 'sin',
        argument: { kind: 'reference', objectId: object(2) } } } } : value) }
    expect(validateAndOrderPlanV1(invalid).ok).toBe(false)
  })

  it('preserves subtraction and division grouping in concise expressions', () => {
    const plan = inscribedRegularPolygonPlan()
    const rotation = plan.steps[4]!.operation
    if (rotation.kind !== 'createRotatedPoint') throw new Error('rotation_fixture_missing')
    rotation.angleUnit = 'radians'
    rotation.angle = { kind: 'binary', op: '/',
      left: { kind: 'binary', op: '-', left: { kind: 'constant', name: 'pi' },
        right: { kind: 'binary', op: '+', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 2 } } },
      right: { kind: 'binary', op: '/', left: { kind: 'literal', value: 3 }, right: { kind: 'literal', value: 4 } } }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands))
      .toContain('B=Rotate[A,(pi-(1+2))/(3/4),O]')
  })

  it('rejects unsupported constant identifiers and raw strings', () => {
    for (const value of [{ kind: 'constant', name: 'tau' }, { kind: 'constant', name: 'slider1' },
      { kind: 'constant', name: 'pi);Delete(A)' }, { kind: 'literal', value: 'pi' }, { kind: 'function', name: 'random', argument: { kind: 'literal', value: 1 } }]) {
      expect(numericExpressionV1Schema.safeParse(value).success).toBe(false)
    }
  })

  it('keeps an explicitly supplied decimal literal unchanged', () => {
    const plan = inscribedRegularPolygonPlan()
    const rotation = plan.steps[4]!.operation
    if (rotation.kind !== 'createRotatedPoint') throw new Error('rotation_fixture_missing')
    rotation.angleUnit = 'radians'
    rotation.angle = { kind: 'literal', value: 3.141592653589793 }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands))
      .toContain('B=Rotate[A,3.141592653589793,O]')
  })

  it('rejects a slider whose initial value is outside its range', () => {
    const plan = inscribedRegularPolygonPlan()
    plan.steps[3]!.operation = { kind: 'createSlider', output: object(4), min: 3, max: 12, step: 1, initialValue: 20, integer: true }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok).toBe(false)
  })

  it('rejects an integer slider with a fractional step', () => {
    const plan = inscribedRegularPolygonPlan()
    plan.steps[3]!.operation = { kind: 'createSlider', output: object(4), min: 3, max: 12, step: 0.5, initialValue: 6, integer: true }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok).toBe(false)
  })

  it('rejects a numeric expression that references a non-slider object', () => {
    const plan = inscribedRegularPolygonPlan()
    plan.steps[4]!.operation = {
      kind: 'createRotatedPoint', output: object(5), point: object(2), center: object(1),
      angleUnit: 'degrees',
      angle: { kind: 'reference', objectId: object(3) },
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok).toBe(false)
  })
})

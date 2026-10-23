import { describe, expect, it } from 'vitest'

import type { MathConstructionPlanV1 } from '@ggb-copilot/geometry-contract'
import { validateAndOrderPlanV1 } from '@ggb-copilot/geometry-validation'

import { compileGeometryPlanV1, renderGeoGebraScriptV1 } from '../src/index.js'

const id = (prefix: string, value: number): string =>
  `${prefix}_10000000-0000-4000-8000-${String(value).padStart(12, '0')}`

function spatialPlan(): MathConstructionPlanV1 {
  const kinds = ['point', 'point', 'point', 'point', 'polygon', 'plane', 'sphere', 'polyhedron',
    'solid', 'solid', 'polyhedron'] as const
  const labels = ['A', 'B', 'C', 'D', 'base', 'alpha', 's', 'prism1', 'cone1', 'cylinder1', 'cube1']
  const operations: MathConstructionPlanV1['steps'][number]['operation'][] = [
    { kind: 'createPointByCoordinates', output: object(1), x: 0, y: 0, z: 0 },
    { kind: 'createPointByCoordinates', output: object(2), x: 3, y: 0, z: 0 },
    { kind: 'createPointByCoordinates', output: object(3), x: 0, y: 3, z: 0 },
    { kind: 'createPointByCoordinates', output: object(4), x: 0, y: 0, z: 2 },
    { kind: 'createPolygon', output: object(5), points: [object(1), object(2), object(3)] },
    { kind: 'createPlaneThroughPoints', output: object(6), points: [object(1), object(2), object(3)] },
    { kind: 'createSphereByCenterPoint', output: object(7), center: object(1), point: object(4) },
    { kind: 'createPrism', output: object(8), base: object(5), top: object(4) },
    { kind: 'createCone', output: object(9), center: object(1), apex: object(4), radius: 2 },
    { kind: 'createCylinder', output: object(10), centers: [object(1), object(4)], radius: 2 },
    { kind: 'createCube', output: object(11), points: [object(1), object(2), object(3)] },
  ]
  return {
    schemaVersion: 1, space: '3d', planId: id('plan', 100) as MathConstructionPlanV1['planId'],
    problemSummary: 'construct a triangular prism and its reference plane and sphere.',
    assumptions: [],
    objects: kinds.map((kind, index) => ({ objectId: object(index + 1), kind,
      variableName: labels[index]!, description: labels[index]!, protected: false })),
    steps: operations.map((operation, index) => ({ stepId: step(index + 1),
      dependsOn: Array.from({ length: index }, (_, prior) => step(prior + 1)),
      operation, explanation: `step ${String(index + 1)}` })),
    assertions: [{ assertionId: id('assert', 1) as MathConstructionPlanV1['assertions'][number]['assertionId'],
      kind: 'exists', subjects: [object(8), object(9), object(10), object(11)], expected: true, required: true }],
  }
}

describe('spatial GeoGebra compiler', () => {
  it('compiles typed 3D objects without accepting raw script', () => {
    const validated = validateAndOrderPlanV1(spatialPlan())
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const compiled = compileGeometryPlanV1(validated.value)
    expect(compiled.commands.map(command => command.name)).toEqual([
      'Point', 'Point', 'Point', 'Point', 'Polygon', 'Plane', 'Sphere', 'Prism', 'Cone', 'Cylinder', 'Cube',
    ])
    const script = renderGeoGebraScriptV1(compiled.commands)
    expect(script).toContain('D=Point[{0,0,2}]')
    expect(script).toContain('alpha=Plane[A,B,C]')
    expect(script).toContain('s=Sphere[A,D]')
    expect(script).toContain('prism1=Prism[base,D]')
    expect(script).toContain('cone1=Cone[A,D,2]')
    expect(script).toContain('cylinder1=Cylinder[A,D,2]')
    expect(script).toContain('cube1=Cube[A,B,C]')
  })

  it('compiles a real parabola instead of an auxiliary-line approximation', () => {
    const plan: MathConstructionPlanV1 = {
      schemaVersion: 1, space: '2d', planId: id('plan', 200) as MathConstructionPlanV1['planId'],
      problemSummary: 'construct a parabola from its focus and directrix.', assumptions: [],
      objects: [
        declaration(21, 'point', 'F'), declaration(22, 'point', 'U'), declaration(23, 'point', 'V'),
        declaration(24, 'line', 'd'), declaration(25, 'conic', 'p'),
      ],
      steps: [
        construction(21, [], { kind: 'createPointByCoordinates', output: object(21), x: 1, y: 0 }),
        construction(22, [], { kind: 'createPointByCoordinates', output: object(22), x: -1, y: -2 }),
        construction(23, [], { kind: 'createPointByCoordinates', output: object(23), x: -1, y: 2 }),
        construction(24, [22, 23], { kind: 'createLineThroughPoints', output: object(24), points: [object(22), object(23)] }),
        construction(25, [21, 24], { kind: 'createParabola', output: object(25), focus: object(21), directrix: object(24) }),
      ],
      assertions: [{ assertionId: id('assert', 201) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'hasType', subjects: [object(25)], expected: 'conic', required: true }],
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)).toContain('p=Parabola[F,d]')
  })

  it('compiles an explicit conic equation as bounded algebra input', (): void => {
    const plan: MathConstructionPlanV1 = {
      schemaVersion: 1, space: '2d', planId: id('plan', 300) as MathConstructionPlanV1['planId'],
      problemSummary: 'Draw y squared equals four x.', assumptions: [],
      objects: [declaration(31, 'conic', 'c')],
      steps: [construction(31, [], {
        kind: 'createConicByEquation', output: object(31), equation: 'y^2 = 4x',
      })],
      assertions: [{ assertionId: id('assert', 301) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'hasType', subjects: [object(31)], expected: 'conic', required: true }],
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const command = compileGeometryPlanV1(validated.value).commands[0]
    expect(command?.name).toBe('ConicEquation')
    expect(renderGeoGebraScriptV1([command!])).toBe('c:y^2 = 4x')
  })

  it('compiles an exact line equation without auxiliary points', (): void => {
    const plan: MathConstructionPlanV1 = {
      schemaVersion: 1, space: '2d', planId: id('plan', 350) as MathConstructionPlanV1['planId'],
      problemSummary: 'Draw the line x = -1.', assumptions: [],
      objects: [declaration(35, 'line', 'd')],
      steps: [construction(35, [], {
        kind: 'createLineByEquation', output: object(35), equation: 'x = -1',
      })],
      assertions: [{ assertionId: id('assert', 351) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'hasType', subjects: [object(35)], expected: 'line', required: true }],
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const command = compileGeometryPlanV1(validated.value).commands[0]
    expect(command?.name).toBe('LineEquation')
    expect(renderGeoGebraScriptV1([command!])).toBe('d:x = -1')
  })

  it('compiles an arbitrary point constrained to a line object', (): void => {
    const plan: MathConstructionPlanV1 = {
      schemaVersion: 1, space: '2d', planId: id('plan', 360) as MathConstructionPlanV1['planId'],
      problemSummary: 'Choose A on d.', assumptions: [],
      objects: [declaration(36, 'line', 'd'), declaration(37, 'point', 'A')],
      steps: [
        construction(36, [], { kind: 'createLineByEquation', output: object(36), equation: 'x = -1' }),
        construction(37, [36], { kind: 'createPointOnObject', output: object(37), object: object(36) }),
      ],
      assertions: [{ assertionId: id('assert', 361) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'pointOnLine', subjects: [object(37), object(36)], expected: true, required: true }],
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)).toContain('A=Point[d]')
  })

  it('compiles a higher-degree implicit polynomial curve by equation', (): void => {
    const plan: MathConstructionPlanV1 = {
      schemaVersion: 1, space: '2d', planId: id('plan', 400) as MathConstructionPlanV1['planId'],
      problemSummary: 'Draw an implicit polynomial curve.', assumptions: [],
      objects: [declaration(41, 'curve', 'q')],
      steps: [construction(41, [], { kind: 'createImplicitCurveByEquation', output: object(41),
        equation: 'x^4 + y^3 = 2xy' })],
      assertions: [{ assertionId: id('assert', 401) as MathConstructionPlanV1['assertions'][number]['assertionId'],
        kind: 'hasType', subjects: [object(41)], expected: 'curve', required: true }],
    }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const command = compileGeometryPlanV1(validated.value).commands[0]
    expect(command?.name).toBe('ImplicitCurveEquation')
    expect(renderGeoGebraScriptV1([command!])).toBe('q:x^4 + y^3 = 2xy')
  })
})

function object(value: number): MathConstructionPlanV1['objects'][number]['objectId'] {
  return id('obj', value) as MathConstructionPlanV1['objects'][number]['objectId']
}

function step(value: number): MathConstructionPlanV1['steps'][number]['stepId'] {
  return id('step', value) as MathConstructionPlanV1['steps'][number]['stepId']
}

function declaration(
  value: number,
  kind: MathConstructionPlanV1['objects'][number]['kind'],
  variableName: string,
): MathConstructionPlanV1['objects'][number] {
  return { objectId: object(value), kind, variableName, description: variableName, protected: false }
}

function construction(
  value: number,
  dependencyValues: readonly number[],
  operation: MathConstructionPlanV1['steps'][number]['operation'],
): MathConstructionPlanV1['steps'][number] {
  return { stepId: step(value), dependsOn: dependencyValues.map(step), operation, explanation: `step ${String(value)}` }
}

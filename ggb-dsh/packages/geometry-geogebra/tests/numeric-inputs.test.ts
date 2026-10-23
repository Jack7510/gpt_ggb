import { describe, expect, it } from 'vitest'
import { constructionOperationV1Schema, mathConstructionPlanV1Schema } from '@ggb-copilot/geometry-contract'
import { validateAndOrderPlanV1 } from '@ggb-copilot/geometry-validation'
import { compileGeometryPlanV1, renderGeoGebraScriptV1 } from '../src/index.js'

const id = (prefix: string, n: number): string => `${prefix}_30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const reference = { kind: 'reference', objectId: id('obj', 1) }
const root = { kind: 'function', name: 'sqrt', argument: reference }

function plan(kind: string, value: unknown): ReturnType<typeof mathConstructionPlanV1Schema.parse> {
  const spatial = kind !== 'createPointByCoordinates'
  const operation = kind === 'createCylinder' ? { kind, centers: [id('obj', 2), id('obj', 3)], radius: value }
    : kind === 'createCone' ? { kind, center: id('obj', 2), apex: id('obj', 3), radius: value }
      : kind === 'createSphereByCenterRadius' ? { kind, center: id('obj', 2), radius: value }
        : { kind, x: -1, y: value, z: { kind: 'constant', name: 'pi' } }
  return mathConstructionPlanV1Schema.parse({ schemaVersion: 1, space: '3d', planId: id('plan', 1),
    problemSummary: 'Official numeric inputs retain dependencies.', assumptions: [], assertions: [],
    objects: ['slider', 'point', 'point', spatial ? kind === 'createSphereByCenterRadius' ? 'sphere' : 'solid' : 'point']
      .map((type, index) => ({ objectId: id('obj', index + 1), kind: type, variableName: ['t', 'O', 'P', 'result'][index],
        description: type, protected: false })),
    steps: [
      { operation: { kind: 'createSlider', output: id('obj', 1), min: 1, max: 9, step: 1, initialValue: 4, integer: true } },
      { operation: { kind: 'createPointByCoordinates', output: id('obj', 2), x: 0, y: 0, z: 0 } },
      { operation: { kind: 'createPointByCoordinates', output: id('obj', 3), x: 0, y: 0, z: 2 } },
      { operation: { ...operation, output: id('obj', 4) } },
    ].map((entry, index) => ({ ...entry, stepId: id('step', index + 1),
      dependsOn: index === 3 ? [id('step', 1), id('step', 2), id('step', 3)] : [], explanation: 'construct' })),
  })
}

describe('Manual numeric input semantics', () => {
  it.each([
    ['createPointByCoordinates', 'result=Point[{-1,sqrt(t),pi}]'],
    ['createSphereByCenterRadius', 'result=Sphere[O,sqrt(t)]'],
    ['createCone', 'result=Cone[O,P,sqrt(t)]'],
    ['createCylinder', 'result=Cylinder[O,P,sqrt(t)]'],
  ])('preserves expressions for %s and rejects missing dependencies/non-numeric objects', (kind, script) => {
    const value = plan(kind, root)
    const valid = validateAndOrderPlanV1(value)
    expect(valid.ok, valid.ok ? '' : JSON.stringify(valid.errors)).toBe(true)
    if (!valid.ok) return
    expect(renderGeoGebraScriptV1(compileGeometryPlanV1(valid.value).commands)).toContain(script)
    value.steps[3]!.dependsOn = [id('step', 2), id('step', 3)]
    expect(validateAndOrderPlanV1(value)).toMatchObject({ ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'PLAN_DEPENDENCY_MISSING' })]) })
    expect(validateAndOrderPlanV1(plan(kind, { ...reference, objectId: id('obj', 2) })))
      .toMatchObject({ ok: false, errors: expect.arrayContaining([
        expect.objectContaining({ code: 'PLAN_REFERENCE_TYPE_MISMATCH' }),
      ]) })
    expect(() => plan(kind, 't);DeleteAll()')).toThrow()
  })

  it('keeps literal compatibility and product bounds separate from AST support', () => {
    for (const kind of ['createPointByCoordinates', 'createSphereByCenterRadius', 'createCone', 'createCylinder']) {
      expect(validateAndOrderPlanV1(plan(kind, 2)).ok).toBe(true)
      expect(() => plan(kind, { kind: 'literal', value: 1_000_001 })).toThrow()
    }
    expect(constructionOperationV1Schema.safeParse({ kind: 'createFreePoint', output: id('obj', 1),
      layout: { x: 0, y: reference } }).success).toBe(false)
    expect(() => plan('createSphereByCenterRadius', { kind: 'literal', value: -2 })).toThrow()
  })
})

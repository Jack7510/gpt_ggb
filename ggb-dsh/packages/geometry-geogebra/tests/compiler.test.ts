import { geometryObjectIdSchema, stepIdSchema } from '@ggb-copilot/geometry-contract'
import { compileGeometryOperationV1 } from '../src/index.js'
import { describe, expect, it } from 'vitest'

import type { MathConstructionPlanV1 } from '@ggb-copilot/geometry-contract'
import { validateAndOrderPlanV1 } from '@ggb-copilot/geometry-validation'

import { compileGeometryPlanV1, encodeGeoGebraCommandV1, renderGeoGebraScriptV1 } from '../src/index.js'

const id = (prefix: string, value: number): string => `${prefix}_00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

function compilePlan(): MathConstructionPlanV1 {
  const objects = Array.from({ length: 15 }, (_, index) => ({
    objectId: id('obj', index + 1),
    kind: index < 5 || index === 8 || index === 13 ? 'point' as const
      : index === 7 || (index >= 10 && index <= 12) || index === 14 ? 'line' as const
        : index === 9 ? 'segment' as const : 'circle' as const,
    variableName: `O${index + 1}`,
    description: `object ${index + 1}`,
    protected: false,
  }))
  const operations: Array<Record<string, unknown>> = [
    { kind: 'createFreePoint', output: id('obj', 1), layout: { x: -1, y: 0 } },
    { kind: 'createPointByCoordinates', output: id('obj', 2), x: 1, y: 0 },
    { kind: 'createPointByCoordinates', output: id('obj', 3), x: 0, y: 2 },
    { kind: 'createPointByCoordinates', output: id('obj', 4), x: 2, y: 2 },
    { kind: 'createPointByCoordinates', output: id('obj', 5), x: 3, y: 1 },
    { kind: 'createCircleByCenterPoint', output: id('obj', 6), center: id('obj', 1), point: id('obj', 2) },
    { kind: 'createCircleByThreePoints', output: id('obj', 7), points: [id('obj', 1), id('obj', 2), id('obj', 3)] },
    { kind: 'createLineThroughPoints', output: id('obj', 8), points: [id('obj', 1), id('obj', 2)] },
    { kind: 'createIntersection', output: id('obj', 9), objects: [id('obj', 6), id('obj', 8)], index: 1 },
    { kind: 'createSegment', output: id('obj', 10), points: [id('obj', 1), id('obj', 3)] },
    { kind: 'createPerpendicularLine', output: id('obj', 11), point: id('obj', 3), line: id('obj', 8) },
    { kind: 'createParallelLine', output: id('obj', 12), point: id('obj', 4), line: id('obj', 8) },
    { kind: 'createAngleBisector', output: id('obj', 13), points: [id('obj', 1), id('obj', 3), id('obj', 2)] },
    { kind: 'createMidpoint', output: id('obj', 14), points: [id('obj', 1), id('obj', 2)] },
    { kind: 'invokeManualCommand', output: id('obj', 15),
      signatureId: 'perpendicular-bisector-31153bdc0b7a', command: 'PerpendicularBisector',
      arguments: [{ kind: 'object', objectId: id('obj', 10) }] },
    { kind: 'setCaption', target: id('obj', 14), caption: 'M' },
    { kind: 'setVisibility', target: id('obj', 13), visible: false },
    { kind: 'setStyle', target: id('obj', 10),
      style: { color: '#12ABEF', lineThickness: 4, lineStyle: 1, opacity: 0.5 } },
  ]
  return {
    schemaVersion: 1,
    planId: id('plan', 100) as MathConstructionPlanV1['planId'],
    problemSummary: 'Compile every M1 operation.', assumptions: [], objects,
    steps: operations.map((operation, index) => ({
      stepId: id('step', index + 1),
      dependsOn: Array.from({ length: index }, (_, prior) => id('step', prior + 1)),
      explanation: `step ${index + 1}`, operation,
    })) as MathConstructionPlanV1['steps'],
    assertions: ([{
      assertionId: id('assert', 200), kind: 'exists', subjects: [id('obj', 14)], expected: true, required: true,
    }] as MathConstructionPlanV1['assertions']),
  }
}

describe('compileGeometryPlanV1', () => {
  it('derives signed equation references from the frozen assertion', () => {
    const base = compilePlan()
    const input = { ...base, space: '2d', assertions: [{ assertionId: id('assert', 200),
      kind: 'hasEquation', subjects: [id('obj', 6)], expected: 'x^2+y^2=1', required: true }] }
    const validated = validateAndOrderPlanV1(input)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const compiled = compileGeometryPlanV1(validated.value)
    expect(compiled.probes).toEqual([{ queryId: id('assert', 200), kind: 'hasEquation',
      subjects: [{ objectId: id('obj', 6), label: 'O6' }], expected: 'x^2+y^2=1' }])
    const other = validateAndOrderPlanV1({ ...input, assertions: [{ ...input.assertions[0]!, expected: 'x^2+y^2=4' }] })
    expect(other.ok).toBe(true)
    if (other.ok) expect(compileGeometryPlanV1(other.value).probes[0]).toMatchObject({ expected: 'x^2+y^2=4' })
  })

  it('derives a bound native query from an existing polygon-on-circle assertion', () => {
    const base = compilePlan()
    const polygon = { objectId: id('obj', 30), kind: 'polygon', variableName: 'poly', description: 'polygon' }
    const validated = validateAndOrderPlanV1({ ...base, objects: [...base.objects, polygon],
      steps: [...base.steps, { stepId: id('step', 30), explanation: 'polygon', dependsOn: [id('step', 1), id('step', 2), id('step', 3)],
        operation: { kind: 'createPolygon', output: polygon.objectId,
          points: [id('obj', 1), id('obj', 2), id('obj', 3)] } }],
      assertions: [{ assertionId: id('assert', 30), kind: 'polygonOnCircle',
        subjects: [polygon.objectId, id('obj', 6)], expected: true, required: true }] })
    expect(validated.ok).toBe(true)
    if (validated.ok) expect(compileGeometryPlanV1(validated.value).probes).toEqual([{
      queryId: id('assert', 30), kind: 'polygonOnCircle', subjects: [
        { objectId: polygon.objectId, label: 'poly' }, { objectId: id('obj', 6), label: 'O6' }],
    }])
  })

  it('retains a mathematical prime Caption independently of the allocated variable name', () => {
    const base = compilePlan()
    const primed = { ...base, objects: base.objects.map((object, index) => index === 0
      ? { ...object, variableName: "F'" } : index === 1 ? { ...object, variableName: 'F' } : object) }
    const validated = validateAndOrderPlanV1(primed)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const compiled = compileGeometryPlanV1(validated.value)
    const output = compiled.commands.find(command => command.output?.objectId === id('obj', 1))!.output!
    expect(output.caption).toBe("F'")
    expect(output.label).toBe("F'")
    expect(output.label).toBe("F'")
    expect(compiled.expectedObjects[id('obj', 1)]).toBe(output.label)
    expect(new Set(Object.values(compiled.expectedObjects)).size).toBe(primed.objects.length)
    expect(renderGeoGebraScriptV1(compiled.commands)).toContain("F'=")
    expect(validateAndOrderPlanV1({ ...primed, objects: primed.objects.map((object, index) =>
      index === 0 ? { ...object, protected: true } : object) }).ok).toBe(false)
  })

  it.each(['P2', "P'"])('preserves the declared reflection caption %s and safe execution label', caption => {
    const base = compilePlan()
    const objects = base.objects.map((object, index) => index === 0
      ? { ...object, variableName: 'P' } : index === 13 ? { ...object, variableName: caption } : object)
    const steps = base.steps.map((step, index) => index === 13 ? { ...step,
      operation: { kind: 'invokeManualCommand' as const, output: id('obj', 14),
        signatureId: 'reflect-a9b715ab6a3c', command: 'Reflect', arguments: [
          { kind: 'object' as const, objectId: id('obj', 1) },
          { kind: 'object' as const, objectId: id('obj', 8) },
        ] } } : step)
    const validated = validateAndOrderPlanV1({ ...base, objects, steps })
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const compiled = compileGeometryPlanV1(validated.value)
    const reflection = compiled.commands.find(command => command.output?.objectId === id('obj', 14))
    expect(reflection?.output).toMatchObject({ label: caption, caption })
    expect(compiled.expectedObjects[id('obj', 14)]).toBe(caption)
  })

  it('compiles every M1 operation with deterministic, semantic execution labels', () => {
    const validated = validateAndOrderPlanV1(compilePlan())
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const first = compileGeometryPlanV1(validated.value)
    const second = compileGeometryPlanV1(validated.value)
    expect(first).toEqual(second)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.commands.map(item => item.name)).toEqual(expect.arrayContaining([
      'Point', 'Line', 'Segment', 'Circle', 'Intersect', 'Midpoint',
      'PerpendicularLine', 'ParallelLine', 'AngleBisector', 'SetCaption',
      'SetVisibleInView', 'SetColor', 'SetLineThickness', 'SetLineStyle', 'SetFilling', 'ManualCommand',
    ]))
    const executionVariableNames = Object.values(first.expectedObjects)
    expect(new Set(executionVariableNames).size).toBe(executionVariableNames.length)
    expect(executionVariableNames).toEqual(compilePlan().objects.map(object => object.variableName))
    expect(executionVariableNames.every(label => !label.startsWith('obj_'))).toBe(true)
    expect(first.commands.filter(item => item.output !== undefined).map(item => item.output?.caption))
      .toEqual(outputVariableNames(compilePlan()))
    expect(first.commands.find(item => item.name === 'SetColor')?.arguments.slice(1)).toEqual([
      { kind: 'number', value: 0x12 / 255 },
      { kind: 'number', value: 0xab / 255 },
      { kind: 'number', value: 0xef / 255 },
    ])
    // A dashed line is a program style, not only a Manual command: the applet applies line style 1.
    expect(first.commands.find(item => item.name === 'SetLineStyle')?.arguments.slice(1))
      .toEqual([{ kind: 'number', value: 1 }])
  })

  it.each([true, false])('compiles explicit label visibility %s to a typed ShowLabel command', labelVisible => {
    const plan = compilePlan()
    const last = plan.steps[plan.steps.length - 1]!
    const operation = { kind: 'setStyle' as const, target: id('obj', 10) as Extract<typeof last.operation,
      { kind: 'setStyle' }>['target'], style: { labelVisible } }
    const validated = validateAndOrderPlanV1({ ...plan,
      steps: [...plan.steps.slice(0, -1), { ...last, operation }] })
    expect(validated.ok).toBe(true)
    if (!validated.ok) throw new Error('label visibility fixture must be valid')
    const compiled = compileGeometryPlanV1(validated.value)
    const command = compiled.commands.find(item => item.name === 'ShowLabel')!
    expect(command.arguments).toEqual([
      { kind: 'object', objectId: id('obj', 10), label: 'O10' }, { kind: 'boolean', value: labelVisible },
    ])
    expect(command.output).toBeUndefined()
    expect(encodeGeoGebraCommandV1(command)).toBe(`ShowLabel[O10,${labelVisible}]`)
  })

  it('encodes labels, finite numbers and escaped strings at the final boundary', () => {
    const validated = validateAndOrderPlanV1(compilePlan())
    if (!validated.ok) throw new Error('fixture must be valid')
    const compiled = compileGeometryPlanV1(validated.value)
    const point = compiled.commands.find(item => item.name === 'Point')
    const caption = compiled.commands.find(item => item.name === 'SetCaption')
    expect(encodeGeoGebraCommandV1(point)).toBe(`${point?.output?.label}=Point[{-1,0}]`)
    expect(encodeGeoGebraCommandV1(caption)).toContain('SetCaption[')
    expect(() => encodeGeoGebraCommandV1({ ...point, output: { ...point?.output, label: 'A;DeleteAll' } })).toThrow()
    expect(() => encodeGeoGebraCommandV1({ ...point, arguments: [{ kind: 'number', value: Number.NaN }] })).toThrow()
    expect(() => encodeGeoGebraCommandV1({ ...point, name: 'ConicEquation',
      arguments: [{ kind: 'expression', value: 'y^2=4x;DeleteAll()' }] })).toThrow()
  })

  it('renders the same semantic labels that the applet executes', () => {
    const validated = validateAndOrderPlanV1(compilePlan())
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const script = renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)
    expect(script).toContain('O1=Point[{-1,0}]')
    expect(script).toContain('O8=Line[O1,O2]')
    expect(script).toContain('O14=Midpoint[O1,O2]')
    expect(script).toContain('O15=PerpendicularBisector[O10]')
    expect(script).not.toMatch(/ggb_[a-f0-9]{24}/)
  })

  it('compiles an evidence-bound Manual presentation without declaring a new output', () => {
    const source = compilePlan()
    const target = source.objects[9]!
    const plan = { ...source, steps: [{
      stepId: id('step', 900), dependsOn: [], explanation: '把线段改为虚线',
      operation: { kind: 'invokeManualPresentation' as const,
        signatureId: 'set-line-style-3d63cb24f931', command: 'SetLineStyle', arguments: [
          { kind: 'object' as const, objectId: target.objectId }, { kind: 'number' as const, value: 1 },
        ] },
    }], assertions: [] }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return

    const commands = compileGeometryPlanV1(validated.value).commands
    expect(commands).toMatchObject([{ name: 'ManualCommand',
      manual: { command: 'SetLineStyle', effect: 'presentation' } }])
    expect(commands[0]).not.toHaveProperty('output')
    expect(renderGeoGebraScriptV1(commands)).toBe(`SetLineStyle[${commands[0]?.arguments[0]?.kind === 'object' ? commands[0].arguments[0].label : ''},1]`)
  })

  it('collapses indexed members of one Manual result set into one command', () => {
    const objects = [
      { objectId: id('obj', 301), kind: 'conic' as const, variableName: 'c', description: 'ellipse', protected: false },
      { objectId: id('obj', 302), kind: 'point' as const, variableName: 'F1', description: 'left focus', protected: false },
      { objectId: id('obj', 303), kind: 'point' as const, variableName: 'F2', description: 'right focus', protected: false },
    ]
    const plan = {
      schemaVersion: 1 as const, planId: id('plan', 301) as MathConstructionPlanV1['planId'],
      problemSummary: 'Bind both foci.', assumptions: [], objects,
      steps: [
        { stepId: id('step', 301), dependsOn: [], explanation: 'ellipse',
          operation: { kind: 'createConicByEquation' as const, output: objects[0]!.objectId, equation: 'x^2+2y^2=2' } },
        ...[1, 2].map((resultIndex, offset) => ({
          stepId: id('step', 302 + offset), dependsOn: [id('step', 301)], explanation: 'focus',
          operation: { kind: 'invokeManualCommand' as const, output: objects[offset + 1]!.objectId,
            signatureId: 'focus-61f0e85d2eda', command: 'Focus', resultIndex,
            arguments: [{ kind: 'object' as const, objectId: objects[0]!.objectId }] },
        })),
      ], assertions: [],
    } as MathConstructionPlanV1
    const validated = validateAndOrderPlanV1(plan)
    if (!validated.ok) throw new Error('fixture must be valid')
    const manual = compileGeometryPlanV1(validated.value).commands.filter(command => command.name === 'ManualCommand')
    expect(manual).toHaveLength(1)
    expect(manual[0]?.manual?.resultOutputs?.map(output => [output.index, output.caption]))
      .toEqual([[1, 'F1'], [2, 'F2']])
    expect(manual[0]?.manual?.resultOutputs?.map(output => output.label)).toEqual(['F1', 'F2'])
  })

  it('keeps Unicode subscript captions separate from system execution names', () => {
    const validated = validateAndOrderPlanV1({
      ...compilePlan(),
      objects: compilePlan().objects.map((object, index) => index === 0
        ? { ...object, variableName: 'D₁' } : object),
    })
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const script = renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)
    expect(script).toContain('D1=Point[{-1,0}]')
    expect(script).not.toMatch(/ggb_[a-f0-9]{24}/)
  })

  it('refuses colliding normalized labels instead of silently renaming them', () => {
    const source = compilePlan()
    const validated = validateAndOrderPlanV1({ ...source, objects: source.objects.map((object, index) => (
      index === 0 ? { ...object, variableName: 'D₁' }
        : index === 1 ? { ...object, variableName: 'D1' } : object
    )) })
    expect(validated).toMatchObject({ ok: false, errors: [{ code: 'PLAN_UNSAFE_VARIABLE_NAME' }] })
  })

  it('compiles a triangle perimeter as explicit segments with readable execution labels', () => {
    const source = compilePlan()
    const objects = source.objects.slice(0, 7).map((object, index) => ({ ...object,
      kind: index < 3 ? 'point' as const : index < 6 ? 'segment' as const : 'circle' as const,
      variableName: ['A', 'B', 'C', 'seg1', 'seg2', 'seg3', 'circ1'][index]!,
    }))
    const plan: MathConstructionPlanV1 = { ...source, objects, steps: [
      { ...source.steps[0]!, operation: { kind: 'createPointByCoordinates', output: objects[0]!.objectId, x: -2, y: -1 } },
      { ...source.steps[1]!, operation: { kind: 'createPointByCoordinates', output: objects[1]!.objectId, x: 2, y: -1 } },
      { ...source.steps[2]!, operation: { kind: 'createPointByCoordinates', output: objects[2]!.objectId, x: 0.5, y: 2 } },
      { ...source.steps[3]!, operation: { kind: 'createSegment', output: objects[3]!.objectId,
        points: [objects[0]!.objectId, objects[1]!.objectId] } },
      { ...source.steps[4]!, operation: { kind: 'createSegment', output: objects[4]!.objectId,
        points: [objects[1]!.objectId, objects[2]!.objectId] } },
      { ...source.steps[5]!, operation: { kind: 'createSegment', output: objects[5]!.objectId,
        points: [objects[2]!.objectId, objects[0]!.objectId] } },
      { ...source.steps[6]!, operation: { kind: 'createCircleByThreePoints', output: objects[6]!.objectId,
        points: [objects[0]!.objectId, objects[1]!.objectId, objects[2]!.objectId] } },
    ], assertions: [] }
    const validated = validateAndOrderPlanV1(plan)
    expect(validated.ok, validated.ok ? '' : JSON.stringify(validated.errors)).toBe(true)
    if (!validated.ok) return
    const script = renderGeoGebraScriptV1(compileGeometryPlanV1(validated.value).commands)
    expect(script).toBe([
      'A=Point[{-2,-1}]', 'B=Point[{2,-1}]', 'C=Point[{0.5,2}]',
      'seg1=Segment[A,B]',
      'seg2=Segment[B,C]',
      'seg3=Segment[C,A]',
      'circ1=Circle[A,B,C]',
    ].join('\n'))
  })
})

function outputVariableNames(plan: MathConstructionPlanV1): string[] {
  const declarations = new Map(plan.objects.map(item => [item.objectId, item.variableName]))
  return plan.steps.flatMap(step => 'output' in step.operation ? [declarations.get(step.operation.output)!] : [])
}

it('compiles a variable suffix and mathematical Caption independently', () => {
  const base = compilePlan()
  const plan = { ...base, objects: base.objects.map((object, index) => index === 0
    ? { ...object, variableName: 'Fprime', caption: "F'" } : object) }
  const valid = validateAndOrderPlanV1(plan)
  expect(valid.ok).toBe(true)
  if (!valid.ok) return
  const compiled = compileGeometryPlanV1(valid.value)
  const output = compiled.commands.find(command => command.output?.objectId === id('obj', 1))!.output!
  expect(output).toMatchObject({ label: "F'", caption: "F'" })
  expect(encodeGeoGebraCommandV1({ ...compiled.commands[0]!, output: { ...output, label: "F'" } }))
    .toContain("F'=")
})

it('compiles mixed presentation properties without dropping visibility or Caption', () => {
  const target = geometryObjectIdSchema.parse(id('obj', 1))
  const step = stepIdSchema.parse(id('step', 1))
  const labels = new Map([[target, 'A']])
  const commands = compileGeometryOperationV1(step, { kind: 'setStyle', target,
    style: { color: '#ff0000', visible: false, caption: "A2", labelVisible: true } }, labels, labels)
  expect(commands.map(command => command.name)).toEqual(['SetColor', 'ShowLabel', 'SetVisibleInView', 'SetCaption'])
  expect(new Set(commands.map(command => command.commandId)).size).toBe(4)
  expect(commands.every(command => command.arguments[0]?.kind === 'object'
    && command.arguments[0].objectId === target)).toBe(true)
  expect(commands[2]!.arguments.slice(1)).toEqual([{ kind: 'number', value: 1 }, { kind: 'boolean', value: false }])
  expect(commands[3]!.arguments[1]).toEqual({ kind: 'string', value: 'A2' })
})

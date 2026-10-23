import { geometryObjectCaptionV1 } from '@ggb-copilot/geometry-contract'
import {
  geoGebraCommandV1Schema,
  type NativeGeometryQueryV1,
  type CommandId,
  type ConstructionOperationV1,
  type GeoGebraArgumentV1,
  type GeoGebraCommandV1,
  type GeometryObjectId,
  type NumericExpressionV1,
  type PlanId,
  type StepId,
} from '@ggb-copilot/geometry-contract'
import { createGeoGebraVariableNamesV1, type ValidatedPlanV1 } from '@ggb-copilot/geometry-validation'

import { sha256Hex } from './hash.js'

export { encodeGeoGebraCommandV1 } from './encoder.js'

export interface CompiledGeometryPlanV1 {
  readonly schemaVersion: 1
  readonly planId: PlanId
  readonly commands: readonly GeoGebraCommandV1[]
  readonly probes: readonly NativeGeometryQueryV1[]
  readonly expectedObjects: Readonly<Record<string, string>>
  readonly digest: string
}

/** Deterministically compile a validated plan without accessing runtime state. */
export function compileGeometryPlanV1(validated: ValidatedPlanV1): CompiledGeometryPlanV1 {
  const allocated = createGeoGebraVariableNamesV1(validated.plan.objects)
  if (allocated.errors.length > 0) throw new Error('Validated plan has unsafe execution labels.')
  const labels = allocated.labels
  const captions = new Map(validated.plan.objects.map(item => [item.objectId,
    geometryObjectCaptionV1(item, requiredLabel(item.objectId, labels))]))
  const commands = compileOperations(validated.orderedSteps, labels, captions)
  const probes: NativeGeometryQueryV1[] = validated.plan.assertions.flatMap((assertion): NativeGeometryQueryV1[] => {
    const subjects = assertion.subjects.map(objectId => ({ objectId, label: requiredLabel(objectId, labels) }))
    if (validated.plan.space === '2d' && (assertion.scope === undefined || assertion.scope === 'single_observation')) {
      if (assertion.kind === 'hasEquation' && typeof assertion.expected === 'string') return [{ queryId: assertion.assertionId,
        kind: 'hasEquation', subjects: [subjects[0]!], expected: assertion.expected }]
      if (assertion.kind === 'pointOnConic') return [{ queryId: assertion.assertionId,
        kind: 'pointOnConic', subjects: [subjects[0]!, subjects[1]!] }]
    }
    if (assertion.verificationProgram !== undefined && (typeof assertion.expected === 'boolean' || typeof assertion.expected === 'number')) {
      return [{ queryId: assertion.assertionId, kind: 'verificationProgram', subjects,
        program: assertion.verificationProgram, expected: assertion.expected, scope: 'single_observation' }]
    }
    if (assertion.kind === 'polygonOnCircle') return [{ queryId: assertion.assertionId,
      kind: 'polygonOnCircle' as const, subjects: [subjects[0]!, subjects[1]!] }]
    if (assertion.kind === 'regularPolygon' && validated.plan.space === '2d') return [{ queryId: assertion.assertionId,
      kind: 'regularPolygon' as const, subjects: [subjects[0]!] }]
    return []
  })
  const expectedObjects = Object.fromEntries([...labels.entries()])
  const content = { schemaVersion: 1 as const, planId: validated.plan.planId, commands, probes, expectedObjects }
  return { ...content, digest: sha256(canonicalJson(content)) }
}

/** Collapse model-declared result-set members into one native Manual command. */
function compileOperations(
  steps: ValidatedPlanV1['orderedSteps'],
  labels: ReadonlyMap<GeometryObjectId, string>,
  captions: ReadonlyMap<GeometryObjectId, string>,
): GeoGebraCommandV1[] {
  const grouped = new Map<string, typeof steps>()
  for (const step of steps) {
    if (step.operation.kind !== 'invokeManualCommand' || step.operation.resultIndex === undefined) continue
    const key = JSON.stringify([step.operation.signatureId, step.operation.command, step.operation.arguments])
    grouped.set(key, [...(grouped.get(key) ?? []), step])
  }
  const consumed = new Set<StepId>()
  return steps.flatMap(step => {
    if (consumed.has(step.stepId)) return []
    if (step.operation.kind !== 'invokeManualCommand' || step.operation.resultIndex === undefined) {
      return compileGeometryOperationV1(step.stepId, step.operation, labels, captions)
    }
    const key = JSON.stringify([step.operation.signatureId, step.operation.command, step.operation.arguments])
    const members = grouped.get(key) ?? [step]
    if (members.length < 2) return compileGeometryOperationV1(step.stepId, step.operation, labels, captions)
    members.forEach(member => consumed.add(member.stepId))
    return [compileManualResultSet(members, labels, captions)]
  })
}

function compileManualResultSet(
  steps: ValidatedPlanV1['orderedSteps'],
  labels: ReadonlyMap<GeometryObjectId, string>,
  captions: ReadonlyMap<GeometryObjectId, string>,
): GeoGebraCommandV1 {
  const first = steps[0]!
  if (first.operation.kind !== 'invokeManualCommand') throw new Error('Manual result group is invalid.')
  const resultOutputs = steps.map(step => {
    if (step.operation.kind !== 'invokeManualCommand' || step.operation.resultIndex === undefined) {
      throw new Error('Manual result group member is invalid.')
    }
    return { index: step.operation.resultIndex, ...objectOutput(step.operation.output, labels, captions) }
  }).sort((left, right) => left.index - right.index)
  const args = manualArguments(first.operation.arguments, labels)
  const primary = objectOutput(first.operation.output, labels, captions)
  return command(first.stepId, 0, 'ManualCommand', args, primary, {
    signatureId: first.operation.signatureId, command: first.operation.command,
    effect: 'construction', resultOutputs,
  })
}

/** Compile one typed operation using caller-owned object identities; also used for Review facts. */
export function compileGeometryOperationV1(
  stepId: StepId,
  operation: ConstructionOperationV1,
  labels: ReadonlyMap<GeometryObjectId, string>,
  captions: ReadonlyMap<GeometryObjectId, string>,
): GeoGebraCommandV1[] {
  const output = 'output' in operation ? objectOutput(operation.output, labels, captions) : undefined
  const create = (name: GeoGebraCommandV1['name'], args: GeoGebraArgumentV1[]): GeoGebraCommandV1[] => [
    command(stepId, 0, name, args, output),
  ]
  if (operation.kind === 'createFreePoint') return create('Point', numbers(
    operation.layout.x, operation.layout.y, ...optionalNumber(operation.layout.z),
  ))
  if (operation.kind === 'createPointByCoordinates') return create('Point', numericArguments([
    operation.x, operation.y, ...(operation.z === undefined ? [] : [operation.z]),
  ], labels))
  if (operation.kind === 'createPointOnObject') return create('PointOnObject', objects([operation.object], labels))
  if (operation.kind === 'createLineThroughPoints') return create('Line', objects(operation.points, labels))
  if (operation.kind === 'createLineByEquation') return create('LineEquation', [
    { kind: 'expression', value: operation.equation },
  ])
  if (operation.kind === 'createSegment') return create('Segment', objects(operation.points, labels))
  if (operation.kind === 'createCircleByCenterPoint') return create('Circle', objects([operation.center, operation.point], labels))
  if (operation.kind === 'createCircleByCenterRadius') return create('Circle', [
    ...objects([operation.center], labels),
    { kind: 'expression', value: renderNumericExpression(operation.radius, labels) },
  ])
  if (operation.kind === 'createCircleByThreePoints') return create('Circle', objects(operation.points, labels))
  if (operation.kind === 'createIntersection') return create('Intersect', [
    ...objects(operation.objects, labels), ...(operation.index === undefined ? [] : numbers(operation.index)),
  ])
  if (operation.kind === 'createMidpoint') return create('Midpoint', objects(operation.points, labels))
  if (operation.kind === 'createPerpendicularLine') return create('PerpendicularLine', objects([operation.point, operation.line], labels))
  if (operation.kind === 'createParallelLine') return create('ParallelLine', objects([operation.point, operation.line], labels))
  if (operation.kind === 'createAngleBisector') return create('AngleBisector', objects(operation.points, labels))
  if (operation.kind === 'createVector') return create('Vector', objects(operation.points, labels))
  if (operation.kind === 'createPolygon') return create('Polygon', objects(operation.points, labels))
  if (operation.kind === 'createConicByFivePoints') return create('Conic', objects(operation.points, labels))
  if (operation.kind === 'createConicByEquation') return create('ConicEquation', [
    { kind: 'expression', value: operation.equation },
  ])
  if (operation.kind === 'createImplicitCurveByEquation') return create('ImplicitCurveEquation', [
    { kind: 'expression', value: operation.equation },
  ])
  if (operation.kind === 'createParabola') return create('Parabola', objects([operation.focus, operation.directrix], labels))
  if (operation.kind === 'createEllipse') return create('Ellipse', objects([...operation.foci, operation.point], labels))
  if (operation.kind === 'createHyperbola') return create('Hyperbola', objects([...operation.foci, operation.point], labels))
  if (operation.kind === 'createPlaneThroughPoints') return create('Plane', objects(operation.points, labels))
  if (operation.kind === 'createPlaneIntersection') return create('Intersect', objects(operation.planes, labels))
  if (operation.kind === 'createParallelPlane') return create('Plane', objects([operation.point, operation.plane], labels))
  if (operation.kind === 'createPerpendicularPlane') return create('PerpendicularPlane', objects([operation.point, operation.line], labels))
  if (operation.kind === 'createSphereByCenterPoint') return create('Sphere', objects([operation.center, operation.point], labels))
  if (operation.kind === 'createSphereByCenterRadius') return create('Sphere', [
    ...objects([operation.center], labels), ...numericArguments([operation.radius], labels),
  ])
  if (operation.kind === 'createPrism') return create('Prism', objects([operation.base, operation.top], labels))
  if (operation.kind === 'createPyramid') return create('Pyramid', objects([operation.base, operation.apex], labels))
  if (operation.kind === 'createCone') return create('Cone', [
    ...objects([operation.center, operation.apex], labels), ...numericArguments([operation.radius], labels),
  ])
  if (operation.kind === 'createCylinder') return create('Cylinder', [
    ...objects(operation.centers, labels), ...numericArguments([operation.radius], labels),
  ])
  if (operation.kind === 'createCube') return create('Cube', objects(operation.points, labels))
  if (operation.kind === 'createSlider') {
    const slider = create('Slider', numbers(operation.min, operation.max, operation.step))
    const initial = command(stepId, 1, 'SetValue', [
      { kind: 'object', objectId: operation.output, label: requiredLabel(operation.output, labels) },
      { kind: 'number', value: operation.initialValue },
    ])
    return [...slider, initial]
  }
  if (operation.kind === 'createRotatedPoint') return create('Rotate', [
    ...objects([operation.point], labels),
    { kind: 'expression', value: renderAngleExpression(operation.angle, operation.angleUnit, labels) },
    ...objects([operation.center], labels),
  ])
  if (operation.kind === 'createRegularPolygonBySideCount') return create('Polygon', [
    ...objects(operation.points, labels),
    { kind: 'expression', value: renderNumericExpression(operation.count, labels) },
  ])
  if (operation.kind === 'invokeManualCommand') return [command(stepId, 0, 'ManualCommand',
    manualArguments(operation.arguments, labels), output, {
      signatureId: operation.signatureId, command: operation.command, effect: 'construction',
    })]
  if (operation.kind === 'invokeManualPresentation') return [command(stepId, 0, 'ManualCommand',
    manualArguments(operation.arguments, labels), undefined, {
      signatureId: operation.signatureId, command: operation.command, effect: 'presentation',
    })]
  if (operation.kind === 'setCaption') return presentation(stepId, 'SetCaption', operation.target, [{ kind: 'string', value: operation.caption }], labels)
  if (operation.kind === 'setVisibility') return presentation(stepId, 'SetVisibleInView', operation.target,
    [{ kind: 'number', value: 1 }, { kind: 'boolean', value: operation.visible }], labels)
  return compileStyle(stepId, operation.target, operation.style, labels)
}

function manualArguments(
  argumentsValue: Extract<ConstructionOperationV1,
    { kind: 'invokeManualCommand' | 'invokeManualPresentation' }>['arguments'],
  labels: ReadonlyMap<GeometryObjectId, string>,
): GeoGebraArgumentV1[] {
  return argumentsValue.map(argument => argument.kind === 'object'
    ? { kind: 'object', objectId: argument.objectId, label: requiredLabel(argument.objectId, labels) }
    : argument)
}

/** Render rotations with an explicit unit; omitted legacy values retain planner degree semantics. */
function renderAngleExpression(
  expression: NumericExpressionV1,
  unit: 'degrees' | 'radians' | undefined,
  labels: ReadonlyMap<GeometryObjectId, string>,
): string {
  const rendered = renderNumericExpression(expression, labels)
  return unit === 'radians' ? rendered : `(${rendered})°`
}

function compileStyle(
  stepId: StepId,
  target: GeometryObjectId,
  style: Extract<ConstructionOperationV1, { kind: 'setStyle' }>['style'],
  labels: ReadonlyMap<GeometryObjectId, string>,
): GeoGebraCommandV1[] {
  const specs: Array<[GeoGebraCommandV1['name'], GeoGebraArgumentV1[]]> = []
  if (style.color !== undefined) specs.push(['SetColor', hexColorArguments(style.color)])
  if (style.lineThickness !== undefined) specs.push(['SetLineThickness', numbers(style.lineThickness)])
  if (style.lineStyle !== undefined) specs.push(['SetLineStyle', numbers(style.lineStyle)])
  if (style.pointSize !== undefined) specs.push(['SetPointSize', numbers(style.pointSize)])
  if (style.opacity !== undefined) specs.push(['SetFilling', numbers(style.opacity)])
  if (style.labelVisible !== undefined) specs.push(['ShowLabel', [{ kind: 'boolean', value: style.labelVisible }]])
  if (style.visible !== undefined) specs.push(['SetVisibleInView',
    [{ kind: 'number', value: 1 }, { kind: 'boolean', value: style.visible }]])
  if (style.caption !== undefined) specs.push(['SetCaption', [{ kind: 'string', value: style.caption }]])
  return specs.map(([name, args], index) => command(stepId, index, name,
    [{ kind: 'object', objectId: target, label: requiredLabel(target, labels) }, ...args]))
}

function presentation(
  stepId: StepId,
  name: GeoGebraCommandV1['name'],
  target: GeometryObjectId,
  args: GeoGebraArgumentV1[],
  labels: ReadonlyMap<GeometryObjectId, string>,
): GeoGebraCommandV1[] {
  return [command(stepId, 0, name, [
    { kind: 'object', objectId: target, label: requiredLabel(target, labels) }, ...args,
  ])]
}

function command(
  stepId: StepId,
  index: number,
  name: GeoGebraCommandV1['name'],
  args: GeoGebraArgumentV1[],
  output?: GeoGebraCommandV1['output'],
  manual?: GeoGebraCommandV1['manual'],
): GeoGebraCommandV1 {
  const value = { commandId: deterministicCommandId(stepId, index), stepId, name, arguments: args,
    ...(output === undefined ? {} : { output }), ...(manual === undefined ? {} : { manual }) }
  return geoGebraCommandV1Schema.parse(value)
}

function deterministicCommandId(stepId: StepId, index: number): CommandId {
  const hex = sha256(`${stepId}:${index}`).slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = '8'
  const uuid = `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
  return `cmd_${uuid}` as CommandId
}

function objectOutput(
  objectId: GeometryObjectId,
  labels: ReadonlyMap<GeometryObjectId, string>,
  captions: ReadonlyMap<GeometryObjectId, string>,
): NonNullable<GeoGebraCommandV1['output']> {
  return {
    objectId,
    label: requiredLabel(objectId, labels),
    caption: requiredLabel(objectId, captions),
  }
}

function objects(ids: readonly GeometryObjectId[], labels: ReadonlyMap<GeometryObjectId, string>): GeoGebraArgumentV1[] {
  return ids.map(objectId => ({ kind: 'object', objectId, label: requiredLabel(objectId, labels) }))
}

function requiredLabel(id: GeometryObjectId, labels: ReadonlyMap<GeometryObjectId, string>): string {
  const label = labels.get(id)
  if (label === undefined) throw new Error('Validated plan contains an undeclared object reference.')
  return label
}

/** Keep literal compatibility while using the existing AST renderer for dependent scalar inputs. */
function numericArguments(values: readonly (number | NumericExpressionV1)[],
  labels: ReadonlyMap<GeometryObjectId, string>): GeoGebraArgumentV1[] {
  return values.map(value => typeof value === 'number' ? { kind: 'number', value }
    : { kind: 'expression', value: renderNumericExpression(value, labels) })
}

function numbers(...values: number[]): GeoGebraArgumentV1[] {
  return values.map(value => ({ kind: 'number', value }))
}

/** Render a validated numeric expression AST as a bounded expression string. */
function renderNumericExpression(
  expression: NumericExpressionV1,
  labels: ReadonlyMap<GeometryObjectId, string>,
): string {
  if (expression.kind === 'literal') return numberLiteral(expression.value)
  if (expression.kind === 'constant') return expression.name === 'e' ? 'ℯ' : expression.name
  if (expression.kind === 'reference') return requiredLabel(expression.objectId, labels)
  if (expression.kind === 'function') return `${expression.name}(${renderNumericExpression(expression.argument, labels)})`
  return `${renderNumericOperand(expression.left, expression.op, false, labels)}${expression.op}${renderNumericOperand(expression.right, expression.op, true, labels)}`
}

/** Keep grouping when precedence or a right-hand subtree requires it; do not change the AST. */
function renderNumericOperand(
  expression: NumericExpressionV1,
  parent: '+' | '-' | '*' | '/',
  right: boolean,
  labels: ReadonlyMap<GeometryObjectId, string>,
): string {
  const rendered = renderNumericExpression(expression, labels)
  if (expression.kind !== 'binary') return expression.kind === 'literal' && expression.value < 0
    ? `(${rendered})` : rendered
  const precedence = (op: '+' | '-' | '*' | '/'): number => op === '+' || op === '-' ? 1 : 2
  const needsGrouping = precedence(expression.op) < precedence(parent)
    || (right && precedence(expression.op) === precedence(parent))
  return needsGrouping ? `(${rendered})` : rendered
}

function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Unsafe numeric expression literal.')
  return String(value)
}

function optionalNumber(value: number | undefined): number[] {
  return value === undefined ? [] : [value]
}

function hexColorArguments(value: string): GeoGebraArgumentV1[] {
  return [1, 3, 5].map(offset => ({
    kind: 'number',
    value: Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
  }))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return sha256Hex(value)
}

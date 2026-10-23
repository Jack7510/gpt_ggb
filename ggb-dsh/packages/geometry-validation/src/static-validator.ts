import {
  mathConstructionPlanV1Schema,
  mathPlanningPlanV1Schema,
  geometryNameConflictsV1, geometryObjectCaptionV1, isReservedGeoGebraNameV1, normalizeGeometryNameV1,
  type ConstructionOperationV1,
  type ConstructionStepV1,
  type GeometryErrorCode,
  type GeometryErrorV1,
  type GeometryObjectDeclarationV1,
  type GeometryObjectId,
  type MathConstructionPlanV1,
  type MathPlanningPlanV1,
  type MathPlanningStepV1,
  type NumericExpressionV1,
  type StepId,
} from '@ggb-copilot/geometry-contract'
import { preflightAssertionCapabilitiesV1 } from './assertion-capabilities.js'

export interface ValidatedPlanV1 {
  readonly plan: MathConstructionPlanV1
  readonly orderedSteps: readonly ConstructionStepV1[]
}

export type PlanValidationResultV1 =
  | { readonly ok: true; readonly value: ValidatedPlanV1 }
  | { readonly ok: false; readonly errors: readonly GeometryErrorV1[] }

export type PlanningValidationResultV1 =
  | { readonly ok: true; readonly value: MathPlanningPlanV1 }
  | { readonly ok: false; readonly errors: readonly GeometryErrorV1[] }

/** Resolve requested labels once by the same rules at Planning and Codegen. */
export function createGeoGebraVariableNamesV1(
  objects: readonly GeometryObjectDeclarationV1[],
): { readonly labels: ReadonlyMap<GeometryObjectId, string>; readonly errors: readonly GeometryErrorV1[] } {
  const labels = new Map<GeometryObjectId, string>()
  const errors: GeometryErrorV1[] = []
  for (const object of objects) {
    const label = normalizeExecutionLabel(object.protected ? object.variableName : normalizeGeometryNameV1(object.variableName))
    if (label === null || (object.protected && label !== object.variableName)) {
      errors.push(unsafeVariableName(object))
      continue
    }
    labels.set(object.objectId, label)
  }
  const names = objects.map(object => ({ label: labels.get(object.objectId) ?? object.variableName,
    caption: object.protected ? object.caption : geometryObjectCaptionV1(object, labels.get(object.objectId) ?? object.variableName) }))
  for (const conflict of geometryNameConflictsV1(names)) errors.push(error('PLAN_UNSAFE_VARIABLE_NAME',
    'A label or Caption can belong to only one object.', { variableName: conflict.name,
      objectIds: conflict.owners.map(index => objects[index]!.objectId) }))
  for (const [index, name] of names.entries()) if ([name.label, name.caption].some(value => value !== undefined && isReservedGeoGebraNameV1(value))) {
    errors.push(unsafeVariableName(objects[index]!))
  }
  return { labels, errors }
}

/** Keep the Codegen guard, while also applying this review before Planning commits. */
export function reviewConstructionVariableNamesV1(plan: MathConstructionPlanV1): readonly GeometryErrorV1[] {
  return createGeoGebraVariableNamesV1(plan.objects).errors
}

function unsafeVariableName(object: GeometryObjectDeclarationV1): GeometryErrorV1 {
  return error('PLAN_UNSAFE_VARIABLE_NAME', 'Object label or Caption is invalid or reserved by GeoGebra.', {
    objectId: object.objectId, objectKind: object.kind, variableName: object.variableName,
    suggestedLabel: suggestedVariableName(object.kind),
  })
}

function normalizeExecutionLabel(value: string): string | null {
  const normalized = value.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, digit => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(digit)))
  return normalized.length <= 32 && /^[A-Za-z][A-Za-z0-9_]*'*$/.test(normalized) ? normalized : null
}

function suggestedVariableName(kind: MathConstructionPlanV1['objects'][number]['kind']): string {
  const names: Partial<Record<MathConstructionPlanV1['objects'][number]['kind'], string>> = {
    point: 'Pt1',
    line: 'line1', segment: 'seg1', vector: 'vec1', circle: 'circ1', conic: 'conic1', curve: 'curve1',
    polygon: 'poly1', plane: 'plane1', sphere: 'sphere1', polyhedron: 'poly1', solid: 'solid1', slider: 'slider1',
  }
  return names[kind] ?? 'obj1'
}

/** Validate semantic plan identity, references, dependency order, and dimensional space before code generation. */
export function validatePlanningPlanV1(input: unknown): PlanningValidationResultV1 {
  const parsed = mathPlanningPlanV1Schema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: [planningSchemaError(parsed.error.issues)] }
  const plan = parsed.data
  const errors: GeometryErrorV1[] = []
  errors.push(...createGeoGebraVariableNamesV1(plan.objects).errors)
  appendDuplicates(errors, plan.objects.map(item => item.objectId), 'objectId')
  appendDuplicates(errors, plan.objects.map(item => item.variableName), 'variableName')
  appendDuplicates(errors, plan.steps.map(item => item.stepId), 'stepId')
  appendDuplicates(errors, plan.assertions.map(item => item.assertionId), 'assertionId')
  const objects = new Set(plan.objects.map(item => item.objectId))
  const steps = new Set(plan.steps.map(item => item.stepId))
  for (const step of plan.steps) appendMissing(errors,
    step.dependsOn.filter(id => !steps.has(id)), 'stepDependency', step.stepId)
  for (const step of plan.steps) {
    appendMissing(errors, step.inputs.filter(id => !objects.has(id)), 'stepInput', step.stepId)
    if (step.output !== null && !objects.has(step.output)) appendMissing(errors, [step.output], 'stepOutput', step.stepId)
  }
  for (const assertion of plan.assertions) appendMissing(errors,
    assertion.subjects.filter(id => !objects.has(id)), 'assertionSubject', assertion.assertionId)
  errors.push(...preflightAssertionCapabilitiesV1(plan))
  if (topologicalOrder(plan.steps) === null) {
    errors.push(error('PLAN_DEPENDENCY_CYCLE', 'Plan steps contain a dependency cycle.', {}))
  }
  const spatial = plan.objects.find(item => ['plane', 'sphere', 'polyhedron', 'solid'].includes(item.kind))
  if (spatial !== undefined && plan.space !== '3d') errors.push(error(
    'PLAN_SPACE_MISMATCH', 'Spatial constructions must declare space as 3d.', { objectId: spatial.objectId },
  ))
  errors.push(...validatePlanningStructure(plan))
  return errors.length === 0 ? { ok: true, value: plan } : { ok: false, errors }
}

function validatePlanningStructure(plan: MathPlanningPlanV1): GeometryErrorV1[] {
  const errors: GeometryErrorV1[] = []
  const producers = new Map<GeometryObjectId, MathPlanningStepV1[]>()
  for (const step of plan.steps) {
    if (step.output !== null) producers.set(step.output, [...(producers.get(step.output) ?? []), step])
  }
  for (const object of plan.objects.filter(item => !item.protected)) {
    const owners = producers.get(object.objectId) ?? []
    if (owners.length !== 1) errors.push(error(
      'PLAN_OUTPUT_MISMATCH', 'Each planned object must have exactly one producing step.',
      { objectId: object.objectId, stepIds: owners.map(step => step.stepId) },
    ))
  }
  for (const step of plan.steps) {
    errors.push(...planningDependencyErrors(step, producers, plan.steps))
  }
  return errors
}

function planningDependencyErrors(
  step: MathPlanningStepV1,
  producers: ReadonlyMap<GeometryObjectId, readonly MathPlanningStepV1[]>,
  steps: readonly MathPlanningStepV1[],
): GeometryErrorV1[] {
  const reachable = dependencyClosure(step.dependsOn, steps)
  const missing = step.inputs.filter((objectId) => {
    const producer = producers.get(objectId)?.[0]
    return producer !== undefined && producer.stepId !== step.stepId && !reachable.has(producer.stepId)
  })
  return missing.length === 0 ? [] : [error(
    'PLAN_DEPENDENCY_MISSING', 'A planning step does not depend on the producers of its inputs.',
    { stepId: step.stepId, objectIds: [...new Set(missing)].sort() },
  )]
}

/** Validate an untrusted plan and deterministically topologically order its steps. */
export function validateAndOrderPlanV1(input: unknown): PlanValidationResultV1 {
  const parsed = mathConstructionPlanV1Schema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: [schemaError(parsed.error.issues)] }
  const plan = parsed.data
  const errors = validateIdentities(plan)
  errors.push(...createGeoGebraVariableNamesV1(plan.objects).errors)
  errors.push(...validateReferences(plan))
  errors.push(...validateInputKinds(plan))
  errors.push(...validateConstructionGraph(plan))
  errors.push(...validateSpatialSpace(plan))
  errors.push(...validateProtectedObjectOutputs(plan))
  errors.push(...validateSliderConfigurations(plan))
  errors.push(...preflightAssertionCapabilitiesV1(plan))
  const ordered = topologicalOrder(plan.steps)
  if (ordered === null) errors.push(error('PLAN_DEPENDENCY_CYCLE', 'Plan steps contain a dependency cycle.', {}))
  const names = plan.objects.map(object => ({ label: object.protected ? object.variableName : normalizeGeometryNameV1(object.variableName),
    caption: object.caption }))
  for (const step of ordered ?? []) if (step.operation.kind === 'setCaption') {
    const operation = step.operation
    const index = plan.objects.findIndex(object => object.objectId === operation.target)
    if (index < 0) continue
    names[index] = { ...names[index]!, caption: step.operation.caption }
    for (const conflict of geometryNameConflictsV1(names)) errors.push(error('PLAN_UNSAFE_VARIABLE_NAME',
      'Caption update conflicts with another object label or Caption.', { stepId: step.stepId, variableName: conflict.name }))
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { plan, orderedSteps: ordered ?? [] } }
}

type ObjectKind = MathConstructionPlanV1['objects'][number]['kind']
type InputRequirement = readonly [GeometryObjectId, readonly ObjectKind[]]

function validateInputKinds(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const declarations = new Map(plan.objects.map(object => [object.objectId, object.kind]))
  return plan.steps.flatMap(step => inputRequirements(step.operation).flatMap(([objectId, accepted]) => {
    const actual = declarations.get(objectId)
    if (actual === undefined || accepted.includes(actual)) return []
    return [error('PLAN_REFERENCE_TYPE_MISMATCH', 'A construction input has an incompatible object type.', {
      stepId: step.stepId, objectId, actual, expected: [...accepted],
    })]
  }))
}

function inputRequirements(operation: ConstructionOperationV1): InputRequirement[] {
  const points = (ids: readonly GeometryObjectId[]): InputRequirement[] => ids.map(id => [id, ['point']])
  if ('target' in operation) return []
  if (operation.kind === 'createSlider') return []
  if (operation.kind === 'createRotatedPoint') return points([operation.point, operation.center])
  if (['createFreePoint', 'createPointByCoordinates'].includes(operation.kind)) return []
  if (operation.kind === 'createPointOnObject') return [[operation.object, [
    'line', 'segment', 'circle', 'conic', 'curve', 'polygon',
  ]]]
  if ('points' in operation) return points(operation.points)
  if (operation.kind === 'createIntersection') return operation.objects.map(id => [id, [
    'line', 'segment', 'circle', 'conic', 'curve', 'plane', 'polygon', 'sphere',
  ]])
  if (operation.kind === 'createPlaneIntersection') return operation.planes.map(id => [id, ['plane']])
  if (operation.kind === 'createParabola') return [[operation.focus, ['point']], [operation.directrix, ['line']]]
  if (operation.kind === 'createEllipse' || operation.kind === 'createHyperbola') return points([...operation.foci, operation.point])
  if (operation.kind === 'createParallelPlane') return [[operation.point, ['point']], [operation.plane, ['plane']]]
  if (operation.kind === 'createPerpendicularPlane') return [[operation.point, ['point']], [operation.line, ['line']]]
  if (operation.kind === 'createPrism') return [[operation.base, ['polygon']], [operation.top, ['point']]]
  if (operation.kind === 'createPyramid') return [[operation.base, ['polygon']], [operation.apex, ['point']]]
  if (operation.kind === 'createCone') return [[operation.center, ['point']], [operation.apex, ['point']]]
  if (operation.kind === 'createCylinder') return points(operation.centers)
  if ('center' in operation) return 'point' in operation
    ? [[operation.center, ['point']], [operation.point, ['point']]] : [[operation.center, ['point']]]
  if ('line' in operation) return [[operation.point, ['point']], [operation.line,
    operation.kind === 'createPerpendicularLine' ? ['line', 'segment'] : ['line']]]
  return []
}

function validateSpatialSpace(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const spatialKinds = new Set(['plane', 'sphere', 'polyhedron', 'solid'])
  const spatialObject = plan.objects.find(object => spatialKinds.has(object.kind))
  const spatialStep = plan.steps.find(step => {
    const operation = step.operation
    return ('z' in operation && operation.z !== undefined)
      || ('layout' in operation && operation.layout.z !== undefined)
  })
  if (spatialObject === undefined && spatialStep === undefined) return []
  return plan.space === '3d' ? [] : [error(
    'PLAN_SPACE_MISMATCH', 'Spatial constructions must declare space as 3d.', {
      objectId: spatialObject?.objectId ?? null, stepId: spatialStep?.stepId ?? null,
    },
  )]
}

function validateConstructionGraph(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const errors: GeometryErrorV1[] = []
  const declarations = new Map(plan.objects.map(item => [item.objectId, item.kind]))
  const producers = new Map<GeometryObjectId, ConstructionStepV1[]>()
  for (const step of plan.steps) {
    const output = operationOutput(step.operation)
    if (output !== null) producers.set(output, [...(producers.get(output) ?? []), step])
  }
  for (const [objectId, steps] of producers) {
    const outputKind = operationOutputKind(steps[0]!.operation)
    if (steps.length !== 1 || outputKind !== null && declarations.get(objectId) !== outputKind) {
      errors.push(error('PLAN_OUTPUT_MISMATCH', 'A construction output is duplicated or has the wrong declared type.', {
        objectId, stepIds: steps.map(step => step.stepId),
      }))
    }
  }
  for (const step of plan.steps) errors.push(...missingProducerDependencies(step, producers, plan.steps))
  return errors
}

function missingProducerDependencies(
  step: ConstructionStepV1,
  producers: ReadonlyMap<GeometryObjectId, readonly ConstructionStepV1[]>,
  steps: readonly ConstructionStepV1[],
): GeometryErrorV1[] {
  const reachable = dependencyClosure(step.dependsOn, steps)
  const missing = operationReferences(step.operation).filter((objectId) => {
    const producer = producers.get(objectId)?.[0]
    return producer !== undefined && producer.stepId !== step.stepId && !reachable.has(producer.stepId)
  })
  return missing.length === 0 ? [] : [error(
    'PLAN_DEPENDENCY_MISSING', 'A step does not depend on the steps that produce its inputs.',
    { stepId: step.stepId, objectIds: [...new Set(missing)].sort() },
  )]
}

function dependencyClosure(
  seed: readonly StepId[], steps: readonly Pick<MathPlanningStepV1, 'stepId' | 'dependsOn'>[],
): Set<StepId> {
  const byId = new Map(steps.map(step => [step.stepId, step]))
  const found = new Set<StepId>()
  const pending = [...seed]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || found.has(current)) continue
    found.add(current)
    pending.push(...(byId.get(current)?.dependsOn ?? []))
  }
  return found
}

function operationOutputKind(operation: ConstructionOperationV1): MathConstructionPlanV1['objects'][number]['kind'] | null {
  if (!('output' in operation)) return null
  if (operation.kind === 'invokeManualCommand') return null
  if (['createFreePoint', 'createPointByCoordinates', 'createPointOnObject',
    'createIntersection', 'createMidpoint'].includes(operation.kind)) return 'point'
  if (['createLineThroughPoints', 'createLineByEquation', 'createPerpendicularLine', 'createParallelLine', 'createAngleBisector',
    'createPlaneIntersection'].includes(operation.kind)) return 'line'
  if (operation.kind === 'createSegment') return 'segment'
  if (operation.kind === 'createVector') return 'vector'
  if (['createCircleByCenterPoint', 'createCircleByCenterRadius',
    'createCircleByThreePoints'].includes(operation.kind)) return 'circle'
  if (['createConicByFivePoints', 'createConicByEquation', 'createParabola',
    'createEllipse', 'createHyperbola'].includes(operation.kind)) return 'conic'
  if (operation.kind === 'createImplicitCurveByEquation') return 'curve'
  if (operation.kind === 'createPolygon' || operation.kind === 'createRegularPolygonBySideCount') return 'polygon'
  if (operation.kind === 'createSlider') return 'slider'
  if (operation.kind === 'createRotatedPoint') return 'point'
  if (['createPlaneThroughPoints', 'createParallelPlane', 'createPerpendicularPlane'].includes(operation.kind)) return 'plane'
  if (['createSphereByCenterPoint', 'createSphereByCenterRadius'].includes(operation.kind)) return 'sphere'
  if (operation.kind === 'createCone' || operation.kind === 'createCylinder') return 'solid'
  return 'polyhedron'
}

function validateIdentities(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const errors: GeometryErrorV1[] = []
  appendDuplicates(errors, plan.objects.map(item => item.objectId), 'objectId')
  appendDuplicates(errors, plan.objects.map(item => item.variableName), 'variableName')
  appendDuplicates(errors, plan.steps.map(item => item.stepId), 'stepId')
  appendDuplicates(errors, plan.assertions.map(item => item.assertionId), 'assertionId')
  return errors
}

function appendDuplicates(errors: GeometryErrorV1[], values: readonly string[], field: string): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  if (duplicates.size > 0) errors.push(error('PLAN_DUPLICATE_ID', `Plan contains duplicate ${field} values.`, {
    field, values: [...duplicates].sort(),
  }))
}

function validateReferences(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const errors: GeometryErrorV1[] = []
  const objects = new Set<GeometryObjectId>(plan.objects.map(item => item.objectId))
  const steps = new Set<StepId>(plan.steps.map(item => item.stepId))
  for (const step of plan.steps) {
    appendMissing(errors, step.dependsOn.filter(id => !steps.has(id)), 'stepDependency', step.stepId)
    appendMissing(errors, operationReferences(step.operation).filter(id => !objects.has(id)), 'objectReference', step.stepId)
    const output = operationOutput(step.operation)
    if (output !== null && !objects.has(output)) appendMissing(errors, [output], 'stepOutput', step.stepId)
  }
  for (const assertion of plan.assertions) {
    appendMissing(errors, assertion.subjects.filter(id => !objects.has(id)), 'assertionSubject', assertion.assertionId)
  }
  return errors
}

function appendMissing(errors: GeometryErrorV1[], values: readonly string[], field: string, owner: string): void {
  if (values.length === 0) return
  errors.push(error('PLAN_REFERENCE_MISSING', `Plan ${field} refers to undeclared values.`, {
    field, owner, values: [...new Set(values)].sort(),
  }))
}

function validateProtectedObjectOutputs(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const protectedIds = new Set(plan.objects.filter(item => item.protected).map(item => item.objectId))
  return plan.steps.flatMap((step) => {
    const output = operationOutput(step.operation)
    if (output === null) return []
    return protectedIds.has(output)
      ? [error('PLAN_PROTECTED_OBJECT', 'A construction step cannot replace a protected canvas object.', {
          stepId: step.stepId, objectId: output,
        })]
      : []
  })
}

function validateSliderConfigurations(plan: MathConstructionPlanV1): GeometryErrorV1[] {
  const declarations = new Map(plan.objects.map(item => [item.objectId, item]))
  const errors: GeometryErrorV1[] = []
  for (const step of plan.steps) {
    const operation = step.operation
    if (operation.kind === 'createSlider') {
      const trusted = declarations.get(operation.output)?.slider
      if (trusted !== undefined && !sameSliderSpec(trusted, operation)) errors.push(error(
        'PLAN_CODEGEN_MISMATCH', 'Code generation changed the trusted Slider configuration.',
        { stepId: step.stepId, objectId: operation.output },
      ))
    }
    for (const reference of numericReferencesOfOperation(operation)) {
      if (declarations.get(reference)?.kind !== 'slider') {
        errors.push(error('PLAN_REFERENCE_TYPE_MISMATCH', 'Numeric expressions must reference only slider objects.', {
          stepId: step.stepId, objectId: reference,
        }))
      }
    }
  }
  return errors
}

function sameSliderSpec(
  expected: NonNullable<MathConstructionPlanV1['objects'][number]['slider']>,
  actual: Extract<ConstructionOperationV1, { kind: 'createSlider' }>,
): boolean {
  return expected.min === actual.min && expected.max === actual.max && expected.step === actual.step
    && expected.initialValue === actual.initialValue && expected.integer === actual.integer
}

function topologicalOrder<T extends ConstructionStepV1 | MathPlanningStepV1>(steps: readonly T[]): T[] | null {
  const byId = new Map(steps.map(step => [step.stepId, step]))
  const indegree = new Map(steps.map(step => [step.stepId, 0]))
  const outgoing = new Map<StepId, StepId[]>()
  for (const step of steps) {
    for (const dependency of new Set(step.dependsOn)) {
      if (!byId.has(dependency)) continue
      indegree.set(step.stepId, (indegree.get(step.stepId) ?? 0) + 1)
      outgoing.set(dependency, [...(outgoing.get(dependency) ?? []), step.stepId])
    }
  }
  const ready = steps.filter(step => indegree.get(step.stepId) === 0)
  const ordered: T[] = []
  while (ready.length > 0) {
    const current = ready.shift()
    if (current === undefined) break
    ordered.push(current)
    for (const target of outgoing.get(current.stepId) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1
      indegree.set(target, remaining)
      if (remaining === 0) ready.push(byId.get(target)!)
    }
  }
  return ordered.length === steps.length ? ordered : null
}

function operationOutput(operation: ConstructionOperationV1): GeometryObjectId | null {
  return 'output' in operation ? operation.output : null
}

function operationReferences(operation: ConstructionOperationV1): GeometryObjectId[] {
  let refs: GeometryObjectId[] = []
  if (operation.kind === 'invokeManualCommand' || operation.kind === 'invokeManualPresentation') refs = operation.arguments.flatMap(argument =>
    argument.kind === 'object' ? [argument.objectId] : [])
  else if ('points' in operation) refs = [...operation.points]
  else if ('objects' in operation) refs = [...operation.objects]
  else if ('planes' in operation) refs = [...operation.planes]
  else if ('centers' in operation) refs = [...operation.centers]
  else if ('foci' in operation) refs = [...operation.foci, operation.point]
  else if ('focus' in operation) refs = [operation.focus, operation.directrix]
  else if ('object' in operation) refs = [operation.object]
  else if ('base' in operation) refs = [operation.base, 'top' in operation ? operation.top : operation.apex]
  else if (operation.kind === 'createCone') refs = [operation.center, operation.apex]
  else if ('plane' in operation) refs = [operation.point, operation.plane]
  else if ('center' in operation) refs = 'point' in operation ? [operation.center, operation.point] : [operation.center]
  else if ('line' in operation) refs = [operation.point, operation.line]
  else if ('target' in operation) refs = [operation.target]
  return [...refs, ...numericReferencesOfOperation(operation)]
}

function numericReferencesOfOperation(operation: ConstructionOperationV1): GeometryObjectId[] {
  if (operation.kind === 'createPointByCoordinates') return [operation.x, operation.y,
    ...(operation.z === undefined ? [] : [operation.z])].flatMap(numericReferences)
  if ('radius' in operation) return numericReferences(operation.radius)
  if (operation.kind === 'createRotatedPoint') return numericReferences(operation.angle)
  if (operation.kind === 'createRegularPolygonBySideCount') return numericReferences(operation.count)
  return []
}

function numericReferences(expression: number | NumericExpressionV1): GeometryObjectId[] {
  if (typeof expression === 'number') return []
  if (expression.kind === 'literal' || expression.kind === 'constant') return []
  if (expression.kind === 'reference') return [expression.objectId]
  if (expression.kind === 'function') return numericReferences(expression.argument)
  return [...numericReferences(expression.left), ...numericReferences(expression.right)]
}

function schemaError(issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[]): GeometryErrorV1 {
  const details = schemaIssueDetails(issues)
  const versionIssue = issues.some(issue => issue.path.length === 1 && issue.path[0] === 'schemaVersion')
  const complexityIssue = issues.some(issue => issue.code === 'too_big')
  const operationIssue = issues.some(issue => issue.path.includes('operation') && issue.path.includes('kind'))
  if (versionIssue) return error('PLAN_VERSION_UNSUPPORTED', 'Plan schema version is unsupported.', details)
  if (complexityIssue) return error('PLAN_COMPLEXITY_EXCEEDED', 'Plan exceeds a configured complexity limit.', details)
  if (operationIssue) return error('PLAN_OPERATION_UNSUPPORTED', 'Plan contains an unsupported operation.', details)
  return error('PLAN_SCHEMA_INVALID', 'Plan does not match MathConstructionPlanV1.', details)
}

function planningSchemaError(issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[]): GeometryErrorV1 {
  const classified = schemaError(issues)
  return classified.code === 'PLAN_SCHEMA_INVALID'
    ? { ...classified, message: 'Plan does not match MathPlanningPlanV1.' }
    : classified
}

/** Return bounded schema locations without exposing untrusted field names or values. */
function schemaIssueDetails(issues: readonly { readonly code: string; readonly path: readonly PropertyKey[] }[]): GeometryErrorV1['details'] {
  return {
    issueCount: Math.min(issues.length, 32),
    issueCodes: uniqueBounded(issues.map(issue => issue.code)),
    issuePaths: uniqueBounded(issues.map(issue => safeSchemaPath(issue.path))),
  }
}

function uniqueBounded(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, 16)
}

function safeSchemaPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'root'
  return path.map(segment => typeof segment === 'number' ? `[${segment}]`
    : schemaFieldNames.has(String(segment)) ? String(segment) : '<unknown>').join('.')
}

const schemaFieldNames = new Set([
  'schemaVersion', 'planId', 'problemSummary', 'assumptions', 'id', 'text', 'source',
  'objects', 'objectId', 'kind', 'variableName', 'description', 'protected',
  'steps', 'stepId', 'dependsOn', 'inputs', 'instruction', 'expectedResult', 'operation', 'explanation', 'output', 'layout', 'x', 'y', 'z', 'space',
  'object', 'equation',
  'points', 'center', 'point', 'index', 'target', 'label', 'visible', 'style', 'color',
  'lineThickness', 'pointSize', 'opacity', 'assertions', 'assertionId', 'subjects', 'expected', 'required',
  'focus', 'directrix', 'foci', 'plane', 'planes', 'radius', 'base', 'top', 'apex', 'centers',
  'min', 'max', 'step', 'initialValue', 'integer', 'angle', 'count', 'op', 'left', 'right', 'value', 'kind',
])

function error(code: GeometryErrorCode, message: string, details: GeometryErrorV1['details']): GeometryErrorV1 {
  return { schemaVersion: 1, code, phase: 'plan', retry: 'after_replan', message, details }
}

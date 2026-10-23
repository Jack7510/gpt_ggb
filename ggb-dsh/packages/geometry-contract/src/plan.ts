import { z } from 'zod'
import { verificationProgramV1Schema } from './verification-program.js'

import {
  assertionIdSchema, geometryObjectIdSchema, planIdSchema, stepIdSchema, type GeometryObjectId,
} from './ids.js'
import { geometrySchemaVersion } from './version.js'
import { isReservedGeoGebraNameV1, normalizeGeometryNameV1 } from './names.js'

export const MAX_PLAN_OBJECTS = 128
export const MAX_PLAN_STEPS = 64
export const MAX_PLAN_ASSERTIONS = 128

// Requested GGB Script variable names may carry trailing prime marks.
export const geometryVariableNameV1Schema = z.string().trim().min(1).max(32)
  .regex(/^[\p{L}][\p{L}\p{N}_]*['′″]*$/u)
  .refine(value => !isReservedGeoGebraNameV1(value), 'geometry_name_reserved')
/** Normalize newly requested Captions before validating the unified namespace. */
export const geometryCaptionV1Schema = z.string().trim().min(1).max(32)
  .transform(normalizeGeometryNameV1)
  .refine(value => !isReservedGeoGebraNameV1(value), 'geometry_name_reserved')
/** Explicit Caption overrides the default, which is the actual allocated label. */
export function geometryObjectCaptionV1(object: { readonly variableName: string; readonly caption?: string | undefined },
  allocatedVariableName: string): string {
  return normalizeGeometryNameV1(object.caption ?? allocatedVariableName)
}
const finiteCoordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000)
const objectKindSchema = z.enum([
  'point', 'line', 'segment', 'vector', 'circle', 'conic', 'curve', 'polygon',
  'plane', 'sphere', 'polyhedron', 'solid', 'slider', 'object',
])
const assumptionSourceSchema = z.enum(['explicit', 'construction', 'layout', 'inferred'])
const manualSignatureIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,95}$/)
const manualCommandNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/)

/** Product-reviewed bounds for one user-controllable numeric slider. */
export const sliderSpecV1Schema = z.object({
  min: finiteCoordinateSchema,
  max: finiteCoordinateSchema,
  step: finiteCoordinateSchema.positive(),
  initialValue: finiteCoordinateSchema,
  integer: z.boolean(),
}).strict().superRefine((value, context): void => {
  if (value.min >= value.max) context.addIssue({ code: 'custom', path: ['min'], message: 'min must be less than max' })
  if (value.initialValue < value.min || value.initialValue > value.max) {
    context.addIssue({ code: 'custom', path: ['initialValue'], message: 'initial value must be within the slider range' })
  }
  if (value.step > value.max - value.min) {
    context.addIssue({ code: 'custom', path: ['step'], message: 'step must not exceed the slider range' })
  }
  if (value.integer && ![value.min, value.max, value.step, value.initialValue].every(Number.isInteger)) {
    context.addIssue({ code: 'custom', path: ['integer'], message: 'integer slider values must be integers' })
  }
})

/** Polynomial equation accepted for direct, label-owned GeoGebra construction. */
export const geoGebraPolynomialEquationV1Schema = z.string().trim().min(3).max(256)
  .refine(isSafePolynomialEquation, 'equation must be a bounded polynomial equality in x and y')

/** Linear equation accepted for direct, label-owned GeoGebra line construction. */
export const geoGebraLinearEquationV1Schema = geoGebraPolynomialEquationV1Schema
  .refine(isSafeLinearEquation, 'equation must contain only linear x, y and constant terms')

export const geometryObjectDeclarationV1Schema = z.object({
  objectId: geometryObjectIdSchema,
  kind: objectKindSchema,
  variableName: geometryVariableNameV1Schema,
  caption: geometryCaptionV1Schema.optional(),
  description: z.string().trim().min(1).max(500),
  protected: z.boolean().default(false),
  parameterRole: z.string().trim().min(1).max(200).optional(),
  slider: sliderSpecV1Schema.optional(),
}).strict().superRefine((value, context): void => {
  if (value.kind === 'object' && !value.protected) {
    context.addIssue({ code: 'custom', path: ['kind'], message: 'generic object kind is reserved for existing canvas objects' })
  }
  if (value.kind !== 'slider' && (value.parameterRole !== undefined || value.slider !== undefined)) {
    context.addIssue({ code: 'custom', path: ['slider'], message: 'slider metadata requires kind slider' })
  }
})

const styleSchema = z.object({
  visible: z.boolean().optional(),
  caption: z.string().max(128).optional(),
  labelVisible: z.boolean().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  lineThickness: z.number().int().min(1).max(13).optional(),
  // GeoGebra line styles: 0 solid, 1 dashed, 2 dotted, 3 dash-dot, 4 dash-dot-dot. The Task Brief has
  // always accepted a dashed presentation goal, but the program patch could not express it, so a
  // request such as "用虚线连接" was unreachable end to end (run_54080dc4 burned its token budget
  // retrying `style:{lineStyle:2}` against a schema that refused the key).
  lineStyle: z.number().int().min(0).max(4).optional(),
  pointSize: z.number().int().min(1).max(9).optional(),
  opacity: z.number().min(0).max(1).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'style must set at least one property')

/** Safe numeric expression AST that may reference slider values; never a raw string. */
export type NumericExpressionV1 =
  | { readonly kind: 'literal'; readonly value: number }
  | { readonly kind: 'constant'; readonly name: 'pi' | 'e' | 'deg' }
  | { readonly kind: 'reference'; readonly objectId: GeometryObjectId }
  | { readonly kind: 'function'; readonly name: 'sqrt' | 'abs' | 'exp' | 'ln' | 'sin' | 'cos' | 'tan'; readonly argument: NumericExpressionV1 }
  | {
      readonly kind: 'binary'
      readonly op: '+' | '-' | '*' | '/'
      readonly left: NumericExpressionV1
      readonly right: NumericExpressionV1
    }

export const numericExpressionV1Schema: z.ZodType<NumericExpressionV1> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('constant'), name: z.enum(['pi', 'e', 'deg']) }).strict(),
  z.object({ kind: z.literal('reference'), objectId: geometryObjectIdSchema }).strict(),
  z.object({
    kind: z.literal('function'), name: z.enum(['sqrt', 'abs', 'exp', 'ln', 'sin', 'cos', 'tan']),
    argument: numericExpressionV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('binary'),
    op: z.enum(['+', '-', '*', '/']),
    left: numericExpressionV1Schema,
    right: numericExpressionV1Schema,
  }).strict(),
]))

/** Cartesian components and spatial radii preserve legacy numbers and dependent numeric expressions. */
const coordinateValueSchema = z.union([finiteCoordinateSchema, numericExpressionV1Schema])
  .refine(value => typeof value === 'number' || value.kind !== 'literal'
    || finiteCoordinateSchema.safeParse(value.value).success, 'coordinate literal exceeds product bounds')
const spatialRadiusValueSchema = coordinateValueSchema.refine(value =>
  typeof value === 'number' ? value > 0 : value.kind !== 'literal' || value.value > 0,
  'radius literal must be positive')

/** Pinned Manual arguments: numeric objects use object bindings; arbitrary expressions are excluded. */
export const manualCommandArgumentV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), objectId: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('string'), value: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
])

const createOperationSchemas = [
  z.object({ kind: z.literal('createFreePoint'), output: geometryObjectIdSchema,
    layout: z.object({ x: finiteCoordinateSchema, y: finiteCoordinateSchema,
      z: finiteCoordinateSchema.optional() }).strict() }).strict(),
  z.object({ kind: z.literal('createPointByCoordinates'), output: geometryObjectIdSchema,
    x: coordinateValueSchema, y: coordinateValueSchema, z: coordinateValueSchema.optional() }).strict(),
  z.object({ kind: z.literal('createPointOnObject'), output: geometryObjectIdSchema,
    object: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createLineThroughPoints'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createLineByEquation'), output: geometryObjectIdSchema,
    equation: geoGebraLinearEquationV1Schema }).strict(),
  z.object({ kind: z.literal('createSegment'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createCircleByCenterPoint'), output: geometryObjectIdSchema,
    center: geometryObjectIdSchema, point: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createCircleByCenterRadius'), output: geometryObjectIdSchema,
    center: geometryObjectIdSchema, radius: numericExpressionV1Schema }).strict(),
  z.object({ kind: z.literal('createCircleByThreePoints'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createIntersection'), output: geometryObjectIdSchema,
    objects: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]), index: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z.object({ kind: z.literal('createMidpoint'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createPerpendicularLine'), output: geometryObjectIdSchema,
    point: geometryObjectIdSchema, line: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createParallelLine'), output: geometryObjectIdSchema,
    point: geometryObjectIdSchema, line: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createAngleBisector'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createVector'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createPolygon'), output: geometryObjectIdSchema,
    points: z.array(geometryObjectIdSchema).min(3).max(32) }).strict(),
  z.object({ kind: z.literal('createConicByFivePoints'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema, geometryObjectIdSchema,
      geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createConicByEquation'), output: geometryObjectIdSchema,
    equation: geoGebraPolynomialEquationV1Schema }).strict(),
  z.object({ kind: z.literal('createImplicitCurveByEquation'), output: geometryObjectIdSchema,
    equation: geoGebraPolynomialEquationV1Schema }).strict(),
  z.object({ kind: z.literal('createParabola'), output: geometryObjectIdSchema,
    focus: geometryObjectIdSchema, directrix: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createEllipse'), output: geometryObjectIdSchema,
    foci: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]), point: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createHyperbola'), output: geometryObjectIdSchema,
    foci: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]), point: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createPlaneThroughPoints'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createPlaneIntersection'), output: geometryObjectIdSchema,
    planes: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]) }).strict(),
  z.object({ kind: z.literal('createParallelPlane'), output: geometryObjectIdSchema,
    point: geometryObjectIdSchema, plane: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createPerpendicularPlane'), output: geometryObjectIdSchema,
    point: geometryObjectIdSchema, line: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createSphereByCenterPoint'), output: geometryObjectIdSchema,
    center: geometryObjectIdSchema, point: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createSphereByCenterRadius'), output: geometryObjectIdSchema,
    center: geometryObjectIdSchema, radius: spatialRadiusValueSchema }).strict(),
  z.object({ kind: z.literal('createPrism'), output: geometryObjectIdSchema,
    base: geometryObjectIdSchema, top: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createPyramid'), output: geometryObjectIdSchema,
    base: geometryObjectIdSchema, apex: geometryObjectIdSchema }).strict(),
  z.object({ kind: z.literal('createCone'), output: geometryObjectIdSchema,
    center: geometryObjectIdSchema, apex: geometryObjectIdSchema, radius: spatialRadiusValueSchema }).strict(),
  z.object({ kind: z.literal('createCylinder'), output: geometryObjectIdSchema,
    centers: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]), radius: spatialRadiusValueSchema }).strict(),
  z.object({ kind: z.literal('createCube'), output: geometryObjectIdSchema,
    points: z.union([z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]),
      z.tuple([geometryObjectIdSchema, geometryObjectIdSchema, geometryObjectIdSchema])]) }).strict(),
  sliderSpecV1Schema.safeExtend({
    kind: z.literal('createSlider'), output: geometryObjectIdSchema,
  }).strict(),
  z.object({ kind: z.literal('createRotatedPoint'), output: geometryObjectIdSchema,
    point: geometryObjectIdSchema, center: geometryObjectIdSchema, angle: numericExpressionV1Schema,
    angleUnit: z.enum(['degrees', 'radians']).optional() }).strict(),
  z.object({ kind: z.literal('createRegularPolygonBySideCount'), output: geometryObjectIdSchema,
    points: z.tuple([geometryObjectIdSchema, geometryObjectIdSchema]),
    count: numericExpressionV1Schema }).strict(),
  z.object({ kind: z.literal('invokeManualCommand'), output: geometryObjectIdSchema,
    signatureId: manualSignatureIdSchema, command: manualCommandNameSchema,
    arguments: z.array(manualCommandArgumentV1Schema).max(16),
    resultIndex: z.number().int().min(1).max(8).optional() }).strict(),
  z.object({ kind: z.literal('invokeManualPresentation'),
    signatureId: manualSignatureIdSchema, command: manualCommandNameSchema,
    arguments: z.array(manualCommandArgumentV1Schema).min(1).max(16) }).strict(),
] as const

const presentationOperationSchemas = [
  z.object({ kind: z.literal('setCaption'), target: geometryObjectIdSchema, caption: geometryCaptionV1Schema }).strict(),
  z.object({ kind: z.literal('setVisibility'), target: geometryObjectIdSchema, visible: z.boolean() }).strict(),
  z.object({ kind: z.literal('setStyle'), target: geometryObjectIdSchema, style: styleSchema }).strict(),
] as const

export const constructionOperationV1Schema = z.discriminatedUnion('kind', [
  ...createOperationSchemas, ...presentationOperationSchemas,
])

export const mathPlanningStepV1Schema = z.object({
  stepId: stepIdSchema,
  dependsOn: z.array(stepIdSchema).max(MAX_PLAN_STEPS),
  output: geometryObjectIdSchema.nullable(),
  inputs: z.array(geometryObjectIdSchema).max(32),
  instruction: z.string().trim().min(1).max(500),
  expectedResult: z.string().trim().min(1).max(500),
}).strict()

export const constructionStepV1Schema = z.object({
  stepId: stepIdSchema,
  dependsOn: z.array(stepIdSchema).max(MAX_PLAN_STEPS),
  operation: constructionOperationV1Schema,
  explanation: z.string().trim().min(1).max(500),
}).strict()

/** The one assertion vocabulary: the plan schema, the probe schema and the capability table all read it. */
export const assertionKindV1Schema = z.enum([
  'exists', 'hasType', 'collinear', 'parallel', 'perpendicular', 'equalLength',
  'length', 'angle', 'pointOnLine', 'pointOnCircle', 'pointOnConic', 'pointOnPlane', 'pointOnSphere',
  'coplanar', 'midpoint', 'concurrent', 'tangent', 'dependsOn', 'dynamicPointOnCircle',
  'valueInInterval', 'hasEquation', 'regularPolygon', 'polygonOnCircle', 'polygonVertexCount',
])

/** Per-kind subject arity. Keyed by the shared kind enum, so a new kind must declare its arity. */
const assertionSubjectCounts: Readonly<Record<z.infer<typeof assertionKindV1Schema>, readonly number[]>> = {
  exists: [1, 2, 3, 4], hasType: [1], collinear: [3], parallel: [2], perpendicular: [2],
  equalLength: [2], length: [1, 2], angle: [3], pointOnLine: [2], pointOnCircle: [2], pointOnConic: [2],
  pointOnPlane: [2], pointOnSphere: [2], coplanar: [4],
  midpoint: [3], concurrent: [3, 4], tangent: [2],
  dependsOn: [2],
  dynamicPointOnCircle: [3],
  valueInInterval: [1],
  hasEquation: [1],
  regularPolygon: [1], polygonOnCircle: [2], polygonVertexCount: [1],
}

/**
 * One bounded numeric interval. A `null` bound is unbounded on that side, so `y_P > 0` is
 * `{min: 0, max: null, includeMin: false}` rather than a sentinel number. A closed singleton
 * `{min: 1, max: 1}` retains an exact requested scalar for observation-time tolerance checking.
 */
export const numericIntervalV1Schema = z.object({
  min: finiteCoordinateSchema.nullable(),
  max: finiteCoordinateSchema.nullable(),
  includeMin: z.boolean().default(true),
  includeMax: z.boolean().default(true),
}).strict()
  .refine(value => value.min !== null || value.max !== null, 'interval needs at least one bound')
  .refine(value => value.min === null || value.max === null || value.min < value.max
    || value.min === value.max && value.includeMin && value.includeMax,
    'interval bounds must be ordered; equal bounds require closed ends')

export const geometryAssertionV1Schema = z.object({
  assertionId: assertionIdSchema,
  scope: z.enum(['single_observation', 'single_point', 'finite_samples']).optional(),
  verificationProgram: verificationProgramV1Schema.optional(),
  kind: assertionKindV1Schema,
  subjects: z.array(geometryObjectIdSchema).min(1).max(4),
  expected: z.union([z.string().trim().min(1).max(256), z.number().finite(), z.boolean()]),
  /** Which observed scalar `valueInInterval` reads: a point coordinate or a numeric value. */
  axis: z.enum(['x', 'y', 'z', 'value']).optional(),
  interval: numericIntervalV1Schema.optional(),
  required: z.boolean().default(true),
}).strict().superRefine((assertion, context): void => {
  if (assertion.kind === 'hasEquation') {
    if (!geoGebraPolynomialEquationV1Schema.safeParse(assertion.expected).success) {
      context.addIssue({ code: 'custom', path: ['expected'], message: 'hasEquation requires a bounded polynomial equation' })
    }
  } else if (typeof assertion.expected === 'string' && assertion.expected.length > 64) {
    context.addIssue({ code: 'custom', path: ['expected'], message: 'expected exceeds 64 characters' })
  }
  const counts = assertionSubjectCounts[assertion.kind]
  if (!counts.includes(assertion.subjects.length)) {
    context.addIssue({ code: 'custom', path: ['subjects'], message: `${assertion.kind} has an invalid subject count` })
  }
  const numeric = ['length', 'angle', 'polygonVertexCount'].includes(assertion.kind)
  if (assertion.kind === 'polygonVertexCount' && (typeof assertion.expected !== 'number'
    || !Number.isInteger(assertion.expected) || assertion.expected < 3 || assertion.expected > 64)) {
    context.addIssue({ code: 'custom', path: ['expected'], message: 'polygonVertexCount requires an integer from 3 to 64' })
  }
  if (numeric !== (typeof assertion.expected === 'number')) {
    context.addIssue({ code: 'custom', path: ['expected'], message: `${assertion.kind} has an invalid expected value type` })
  }
  if (assertion.kind === 'hasType' && typeof assertion.expected !== 'string') {
    context.addIssue({ code: 'custom', path: ['expected'], message: 'hasType requires a string expected value' })
  }
  const intervalKind = assertion.kind === 'valueInInterval'
  if (intervalKind && (assertion.axis === undefined || assertion.interval === undefined)) {
    context.addIssue({ code: 'custom', path: ['interval'],
      message: 'valueInInterval requires an axis and an interval' })
  }
  if (!intervalKind && (assertion.axis !== undefined || assertion.interval !== undefined)) {
    context.addIssue({ code: 'custom', path: ['interval'],
      message: `${assertion.kind} does not take an axis or an interval` })
  }
  if (intervalKind && typeof assertion.expected !== 'boolean') {
    context.addIssue({ code: 'custom', path: ['expected'],
      message: 'valueInInterval requires a boolean expected value' })
  }
})

/** Agent-authored, data-only geometry plan accepted by the static validator. */
export const mathConstructionPlanV1Schema = z.object({
  schemaVersion: geometrySchemaVersion,
  space: z.enum(['2d', '3d']).optional(),
  planId: planIdSchema,
  problemSummary: z.string().trim().min(1).max(2_000),
  assumptions: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    text: z.string().trim().min(1).max(500),
    source: assumptionSourceSchema,
  }).strict()).max(32),
  objects: z.array(geometryObjectDeclarationV1Schema).min(1).max(MAX_PLAN_OBJECTS),
  steps: z.array(constructionStepV1Schema).min(1).max(MAX_PLAN_STEPS),
  assertions: z.array(geometryAssertionV1Schema).max(MAX_PLAN_ASSERTIONS),
}).strict()

/** Model-authored semantic plan that deliberately contains no executable GeoGebra operation. */
export const mathPlanningPlanV1Schema = z.object({
  schemaVersion: geometrySchemaVersion,
  space: z.enum(['2d', '3d']).optional(),
  planId: planIdSchema,
  problemSummary: z.string().trim().min(1).max(2_000),
  assumptions: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    text: z.string().trim().min(1).max(500),
    source: assumptionSourceSchema,
  }).strict()).max(32),
  objects: z.array(geometryObjectDeclarationV1Schema).min(1).max(MAX_PLAN_OBJECTS),
  steps: z.array(mathPlanningStepV1Schema).min(1).max(MAX_PLAN_STEPS),
  assertions: z.array(geometryAssertionV1Schema).max(MAX_PLAN_ASSERTIONS),
}).strict()

/** Code-generation output: one safe operation for every trusted semantic construction step. */
export const ggbCodegenPlanV1Schema = z.object({
  schemaVersion: geometrySchemaVersion,
  planId: planIdSchema,
  steps: z.array(z.object({
    stepId: stepIdSchema,
    operation: constructionOperationV1Schema,
  }).strict()).min(1).max(MAX_PLAN_STEPS),
}).strict()

export type GeometryObjectDeclarationV1 = z.infer<typeof geometryObjectDeclarationV1Schema>
export type SliderSpecV1 = z.infer<typeof sliderSpecV1Schema>
export type ConstructionOperationV1 = z.infer<typeof constructionOperationV1Schema>
export type ConstructionStepV1 = z.infer<typeof constructionStepV1Schema>
export type GeometryAssertionV1 = z.infer<typeof geometryAssertionV1Schema>
export type MathConstructionPlanV1 = z.infer<typeof mathConstructionPlanV1Schema>
export type MathPlanningStepV1 = z.infer<typeof mathPlanningStepV1Schema>
export type MathPlanningPlanV1 = z.infer<typeof mathPlanningPlanV1Schema>
export type GgbCodegenPlanV1 = z.infer<typeof ggbCodegenPlanV1Schema>

function isSafePolynomialEquation(value: string): boolean {
  if (!/^[0-9xy+\-*/^().= \t]+$/.test(value)) return false
  if ((value.match(/=/g) ?? []).length !== 1) return false
  const [left, right] = value.split('=')
  if (left?.trim() === '' || right?.trim() === '' || !/[xy]/.test(value)) return false
  let depth = 0
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth < 0 || depth > 16) return false
  }
  if (depth !== 0) return false
  const exponents = [...value.matchAll(/\^\s*(\d+)/g)].map(match => Number(match[1]))
  if (exponents.some(exponent => !Number.isInteger(exponent) || exponent > 12)) return false
  return !/\^(?!\s*\d)/.test(value)
}

function isSafeLinearEquation(value: string): boolean {
  const [left, right] = value.replaceAll(' ', '').replaceAll('\t', '').split('=')
  return left !== undefined && right !== undefined && linearExpression(left) && linearExpression(right)
}

function linearExpression(value: string): boolean {
  const number = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`
  const term = String.raw`(?:(?:${number})?\*?[xy]|${number})`
  return new RegExp(String.raw`^[+-]?${term}(?:[+-]${term})*$`).test(value)
}

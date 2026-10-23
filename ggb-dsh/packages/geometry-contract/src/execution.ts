import { z } from 'zod'
import { verificationProgramV1Schema, VERIFICATION_PROGRAM_METHOD_V1 } from './verification-program.js'

import { geometryErrorV1Schema } from './error.js'
import {
  appSessionIdSchema, canvasVersionSchema, commandIdSchema,
  dshSessionIdSchema, geometryObjectIdSchema, planIdSchema, runIdSchema,
  stepIdSchema, transactionIdSchema,
} from './ids.js'
import { geometrySchemaVersion } from './version.js'
import { geoGebraLinearEquationV1Schema,
  geoGebraPolynomialEquationV1Schema, geometryCaptionV1Schema } from './plan.js'

const timestampSchema = z.iso.datetime({ offset: true })
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const scalarSchema = z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()])
const evidenceSchema = z.record(
  z.string().min(1).max(64), scalarSchema,
).refine(value => Object.keys(value).length <= 32, 'evidence exceeds 32 entries')

const safeNumericExpressionV1Schema = z.string().trim().min(1).max(256)
  .regex(/^[0-9A-Za-z_'ℯ.()+\-*/° ]+$/, 'expression must be a bounded numeric expression')
const unsafeManualCommands = new Set([
  'Delete', 'Execute', 'ExportImage', 'Pan', 'PlaySound', 'Rename', 'RunClickScript', 'RunUpdateScript',
  'StartAnimation', 'ZoomIn', 'ZoomOut',
])

function isSafeManualCommandName(command: string): boolean {
  return /^[A-Z][A-Za-z0-9]{0,63}$/.test(command) && !unsafeManualCommands.has(command)
}

/** Allow evidence-bound Manual construction commands outside the explicit side-effect boundary. */
export function isDeclarativeGeoGebraManualCommandV1(command: string): boolean {
  return isSafeManualCommandName(command)
}

/** Allow evidence-bound output-free commands outside the explicit side-effect boundary. */
export function isPresentationGeoGebraManualCommandV1(command: string): boolean {
  return isSafeManualCommandName(command)
}

export const geoGebraArgumentV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('object'), objectId: geometryObjectIdSchema, label: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal('number'), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('string'), value: z.string().max(128) }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('expression'), value: z.union([
    geoGebraLinearEquationV1Schema, geoGebraPolynomialEquationV1Schema, safeNumericExpressionV1Schema,
  ]) }).strict(),
])

export const geoGebraCommandV1Schema = z.object({
  commandId: commandIdSchema,
  stepId: stepIdSchema,
  name: z.enum([
    'Point', 'PointOnObject', 'Line', 'LineEquation', 'Segment', 'Vector', 'Circle', 'Conic', 'ConicEquation', 'ImplicitCurveEquation',
    'Parabola', 'Ellipse',
    'Hyperbola', 'Polygon', 'Plane', 'Sphere', 'Prism', 'Pyramid', 'Cone', 'Cylinder',
    'Cube', 'Intersect', 'Midpoint',
    'PerpendicularLine', 'ParallelLine', 'AngleBisector',
    'PerpendicularPlane', 'Rotate', 'Slider', 'SetValue',
    'SetCaption', 'ShowLabel', 'SetVisibleInView', 'SetColor',
    'SetLineThickness', 'SetLineStyle', 'SetPointSize', 'SetFilling', 'ManualCommand',
  ]),
  manual: z.object({
    signatureId: z.string().regex(/^[a-z][a-z0-9-]{0,95}$/),
    command: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
    effect: z.enum(['construction', 'presentation']).optional(),
    resultOutputs: z.array(z.object({
      index: z.number().int().min(1).max(8),
      objectId: geometryObjectIdSchema,
      label: z.string().min(1).max(32),
      caption: geometryCaptionV1Schema.optional(),
    }).strict()).min(1).max(8).optional(),
  }).strict().optional(),
  output: z.object({
    objectId: geometryObjectIdSchema,
    label: z.string().min(1).max(32),
    caption: geometryCaptionV1Schema.optional(),
  }).strict().optional(),
  arguments: z.array(geoGebraArgumentV1Schema).max(32),
}).strict().transform(command => {
  if (command.name !== 'SetCaption' && command.manual?.command !== 'SetCaption') return command
  const value = command.arguments[1]
  if (value?.kind !== 'string') return command
  const caption = geometryCaptionV1Schema.safeParse(value.value)
  return !caption.success ? command : { ...command, arguments: command.arguments.map((argument, index) =>
    index === 1 ? { kind: 'string' as const, value: caption.data } : argument) }
}).superRefine((command, context): void => {
  if (command.name === 'SetCaption' || command.manual?.command === 'SetCaption') {
    const value = command.arguments[1]
    if (value?.kind !== 'string' || !geometryCaptionV1Schema.safeParse(value.value).success) {
      context.addIssue({ code: 'custom', path: ['arguments', 1], message: 'caption_invalid_or_reserved' })
    }
  }
  if ((command.name === 'ManualCommand') !== (command.manual !== undefined)) {
    context.addIssue({ code: 'custom', path: ['manual'],
      message: 'ManualCommand requires pinned Manual metadata and other commands must omit it' })
  }
  if (command.name === 'ManualCommand') {
    const effect = command.manual?.effect ?? 'construction'
    const allowed = effect === 'presentation'
      ? isPresentationGeoGebraManualCommandV1(command.manual?.command ?? '')
      : isDeclarativeGeoGebraManualCommandV1(command.manual?.command ?? '')
    if (!allowed) context.addIssue({ code: 'custom', path: ['manual', 'command'],
      message: `Manual command is not allowed for ${effect}` })
    if ((effect === 'construction') !== (command.output !== undefined)) {
      context.addIssue({ code: 'custom', path: ['output'],
        message: 'Manual construction requires an output and Manual presentation must omit it' })
    }
  }
  const resultOutputs = command.manual?.resultOutputs
  if (resultOutputs !== undefined && new Set(resultOutputs.map(item => item.index)).size !== resultOutputs.length) {
    context.addIssue({ code: 'custom', path: ['manual', 'resultOutputs'], message: 'Manual result indexes must be unique' })
  }
})

/** Fixed commands used by each controlled query; documentation is read from the pinned Manual. */
export const NATIVE_GEOMETRY_QUERY_METHODS_V1 = {
  hasEquation: { method: 'geogebra-equation-equality-v1', spaces: ['2d'], commands: ['Area', 'AreEqual'] },
  pointOnConic: { method: 'geogebra-point-conic-distance-v1', spaces: ['2d'], commands: ['Distance'] },
  polygonOnCircle: { method: 'geogebra-vertex-distance-v1', spaces: ['2d', '3d'], commands: ['Vertex', 'Length', 'Radius', 'Distance'] },
  regularPolygon: { method: 'geogebra-regular-reference-v1', spaces: ['2d'], commands: ['Vertex', 'Length', 'Polygon', 'Area', 'AreEqual', 'Distance'] },
} as const

/** System-derived queries; no model expressions or arbitrary script text cross this boundary. */
const nativeQuerySubject = z.object({ objectId: geometryObjectIdSchema,
  label: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*'*$/).max(32) }).strict()
const nativeQueryId = z.string().regex(/^assert_[a-z0-9_-]{1,120}$/)
const circleQuery = z.object({ queryId: nativeQueryId, kind: z.literal('polygonOnCircle'),
  subjects: z.tuple([nativeQuerySubject, nativeQuerySubject]) }).strict()
const regularQuery = z.object({ queryId: nativeQueryId, kind: z.literal('regularPolygon'),
  subjects: z.tuple([nativeQuerySubject]) }).strict()
const programQuery = z.object({ queryId: nativeQueryId, kind: z.literal('verificationProgram'),
  subjects: z.array(nativeQuerySubject).min(1).max(4), program: verificationProgramV1Schema,
  expected: z.union([z.number().finite(), z.boolean()]), scope: z.literal('single_observation') }).strict()
const equationQuery = z.object({ queryId: nativeQueryId, kind: z.literal('hasEquation'),
  subjects: z.tuple([nativeQuerySubject]), expected: geoGebraPolynomialEquationV1Schema }).strict()
const conicQuery = z.object({ queryId: nativeQueryId, kind: z.literal('pointOnConic'),
  subjects: z.tuple([nativeQuerySubject, nativeQuerySubject]) }).strict()
export const nativeGeometryQueryV1Schema = z.discriminatedUnion('kind', [circleQuery, regularQuery, programQuery, equationQuery, conicQuery])
const nativeQueryReason = z.enum(['query_unavailable', 'query_failed', 'snapshot_mismatch', 'unsupported_object', 'vertex_limit']).nullable()
const nativeVertexCount = z.number().int().min(3).max(128).nullable()
const nativeDistances = z.array(z.number().finite().nonnegative().nullable()).max(128)

/** Native measurements from an isolated copy of exactly one post-construction canvas. */
export const nativeGeometryQueryResultV1Schema = z.discriminatedUnion('method', [
  z.object({ query: equationQuery, sourceCanvasVersion: canvasVersionSchema,
    method: z.literal('geogebra-equation-equality-v1'), equal: z.boolean().nullable(), reason: nativeQueryReason }).strict(),
  z.object({ query: conicQuery, sourceCanvasVersion: canvasVersionSchema,
    method: z.literal('geogebra-point-conic-distance-v1'), distance: z.number().finite().nonnegative().nullable(), reason: nativeQueryReason }).strict(),
  z.object({ query: programQuery, sourceCanvasVersion: canvasVersionSchema,
    method: z.literal(VERIFICATION_PROGRAM_METHOD_V1),
    values: z.array(z.union([z.number().finite(), z.boolean(), z.null()])).max(8),
    reason: nativeQueryReason }).strict(),
  z.object({ query: circleQuery, sourceCanvasVersion: canvasVersionSchema,
    method: z.literal('geogebra-vertex-distance-v1'), vertexCount: nativeVertexCount,
    radius: z.number().finite().positive().nullable(), distances: nativeDistances, reason: nativeQueryReason }).strict(),
  z.object({ query: regularQuery, sourceCanvasVersion: canvasVersionSchema,
    method: z.literal('geogebra-regular-reference-v1'), vertexCount: nativeVertexCount,
    sideLength: z.number().finite().nonnegative().nullable(), area: z.number().finite().nonnegative().nullable(),
    referenceAreas: z.tuple([z.number().finite().nonnegative().nullable(), z.number().finite().nonnegative().nullable()]),
    referenceMatches: z.tuple([z.boolean().nullable(), z.boolean().nullable()]),
    forwardDistances: nativeDistances, reverseDistances: nativeDistances, reason: nativeQueryReason }).strict(),
])
export type NativeGeometryQueryV1 = z.infer<typeof nativeGeometryQueryV1Schema>
export type NativeGeometryQueryResultV1 = z.infer<typeof nativeGeometryQueryResultV1Schema>

/** Authenticated, bounded request for one expected canvas version. */
export const executionTransactionV1Schema = z.object({
  schemaVersion: geometrySchemaVersion,
  protocolVersion: z.literal(1),
  transactionId: transactionIdSchema,
  /** Set by the DSH bridge; absent for the same-origin PWA write path. */
  appSessionId: appSessionIdSchema.optional(),
  /** DSH-owned identity; the browser runtime must not fabricate one. */
  dshSessionId: dshSessionIdSchema.optional(),
  runId: runIdSchema,
  planId: planIdSchema,
  expectedCanvasVersion: canvasVersionSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  commands: z.array(geoGebraCommandV1Schema).min(1).max(128),
  probes: z.array(nativeGeometryQueryV1Schema).max(128),
  /** Required on the authenticated DSH execution channel, absent in the same-origin PWA. */
  integrity: z.object({ algorithm: z.literal('hmac-sha256'), value: digestSchema }).strict().optional(),
}).strict()

/** Direct getter identities shared by observation producers and requirement-result consumers. */
export const PRESENTATION_COMMAND_METHODS_V1: Readonly<Record<string, string>> = Object.freeze({
  SetLineThickness: 'api.getLineThickness', SetLineStyle: 'api.getLineStyle',
  SetPointSize: 'api.getPointSize', SetFilling: 'api.getFilling', ShowLabel: 'api.getLabelVisible',
  SetVisibleInView: 'api.getVisible', SetCaption: 'api.getCaption', SetColor: 'api.getColor',
})

/** Direct presentation-call evidence; absence of a readable property never proves mismatch. */
export const presentationCommandResultV1Schema = z.object({
  apiAccepted: z.boolean().nullable(), apiException: z.boolean(),
  method: z.string().min(1).max(64), expected: scalarSchema, actual: scalarSchema,
  outcome: z.enum(['satisfied', 'not_satisfied', 'unverified']),
  reason: z.enum(['target_satisfied', 'target_mismatch', 'property_unavailable', 'api_exception']),
}).strict()

export const commandObservationV1Schema = z.object({
  commandId: commandIdSchema,
  status: z.enum(['applied', 'rejected', 'unknown']),
  createdLabels: z.array(z.string().min(1).max(32)).max(8),
  durationMs: z.number().int().nonnegative().max(300_000),
  error: geometryErrorV1Schema.optional(),
  result: presentationCommandResultV1Schema.optional(),
}).strict()

export const geometryObjectObservationV1Schema = z.object({
  objectId: geometryObjectIdSchema,
  label: z.string().min(1).max(32),
  kind: z.enum([
    'point', 'line', 'segment', 'vector', 'circle', 'conic', 'curve', 'polygon',
    'plane', 'sphere', 'polyhedron', 'solid', 'slider', 'object',
  ]),
  rawKind: z.string().trim().min(1).max(100).optional(),
  definition: z.string().max(2_000),
  dependencies: z.array(geometryObjectIdSchema).max(32),
  properties: evidenceSchema,
}).strict()

export const executionObservationV1Schema = z.object({
  schemaVersion: geometrySchemaVersion,
  transactionId: transactionIdSchema,
  status: z.enum(['applied', 'rejected', 'rolled_back', 'outcome_unknown']),
  beforeCanvasVersion: canvasVersionSchema,
  afterCanvasVersion: canvasVersionSchema.optional(),
  commands: z.array(commandObservationV1Schema).max(128),
  objects: z.array(geometryObjectObservationV1Schema).max(128),
  probes: z.array(nativeGeometryQueryResultV1Schema).max(128),
  rollback: z.object({
    attempted: z.boolean(), succeeded: z.boolean(), restoredCanvasVersion: canvasVersionSchema.optional(),
  }).strict().optional(),
  error: geometryErrorV1Schema.optional(),
}).strict()

/** Browser applet settlement after the geometry tool accepts or rejects the semantic result. */
export const executionFinalizeResultV1Schema = z.object({
  schemaVersion: geometrySchemaVersion,
  transactionId: transactionIdSchema,
  decision: z.enum(['commit', 'rollback']),
  status: z.enum(['committed', 'rolled_back', 'recovery_required']),
  canvasVersion: canvasVersionSchema,
  rollback: z.object({
    attempted: z.boolean(), succeeded: z.boolean(), restoredCanvasVersion: canvasVersionSchema.optional(),
  }).strict().optional(),
  error: geometryErrorV1Schema.optional(),
}).strict()

export type GeoGebraArgumentV1 = z.infer<typeof geoGebraArgumentV1Schema>
export type GeoGebraCommandV1 = z.infer<typeof geoGebraCommandV1Schema>
export type ExecutionTransactionV1 = z.infer<typeof executionTransactionV1Schema>
export type CommandObservationV1 = z.infer<typeof commandObservationV1Schema>
export type GeometryObjectObservationV1 = z.infer<typeof geometryObjectObservationV1Schema>
export type ExecutionObservationV1 = z.infer<typeof executionObservationV1Schema>
export type ExecutionFinalizeResultV1 = z.infer<typeof executionFinalizeResultV1Schema>

export type PresentationCommandResultV1 = z.infer<typeof presentationCommandResultV1Schema>

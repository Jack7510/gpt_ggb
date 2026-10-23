import { z } from 'zod'

/** Opaque product identifier whose runtime value has passed its owning schema. */
export type BrandedId<Name extends string> = string & { readonly __brand: Name }

/** Application-owned conversation identity. */
export type AppSessionId = BrandedId<'AppSessionId'>
/** DSH-owned durable Session identity. */
export type DshSessionId = BrandedId<'DshSessionId'>
/** One user-visible Agent run identity. */
export type RunId = BrandedId<'RunId'>
/** One canvas mutation transaction identity. */
export type TransactionId = BrandedId<'TransactionId'>
/** One immutable committed canvas version identity. */
export type CanvasVersion = BrandedId<'CanvasVersion'>
/** One bridge-owned saved or private artifact identity. */
export type ArtifactId = BrandedId<'ArtifactId'>
/** One structured application diagnostic identity. */
export type DiagnosticId = BrandedId<'DiagnosticId'>
/** One stable geometry object identity, independent of its display label. */
export type GeometryObjectId = BrandedId<'GeometryObjectId'>
/** One immutable construction plan identity. */
export type PlanId = BrandedId<'PlanId'>
/** One construction step identity within a plan. */
export type StepId = BrandedId<'StepId'>
/** One semantic assertion identity within a plan. */
export type AssertionId = BrandedId<'AssertionId'>
/** One compiled command identity within a transaction. */
export type CommandId = BrandedId<'CommandId'>

const uuidV4 = z.uuid({ version: 'v4' })

function productIdSchema<const Prefix extends string, Name extends string>(prefix: Prefix): z.ZodType<BrandedId<Name>> {
  return z.templateLiteral([z.literal(`${prefix}_`), uuidV4]).transform(value => value as BrandedId<Name>)
}

/** Validates an application session id encoded as `app_<uuid-v4>`. */
export const appSessionIdSchema = productIdSchema<'app', 'AppSessionId'>('app')
/** Validates a run id encoded as `run_<uuid-v4>`. */
export const runIdSchema = productIdSchema<'run', 'RunId'>('run')
/** Validates a transaction id encoded as `txn_<uuid-v4>`. */
export const transactionIdSchema = productIdSchema<'txn', 'TransactionId'>('txn')
/** Validates a canvas version id encoded as `canvas_<uuid-v4>`. */
export const canvasVersionSchema = productIdSchema<'canvas', 'CanvasVersion'>('canvas')
/** Validates an artifact id encoded as `artifact_<uuid-v4>`. */
export const artifactIdSchema = productIdSchema<'artifact', 'ArtifactId'>('artifact')
/** Validates a diagnostic id encoded as `diagnostic_<uuid-v4>`. */
export const diagnosticIdSchema = productIdSchema<'diagnostic', 'DiagnosticId'>('diagnostic')
/** Validates an object id encoded as `obj_<uuid-v4>`. */
export const geometryObjectIdSchema = productIdSchema<'obj', 'GeometryObjectId'>('obj')
/** Validates a construction plan id encoded as `plan_<uuid-v4>`. */
export const planIdSchema = productIdSchema<'plan', 'PlanId'>('plan')
/** Validates a construction step id encoded as `step_<uuid-v4>`. */
export const stepIdSchema = productIdSchema<'step', 'StepId'>('step')
/** Validates a semantic assertion id encoded as `assert_<uuid-v4>`. */
export const assertionIdSchema = productIdSchema<'assert', 'AssertionId'>('assert')
/** Validates a compiled command id encoded as `cmd_<uuid-v4>`. */
export const commandIdSchema = productIdSchema<'cmd', 'CommandId'>('cmd')

/** DSH Session ids are external opaque values and remain bounded but prefix-free. */
export const dshSessionIdSchema = z.string().trim().min(1).max(128).transform(value => value as DshSessionId)

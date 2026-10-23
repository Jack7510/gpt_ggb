import { z } from 'zod'

/** Stable geometry processing phases exposed to the Agent and UI. */
export const geometryErrorPhaseSchema = z.enum([
  'plan', 'compile', 'execute', 'observe', 'validate', 'recover',
])

/** Stable retry decisions; dynamic failure details never alter this value. */
export const geometryRetrySchema = z.enum([
  'never', 'after_replan', 'transient', 'user_action',
])

/** Closed M1 error vocabulary. Object labels and provider text belong in details. */
export const geometryErrorCodeSchema = z.enum([
  'PLAN_SCHEMA_INVALID',
  'PLAN_VERSION_UNSUPPORTED',
  'PLAN_DUPLICATE_ID',
  'PLAN_REFERENCE_MISSING',
  'PLAN_REFERENCE_TYPE_MISMATCH',
  'PLAN_DEPENDENCY_MISSING',
  'PLAN_OUTPUT_MISMATCH',
  'PLAN_SPACE_MISMATCH',
  'PLAN_DEPENDENCY_CYCLE',
  'PLAN_COMPLEXITY_EXCEEDED',
  'PLAN_OPERATION_UNSUPPORTED',
  'PLAN_CODEGEN_MISMATCH',
  'PLAN_UNSAFE_VARIABLE_NAME',
  'PLAN_PROTECTED_OBJECT',
  'PLAN_ATTEMPT_BUDGET_EXHAUSTED',
  'COMPILE_ENCODING_INVALID',
  'COMPILE_OPERATION_UNSUPPORTED',
  'EXECUTE_CANVAS_VERSION_MISMATCH',
  'EXECUTE_TRANSACTION_PENDING',
  'EXECUTE_COMMAND_REJECTED',
  'EXECUTE_ATTEMPT_BUDGET_EXHAUSTED',
  'EXECUTE_COMMAND_TIMEOUT',
  'EXECUTE_CHANNEL_CLOSED',
  'EXECUTE_RESPONSE_LOST',
  'OBSERVE_OBJECT_MISSING',
  'OBSERVE_PROPERTY_MISSING',
  'OBSERVE_TYPE_UNSUPPORTED',
  'VALIDATE_ASSERTION_FAILED',
  'VALIDATE_EVIDENCE_MISSING',
  'VALIDATE_DEGENERATE_GEOMETRY',
  'RECOVER_ROLLBACK_FAILED',
  'RECOVER_OUTCOME_UNKNOWN',
])

const geometryErrorDetailSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(256)).max(32),
])
const geometryErrorDetailsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),
  geometryErrorDetailSchema,
).refine(value => Object.keys(value).length <= 32, 'details exceed 32 entries')

/** Versioned, bounded error safe to persist and return to a model. */
export const geometryErrorV1Schema = z.object({
  schemaVersion: z.literal(1),
  code: geometryErrorCodeSchema,
  phase: geometryErrorPhaseSchema,
  retry: geometryRetrySchema,
  message: z.string().trim().min(1).max(500),
  details: geometryErrorDetailsSchema,
}).strict()

export type GeometryErrorPhase = z.infer<typeof geometryErrorPhaseSchema>
export type GeometryRetry = z.infer<typeof geometryRetrySchema>
export type GeometryErrorCode = z.infer<typeof geometryErrorCodeSchema>
export type GeometryErrorV1 = z.infer<typeof geometryErrorV1Schema>

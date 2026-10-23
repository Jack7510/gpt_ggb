import { pluginCoreConstructionRecordSchema, constructionMatchesBuild } from './plugin-core-construction.js'
import { pluginCoreBuildFailureSchema } from './plugin-core-build-failure.js'
import { pluginCoreTrustedBuildSchema, pluginCoreCleanupSchema } from './plugin-core-trust.js'
import { z } from 'zod'
import { pluginCoreProgressSchema, type PluginCoreProgress } from './plugin-core-progress.js'
import { runIdSchema } from './ids.js'

/** The selected construction engine; persisted per run and advertised by bootstrap. */
export const agentEngineSchema = z.literal('plugin_core')
export type AgentEngine = z.infer<typeof agentEngineSchema>

/** Plugin-core runs have one terminal transition and no Native checkpoint. */
export const pluginCorePhaseSchema = z.enum([
  'accepted', 'running', 'completed', 'failed', 'cancelled',
])
export type PluginCorePhase = z.infer<typeof pluginCorePhaseSchema>

export const TERMINAL_PLUGIN_CORE_PHASES: readonly PluginCorePhase[] = [
  'completed', 'failed', 'cancelled',
]

/** Aggregate provider usage; null counters mean the SDK did not supply them. */
export const pluginCoreUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  complete: z.boolean(),
  /** `sdk` when every counter came from the SDK; `unknown` on a failed turn. */
  source: z.enum(['sdk', 'unknown']),
}).strict()
export type PluginCoreUsage = z.infer<typeof pluginCoreUsageSchema>

export const pluginCoreFailureCodeSchema = z.enum([
  'plugin_core_failed',
  'plugin_core_max_tokens',
  'plugin_core_no_delivery',
  'plugin_core_empty_turn',
  'plugin_core_disabled',
  'plugin_core_timeout',
  'plugin_core_worker_unavailable',
  'plugin_core_interrupted',
  'plugin_core_cancelled',
  'plugin_core_delivery_missing',
  'plugin_core_delivery_invalid',
  'plugin_core_cleanup_failed',
  'plugin_core_commit_conflict',
])
export type PluginCoreFailureCode = z.infer<typeof pluginCoreFailureCodeSchema>

export const pluginCoreFailureSchema = z.object({
  code: pluginCoreFailureCodeSchema,
  message: z.string().min(1).max(2_048),
  details: pluginCoreBuildFailureSchema.optional(),
}).strict()
export type PluginCoreFailure = z.infer<typeof pluginCoreFailureSchema>

export const pluginCoreArtifactKindSchema = z.enum([
  'result_ggb', 'preview', 'verification', 'manifest',
])
export type PluginCoreArtifactKind = z.infer<typeof pluginCoreArtifactKindSchema>

/** Artifact metadata crosses to the browser; content stays behind the run token. */
export const pluginCoreArtifactSchema = z.object({
  artifactId: z.string().min(1).max(128),
  kind: pluginCoreArtifactKindSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1).max(128),
}).strict()
export type PluginCoreArtifact = z.infer<typeof pluginCoreArtifactSchema>

export const pluginCoreDeliverySchema = z.object({
  /** Digest of the delivered result.ggb; also the artifact id. */
  id: z.string().regex(/^[a-f0-9]{64}$/),
  artifacts: z.array(pluginCoreArtifactSchema).min(1).max(8),
  verification: z.json(),
  trustedBuild: pluginCoreTrustedBuildSchema.optional(),
  construction: pluginCoreConstructionRecordSchema.optional(),
  cleanup: pluginCoreCleanupSchema.optional(),
}).strict().refine(value => constructionMatchesBuild(value.construction, value.trustedBuild), 'construction_binding')
export type PluginCoreDelivery = z.infer<typeof pluginCoreDeliverySchema>

/** Persisted run row. Prompt/base bytes are not duplicated in the ledger. */
export interface PluginCoreRunRecord {
  deliveryContract?: 'legacy' | 'receipt-v1'
  runId: string
  tokenVerifier: string
  requestDigest: string
  prompt: string
  promptDigest: string
  baseSha256: string | null
  baseName: string | null
  phase: PluginCorePhase
  stopRequested: boolean
  executionStartedAt: string | null
  executionExpiresAt: string | null
  finalResponse: string | null
  failure: PluginCoreFailure | null
  delivery: PluginCoreDelivery | null
  usage: PluginCoreUsage | null
  durationMs: number | null
  modelId: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface NewPluginCoreRunSpec {
  deliveryContract?: 'legacy' | 'receipt-v1'
  runId: string
  tokenVerifier: string
  requestDigest: string
  prompt: string
  promptDigest: string
  baseSha256: string | null
  baseName: string | null
  executionExpiresAt: string
  expiresAt: string
}

export interface PluginCoreRunAccessFacts {
  tokenVerifier: string
  requestDigest: string
}

export interface PluginCoreRunView {
  progress?: PluginCoreProgress | null
  runId: string
  engine: 'plugin_core'
  phase: PluginCorePhase
  stopRequested: boolean
  finalResponse: string | null
  failure: PluginCoreFailure | null
  delivery: PluginCoreDelivery | null
  usage: PluginCoreUsage | null
  durationMs: number | null
  modelId: string | null
  createdAt: string
  events: { earliestEventId: number | null; latestEventId: number | null }
  terminal: boolean
}

export interface PluginCoreArtifactRecord extends PluginCoreArtifact {
  runId: string
  createdAt: string
  expiresAt: string
}

/** Persisted event envelope; the payload stays plugin-namespaced. */
export const pluginCoreEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plugin_core.progress'), progress: pluginCoreProgressSchema }).strict(),
  z.object({
    type: z.literal('plugin_core.phase'),
    phase: pluginCorePhaseSchema,
  }).strict(),
  z.object({
    type: z.literal('plugin_core.delivery'),
    finalResponse: z.string().max(200_000),
    delivery: pluginCoreDeliverySchema,
    usage: pluginCoreUsageSchema.nullable(),
    durationMs: z.number().int().nonnegative().max(86_400_000),
  }).strict(),
  z.object({
    type: z.literal('plugin_core.failed'),
    code: pluginCoreFailureCodeSchema,
    message: z.string().min(1).max(2_048),
    details: pluginCoreBuildFailureSchema.optional(),
    usage: pluginCoreUsageSchema.nullable(),
  }).strict(),
  z.object({ type: z.literal('plugin_core.cancelled'), cleanup: pluginCoreCleanupSchema.optional() }).strict(),
])
export type PluginCoreEventPayload = z.infer<typeof pluginCoreEventPayloadSchema>

export interface PluginCoreEvent {
  schemaVersion: 1
  eventId: number
  occurredAt: string
  runId: string
  payload: PluginCoreEventPayload
}

export interface PluginCoreEventAppend {
  payload: PluginCoreEventPayload
  occurredAt: string
}

/** SSE wire frame for one persisted plugin event. */
export function pluginCoreEventToSseFrame(event: PluginCoreEvent): string {
  const data = JSON.stringify({
    ...event.payload,
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    runId: event.runId,
  })
  return `id: ${String(event.eventId)}\nevent: ${event.payload.type}\ndata: ${data}\n\n`
}

/** Terminal payloads close the plugin SSE stream. */
export function isTerminalPluginCoreEvent(payload: PluginCoreEventPayload): boolean {
  return payload.type === 'plugin_core.delivery'
    || payload.type === 'plugin_core.failed'
    || payload.type === 'plugin_core.cancelled'
}

export function isTerminalPluginCorePhase(phase: PluginCorePhase): boolean {
  return TERMINAL_PLUGIN_CORE_PHASES.includes(phase)
}

/** Validate a plugin request run ID with the shared format. */
export const pluginCoreRunIdSchema = runIdSchema

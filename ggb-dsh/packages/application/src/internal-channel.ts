import { pluginCoreBuildFailureSchema } from './plugin-core-build-failure.js'
import { pluginCoreImageSchema } from './plugin-core-image.js'
import { pluginCoreCleanupSchema, pluginCoreTrustedBuildSchema } from './plugin-core-trust.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { runIdSchema } from './ids.js'

/**
 * §7.5 internal API→worker channel protocol. Messages travel over a loopback
 * Unix socket as NDJSON; every request carries an HMAC-SHA-256 `authentication`
 * field computed over the canonical JSON of the message without that field.
 */
export const INTERNAL_CHANNEL_PROTOCOL_VERSION = 5 as const

// Raw artifact limits and NDJSON byte budgets share one host contract.
export const PLUGIN_CORE_LIMITS = Object.freeze({ ggbBytes: 6 * 1024 * 1024,
  previewBytes: 3 * 1024 * 1024, reportBytes: 1024 * 1024, manifestBytes: 1024 * 1024,
  deliveryBytes: 16 * 1024 * 1024, responseBytes: 17 * 1024 * 1024 })
const base64Limit = (bytes: number): number => 4 * Math.ceil(bytes / 3)

const channelAuthenticationSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const channelHandshakeRequestSchema = z
  .object({
    protocolVersion: z.literal(INTERNAL_CHANNEL_PROTOCOL_VERSION),
    type: z.literal('handshake'),
    requestId: z.uuid({ version: 'v4' }),
    issuedAt: z.iso.datetime({ offset: true }),
    nonce: z.string().min(16).max(128),
    authentication: channelAuthenticationSchema,
  })
  .strict()

export const channelHandshakeResponseSchema = z
  .object({
    type: z.literal('handshake.accepted'),
    requestId: z.uuid({ version: 'v4' }),
    workerInstanceId: z.string().min(1).max(128),
  })
  .strict()

export const channelCredentialSchema = z
  .object({
    /** Provider key handed to the run; null when resuming without model calls. */
    providerKey: z.string().min(1).max(512).nullable(),
  })
  .strict()

/** Optional base GGB for Phase 2. Eight MiB raw stays below the channel frame. */
export const channelPluginCoreBaseSchema = z
  .object({
    dataBase64: z.string().min(1).max(11 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().trim().min(1).max(256).nullable(),
  })
  .strict()

/**
 * Independent plugin-core run. The API sends one prompt and the Worker returns the
 * bounded delivery facts in the same exchange; there is no Native checkpoint.
 */
export const channelPluginCoreRequestSchema = z
  .object({
    type: z.literal('plugin-core.run'),
    deliveryContract: z.literal('receipt-v1').default('receipt-v1'),
    requestId: z.uuid({ version: 'v4' }),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    nonce: z.string().min(16).max(128),
    runId: runIdSchema,
    credential: channelCredentialSchema,
    prompt: z.string().min(1).max(12_000),
    image: pluginCoreImageSchema.optional(),
    /** Absent or null creates a new figure. Present edits the declared base. */
    base: channelPluginCoreBaseSchema.nullable().optional(),
    authentication: channelAuthenticationSchema,
  })
  .strict()

/** Cancel one in-flight plugin-core run; the Worker kills its process tree. */
export const channelPluginCoreCancelRequestSchema = z
  .object({
    type: z.literal('plugin-core.cancel'),
    requestId: z.uuid({ version: 'v4' }),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    nonce: z.string().min(16).max(128),
    runId: runIdSchema,
    authentication: channelAuthenticationSchema,
  })
  .strict()

export const channelPluginCoreCancelAckSchema = z
  .object({
    type: z.literal('plugin-core.cancel.ack'),
    requestId: z.uuid({ version: 'v4' }),
    result: z.enum(['cancelled', 'not_found', 'already_terminal']),
  })
  .strict()

/** Bounded delivery facts. The GGB and screenshot travel as base64; paths stay server-side. */
export const channelPluginCoreDeliverySchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    ggbBase64: z.string().max(base64Limit(PLUGIN_CORE_LIMITS.ggbBytes)).nullable(),
    ggbBytes: z.number().int().nonnegative().max(PLUGIN_CORE_LIMITS.ggbBytes),
    screenshotBase64: z.string().max(base64Limit(PLUGIN_CORE_LIMITS.previewBytes)).nullable(),
    verification: z.json(),
    trustedBuild: pluginCoreTrustedBuildSchema.optional(),
    reportBase64: z.string().max(base64Limit(PLUGIN_CORE_LIMITS.reportBytes)).optional(),
    manifestBase64: z.string().max(base64Limit(PLUGIN_CORE_LIMITS.manifestBytes)).optional(),
  })
  .strict().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <=
    PLUGIN_CORE_LIMITS.deliveryBytes, 'delivery_size')
  .refine(value => ([['ggbBase64', 'ggbBytes'], ['screenshotBase64', 'previewBytes'],
    ['reportBase64', 'reportBytes'], ['manifestBase64', 'manifestBytes']] as const).every(([field, limit]) => {
    const encoded = value[field]
    if (encoded == null) return true
    const bytes = Buffer.from(encoded, 'base64')
    return bytes.length <= PLUGIN_CORE_LIMITS[limit] && bytes.toString('base64') === encoded
      && (field !== 'ggbBase64' || bytes.length === value.ggbBytes)
  }), 'artifact_size_or_encoding')

/** One bounded SDK call fact; never provider text or arguments. */
export const channelPluginCoreModelCallSchema = z
  .object({
    callOrdinal: z.number().int().positive(),
    outcome: z.enum([
      'completed', 'interrupted', 'attempt_without_message', 'incomplete',
    ]),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    usageComplete: z.boolean(),
  })
  .strict()

export const channelPluginCoreResultSchema = z
  .object({
    type: z.literal('plugin-core.result'),
    cleanup: pluginCoreCleanupSchema.optional(),
    requestId: z.uuid({ version: 'v4' }),
    finalResponse: z.string().max(200_000),
    delivery: channelPluginCoreDeliverySchema.nullable(),
    error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(2048),
      details: pluginCoreBuildFailureSchema.optional() }).strict().nullable(),
    /** Bounded SDK usage; null when the SDK did not supply counters. */
    usage: z.object({
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      reasoningTokens: z.number().int().nonnegative().nullable(),
      cacheReadTokens: z.number().int().nonnegative().nullable(),
      complete: z.boolean(),
    }).strict().nullable().optional(),
    /** Pinned model and wall-clock duration; absent only for older Workers. */
    modelId: z.string().min(1).max(128).optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    /** At most 32 call facts; the aggregate `usage` remains authoritative. */
    modelCalls: z.array(channelPluginCoreModelCallSchema).max(32).optional(),
    modelCallsTruncated: z.boolean().optional(),
    /** Event-type counts and tool-call count; no provider text. */
    diagnostics: z.object({
      eventTypes: z.record(z.string(), z.number().int().nonnegative()),
      toolCalls: z.number().int().nonnegative(),
    }).strict().nullable().optional(),
  })
  .strict()

export const channelErrorCodeSchema = z.enum([
  'authentication_failed',
  'request_expired',
  'duplicate_request',
  'message_too_large',
  'protocol_unsupported',
  'request_invalid',
  'worker_busy',
  'handler_failed',
  'server_closed',
])

export const channelErrorResponseSchema = z
  .object({
    type: z.literal('channel.error'),
    requestId: z.uuid({ version: 'v4' }),
    code: channelErrorCodeSchema,
  })
  .strict()

export const channelRequestSchema = z.discriminatedUnion('type', [
  channelHandshakeRequestSchema,
  channelPluginCoreRequestSchema,
  channelPluginCoreCancelRequestSchema,
])

export const channelResponseSchema = z.discriminatedUnion('type', [
  channelHandshakeResponseSchema,
  channelErrorResponseSchema,
  channelPluginCoreResultSchema,
  channelPluginCoreCancelAckSchema,
])

export type ChannelHandshakeRequest = z.infer<typeof channelHandshakeRequestSchema>
export type ChannelHandshakeResponse = z.infer<typeof channelHandshakeResponseSchema>
export type ChannelCredential = z.infer<typeof channelCredentialSchema>
export type ChannelPluginCoreBase = z.infer<typeof channelPluginCoreBaseSchema>
export type ChannelPluginCoreRequest = z.infer<typeof channelPluginCoreRequestSchema>
export type ChannelPluginCoreCancelRequest = z.infer<typeof channelPluginCoreCancelRequestSchema>
export type ChannelPluginCoreDelivery = z.infer<typeof channelPluginCoreDeliverySchema>
export type ChannelPluginCoreResult = z.infer<typeof channelPluginCoreResultSchema>
export type ChannelPluginCoreCancelAck = z.infer<typeof channelPluginCoreCancelAckSchema>
export type ChannelPluginCoreModelCall = z.infer<typeof channelPluginCoreModelCallSchema>
export type ChannelErrorCode = z.infer<typeof channelErrorCodeSchema>
export type ChannelErrorResponse = z.infer<typeof channelErrorResponseSchema>
export type ChannelRequest = z.infer<typeof channelRequestSchema>
export type ChannelResponse = z.infer<typeof channelResponseSchema>

/** Deterministic JSON with recursively sorted object keys; the HMAC signing basis. */
export function channelCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(channelCanonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${channelCanonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function channelHmac(secret: string, content: string): string {
  return createHmac('sha256', secret).update(content, 'utf8').digest('hex')
}

/** Signs a message by appending `authentication = HMAC(secret, canonicalJson(message))`. */
export function signChannelMessage<T extends object>(
  secret: string,
  message: T,
): T & { authentication: string } {
  return { ...message, authentication: channelHmac(secret, channelCanonicalJson(message)) }
}

/** Constant-time check of the message's own `authentication` field. */
export function verifyChannelAuthentication(secret: string, message: Record<string, unknown>): boolean {
  const provided = message.authentication
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)) return false
  const unsigned: Record<string, unknown> = { ...message }
  delete unsigned.authentication
  const expected = channelHmac(secret, channelCanonicalJson(unsigned))
  const left = Buffer.from(expected, 'hex')
  const right = Buffer.from(provided, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000

/** True when the expiry has passed, tolerating the given clock skew. */
export function isChannelRequestExpired(
  expiresAt: string,
  nowMs: number,
  maxClockSkewMs: number = DEFAULT_MAX_CLOCK_SKEW_MS,
): boolean {
  const expiry = Date.parse(expiresAt)
  if (Number.isNaN(expiry)) return true
  return expiry + maxClockSkewMs < nowMs
}

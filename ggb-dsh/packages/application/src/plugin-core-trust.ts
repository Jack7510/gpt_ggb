import { z } from 'zod'
import { runIdSchema } from './ids.js'

/** Worker proof, returned only after SDK and tool executors have drained. */
export const pluginCoreCleanupSchema = z.object({
  confirmed: z.boolean(),
  runId: runIdSchema,
  completedAt: z.iso.datetime({ offset: true }),
}).strict()
export type PluginCoreCleanup = z.infer<typeof pluginCoreCleanupSchema>

/** Host admission facts; identities are generated before the build side effect. */
export const pluginCoreBuildBindingSchema = z.object({
  runId: runIdSchema,
  turnId: z.uuid({ version: 'v4' }),
  epoch: z.number().int().positive(),
  requestId: z.uuid({ version: 'v4' }),
  toolCallId: z.uuid({ version: 'v4' }),
  buildId: z.uuid({ version: 'v4' }),
  domainRequestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  pluginName: z.string(), pluginVersion: z.string(),
  packageIntegrity: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeIdentity: z.json(),
}).strict()
export type PluginCoreBuildBinding = z.infer<typeof pluginCoreBuildBindingSchema>

/** Receipt bytes are preserved as JSON; the installed plugin owns its full schema. */
export const pluginCoreTrustedBuildSchema = z.object({
  binding: pluginCoreBuildBindingSchema,
  receipt: z.json(),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type PluginCoreTrustedBuild = z.infer<typeof pluginCoreTrustedBuildSchema>

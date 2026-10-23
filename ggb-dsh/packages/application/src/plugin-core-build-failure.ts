import { z } from 'zod'

/** Host-owned, bounded build evidence; no filesystem or raw report fields. */
export const pluginCoreBuildFailureSchema = z.object({
  kind: z.enum(['not_built', 'structure_rejected', 'execution_failed', 'verification_failed']),
  lastBuildId: z.uuid({ version: 'v4' }).optional(),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(512) }).strict().optional(),
  failedChecks: z.array(z.object({
    requirementId: z.string().min(1).max(256), checkId: z.string().min(1).max(256),
    method: z.string().min(1).max(64), status: z.string().min(1).max(32),
    reason: z.string().min(1).max(256).optional(),
  }).strict()).max(3),
  reasons: z.array(z.string().min(1).max(512)).max(3),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'not_built' ? value.lastBuildId !== undefined : value.lastBuildId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'build_identity_mismatch' })
  }
})
export type PluginCoreBuildFailure = z.infer<typeof pluginCoreBuildFailureSchema>

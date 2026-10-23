import { z } from 'zod'

/** Fixed execution facts only; no provider text, tool arguments or inferred phases. */
export const PLUGIN_CORE_PROGRESS_LIMIT = 128
export const pluginCoreProgressFactSchema = z.object({
  tool: z.enum(['ggb_inspect', 'ggb_request', 'ggb_check', 'ggb_build', 'model']),
  status: z.enum(['started', 'accepted', 'rejected', 'failed', 'finished']),
  callId: z.uuid(),
  step: z.number().int().min(1).max(1_000_000).optional(),
  buildId: z.uuid().optional(),
  attempt: z.number().int().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().refine(fact => fact.tool === 'model'
  ? fact.step !== undefined && ['started', 'finished'].includes(fact.status)
  : fact.step === undefined && fact.status !== 'finished', 'progress_source_status')
  .refine(fact => (fact.attempt === undefined) === (fact.limit === undefined)
    && (fact.attempt ?? 0) <= (fact.limit ?? 0), 'progress_budget')
export const pluginCoreProgressSchema = pluginCoreProgressFactSchema.safeExtend({
  sequence: z.number().int().min(1).max(PLUGIN_CORE_PROGRESS_LIMIT),
  occurredAt: z.iso.datetime(),
})
export type PluginCoreProgressFact = z.infer<typeof pluginCoreProgressFactSchema>
export type PluginCoreProgress = z.infer<typeof pluginCoreProgressSchema>
export type PluginCoreProgressObserver = (progress: PluginCoreProgress) => void | Promise<void>

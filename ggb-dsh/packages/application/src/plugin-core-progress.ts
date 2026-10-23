import { z } from 'zod'

/** Fixed facts only: no provider text, paths, tool arguments or invented percentages. */
export const PLUGIN_CORE_PROGRESS_LIMIT = 128
export const pluginCoreProgressFactSchema = z.object({
  tool: z.enum(['ggb_inspect', 'ggb_check', 'ggb_build']),
  status: z.enum(['started', 'accepted', 'rejected', 'failed']),
  callId: z.uuid(),
  buildId: z.uuid().optional(),
  attempt: z.number().int().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export const pluginCoreProgressSchema = pluginCoreProgressFactSchema.extend({
  sequence: z.number().int().min(1).max(PLUGIN_CORE_PROGRESS_LIMIT),
  occurredAt: z.iso.datetime(),
}).strict()
export type PluginCoreProgressFact = z.infer<typeof pluginCoreProgressFactSchema>
export type PluginCoreProgress = z.infer<typeof pluginCoreProgressSchema>
export type PluginCoreProgressObserver = (progress: PluginCoreProgress) => void | Promise<void>

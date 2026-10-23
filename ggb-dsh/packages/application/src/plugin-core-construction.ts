import { z } from 'zod'
import type { PluginCoreBuildBinding } from './plugin-core-trust.js'

export const MAX_CONSTRUCTION_RECORD_BYTES = 256 * 1024
export const pluginCoreConstructionRecordSchema = z.object({
  schemaVersion: z.literal(1), origin: z.literal('host-accepted-build'),
  buildId: z.uuid({ version: 'v4' }), domainRequestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  text: z.string().min(1).max(MAX_CONSTRUCTION_RECORD_BYTES),
}).strict().refine(value => new TextEncoder().encode(value.text).length <= MAX_CONSTRUCTION_RECORD_BYTES, 'construction_record_size')
export type PluginCoreConstructionRecord = z.infer<typeof pluginCoreConstructionRecordSchema>

export function constructionMatchesBuild(record: PluginCoreConstructionRecord | undefined,
  proof: { binding: PluginCoreBuildBinding } | undefined): boolean {
  return record === undefined || proof !== undefined && record.buildId === proof.binding.buildId
    && record.domainRequestDigest === proof.binding.domainRequestDigest && record.baseSha256 === proof.binding.baseSha256
}

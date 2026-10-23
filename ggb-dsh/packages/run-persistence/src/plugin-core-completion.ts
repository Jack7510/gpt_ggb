import { createHash } from 'node:crypto'
import { PLUGIN_CORE_LIMITS, toolArgumentsDigest, pluginCoreDeliverySchema, pluginCoreCleanupSchema, pluginCoreEventPayloadSchema, type PluginCoreRunRecord } from '@ggb-copilot/application'
import type { PluginCoreCompleteInput } from './plugin-core-store.js'

/** Byte integrity and admission/receipt linkage shared by every store adapter. */
export function artifactsMatchDelivery(input: PluginCoreCompleteInput,
  run: Pick<PluginCoreRunRecord, 'runId' | 'baseSha256' | 'deliveryContract'>): boolean {
  try {
    if (!pluginCoreDeliverySchema.safeParse(input.delivery).success) return false
    if (!pluginCoreCleanupSchema.safeParse(input.cleanup).success) return false
    if (!pluginCoreEventPayloadSchema.safeParse({ type: 'plugin_core.delivery',
      finalResponse: input.finalResponse, delivery: input.delivery, usage: input.usage, durationMs: input.durationMs }).success) return false
    if (input.delivery.cleanup && toolArgumentsDigest(input.delivery.cleanup) !== toolArgumentsDigest(input.cleanup)) return false
    const artifacts = input.artifacts
    const metadata = input.delivery.artifacts
    if (!artifacts.length || artifacts.length !== metadata.length
      || new Set(artifacts.map(a => a.artifactId)).size !== artifacts.length
      || new Set(artifacts.map(a => a.kind)).size !== artifacts.length) return false
    if (new Set(metadata.map(a => a.artifactId)).size !== metadata.length
      || new Set(metadata.map(a => a.kind)).size !== metadata.length) return false
    const byId = new Map(artifacts.map(a => [a.artifactId, a]))
    if (!metadata.every(m => {
      const a = byId.get(m.artifactId)
      if (!a || a.sha256 !== m.sha256 || a.kind !== m.kind || a.sizeBytes !== m.sizeBytes
        || a.contentType !== m.contentType) return false
      const limit = a.kind === 'result_ggb' ? PLUGIN_CORE_LIMITS.ggbBytes
        : a.kind === 'preview' ? PLUGIN_CORE_LIMITS.previewBytes : PLUGIN_CORE_LIMITS.reportBytes
      if (a.sizeBytes > limit) return false
      const bytes = Buffer.from(a.contentBase64, 'base64')
      return bytes.toString('base64') === a.contentBase64 && bytes.length > 0
        && bytes.length === a.sizeBytes && createHash('sha256').update(bytes).digest('hex') === a.sha256
    })) return false
    const ggb = artifacts.find(a => a.kind === 'result_ggb')
    if (!ggb || ggb.sha256 !== input.delivery.id) return false
    const proof = input.delivery.trustedBuild
    if (!proof) return false
    if (run.deliveryContract !== 'receipt-v1') return false
    if (!input.cleanup?.confirmed || input.cleanup.runId !== input.runId) return false
    if (proof.binding.runId !== run.runId || proof.binding.baseSha256 !== run.baseSha256
      || toolArgumentsDigest(proof.receipt) !== proof.receiptSha256) return false
    const receipt = proof.receipt as Record<string, unknown>
    if (!receipt || receipt.receiptSchemaVersion !== 2 || receipt.status !== 'succeeded'
      || !Array.isArray(receipt.issues) || receipt.issues.length !== 0) return false
    for (const [key, value] of Object.entries(proof.binding)) {
      if (toolArgumentsDigest(receipt[key]) !== toolArgumentsDigest(value)) return false
    }
    const report = artifacts.find(a => a.kind === 'verification')
    const manifest = artifacts.find(a => a.kind === 'manifest')
    const reference = receipt.verification as { reportSha256?: string; reportBytes?: number; summary?: unknown }
    if (!report || !manifest || report.sha256 !== reference?.reportSha256 || report.sizeBytes !== reference?.reportBytes
      || JSON.parse(Buffer.from(manifest.contentBase64, 'base64').toString()).sha256 !== input.delivery.id) return false
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== artifacts.length) return false
    return ['result_ggb', 'verification', 'manifest'].every(kind => artifacts.some(a => a.kind === kind))
      && receipt.artifacts.every((fact: Record<string, unknown>) => artifacts.some(a =>
        a.kind === fact.kind && a.sha256 === fact.sha256 && a.sizeBytes === fact.bytes && a.contentType === fact.contentType))
      && toolArgumentsDigest(reference.summary) === toolArgumentsDigest(input.delivery.verification)
  } catch { return false }
}

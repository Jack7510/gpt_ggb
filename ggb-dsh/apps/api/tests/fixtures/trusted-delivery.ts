import { createHash, randomUUID } from 'node:crypto'
import { toolArgumentsDigest, type ChannelPluginCoreDelivery, type RunId } from '@ggb-copilot/application'

/** Synthetic Worker attestation; API tests never claim a browser-verified GGB. */
export function trustedDelivery(runId: RunId, input: ChannelPluginCoreDelivery): ChannelPluginCoreDelivery {
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const ggb = Buffer.from(input.ggbBase64!, 'base64')
  const report = Buffer.from(JSON.stringify(input.verification, null, 2) + '\n')
  const manifest = Buffer.from(JSON.stringify({ sha256: hash(ggb) }) + '\n')
  const binding = { runId, turnId: randomUUID(), epoch: 1, requestId: randomUUID(), toolCallId: randomUUID(),
    buildId: randomUUID(), domainRequestDigest: 'a'.repeat(64), baseSha256: null,
    pluginName: 'ggb-plugins-dsh', pluginVersion: '0.8.3', packageIntegrity: 'b'.repeat(64), runtimeIdentity: {} }
  const material = [['result_ggb', ggb, 'application/octet-stream'], ['verification', report, 'application/json'],
    ['manifest', manifest, 'application/json'], ...(input.screenshotBase64 ? [['preview', Buffer.from(input.screenshotBase64, 'base64'), 'image/png']] : [])] as const
  const receipt = { receiptSchemaVersion: 2, ...binding, status: 'succeeded', issues: [], verification: { reportSha256: hash(report), reportBytes: report.length, summary: input.verification },
    artifacts: material.map(([kind, bytes, contentType]) => ({ kind, ref: kind, bytes: (bytes as Buffer).length,
      sha256: hash(bytes as Buffer), contentType })) }
  return { ...input, id: hash(ggb), ggbBytes: ggb.length, reportBase64: report.toString('base64'),
    manifestBase64: manifest.toString('base64'), trustedBuild: { binding, receipt, receiptSha256: toolArgumentsDigest(receipt) } }
}

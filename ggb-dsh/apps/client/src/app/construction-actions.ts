import type { PluginCoreConstructionRecord } from '@ggb-copilot/application/browser'
import { copyMessageContent } from './copy-message.js'

export async function copyConstructionRecord(report: PluginCoreConstructionRecord,
  writeText: (text: string) => Promise<void> = value => navigator.clipboard.writeText(value)): Promise<void> {
  await copyMessageContent(report.text, writeText)
}

export function downloadConstructionRecord(report: PluginCoreConstructionRecord): void {
  const url = URL.createObjectURL(new Blob([report.text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `construction-${report.buildId}.txt`
  try { document.body.append(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}

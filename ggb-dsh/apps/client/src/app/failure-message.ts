import type { PluginCoreBuildFailure, PresentationLocale } from '@ggb-copilot/application/browser'
import { text } from './localization.js'

/** The same evidence appears in live notices and restored terminal run views. */
export function failureMessage(failure: { code: string; message: string; details?: PluginCoreBuildFailure | undefined },
  locale: PresentationLocale): string {
  const details = failure.details
  const lines = [`${failure.code}: ${failure.message}`]
  if (details === undefined) return lines[0]!
  const label = { not_built: 'buildNotAttempted', structure_rejected: 'buildStructureRejected',
    execution_failed: 'buildExecutionFailed', verification_failed: 'buildVerificationFailed' } as const
  lines.push(text(locale, label[details.kind]))
  if (details.lastBuildId) lines.push(`${text(locale, 'lastBuild')}: ${details.lastBuildId}`)
  if (details.error) lines.push(`${details.error.code}: ${details.error.message}`)
  lines.push(...details.reasons)
  return lines.join(' · ')
}

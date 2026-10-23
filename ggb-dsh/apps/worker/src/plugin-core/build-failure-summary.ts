import { pluginCoreBuildFailureSchema, type PluginCoreBuildFailure } from '@ggb-copilot/application'
import type { PluginCoreToolReport } from './gateway.js'
import type { PluginCoreRunResult } from './process-runner.js'
import { redactEvidence } from './evidence.js'

function short(value: string, limit: number): string {
  return String(redactEvidence(value, [], true)).replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, limit) || 'unknown'
}

export function summarizeBuildFailure(result: PluginCoreRunResult, buildId: string,
  report: PluginCoreToolReport): PluginCoreBuildFailure {
  const process = result.execution
  const unsafe = process !== undefined && (process.kind !== 'completed' || process.exitCode !== 0
    || process.signal !== null || process.cleanupConfirmed !== true)
  const kind = unsafe ? 'execution_failed' : result.buildPhase === 'preflight' ? 'structure_rejected'
    : result.error?.code === 'verification_failed' || report.failedChecks.length > 0
      ? 'verification_failed' : 'execution_failed'
  const failedChecks = report.failedChecks.slice(0, 3).map(check => ({
    requirementId: short(check.requirementId, 256), checkId: short(check.checkId, 256),
    method: short(check.method, 64), status: short(check.status, 32),
    ...(check.reason ? { reason: short(check.reason, 256) } : {}),
  }))
  const error = { code: short(result.error?.code ?? 'build_execution_failed', 64),
    message: short(result.error?.message ?? 'The build did not complete successfully.', 512) }
  const reasons = failedChecks.map(check => short(
    `${check.requirementId}/${check.checkId}: ${check.reason ?? `${check.method} ${check.status}`}`, 512))
  return pluginCoreBuildFailureSchema.parse({ kind, lastBuildId: buildId, error, failedChecks,
    reasons: reasons.length > 0 ? reasons : [error.message] })
}

export function noDeliveryMessage(details: PluginCoreBuildFailure): string {
  switch (details.kind) {
    case 'not_built': return 'No build was attempted; no accepted build receipt exists.'
    case 'structure_rejected': return 'The last build was rejected during structural preflight.'
    case 'execution_failed': return 'The last build did not complete successfully.'
    case 'verification_failed': return 'The last build did not satisfy verification.'
  }
}

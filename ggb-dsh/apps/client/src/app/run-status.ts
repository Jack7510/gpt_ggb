import { failureMessage } from './failure-message.js'
import type { ProjectedRunState } from '../runtime/run-state.js'
import type { PresentationLocale } from '@ggb-copilot/application/browser'
import { text } from './localization.js'

export interface RunStatusDescription {
  tone: 'ready' | 'working' | 'waiting' | 'success' | 'error'
  label: string
  detail: string
}

/**
 * Renders a status from durable run timestamps plus the browser clock. The
 * clock is display-only: it does not change run state or create network work.
 */
export function describeRunStatus(
  run: ProjectedRunState | undefined,
  hasProviderKey: boolean,
  nowMs: number,
  locale: PresentationLocale,
): RunStatusDescription {
  if (run === undefined) return hasProviderKey
    ? { tone: 'ready', label: text(locale, 'ready'), detail: text(locale, 'readyDetail') }
    : { tone: 'waiting', label: text(locale, 'keyRequired'), detail: text(locale, 'keyRequiredDetail') }
  if (run.phase === 'completed') return { tone: 'success', label: text(locale, 'completed'), detail: text(locale, 'completedDetail') }
  if (run.phase === 'cancelled') return { tone: 'ready', label: text(locale, 'cancelled'), detail: text(locale, 'cancelledDetail') }
  if (run.stopRequested) return { tone: 'working', label: text(locale, 'stopping'), detail: text(locale, 'stoppingDetail') }
  if (run.phase === 'failed') return { tone: 'error', label: text(locale, 'attention'), detail: run.failure?.details ? failureMessage(run.failure, locale) : run.failure?.message ?? text(locale, 'failedDetail') }

  const total = elapsed(run.startedAt, nowMs)
  return {
    tone: 'working',
    label: total === null ? text(locale, 'working') : `${text(locale, 'working')} · ${total}`,
    detail: run.progress ? describeToolProgress(run.progress, nowMs, locale) : text(locale, 'planningDetail'),
  }
}

function elapsed(startedAt: string | null, nowMs: number): string | null {
  if (startedAt === null) return null
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return null
  const seconds = Math.max(0, Math.floor((nowMs - startMs) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** Describe the browser provider-key requirement without echoing provider text. */
export function credentialRequiredNotice(hasProviderKey: boolean, locale: PresentationLocale): string {
  return text(locale, hasProviderKey ? 'resumeReadyDetail' : 'keyRequiredNotice')
}

function describeToolProgress(progress: NonNullable<ProjectedRunState['progress']>, nowMs: number,
  locale: PresentationLocale): string {
  const zh = locale === 'zh-CN'
  const attempt = progress.attempt === undefined ? ''
    : ` · ${zh ? '最近构建' : 'Last build'} ${progress.attempt}/${progress.limit}`
  if (progress.tool === 'model') {
    const started = Date.parse(progress.occurredAt)
    const elapsedSeconds = progress.status === 'started' && Number.isFinite(started)
      ? Math.max(0, Math.floor((nowMs - started) / 1_000)) : 0
    const seconds = elapsedSeconds > 0 ? elapsedSeconds : null
    const running = seconds === null ? '' : zh ? ` · 已运行 ${seconds}s` : ` · running ${seconds}s`
    return `${zh ? '模型第' : 'Model step '}${progress.step}${zh ? '步' : ''} · ${
      progress.status === 'started' ? zh ? '已开始' : 'Started' : zh ? '已结束，等待后续执行' : 'Finished; awaiting subsequent execution'}${attempt}${running}`
  }
  const tool = { ggb_request: zh ? '保存或读取请求草稿' : 'Save or read request draft', ggb_inspect: zh ? '读取参考或基线' : 'Read reference or baseline',
    ggb_check: zh ? '结构预检' : 'Structural check',
    ggb_build: zh ? '构造与核验' : 'Construction and verification' }[progress.tool]
  const status = { started: zh ? '调用中' : 'Running', accepted: zh ? '工具结果已接受' : 'Tool result accepted',
    rejected: zh ? '调用被拒绝，等待后续处理' : 'Call rejected; awaiting further processing',
    failed: zh ? '调用异常，等待任务结算' : 'Call failed; awaiting task outcome',
    finished: '' }[progress.status]
  return `${tool}${attempt} · ${status}`
}

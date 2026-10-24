import type { PresentationLocale } from '@ggb-copilot/application/browser'

/** Render measured sample coverage, including older passed/zero summaries. */
export function interactionSummary(verification: unknown, locale: PresentationLocale): string {
  const zh = locale === 'zh-CN'
  if (!verification || typeof verification !== 'object' || !('interaction' in verification)) return ''
  const value = verification.interaction
  if (!value || typeof value !== 'object' || !('status' in value) || !('samples' in value)) return ''
  const samples = value.samples
  if (typeof samples !== 'number' || !Number.isSafeInteger(samples) || samples < 0) return ''
  if (samples === 0 && (value.status === 'passed' || value.status === 'not_sampled')) {
    return zh ? '未采样：未验证参数变化或拖动后的行为。' : 'Not sampled: parameter changes and dragging were not verified.'
  }
  if (samples > 0 && value.status === 'passed') {
    return zh ? `交互采样通过（${samples} 个样本）；采样不代表全域证明。` : `Interaction passed (${samples} samples); finite sampling is not a proof for all inputs.`
  }
  return zh ? '交互采样未确认通过。' : 'Interaction sampling is not confirmed as passed.'
}

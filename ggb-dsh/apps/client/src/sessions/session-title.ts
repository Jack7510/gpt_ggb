import type { PresentationLocale } from '@ggb-copilot/application/browser'

export const DEFAULT_SESSION_TITLE = 'New session'
export const DEFAULT_SESSION_TITLES = new Set([DEFAULT_SESSION_TITLE, '新会话'])

/** Local presentation only. No model call and no conversion of mathematical operators. */
export function titleFromPrompt(prompt: string, hasImage: boolean, locale: PresentationLocale): string {
  const clean = prompt.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+)/gmu, '')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, '$1$2').replace(/`/gu, '').replace(/\s+/gu, ' ').trim()
  if (hasImage && (clean.length === 0 || ['请根据图片中的题目完成几何构图。',
    'Construct the geometry described in this image.'].includes(clean))) {
    return locale === 'zh-CN' ? '图片构图' : 'Image construction'
  }
  const units = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(clean), item => item.segment)
    : Array.from(clean)
  return units.slice(0, 32).join('')
}

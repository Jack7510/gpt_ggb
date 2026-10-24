import type { PresentationLocale } from '@ggb-copilot/application/browser'

export const DEFAULT_SESSION_TITLE = 'New session'
export const DEFAULT_SESSION_TITLES = new Set([DEFAULT_SESSION_TITLE, '新会话'])
export const GENERIC_IMAGE_TITLES = new Set(['图片构图', 'Image construction',
  '按图中的题目画图', '按图作图', '构造图形'])
const GEOMETRY_TOPIC = /(?:抛物线|椭圆|双曲线|圆|三角形|四边形|多边形|函数|直线|平面|parabola|ellipse|hyperbola|circle|triangle|quadrilateral|polygon|function|line|plane)/iu

/** Local presentation only. No model call and no conversion of mathematical operators. */
export function titleFromPrompt(prompt: string, hasImage: boolean, locale: PresentationLocale): string {
  const clean = cleanText(prompt)
  if (hasImage && (clean.length === 0 || ['请根据图片中的题目完成几何构图。',
    'Construct the geometry described in this image.'].includes(clean))) {
    return locale === 'zh-CN' ? '图片构图' : 'Image construction'
  }
  return clip(clean, locale)
}

/**
 * Derive a topic title only after a completed run. The prompt is often a
 * generic image instruction, so use the final construction text or the
 * accepted script's first native source as a conservative fallback.
 */
export function titleFromFinalReport(response: string, constructionText: string | undefined,
  locale: PresentationLocale): string {
  const problem = imageProblemFromReport(response)
  if (problem) return clip(cleanText(problem), locale)
  const candidates = response.split(/\r?\n/u).map(cleanText).filter(Boolean)
  const topic = candidates.find(line => GEOMETRY_TOPIC.test(line))
  if (topic !== undefined) {
    const phrase = stripLead(topic).split(/[。；;]/u)[0] ?? ''
    const title = clip(phrase, locale)
    if (title.length > 0 && !GENERIC_IMAGE_TITLES.has(title)) return title
  }
  for (const line of (constructionText ?? '').split(/\r?\n/u)) {
    const source = stripLead(cleanText(line))
    if (!/[=:：]/u.test(source)
      || /^(?:GGB|技术|Technical|Scripts|#|\d+\.|buildId|domainRequestDigest|baseSha256)/u.test(source)) continue
    const title = clip(source.split(/[。；;]/u)[0] ?? source, locale)
    if (title.length > 0 && !GENERIC_IMAGE_TITLES.has(title)) return title
  }
  return ''
}

/** Read only the host-generated first section; model prose is not an image-source marker. */
export function imageProblemFromReport(response: string): string {
  const match = /^### (?:原题（图片识别）|Original problem \(image transcription\))\r?\n\r?\n((?:>[^\r\n]*(?:\r?\n|$))+)/u.exec(response)
  return match?.[1]?.split(/\r?\n/u).filter(line => line.startsWith('>'))
    .map(line => line.replace(/^> ?/u, '')).join('\n').trim() ?? ''
}

function cleanText(input: string): string {
  return input.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, '$1$2').replace(/`/gu, '')
    .replace(/\\\(|\\\)|\\\[|\\\]/gu, '').replace(/\$/gu, '').replace(/\s+/gu, ' ').trim()
}

function stripLead(input: string): string {
  return input.replace(/^(?:已绘制|绘制|画|创建|构造|作出|Draw|Drew|Create|Construct|Plot|Plotted)\s*/iu, '').trim()
}

function clip(input: string, locale: PresentationLocale): string {
  const units = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(input), item => item.segment)
    : Array.from(input)
  return units.slice(0, 32).join('')
}

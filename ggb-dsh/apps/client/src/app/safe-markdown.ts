import katex from 'katex'
import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'

// Model text is untrusted. Markdown-it escapes raw HTML; KaTeX refuses trusted
// commands such as \href, and links/images cannot create external requests.
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false })
renderer.disable(['link', 'image', 'autolink'])
const existingBlockRules = new Set(renderer.block.ruler.getRules(''))
renderer.use(texmath, {
  engine: katex,
  delimiters: ['brackets', 'dollars'],
  katexOptions: { throwOnError: false, trust: false, output: 'htmlAndMathml' },
})
// texmath registers display blocks without paragraph interruption rules. Reuse
// their silent recognizers so prose can end at a valid formula without rewriting
// source text (which would also alter code fences and inline code).
const mathBlockRules = renderer.block.ruler.getRules('').filter(rule => !existingBlockRules.has(rule))
renderer.block.ruler.before('paragraph', 'math_paragraph_boundary', (state, startLine, endLine, silent) =>
  silent && mathBlockRules.some(rule => rule(state, startLine, endLine, true)), { alt: ['paragraph'] })

/** Render report Markdown and TeX without accepting model-supplied HTML. */
export function renderSafeMarkdown(source: string): string {
  return renderer.render(source)
}

/** Text-block projection retained for callers that do not render HTML. */
export type MarkdownBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'ordered_list'; items: string[] }
  | { kind: 'unordered_list'; items: string[] }
  | { kind: 'code'; language: string; code: string }

export function parseSafeMarkdown(source: string): MarkdownBlock[] {
  const tokens = renderer.parse(source, {})
  const blocks: MarkdownBlock[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token?.type === 'fence') {
      blocks.push({ kind: 'code', language: token.info.trim(), code: token.content.replace(/\n$/, '') })
    } else if (token?.type === 'heading_open') {
      blocks.push({ kind: 'heading', text: tokens[index + 1]?.content ?? '' })
    } else if (token?.type === 'paragraph_open' && token.level === 0) {
      blocks.push({ kind: 'paragraph', text: tokens[index + 1]?.content ?? '' })
    } else if (token?.type === 'ordered_list_open' || token?.type === 'bullet_list_open') {
      const items: string[] = []
      const level = token.level
      while (++index < tokens.length) {
        const item = tokens[index]
        if (item?.level === level && (item.type === 'ordered_list_close' || item.type === 'bullet_list_close')) break
        if (item?.type === 'inline' && item.level === level + 3) items.push(item.content)
      }
      blocks.push({ kind: token.type === 'ordered_list_open' ? 'ordered_list' : 'unordered_list', items })
    }
  }
  return blocks
}

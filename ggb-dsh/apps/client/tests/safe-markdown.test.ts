import { describe, expect, it } from 'vitest'

import { parseSafeMarkdown, renderSafeMarkdown } from '../src/app/safe-markdown.js'

describe('safe run-report Markdown', () => {
  it('keeps a planning summary followed by numbered construction steps as separate UI blocks', () => {
    expect(parseSafeMarkdown('## 已规划构图\n\n已确定可验证的作图步骤。\n\n1. 取点 A\n2. 取点 B\n3. 连接 A、B')).toEqual([
      { kind: 'heading', text: '已规划构图' },
      { kind: 'paragraph', text: '已确定可验证的作图步骤。' },
      { kind: 'ordered_list', items: ['取点 A', '取点 B', '连接 A、B'] },
    ])
  })

  it('renders headings, numbered construction steps and a GGBScript code block as text blocks', () => {
    expect(parseSafeMarkdown('## 作图步骤\n\n1. 创建圆心 A\n2. 作圆 c\n\n## GGBScript\n\n```geogebra\nA=(0,0)\nc=Circle(A,3)\n```')).toEqual([
      { kind: 'heading', text: '作图步骤' },
      { kind: 'ordered_list', items: ['创建圆心 A', '作圆 c'] },
      { kind: 'heading', text: 'GGBScript' },
      { kind: 'code', language: 'geogebra', code: 'A=(0,0)\nc=Circle(A,3)' },
    ])
  })

  it('does not interpret HTML as executable markup', () => {
    expect(parseSafeMarkdown('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'paragraph', text: '<img src=x onerror=alert(1)>' }])
  })

  it.each([['\\[', '\\]'], ['$$', '$$']])('renders display math adjacent to prose with %s delimiters', (open, close) => {
    const html = renderSafeMarkdown(`由三角形不等式，\n${open}\nPA'+PB\\ge A'B\n${close}\n等号在最短路径处成立。`)
    expect(html.match(/class="katex-display"/g)).toHaveLength(1)
    expect(html).toContain('<p>由三角形不等式，</p>')
    expect(html).toContain('<p>等号在最短路径处成立。</p>')
    expect(html).not.toContain('katex-error')
  })

  it('renders consecutive display equations with prose and inline math between them', () => {
    const html = renderSafeMarkdown(String.raw`因为 \(P\) 在对称轴上，都有
\[
PA=PA'.
\]
于是
\[
PA+PB=PA'+PB.
\]
由三角形不等式，
\[
PA'+PB\ge A'B.
\]
取 \(P=C\) 时达到最小。`)
    expect(html.match(/class="katex-display"/g)).toHaveLength(3)
    expect(html.match(/class="katex"/g)).toHaveLength(5)
    expect(html).not.toContain('katex-error')
  })

  it('preserves formula delimiters inside fenced and inline code', () => {
    const source = '```latex\n\\[\nPA+PB\\ge A\n\\]\n```\n\n`\\[PA\\]`'
    const html = renderSafeMarkdown(source)
    expect(html).not.toContain('class="katex')
    expect(html).toContain('<code class="language-latex">\\[\nPA+PB\\ge A\n\\]\n</code>')
    expect(html).toContain('<code>\\[PA\\]</code>')
  })

  it('leaves unclosed math as text and keeps untrusted content inert', () => {
    const unclosed = renderSafeMarkdown('正文\n\\[\n未闭合')
    expect(unclosed).toContain('未闭合')
    expect(unclosed).not.toContain('class="katex')
    const html = renderSafeMarkdown('<img src=x onerror=alert(1)>\n\n[链接](https://example.com)\n\n\\[\\href{javascript:alert(1)}{x}\\]')
    expect(html).not.toMatch(/<img\b|<a\b|<script\b/)
    expect(html).toContain('&lt;img')
  })
})

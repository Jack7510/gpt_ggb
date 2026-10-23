declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it'
  import type katex from 'katex'

  interface TexMathOptions {
    readonly engine: typeof katex
    readonly delimiters: readonly ('brackets' | 'dollars')[]
    readonly katexOptions: katex.KatexOptions
  }

  export default function texmath(markdown: MarkdownIt, options: TexMathOptions): void
}

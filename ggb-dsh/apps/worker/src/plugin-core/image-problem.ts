export interface ImageProblem {
  readonly text: string
  readonly locale: 'zh-CN' | 'en'
}

/** The installed draft appends image transcription to the host-owned original prompt. */
export function recognizedImageProblem(prompt: string, request: unknown): ImageProblem | null {
  if (request === null || typeof request !== 'object') return null
  const value = request as Record<string, unknown>
  const prefix = `${prompt}\n`
  if (typeof value.prompt !== 'string' || !value.prompt.startsWith(prefix)) return null
  const text = value.prompt.slice(prefix.length).trim()
  if (!text) return null
  return { text, locale: value.locale === 'en' ? 'en' : 'zh-CN' }
}

/** Recognition is presented as input text, never as a verified mathematical conclusion. */
export function prependImageProblem(response: string, problem: ImageProblem | null): string {
  if (problem === null) return response
  const heading = problem.locale === 'en' ? 'Original problem (image transcription)' : '原题（图片识别）'
  const quote = problem.text.split(/\r?\n/u).map(line => `> ${line}`).join('\n')
  return `### ${heading}\n\n${quote}\n\n${response}`
}

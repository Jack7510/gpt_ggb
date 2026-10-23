import { describe, expect, it, vi } from 'vitest'
import { copyMessageContent } from '../src/app/copy-message.js'

describe('copyMessageContent', () => {
  it('copies the complete message body, including Markdown and GGBScript', async () => {
    const content = '## 构图步骤\n1. 创建圆\n\n```ggbscript\nCircle((0, 0), 1)\n```'
    const writeText = vi.fn(async (_text: string) => undefined)

    await copyMessageContent(content, writeText)

    expect(writeText).toHaveBeenCalledExactlyOnceWith(content)
  })

  it('propagates clipboard errors for UI feedback', async () => {
    await expect(copyMessageContent('构图完成', async () => { throw new Error('denied') }))
      .rejects.toThrow('denied')
  })
})

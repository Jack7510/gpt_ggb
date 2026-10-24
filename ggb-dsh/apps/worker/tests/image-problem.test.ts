import { describe, expect, it } from 'vitest'
import { prependImageProblem, recognizedImageProblem } from '../src/plugin-core/image-problem.js'
import { PluginCoreExecutionState } from '../src/plugin-core/execution-state.js'
import { runIdSchema } from '@ggb-copilot/application'

describe('accepted image problem presentation', () => {
  it('keeps all questions, conditions and options before the summary', () => {
    const text = '184. 抛物线 y²=4x 的焦点为 F。\n（1）作图；（2）观察。\nA. 相交 B. 相切'
    const problem = recognizedImageProblem('Draw from image.', { prompt: `Draw from image.\n${text}`, locale: 'zh-CN' })
    expect(problem?.text).toBe(text)
    expect(prependImageProblem('已完成构图。', problem)).toBe(
      `### 原题（图片识别）\n\n> 184. 抛物线 y²=4x 的焦点为 F。\n> （1）作图；（2）观察。\n> A. 相交 B. 相切\n\n已完成构图。`)
    expect(prependImageProblem('Done.', { text: 'Find x.', locale: 'en' })).toContain('### Original problem (image transcription)')
  })
  it('does not fabricate recognition for absent, unrelated or empty input', () => {
    for (const request of [null, {}, { prompt: 'draw' }, { prompt: 'draw\n ' }, { prompt: 'unrelated\nquestion' }]) {
      expect(recognizedImageProblem('draw', request)).toBeNull()
    }
    expect(prependImageProblem('unchanged', null)).toBe('unchanged')
  })
  it('uses the latest accepted request and clears recognition when its candidate is invalidated', () => {
    const state = new PluginCoreExecutionState('/unused')
    const runId = runIdSchema.parse('run_00000000-0000-4000-8000-000000000001')
    const other = runIdSchema.parse('run_00000000-0000-4000-8000-000000000002')
    const delivery = { id: 'a'.repeat(64), ggbBase64: null, ggbBytes: 0, screenshotBase64: null, verification: {} }
    state.setImagePrompt(runId, 'image')
    state.accept(runId, delivery, { prompt: 'image\nold question' })
    state.accept(runId, delivery, { prompt: 'image\ncorrected question' })
    expect(state.imageProblem(runId)?.text).toBe('corrected question')
    expect(state.imageProblem(other)).toBeNull()
    state.invalidate(runId)
    expect(state.imageProblem(runId)).toBeNull()
    state.accept(runId, delivery, { prompt: 'image' })
    expect(state.imageProblem(runId)).toBeNull()
    state.release(runId)
    state.accept(runId, delivery, { prompt: 'image\nnot an image run anymore' })
    expect(state.imageProblem(runId)).toBeNull()
  })
})

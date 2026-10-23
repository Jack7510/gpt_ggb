import { describe, expect, it } from 'vitest'
import { titleFromPrompt } from '../src/sessions/session-title.js'
import { createMemoryDatabase } from '../src/persistence/indexeddb.js'
import { SessionRepository } from '../src/sessions/session-repository.js'
import { SessionService } from '../src/sessions/session-service.js'

function fixture() {
  const repo = new SessionRepository(createMemoryDatabase())
  let id = 0
  return { repo, service: new SessionService({ repository: repo, tokens: { reveal: async () => '' },
    runs: { stop: async () => {} }, now: () => '2026-10-23T00:00:00Z', newId: () => `s${++id}` }) }
}
describe('automatic local session titles', () => {
  it('cleans display Markdown and whitespace while retaining mathematical operators', () => {
    expect(titleFromPrompt('## **画圆**\n  [参数](https://example.com) `x_1*y` ∈ [0,1]', false, 'zh-CN'))
      .toBe('画圆 参数 x_1*y ∈ [0,1]')
    expect(titleFromPrompt('绘制 x**2 + x_1*y = 0', false, 'zh-CN')).toBe('绘制 x**2 + x_1*y = 0')
    const family = '👨‍👩‍👧‍👦'
    expect(titleFromPrompt(family.repeat(40), false, 'en')).toBe(family.repeat(32))
  })
  it('uses image fallback only for generic image prompts', () => {
    expect(titleFromPrompt('请根据图片中的题目完成几何构图。', true, 'zh-CN')).toBe('图片构图')
    expect(titleFromPrompt('Construct the geometry described in this image.', true, 'en')).toBe('Image construction')
    expect(titleFromPrompt('绘制抛物线 y²=4x', true, 'zh-CN')).toBe('绘制抛物线 y²=4x')
  })
  it.each([false, true])('manual naming wins concurrent suggestions, including a manual default title (manual first=%s)', async manualFirst => {
    const { repo, service } = fixture()
    const session = await service.createSession()
    const manual = () => service.renameSession(session.sessionId, '新会话')
    const automatic = () => service.applySuggestedTitle(session.sessionId, '自动标题')
    await Promise.all(manualFirst ? [manual(), automatic()] : [automatic(), manual()])
    expect(await repo.getSession(session.sessionId)).toMatchObject({ title: '新会话', titleSource: 'manual' })
    expect(await automatic()).toBe(false)
  })
  it('keeps whole emoji through service normalization', async () => {
    const { repo, service } = fixture()
    const session = await service.createSession()
    const title = '👨‍👩‍👧‍👦'.repeat(32)
    await service.applySuggestedTitle(session.sessionId, title)
    expect((await repo.getSession(session.sessionId))?.title).toBe(title)
  })
  it('does not overwrite the first automatic title or another session, and does not resurrect deletion', async () => {
    const { repo, service } = fixture()
    const first = await service.createSession(), second = await service.createSession()
    await service.applySuggestedTitle(first.sessionId, '首条题目')
    await Promise.all([repo.updateSession(first.sessionId, { activeCanvasVersion: 'v1' }),
      service.applySuggestedTitle(first.sessionId, '后续修改')])
    expect(await repo.getSession(first.sessionId)).toMatchObject({ title: '首条题目', activeCanvasVersion: 'v1' })
    expect((await repo.getSession(second.sessionId))?.title).toBe('New session')
    await repo.deleteSession(first.sessionId)
    expect(await service.applySuggestedTitle(first.sessionId, '迟到标题')).toBe(false)
    expect(await repo.getSession(first.sessionId)).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { PluginCoreConstructionRecord } from '@ggb-copilot/application/browser'
import { ConstructionRecord } from '../src/app/construction-record.js'
import { copyConstructionRecord, downloadConstructionRecord } from '../src/app/construction-actions.js'

const report: PluginCoreConstructionRecord = { schemaVersion: 1, origin: 'host-accepted-build',
  buildId: '11111111-1111-4111-8111-111111111111', domainRequestDigest: 'a'.repeat(64), baseSha256: null,
  text: '构造步骤\n[cas] Factor(x^2-1)\n</code><script>alert(1)</script>\n' }
afterEach(() => vi.unstubAllGlobals())
describe('construction record presentation', () => {
  it('escapes actual component code content and includes copy/download controls', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(ConstructionRecord, { report, locale: 'zh-CN' }) }))
    expect(html).toContain('GGB 构造脚本')
    expect(html).toContain('仅包含几何构造命令')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('copy-construction')
    expect(html).toContain('download-construction')
  })
  it('copies the exact accepted text and propagates clipboard failure', async () => {
    const write = vi.fn(async () => {})
    await copyConstructionRecord(report, write)
    expect(write).toHaveBeenCalledExactlyOnceWith(report.text)
    await expect(copyConstructionRecord(report, async () => { throw new Error('denied') })).rejects.toThrow('denied')
  })
  it.each([false, true])('downloads exact UTF-8 text and releases the preview URL even if the click fails (%s)', async fail => {
    let blob!: Blob
    const revoke = vi.fn()
    const anchor = { href: '', download: '', click: vi.fn(() => { if (fail) throw new Error('click failed') }), remove: vi.fn() }
    vi.stubGlobal('URL', { createObjectURL: (value: Blob) => { blob = value; return 'blob:record' }, revokeObjectURL: revoke })
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } })
    if (fail) expect(() => downloadConstructionRecord(report)).toThrow('click failed')
    else downloadConstructionRecord(report)
    expect(await blob.text()).toBe(report.text)
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(anchor.download).toBe(`construction-${report.buildId}.txt`)
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:record')
  })
})

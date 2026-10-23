import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { pluginCoreConstructionRecordSchema, MAX_CONSTRUCTION_RECORD_BYTES,
  channelPluginCoreDeliverySchema, type PluginCoreBuildBinding } from '@ggb-copilot/application'
import { createConstructionRecord } from '../src/plugin-core/construction-record.js'

const binding: PluginCoreBuildBinding = { runId: `run_${randomUUID()}`, turnId: randomUUID(), epoch: 1,
  requestId: randomUUID(), toolCallId: randomUUID(), buildId: randomUUID(), domainRequestDigest: 'a'.repeat(64),
  baseSha256: null, pluginName: 'fixture', pluginVersion: '1', packageIntegrity: 'b'.repeat(64), runtimeIdentity: {} }
const request = { locale: 'zh-CN', outputDir: '/server/private', base: { path: '/server/base.ggb' }, plan: {
  program: [{ id: 'O', op: 'native', mode: 'algebra', source: 'O=(0,0)', outputs: ['O'], initial: [1,2] },
    { id: 'f', op: 'native', mode: 'cas', source: 'Factor(x^2-1)' }],
  requirements: [{ checks: ['PRIVATE_CHECK'], source: 'PRIVATE_REQUIREMENT' }], interactions: ['PRIVATE_SAMPLE'],
  updates: [{ object: 'A', coords: [2,3] }], edits: [{ object: 'B', properties: { visible: false } }],
  styles: [{ object: 'O', properties: { color: '#FF0000' } }], view: { xMin: -2, xMax: 2, yMin: -2, yMax: 2 }, display: 'graphics',
} }
describe('host accepted construction record', () => {
  it('preserves command order, modes, outputs, initialization and changes without verification or host paths', () => {
    const record = createConstructionRecord(request, binding)
    expect(record).toMatchObject({ buildId: binding.buildId, domainRequestDigest: binding.domainRequestDigest,
      origin: 'host-accepted-build', baseSha256: null })
    expect(record.text.indexOf('O=(0,0)')).toBeLessThan(record.text.indexOf('Factor(x^2-1)'))
    for (const text of ['[algebra]', '[cas]', 'outputs: ["O"]', 'initial: [1,2]', 'updates', 'edits', 'styles', 'view', 'graphics']) expect(record.text).toContain(text)
    expect(record.text).not.toMatch(/PRIVATE_|\/server\//)
  })
  it('records only the delta for baseline edits, and retains the baseline digest', () => {
    const record = createConstructionRecord({ locale: 'en', plan: { edits: request.plan.edits } },
      { ...binding, baseSha256: 'c'.repeat(64) })
    expect(record.baseSha256).toBe('c'.repeat(64))
    expect(record.text).toContain('Changes require the original baseline')
    expect(record.text).toContain('"object":"B"')
    expect(record.text).not.toContain('O=(0,0)')
  })
  it('fits a command near the public request byte budget without truncating source', () => {
    const source = 'f(x)=' + 'x+'.repeat(60000) + '1'
    const record = createConstructionRecord({ plan: { program: [{ id: 'f', op: 'native', mode: 'algebra', source }] } }, binding)
    expect(record.text).toContain(source)
    expect(new TextEncoder().encode(record.text).length).toBeLessThan(MAX_CONSTRUCTION_RECORD_BYTES)
  })
  it('bounds text by UTF-8 bytes and rejects mismatched or missing accepted identity', () => {
    const record = createConstructionRecord(request, binding)
    const delivery = { id: 'c'.repeat(64), ggbBase64: null, ggbBytes: 0, screenshotBase64: null,
      verification: {}, trustedBuild: { binding, receipt: {}, receiptSha256: 'd'.repeat(64) }, construction: record }
    expect(channelPluginCoreDeliverySchema.safeParse(delivery).success).toBe(true)
    for (const construction of [{ ...record, buildId: randomUUID() }, { ...record, domainRequestDigest: 'f'.repeat(64) },
      { ...record, baseSha256: 'f'.repeat(64) }]) {
      expect(channelPluginCoreDeliverySchema.safeParse({ ...delivery, construction }).success).toBe(false)
    }
    expect(channelPluginCoreDeliverySchema.safeParse({ ...delivery, trustedBuild: undefined }).success).toBe(false)
    expect(pluginCoreConstructionRecordSchema.safeParse({ ...record, text: '中'.repeat(MAX_CONSTRUCTION_RECORD_BYTES / 2) }).success).toBe(false)
  })
})

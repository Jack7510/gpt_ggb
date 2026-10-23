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
const verification = { construction: { objects: [{ name: 'f', defined: true, expression: '(x-1)*(x+1)' }] } }
describe('host accepted construction record', () => {
  it('omits duplicate initialization for literal native points in the circle construction', () => {
    const program = [
      { id: 'O', op: 'native', mode: 'algebra', source: 'O=(0,0)', initial: [0,0] },
      { id: 'A', op: 'native', mode: 'algebra', source: 'A=(3,0)', initial: [3,0] },
      { id: 'c', op: 'native', mode: 'algebra', source: 'c=Circle(O,A)' },
    ]
    const original = structuredClone(program)
    const record = createConstructionRecord({ plan: { program } }, binding)!
    expect(record.text).toBe('O=(0,0)\nA=(3,0)\nc=Circle(O,A)')
    expect(record).toMatchObject({ buildId: binding.buildId, domainRequestDigest: binding.domainRequestDigest })
    expect(program).toEqual(original) // The accepted request and its receipt digest stay unchanged.
  })
  it('compares literal coordinates numerically while preserving the original source', () => {
    const source = 'P = ( +0.50, -2.00 )'
    const program = [{ id: 'P', op: 'native', mode: 'algebra', source, initial: [0.5,-2] }]
    expect(createConstructionRecord({ plan: { program } }, binding)?.text).toBe(source)
  })
  it.each(['P=(0,0)', 'P=Point(c)', 'P=(a,0)', 'P=(1/2,0)', 'P=(0,0)\nQ=(1,1)', 'Q=(1,0)'])(
    'keeps meaningful or unproven initialization for %s', source => {
      const program = [{ id: 'P', op: 'native', mode: 'algebra', source, initial: [1,0] }]
      expect(createConstructionRecord({ plan: { program } }, binding)?.text).toBe(`${source}\nSetCoords(P,1,0)`)
    })
  it('preserves CAS initialization even when the resolved expression is a literal point', () => {
    const program = [{ id: 'P', op: 'native', mode: 'cas', source: 'P=(0,0)', initial: [0,0] }]
    const report = { construction: { objects: [{ name: 'P', defined: true, expression: 'P=(0,0)' }] } }
    expect(createConstructionRecord({ plan: { program } }, binding, report)?.text).toBe('P=(0,0)\nSetCoords(P,0,0)')
  })
  it('contains only executable native commands in accepted order', () => {
    const record = createConstructionRecord(request, binding, verification)
    expect(record).not.toBeNull()
    expect(record!.text).toBe('O=(0,0)\nSetCoords(O,1,2)\nf=((x-1)*(x+1))')
    expect(record!.text).not.toMatch(/buildId|domainRequestDigest|baseSha256|outputs|initial|updates|edits|styles|view|display|PRIVATE_|\/server\//u)
  })
  it('preserves CAS assignment before dependent steps and path-point initialization in order', () => {
    const req = { plan: { program: [
      { id: 'n', op: 'native', mode: 'cas', source: '2+3' },
      { id: 'P', op: 'native', mode: 'algebra', source: 'P=(n,0)' },
      { id: 'A', op: 'native', mode: 'algebra', source: 'A=Point(d)', initial: [-1,2] },
      { id: 'M', op: 'native', mode: 'algebra', source: 'M=Midpoint(P,A)' },
    ] } }
    const report = { construction: { objects: [{ name: 'n', defined: true, expression: '5' }] } }
    expect(createConstructionRecord(req, binding, report)?.text)
      .toBe('n=(5)\nP=(n,0)\nA=Point(d)\nSetCoords(A,-1,2)\nM=Midpoint(P,A)')
    expect(createConstructionRecord(req, binding)).toBeNull()
    const constant = { name: 'n', type: 'numeric', value: 5, defined: true, independent: true, expression: null }
    expect(createConstructionRecord(req, binding, { construction: { objects: [constant] } })?.text).toContain('n=(5)\nP=(n,0)')
    expect(createConstructionRecord(req, binding, { construction: { objects: [{ ...constant, independent: false }] } })).toBeNull()
    expect(createConstructionRecord(req, binding, { construction: { objects: [{ name: 'n', defined: false, expression: '5' }] } })).toBeNull()
    const cas = { plan: { program: [{ id: 'f', op: 'native', mode: 'cas', source: 'Factor(x^2-1)' }] } }
    expect(createConstructionRecord(cas, binding, { construction: { objects: [
      { name: 'f', defined: true, expression: 'f(x)=(x-1)*(x+1)' },
    ] } })?.text).toBe('f(x)=(x-1)*(x+1)')
    for (const [expression, expected] of [['f = 5', 'f = 5'], ['f(x) + 1', 'f=(f(x) + 1)']]) {
      expect(createConstructionRecord(cas, binding, { construction: { objects: [
        { name: 'f', defined: true, expression },
      ] } })?.text).toBe(expected)
    }
  })
  it('renders legacy freePoint and command steps as executable GGB input', () => {
    const record = createConstructionRecord({ plan: { program: [
      { op: 'freePoint', id: 'P', x: 1, y: 2 },
      { op: 'command', id: 'l', name: 'Line', args: [{ ref: 'P' }, { ref: 'Q' }] },
    ] } }, binding)
    expect(record?.text).toBe('P=(1,2)\nl=Line(P,Q)')
  })
  it('omits the optional record when a baseline edit has no construction command', () => {
    expect(createConstructionRecord({ locale: 'en', plan: { edits: request.plan.edits } },
      { ...binding, baseSha256: 'c'.repeat(64) })).toBeNull()
  })
  it('keeps a command near the public request byte budget without truncating source', () => {
    const source = 'f(x)=' + 'x+'.repeat(60000) + '1'
    const record = createConstructionRecord({ plan: { program: [{ id: 'f', op: 'native', mode: 'algebra', source }] } }, binding)
    expect(record?.text).toBe(source)
    expect(new TextEncoder().encode(record!.text).length).toBeLessThan(MAX_CONSTRUCTION_RECORD_BYTES)
  })
  it('omits an oversized optional record instead of failing the accepted build', () => {
    const source = 'f(x)=' + 'x+'.repeat(200000) + '1'
    expect(createConstructionRecord({ plan: { program: [{ id: 'f', op: 'native', mode: 'algebra', source }] } }, binding))
      .toBeNull()
  })
  it('bounds text by UTF-8 bytes and rejects mismatched or missing accepted identity', () => {
    const record = createConstructionRecord(request, binding, verification)!
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

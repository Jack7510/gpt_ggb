import { expect, it } from 'vitest'
import { providerRequestFacts } from '../src/plugin-core/provider-request-evidence.js'

it('fingerprints schemas without retaining credentials, history, prompt text or reasoning', () => {
  const schema = { type: 'object', properties: { request: { type: 'object' } }, required: ['request'], additionalProperties: false }
  const sdk = providerRequestFacts({ model: 'fixture', system: 'private instruction\n```json\n{"request":{}}\n```',
    tools: [{ name: 'ggb_check', parameters: schema }], headers: { authorization: 'secret' },
    messages: [{ role: 'user', content: 'private user prompt' }], reasoning: 'private reasoning' }, 'sdk')
  const wire = providerRequestFacts({ tools: [{ name: 'ggb_check', input_schema: schema }], thinking: { type: 'enabled' } }, 'messages')
  expect((sdk.tools as { schemaSha256: string }[])[0]!.schemaSha256)
    .toBe((wire.tools as { schemaSha256: string }[])[0]!.schemaSha256)
  expect(sdk.jsonExamples).toEqual([expect.objectContaining({ validJson: true, rootKeys: ['request'] })])
  const serialized = JSON.stringify(sdk)
  for (const text of ['secret', 'private instruction', 'private user prompt', 'private reasoning']) expect(serialized).not.toContain(text)
  expect(providerRequestFacts({ system: '```json\n{"request":{}}}\n```' }, 'messages').jsonExamples)
    .toEqual([expect.objectContaining({ validJson: false })])
})

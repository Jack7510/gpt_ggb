import { createHash } from 'node:crypto'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Fingerprint contracts only: never persist headers, history, prompt text or reasoning. */
export function providerRequestFacts(input: unknown, format: 'sdk' | 'messages'): Record<string, unknown> {
  const value = record(input)
  const tools = Array.isArray(value.tools) ? value.tools.slice(0, 8) : []
  const system = typeof value.system === 'string' ? value.system : ''
  const examples = [...system.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)].slice(0, 8).map(match => {
    try {
      const parsed = record(JSON.parse(match[1]!))
      return { validJson: true, rootKeys: Object.keys(parsed),
        requestKeys: Object.keys(record(parsed.request)), sha256: hash(parsed) }
    } catch { return { validJson: false, sha256: hash(match[1]) } }
  })
  return { model: value.model, maxTokens: format === 'sdk' ? value.maxTokens : value.max_tokens,
    ...(format === 'sdk' ? { reasoningEffort: value.reasoningEffort }
      : { thinking: record(value.thinking).type, effort: record(value.output_config).effort }),
    systemSha256: hash(system), systemBytes: Buffer.byteLength(system), jsonExamples: examples,
    tools: tools.map(input => {
      const tool = record(input)
      const schema = record(format === 'sdk' ? tool.parameters : tool.input_schema)
      return { name: String(tool.name).slice(0, 128), schemaSha256: hash(schema),
        descriptionSha256: hash(tool.description), schemaBytes: Buffer.byteLength(JSON.stringify(schema)),
        rootKeys: Object.keys(record(schema.properties)), required: schema.required,
        additionalProperties: schema.additionalProperties, strict: tool.strict === true }
    }) }
}

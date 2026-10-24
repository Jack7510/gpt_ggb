/** Turn-owned chapter/section identities only; complete reference contents stay in model context. */
export class PluginCoreReferenceHistory {
  private readonly available: Set<string>
  constructor(preloaded: readonly string[] = [], private readonly maxBytes = 24 * 1024,
    private readonly coverage: (id: string) => readonly string[] = id => [id]) {
    this.available = new Set(preloaded.flatMap(id => [...coverage(id)]))
  }

  /** Failed reads do not change history; different turns never share this state. */
  async read(topics: string[], load: (missing: string[]) => Promise<unknown>, refresh = false): Promise<unknown> {
    const unique = [...new Set(topics)]
    const alreadyAvailable = unique.filter(topic => !refresh && this.available.has(topic))
    const missing = unique.filter(topic => refresh || !this.available.has(topic))
    if (!missing.length) return { alreadyAvailable, note: 'Complete references are already in context. Use refresh:true only if context was lost.' }
    const result = await load(missing)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('plugin_core_reference_result_invalid')
    const record = result as Record<string, unknown>
    const references = Array.isArray(record.references) ? record.references : [record]
    if (references.length !== missing.length || references.some((value, i) => !value || typeof value !== 'object'
      || value.topic !== missing[i] || typeof value.content !== 'string' || !value.content.trim())) {
      throw new Error('plugin_core_reference_result_invalid')
    }
    const response = alreadyAvailable.length ? { ...result, alreadyAvailable } : result
    if (Buffer.byteLength(JSON.stringify(response)) > this.maxBytes) throw new Error('ggb_reference_response_oversized')
    for (const topic of missing) for (const id of this.coverage(topic)) this.available.add(id)
    return response
  }
}

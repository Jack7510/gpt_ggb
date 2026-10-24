interface Fields { [key: string]: unknown }
type ContentKind = 'thinking' | 'text' | 'toolInput'
type TimingKey = 'requestSentMs' | 'responseHeadersMs' | 'firstByteMs' | 'firstEventMs'
  | 'firstContentMs' | 'firstThinkingMs' | 'firstTextMs' | 'firstToolInputMs' | 'lastContentMs' | 'streamEndMs'
interface ContentCount { starts: number; deltas: number; bytes: number }
interface PerformanceEvidence {
  timing: Record<TimingKey, number | null> & { observedContentSpanMs: number | null; postStreamMs: number | null }
  content: Record<ContentKind, ContentCount>
}

/** Fixed counters and observed timestamps only; never retain model content or signatures. */
export class ProviderStreamPerformance {
  private readonly times: Record<TimingKey, number | null> = {
    requestSentMs: null, responseHeadersMs: null, firstByteMs: null, firstEventMs: null,
    firstContentMs: null, firstThinkingMs: null, firstTextMs: null, firstToolInputMs: null,
    lastContentMs: null, streamEndMs: null,
  }
  private readonly content: Record<ContentKind, ContentCount> = {
    thinking: { starts: 0, deltas: 0, bytes: 0 },
    text: { starts: 0, deltas: 0, bytes: 0 },
    toolInput: { starts: 0, deltas: 0, bytes: 0 },
  }
  constructor(private readonly startedAt: number) {}
  mark(key: 'requestSentMs' | 'responseHeadersMs' | 'firstByteMs'): void {
    this.times[key] ??= this.elapsed()
  }
  event(event: Fields): void {
    this.times.firstEventMs ??= this.elapsed()
    if (event.type === 'message_stop') this.times.streamEndMs ??= this.elapsed()
    const start = event.type === 'content_block_start'
    const delta = event.type === 'content_block_delta'
    if (!start && !delta) return
    const block = (start ? event.content_block : event.delta) as Fields | undefined
    if (!block || typeof block !== 'object') return
    let kind: ContentKind
    let value: unknown
    if (block.type === (start ? 'thinking' : 'thinking_delta')) { kind = 'thinking'; value = block.thinking }
    else if (block.type === (start ? 'text' : 'text_delta')) { kind = 'text'; value = block.text }
    else if (block.type === (start ? 'tool_use' : 'input_json_delta')) {
      kind = 'toolInput'
      value = start ? block.input && Object.keys(block.input as object).length
        ? JSON.stringify(block.input) : '' : block.partial_json
    } else return // Signatures and unknown blocks are not output payload evidence.
    const counts = this.content[kind]
    counts[start ? 'starts' : 'deltas']++
    if (typeof value !== 'string' || !value.length) return
    counts.bytes += Buffer.byteLength(value)
    const now = this.elapsed()
    this.times.firstContentMs ??= now
    const first = ({ thinking: 'firstThinkingMs', text: 'firstTextMs', toolInput: 'firstToolInputMs' } as const)[kind]
    this.times[first] ??= now
    this.times.lastContentMs = now
  }
  snapshot(finishedAt: number | null): PerformanceEvidence {
    const first = this.times.firstContentMs
    const last = this.times.lastContentMs
    const end = this.times.streamEndMs
    return { timing: { ...this.times,
      observedContentSpanMs: first === null || last === null ? null : last - first,
      postStreamMs: finishedAt === null || end === null ? null : Math.max(0, finishedAt - this.startedAt - end),
    }, content: structuredClone(this.content) }
  }
  private elapsed(): number { return Math.max(0, Date.now() - this.startedAt) }
}

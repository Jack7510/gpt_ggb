import type { ProviderStreamEvidence } from './provider-stream-evidence.js'

export const name = 'ggb-provider-stream-evidence'
export const inject = ['llm']
interface Chunk { [key: string]: unknown }
interface Context { on(name: string, handler: (options: unknown, next: () => AsyncIterable<Chunk>) => AsyncIterable<Chunk>): void }
/** Observe the public SDK stream without changing or replaying any chunk. */
export function apply(ctx: Context): void {
  ctx.on('llm/stream', (_options, next) => (async function* () {
    const evidence = (globalThis as unknown as Record<symbol, ProviderStreamEvidence>)[Symbol.for('ggb.providerStreamEvidence')]
    if (!evidence) { yield* next(); return }
    const capture = evidence.begin()
    if (!capture) {
      try { yield* next() } finally { await evidence.flush() }
      return
    }
    try { capture.sdkRequest(_options) } catch { /* Optional request diagnostics. */ }
    const iterator = next()[Symbol.asyncIterator]()
    try {
      for (;;) {
        const part = await evidence.scope.run(capture, () => iterator.next())
        if (part.done) break
        try { capture.sdk(part.value) } catch { /* Preserve the SDK stream. */ }
        yield part.value
      }
    } catch (error) { capture.failed(error); throw error }
    finally {
      await evidence.scope.run(capture, () => iterator.return?.())
      await evidence.flush()
    }
  })())
}

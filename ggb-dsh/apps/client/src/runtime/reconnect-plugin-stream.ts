import { RunAdapterError } from './adapter-error.js'

/** Reconnect the existing run only. Never replay createRun or tool side effects. */
export async function reconnectPluginStream(open: (after: number) => Promise<void>,
  cursor: () => number, terminal: () => boolean, signal: AbortSignal): Promise<void> {
  for (let retry = 0; !signal.aborted && !terminal(); retry++) {
    try { await open(cursor()) } catch (error) {
      if (signal.aborted) return
      if (!(error instanceof RunAdapterError) || !['network', 'stream_closed'].includes(error.code)) throw error
    }
    if (signal.aborted || terminal()) return
    if (retry >= 4) throw new RunAdapterError('stream_closed', 'Event stream reconnect limit reached')
    await pause(Math.min(500 * 2 ** retry, 4_000), signal)
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

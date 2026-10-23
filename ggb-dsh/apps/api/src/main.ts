import { composeApi } from './composition.js'

const app = composeApi()
const running = await app.start()
console.log(`[api] ggb v3 run service listening on :${running.port}`)

/**
 * §15: stop admission first, give in-flight requests a bounded window, then close
 * the listener and release the channel/pool. An interactive interrupt skips the
 * window so Ctrl-C stays responsive.
 */
async function shutdown(signal: string, graceMs: number): Promise<void> {
  app.beginDrain()
  console.log(`[api] received ${signal}: admission stopped, draining for ${graceMs}ms`)
  if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
  await running.close()
  await app.dispose()
  process.exit(0)
}

let shuttingDown = false
function onSignal(signal: string, graceMs: number): void {
  if (shuttingDown) return
  shuttingDown = true
  void shutdown(signal, graceMs)
}

process.on('SIGTERM', () => onSignal('SIGTERM', app.config.drainGraceMs))
process.on('SIGINT', () => onSignal('SIGINT', 0))

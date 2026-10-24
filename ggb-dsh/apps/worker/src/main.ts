import { composeWorker } from './composition.js'

const app = await composeWorker()
await app.start()
console.log(
  `[worker] ${app.config.workerInstanceId} listening on ${app.config.socketPath} (plugin-core concurrency ${app.config.pluginCoreMaxConcurrentRuns})`,
)
console.log(`[worker] run diagnostics: ${app.config.pluginCoreOutputRoot}/<runId> (7-day terminal retention)`)
if (app.config.dshTraceRoot !== null) {
  console.log(`[worker] retained text-only DSH homes: ${app.config.dshHomeRoot}/<runId>/<turnId>`)
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[worker] received ${signal}, draining active runs`)
  try {
    await app.dispose()
    process.exit(0)
  } catch {
    console.error('[worker] shutdown failed; unconfirmed execution slots remain quarantined')
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

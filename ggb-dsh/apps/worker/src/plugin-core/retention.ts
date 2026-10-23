import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunId } from '@ggb-copilot/application'

const DIAGNOSTIC_TTL_MS = 7 * 24 * 60 * 60_000
const RUN_NAME = /^run_[a-f0-9-]{36}$/u

/** Remove execution bytes only after all owned processes have exited. */
export async function releaseRunFiles(root: string, runId: RunId, now = Date.now()): Promise<void> {
  const dir = join(root, runId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (!(await lstat(dir)).isDirectory()) throw new Error('plugin_core_retention_path')
  try { await lstat(join(dir, 'quarantine.json')); return } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(join(dir, 'terminal.json'), JSON.stringify({ runId, cleanupConfirmed: true,
    expiresAt: now + DIAGNOSTIC_TTL_MS }), { mode: 0o600 })
  await Promise.all(['base.ggb', 'builds'].map(name => rm(join(dir, name), { recursive: true, force: true })))
}

/** Only confirmed terminal directories expire. Unknown and quarantined runs stay fenced. */
export async function sweepRunFiles(root: string, active: ReadonlySet<string>, now = Date.now()): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  // Retire the former global append-only ledger using the same retention.
  const legacy = join(root, 'usage.jsonl')
  try {
    const info = await lstat(legacy)
    if (info.isFile() && info.mtimeMs + DIAGNOSTIC_TTL_MS <= now) await rm(legacy)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_NAME.test(entry.name) || active.has(entry.name)) continue
    const dir = join(root, entry.name)
    try {
      try { await lstat(join(dir, 'owner.json')); continue } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try { await lstat(join(dir, 'quarantine.json')); continue } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const marker = JSON.parse(await readFile(join(dir, 'terminal.json'), 'utf8'))
      if (marker.runId === entry.name && marker.cleanupConfirmed === true
        && Number.isFinite(marker.expiresAt) && marker.expiresAt <= now) await rm(dir, { recursive: true })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

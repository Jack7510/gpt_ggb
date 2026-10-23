import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  formatRunId, runTokenVerifier, type RunToken,
} from '@ggb-copilot/application'
import type { PoolType } from '@ggb-copilot/run-persistence'
import { createLegacyNativeRunGuard } from '../src/legacy/native-run-probe.js'

const PEPPER = 'a'.repeat(64)
const TOKEN = 'legacy-run-token' as RunToken
const OTHER_TOKEN = 'other-run-token' as RunToken
const RUN_ID = formatRunId('01234567-89ab-4cde-8f01-23456789abcd')
const OTHER_RUN_ID = formatRunId('fedcba98-7654-4321-8fed-cba987654321')
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function sqliteFixture(records: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ggb-legacy-probe-'))
  dirs.push(dir)
  const path = join(dir, 'runs.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE run_store_snapshot (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
  db.prepare('INSERT INTO run_store_snapshot (id, payload) VALUES (1, ?)')
    .run(JSON.stringify({ schemaVersion: 2, runs: records }))
  db.close()
  return path
}

describe('retired Native run probe', () => {
  it('returns incompatible only when the token verifier matches a stored old run', async () => {
    const path = await sqliteFixture([
      { record: { runId: RUN_ID, tokenVerifier: runTokenVerifier(TOKEN, PEPPER) } },
      { record: { runId: OTHER_RUN_ID, tokenVerifier: runTokenVerifier(OTHER_TOKEN, PEPPER) } },
    ])
    const guard = createLegacyNativeRunGuard({ pool: null, sqlitePath: path, serverPepper: PEPPER })
    await expect(guard.check(RUN_ID, TOKEN)).resolves.toBe('incompatible')
    await expect(guard.check(RUN_ID, OTHER_TOKEN)).resolves.toBe('not_found')
    await expect(guard.check(OTHER_RUN_ID, TOKEN)).resolves.toBe('not_found')
  })

  it('hides missing databases, snapshots and malformed records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ggb-legacy-probe-'))
    dirs.push(dir)
    const missing = createLegacyNativeRunGuard({
      pool: null, sqlitePath: join(dir, 'missing.sqlite'), serverPepper: PEPPER,
    })
    await expect(missing.check(RUN_ID, TOKEN)).resolves.toBe('not_found')

    const path = await sqliteFixture([null, { record: { runId: RUN_ID } }, { record: { tokenVerifier: 'x' } }])
    const guard = createLegacyNativeRunGuard({ pool: null, sqlitePath: path, serverPepper: PEPPER })
    await expect(guard.check(RUN_ID, TOKEN)).resolves.toBe('not_found')
  })

  it('reads only token_verifier from PostgreSQL and tolerates a missing table', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('SELECT token_verifier')) {
        return { rows: [{ token_verifier: runTokenVerifier(TOKEN, PEPPER) }] }
      }
      throw new Error('unexpected write')
    })
    const guard = createLegacyNativeRunGuard({
      pool: { query } as unknown as PoolType, sqlitePath: null, serverPepper: PEPPER,
    })
    await expect(guard.check(RUN_ID, TOKEN)).resolves.toBe('incompatible')
    await expect(guard.check(RUN_ID, OTHER_TOKEN)).resolves.toBe('not_found')
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[0]).toBe('SELECT token_verifier FROM runs WHERE run_id = $1')

    const missingTable = {
      query: async () => { throw Object.assign(new Error('missing table'), { code: '42P01' }) },
    }
    const absent = createLegacyNativeRunGuard({
      pool: missingTable as unknown as PoolType, sqlitePath: null, serverPepper: PEPPER,
    })
    await expect(absent.check(RUN_ID, TOKEN)).resolves.toBe('not_found')
  })

  it('returns not_found when neither store is configured', async () => {
    const guard = createLegacyNativeRunGuard({ pool: null, sqlitePath: null, serverPepper: PEPPER })
    await expect(guard.check(RUN_ID, TOKEN)).resolves.toBe('not_found')
  })
})

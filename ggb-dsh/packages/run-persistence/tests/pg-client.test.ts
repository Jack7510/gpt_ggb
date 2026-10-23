import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { assertPluginCoreSchema, runMigrations } from '../src/pg-client.js'

const directory = fileURLToPath(new URL('../migrations', import.meta.url))
const filename = '018_plugin_core_delivery_contract.sql'
const priorVersions = readdirSync(directory).filter(name => name.endsWith('.sql') && name !== filename)
const migration = readFileSync(new URL('../migrations/018_plugin_core_delivery_contract.sql', import.meta.url), 'utf8')

/** Offline driver boundary: it supplies DB results and errors without evaluating SQL. */
function fixture(ready: boolean | undefined, failure: Error | null = null,
  recorded: readonly string[] = priorVersions) {
  const query = vi.fn(async (sql: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> => {
    if (sql.includes('SELECT EXISTS')) return { rows: ready === undefined ? [] : [{ ready }] }
    if (sql === 'SELECT version FROM schema_migrations') return { rows: recorded.map(version => ({ version })) }
    if (sql === migration && failure !== null) throw failure
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, query, release }
}

describe('plugin-core PostgreSQL schema admission', () => {
  it('accepts the recorded migration using a read-only query', async () => {
    const { pool, query } = fixture(true)
    await expect(assertPluginCoreSchema(pool)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT EXISTS'))
    expect(query.mock.calls[0]?.[0]).toContain("version = '018_plugin_core_delivery_contract.sql'")
  })

  it.each([false, undefined])('refuses an unrecorded migration before process admission', async ready => {
    const { pool } = fixture(ready)
    await expect(assertPluginCoreSchema(pool)).rejects.toThrow('plugin_core_schema_migration_required')
  })

  it('maps an uninitialized ledger to migration-required and preserves connectivity errors', async () => {
    const { pool, query } = fixture(false)
    query.mockRejectedValueOnce(Object.assign(new Error('missing table'), { code: '42P01' }))
    await expect(assertPluginCoreSchema(pool)).rejects.toThrow('plugin_core_schema_migration_required')
    const offline = Object.assign(new Error('offline connection'), { code: 'ECONNREFUSED' })
    query.mockRejectedValueOnce(offline)
    await expect(assertPluginCoreSchema(pool)).rejects.toBe(offline)
  })

  it('rolls back a failed migration without recording the version', async () => {
    const failure = new Error('synthetic migration failure')
    const { pool, query, release } = fixture(false, failure)
    await expect(runMigrations(pool, directory)).rejects.toBe(failure)
    const statements = query.mock.calls.map(([sql]) => sql)
    expect(statements).toContain('BEGIN')
    expect(statements).toContain(migration)
    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(statements.some(sql => sql.startsWith('INSERT INTO schema_migrations'))).toBe(false)
    expect(release).toHaveBeenCalledOnce()
  })

  it('applies only the plugin-core migration on an empty ledger', async () => {
    const { pool, query } = fixture(false, null, [])
    expect(await runMigrations(pool, directory)).toEqual(['017_plugin_core.sql', filename])
    const statements = query.mock.calls.map(([sql]) => sql)
    expect(statements).toContain(migration)
    expect(statements.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS runs'))).toBe(false)
  })

  it('records the version only after the migration completes and commits it atomically', async () => {
    const { pool, query, release } = fixture(false)
    expect(await runMigrations(pool, directory)).toEqual([filename])
    const statements = query.mock.calls.map(([sql]) => sql)
    const applied = statements.indexOf(migration)
    expect(query.mock.calls[applied + 1]).toEqual(['INSERT INTO schema_migrations (version) VALUES ($1)', [filename]])
    expect(statements[applied + 2]).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })
})

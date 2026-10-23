import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'

export { Pool }
export type PoolType = Pool

/** Refuse plugin-core admission until migration 018 is recorded. */
export async function assertPluginCoreSchema(pool: Pool): Promise<void> {
  try {
    const result = await pool.query<{ ready: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '018_plugin_core_delivery_contract.sql') AS ready",
    )
    if (result.rows[0]?.ready !== true) throw new Error('plugin_core_schema_migration_required')
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '42P01') {
      throw new Error('plugin_core_schema_migration_required')
    }
    throw error
  }
}

/**
 * Startup applies only the plugin-core schema. Files 001–016 remain in the
 * repository as migration history and are not required by a fresh deployment.
 */
export const PLUGIN_CORE_MIGRATION_FILES = ['017_plugin_core.sql', '018_plugin_core_delivery_contract.sql'] as const

/** Applies the requested migration files in lexicographic order, tracking versions in schema_migrations. */
export async function runMigrations(pool: Pool, migrationsDir: string,
  requested: readonly string[] = PLUGIN_CORE_MIGRATION_FILES): Promise<string[]> {
  const applied: string[] = []
  const requestedSet = new Set(requested)
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && requestedSet.has(name))
    .sort()
  const client = await pool.connect()
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    )
    const existing = await client.query<{ version: string }>('SELECT version FROM schema_migrations')
    const appliedSet = new Set(existing.rows.map((row) => row.version))
    for (const file of files) {
      if (appliedSet.has(file)) continue
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    client.release()
  }
  return applied
}

export function createPgPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 })
}

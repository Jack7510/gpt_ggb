import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runIdSchema } from '@ggb-copilot/application'
import { assertPluginCoreSchema, createPgPool, PgPluginCoreStore, runMigrations } from '../src/index.js'
const socket = process.env.GGB_C_TEST_PG_SOCKET

describe.skipIf(!socket)('017 to 018 on a disposable PostgreSQL database', () => {
  it('rejects admission before 018, preserves old rows and fixes new runs to receipt-v1', async () => {
    const database = 'migration_' + randomUUID().replaceAll('-', '')
    const uri = (db: string) => `postgresql://postgres@localhost/${db}?host=${encodeURIComponent(socket!)}`
    const admin = createPgPool(uri('postgres'))
    await admin.query(`CREATE DATABASE ${database}`)
    const pool = createPgPool(uri(database))
    try {
      await pool.query(await readFile(new URL('../migrations/017_plugin_core.sql', import.meta.url), 'utf8'))
      await pool.query("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('017_plugin_core.sql')")
      await pool.query(`INSERT INTO plugin_core_runs(run_id,token_verifier,request_digest,prompt,prompt_digest,phase,execution_expires_at,expires_at)
        VALUES ('old','a','b','test','c','accepted',now(),now())`)
      await expect(assertPluginCoreSchema(pool)).rejects.toThrow('plugin_core_schema_migration_required')
      const migrations = fileURLToPath(new URL('../migrations', import.meta.url))
      expect(await runMigrations(pool, migrations)).toEqual(['018_plugin_core_delivery_contract.sql'])
      await expect(assertPluginCoreSchema(pool)).resolves.toBeUndefined()
      expect(await runMigrations(pool, migrations)).toEqual([])
      expect((await pool.query('SELECT delivery_contract FROM plugin_core_runs WHERE run_id=\'old\'')).rows[0].delivery_contract).toBe('legacy')
      const created = await new PgPluginCoreStore(pool).createRun({ runId: runIdSchema.parse(`run_${randomUUID()}`),
        tokenVerifier: 'a'.repeat(64), requestDigest: 'b'.repeat(64), prompt: 'test', promptDigest: 'c'.repeat(64),
        baseSha256: null, baseName: null, executionExpiresAt: new Date().toISOString(), expiresAt: new Date().toISOString() })
      expect(created.record.deliveryContract).toBe('receipt-v1')
    } finally { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end() }
  })
})

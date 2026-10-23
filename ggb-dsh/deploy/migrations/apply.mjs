// One-shot migration job for the plugin-core run store.
//
// Runs before a new image is rolled out, against the same `GGB_V3_DATABASE_URL` the
// API and Worker use. It reuses the package's own `runMigrations`, so the ledger
// (`schema_migrations`) and the applied SQL are identical to `GGB_V3_AUTO_MIGRATE=1`
// inside the processes — this job exists to apply migrations explicitly, before
// admission is reopened, instead of racing them at process boot.
//
//   GGB_V3_DATABASE_URL=postgres://... node deploy/migrations/apply.mjs
//
// Only plugin migrations 017 and 018 are applied. Migration files 001-016 remain in the
// repository as history and are not required by a fresh deployment.
import { createPgPool, runMigrations } from '../../packages/run-persistence/lib/index.js'

const databaseUrl = process.env.GGB_V3_DATABASE_URL
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('GGB_V3_DATABASE_URL is required')
  process.exit(64)
}

const migrationsDir = new URL('../../packages/run-persistence/migrations', import.meta.url).pathname
const pool = createPgPool(databaseUrl)
try {
  const applied = await runMigrations(pool, migrationsDir)
  console.log(applied.length === 0 ? 'no pending migrations' : `applied: ${applied.join(', ')}`)
} finally {
  await pool.end()
}

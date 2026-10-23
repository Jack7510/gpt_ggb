import { DatabaseSync } from 'node:sqlite'
import { runTokenVerifier, verifiersEqual, type RunId, type RunToken } from '@ggb-copilot/application'
import type { PoolType } from '@ggb-copilot/run-persistence'

/**
 * Authorization facts for a retired Native run. The nine-stage reader is gone;
 * this probe only proves that a valid run token owns the old record so the API
 * can answer `checkpoint_incompatible` without leaking run existence.
 */
export interface LegacyNativeRunGuard {
  check(runId: RunId, runToken: RunToken): Promise<'incompatible' | 'not_found'>
}

export interface LegacyNativeRunGuardOptions {
  pool: PoolType | null
  sqlitePath: string | null
  serverPepper: string
}

export function createLegacyNativeRunGuard(
  options: LegacyNativeRunGuardOptions,
): LegacyNativeRunGuard {
  const lookup = options.pool !== null
    ? postgresLookup(options.pool)
    : options.sqlitePath !== null ? sqliteLookup(options.sqlitePath) : null
  return {
    async check(runId, runToken) {
      const verifier = lookup === null ? null : await lookup(runId)
      if (verifier === null) return 'not_found'
      return verifiersEqual(verifier, runTokenVerifier(runToken, options.serverPepper))
        ? 'incompatible' : 'not_found'
    },
  }
}

function postgresLookup(pool: PoolType): (runId: RunId) => Promise<string | null> {
  return async (runId) => {
    try {
      const result = await pool.query<{ token_verifier: string }>(
        'SELECT token_verifier FROM runs WHERE run_id = $1', [runId],
      )
      return result.rows[0]?.token_verifier ?? null
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === '42P01') {
        return null
      }
      throw error
    }
  }
}

/**
 * Read only the Native snapshot row. A fresh plugin-core database has no table;
 * a missing table or an unreadable snapshot means there is no legacy run.
 */
function sqliteLookup(path: string): (runId: RunId) => Promise<string | null> {
  return async (runId) => {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })
      const row = db.prepare('SELECT payload FROM run_store_snapshot WHERE id = 1')
        .get() as { payload?: string } | undefined
      if (row?.payload === undefined) return null
      const snapshot = JSON.parse(row.payload) as { runs?: unknown }
      if (!Array.isArray(snapshot.runs)) return null
      for (const entry of snapshot.runs) {
        if (entry === null || typeof entry !== 'object') continue
        const record = (entry as { record?: unknown }).record
        if (record === null || typeof record !== 'object') continue
        const value = record as { runId?: unknown; tokenVerifier?: unknown }
        if (value.runId === runId && typeof value.tokenVerifier === 'string') {
          return value.tokenVerifier
        }
      }
      return null
    } catch {
      return null
    } finally {
      db?.close()
    }
  }
}

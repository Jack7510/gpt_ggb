#!/usr/bin/env node
/**
 * Report the plugin-core usage ledger from SQLite or PostgreSQL. Only aggregate
 * counters and run phases are printed; prompts, provider keys and base bytes
 * are never selected.
 */
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  sqlite: { type: 'string' },
  'database-url': { type: 'string' },
} })

const number = value => value === null || value === undefined ? null : Number(value)
const sum = (rows, key) => rows.every(row => row[key] === null || row[key] === undefined)
  ? null : rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
const complete = value => value === true || value === 1

/** Read the SQLite snapshot (the local adapter is a document store, not SQL tables). */
function sqliteRows(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare(
      'SELECT payload FROM plugin_core_store_snapshot WHERE id = 1').get()
    if (row?.payload === undefined) return []
    const document = JSON.parse(row.payload)
    return (Array.isArray(document.runs) ? document.runs : []).map(run => ({
      run_id: run.runId,
      calls: run.usage?.calls ?? 0,
      input_tokens: run.usage?.inputTokens ?? null,
      output_tokens: run.usage?.outputTokens ?? null,
      reasoning_tokens: run.usage?.reasoningTokens ?? null,
      cache_read_tokens: run.usage?.cacheReadTokens ?? null,
      complete: run.usage?.complete ?? false,
      model_id: run.modelId ?? 'unknown',
      duration_ms: run.durationMs ?? null,
      phase: run.phase,
    }))
  } finally {
    db.close()
  }
}

const sql = `SELECT u.run_id, u.calls, u.input_tokens, u.output_tokens,
  u.reasoning_tokens, u.cache_read_tokens, u.complete, u.model_id,
  u.duration_ms, r.phase
  FROM plugin_core_usage u
  JOIN plugin_core_runs r ON r.run_id = u.run_id
  ORDER BY u.created_at DESC`

let rows
if (values.sqlite !== undefined) {
  rows = sqliteRows(values.sqlite)
} else if (values['database-url'] !== undefined) {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: values['database-url'] })
  try { rows = (await pool.query(sql)).rows } finally { await pool.end() }
} else {
  process.stderr.write('Usage: report-plugin-core-usage.mjs (--sqlite <path> | --database-url <url>)\n')
  process.exit(2)
}

const summary = {
  schemaVersion: 1,
  runs: rows.length,
  calls: rows.reduce((total, row) => total + Number(row.calls ?? 0), 0),
  inputTokens: sum(rows, 'input_tokens'),
  outputTokens: sum(rows, 'output_tokens'),
  reasoningTokens: sum(rows, 'reasoning_tokens'),
  cacheReadTokens: sum(rows, 'cache_read_tokens'),
  completeUsageRuns: rows.filter(row => complete(row.complete)).length,
  unknownUsageRuns: rows.filter(row => !complete(row.complete)).length,
  completedRuns: rows.filter(row => row.phase === 'completed').length,
  failedRuns: rows.filter(row => row.phase === 'failed').length,
  cancelledRuns: rows.filter(row => row.phase === 'cancelled').length,
  averageDurationMs: rows.length === 0 ? null
    : Math.round(rows.reduce((total, row) => total + Number(row.duration_ms ?? 0), 0) / rows.length),
  models: [...new Set(rows.map(row => row.model_id))].sort(),
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

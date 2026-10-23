import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { serializeReleaseKnowledgeJsonl, sha256, validateKnowledgeEntry, writeNewFile } from './release-knowledge.mjs'

const scriptArgs = process.argv.slice(2)
if (scriptArgs[0] === '--') scriptArgs.shift()
const { values } = parseArgs({
  args: scriptArgs,
  options: {
    database: { type: 'string' }, output: { type: 'string' }, report: { type: 'string' },
    force: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  },
})

if (values.help || values.database === undefined || values.output === undefined) {
  console.error('Usage: node tools/export-rag-solved-tasks.mjs --database <application.sqlite3> --output <solved-tasks.jsonl> [--report <report.json>] [--force]')
  process.exit(values.help ? 0 : 2)
}

const database = new DatabaseSync(values.database, { readOnly: true })
const rows = database.prepare(`
  SELECT knowledge_id, title, content, tags_json, corpus_id, status, version, language,
         capability_version, source_version, reviewed_at
  FROM knowledge_entries
  WHERE corpus_id = 'solved_tasks'
  ORDER BY reviewed_at DESC, knowledge_id ASC
`).all()
database.close()

const rejected = []
const entries = []
for (const row of rows) {
  try {
    entries.push(validateKnowledgeEntry({
      id: row.knowledge_id, title: row.title, content: row.content, tags: JSON.parse(row.tags_json),
      corpusId: row.corpus_id, status: row.status, version: row.version, language: row.language,
      capabilityVersion: row.capability_version, sourceVersion: row.source_version, reviewedAt: row.reviewed_at,
    }))
  } catch (error) {
    rejected.push({ id: row.knowledge_id, reason: error instanceof Error ? error.message : 'schema_validation_failed' })
  }
}
const body = serializeReleaseKnowledgeJsonl(entries)
await writeNewFile(values.output, body, values.force)
const report = {
  schemaVersion: 1, operation: 'export_solved_tasks', sourceDatabase: values.database,
  sourceRows: rows.length, exported: entries.length, rejected, sha256: sha256(body),
}
if (values.report !== undefined) await writeNewFile(values.report, `${JSON.stringify(report, null, 2)}\n`, values.force)
console.log(JSON.stringify(report))

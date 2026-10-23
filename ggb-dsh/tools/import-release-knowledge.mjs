import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'

import {
  mergeReleaseKnowledge,
  parseReleaseKnowledgeJsonl,
  serializeReleaseKnowledgeJsonl,
  sha256,
  writeNewFile,
} from './release-knowledge.mjs'

const scriptArgs = process.argv.slice(2)
if (scriptArgs[0] === '--') scriptArgs.shift()
const { values } = parseArgs({
  args: scriptArgs,
  options: {
    base: { type: 'string' }, incoming: { type: 'string' }, output: { type: 'string' }, report: { type: 'string' },
    write: { type: 'boolean', default: false }, keepTitleDuplicates: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  },
})

if (values.help || values.base === undefined || values.incoming === undefined || values.output === undefined) {
  console.error('Usage: node tools/import-release-knowledge.mjs --base <release.jsonl> --incoming <export.jsonl> --output <merged.jsonl> [--report <report.json>] [--keepTitleDuplicates] [--write] [--force]')
  process.exit(values.help ? 0 : 2)
}

const base = parseReleaseKnowledgeJsonl(await readFile(values.base, 'utf8'), values.base)
const incoming = parseReleaseKnowledgeJsonl(await readFile(values.incoming, 'utf8'), values.incoming)
const merged = mergeReleaseKnowledge(base, incoming, { dedupeTitles: !values.keepTitleDuplicates })
const body = serializeReleaseKnowledgeJsonl(merged.entries)
await writeNewFile(values.output, body, values.force)
if (values.write) await writeNewFile(values.base, body, values.force, 0o644)
const report = {
  schemaVersion: 1, operation: 'merge_release_knowledge', base: values.base, incoming: values.incoming,
  output: values.output, writeApplied: values.write, baseEntries: base.length, incomingEntries: incoming.length,
  mergedEntries: merged.entries.length, added: merged.added, skipped: merged.skipped, sha256: sha256(body),
}
if (values.report !== undefined) await writeNewFile(values.report, `${JSON.stringify(report, null, 2)}\n`, values.force)
console.log(JSON.stringify(report))

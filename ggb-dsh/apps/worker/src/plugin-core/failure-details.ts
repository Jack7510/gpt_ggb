/** Extract bounded domain failures only from the current build's owned files. */
import { constants } from 'node:fs'
import { open, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { evidenceRecord, redactEvidence } from './evidence.js'
import type { PluginCoreError } from './process-runner.js'

const FIELDS = new Set(['code', 'message', 'stage', 'cause', 'details', 'issues', 'status',
  'requirementId', 'checkId', 'subjects', 'method', 'scope', 'evidence', 'expected', 'actual',
  'object', 'field', 'reason', 'value', 'tolerance', 'expression', 'defined',
  'stepId', 'source', 'operation', 'rawLabels', 'outputs', 'coordinates', 'objectType', 'moveable', 'x', 'y'])

/** Reports are data: discard paths, stacks, unrelated fields and large payloads. */
function project(input: unknown, depth = 0): unknown {
  if (typeof input === 'string') return input.split(/\r?\n/u)[0]!.slice(0, 1500)
  if (typeof input === 'number' || typeof input === 'boolean' || input === null) return input
  if (depth > 5) return '[depth_limit]'
  if (Array.isArray(input)) return input.slice(0, 8).map(value => project(value, depth + 1))
  return Object.fromEntries(Object.entries(evidenceRecord(input)).filter(([key]) => FIELDS.has(key))
    .map(([key, value]) => [key, project(value, depth + 1)]))
}

/** No links, arbitrary references or reads outside this per-call directory. */
async function readReport(path: string): Promise<unknown> {
  try {
    if (await realpath(path) !== resolve(path)) return null
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) return null
      const buffer = Buffer.alloc(stat.size + 1)
      let total = 0
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
        if (!bytesRead) break
        total += bytesRead
      }
      if (total !== stat.size) return null
      return JSON.parse(buffer.subarray(0, total).toString('utf8')) as unknown
    } finally { await file.close() }
  } catch { return null }
}

function failedChecks(input: unknown, phase: string, output: unknown[], depth = 0): void {
  if (depth > 3 || output.length >= 8) return
  const value = evidenceRecord(input)
  if (Array.isArray(value.results)) {
    for (const result of value.results) {
      if (output.length >= 8) break
      if (['failed', 'unverified'].includes(String(evidenceRecord(result).status))) {
        output.push({ phase, ...evidenceRecord(project(result)) })
      }
    }
  }
  for (const key of ['construction', 'reload', 'interaction', 'after']) {
    if (value[key]) failedChecks(value[key], key, output, depth + 1)
  }
  if (Array.isArray(value.samples)) {
    for (const sample of value.samples.slice(0, 8)) failedChecks(sample, 'interaction', output, depth + 1)
  }
}

/** A diagnostic never changes success admission or the process cleanup decision. */
export async function buildFailure(root: string, fallback: PluginCoreError,
  stderr: string, issues?: unknown): Promise<PluginCoreError> {
  try { root = await realpath(root) } catch { return fallback }
  const directories = [root]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries.filter(item => item.isDirectory() && item.name !== 'accepted').slice(0, 16)) {
      const directory = join(root, entry.name)
      directories.push(directory, join(directory, 'delivery'))
    }
  } catch { /* The CLI may fail before it creates a report. */ }
  const failures: unknown[] = []
  const checks: unknown[] = []
  for (const directory of directories) {
    const run = evidenceRecord(await readReport(join(directory, 'run.json')))
    if (run.state === 'failed' && failures.length < 4) failures.push(project(run.error))
    failedChecks(await readReport(join(directory, 'verification.json')), 'verification', checks)
  }
  const cli = stderr.split(/\r?\n/u).find(line => line.trim() && !/^\s*at /u.test(line))?.slice(0, 1500)
  const first = evidenceRecord(failures[0])
  const issue = evidenceRecord(Array.isArray(issues) ? issues[0] : issues)
  const details = { failures, checks, ...(issues === undefined ? {} : { issues: project(issues) }),
    ...(cli ? { cli: { message: cli } } : {}) }
  const result = redactEvidence({ code: typeof first.code === 'string' ? first.code : fallback.code,
    message: typeof first.message === 'string' ? first.message
      : typeof issue.message === 'string' ? project(issue.message) : cli ?? fallback.message,
    details }, [], true) as PluginCoreError
  if (Buffer.byteLength(JSON.stringify(result)) <= 24 * 1024) return result
  const safeChecks = evidenceRecord(result.details).checks
  return { code: result.code, message: result.message, details: { truncated: true,
    checks: (Array.isArray(safeChecks) ? safeChecks : []).map(check => {
      const value = evidenceRecord(check)
      return { phase: String(value.phase).slice(0, 64),
        ...(typeof value.requirementId === 'string' ? { requirementId: value.requirementId.slice(0, 256) } : {}),
        ...(typeof value.method === 'string' ? { method: value.method.slice(0, 64) } : {}),
        ...(typeof evidenceRecord(value.evidence).message === 'string'
          ? { evidence: { message: String(evidenceRecord(value.evidence).message).slice(0, 256) } } : {}),
        checkId: String(value.checkId).slice(0, 256),
        status: String(value.status).slice(0, 32), subjects: Array.isArray(value.subjects)
          ? value.subjects.slice(0, 4).map(subject => String(subject).slice(0, 128)) : [] }
    }) } }
}

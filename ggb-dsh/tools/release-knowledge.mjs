import { createHash } from 'node:crypto'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const CORPORA = new Set(['construction_patterns', 'solved_tasks', 'ggb_manual_commands', 'failure_guidance'])
const LANGUAGES = new Set(['zh', 'en', 'multilingual'])
const ENTRY_KEYS = new Set(['id', 'title', 'content', 'tags', 'corpusId', 'status', 'version', 'language', 'capabilityVersion', 'sourceVersion', 'reviewedAt'])

export function parseReleaseKnowledgeJsonl(text, source) {
  const seen = new Set()
  return text.split(/\r?\n/u).filter(line => line.trim().length > 0).map((line, index) => {
    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSON at ${source}:${index + 1}`, { cause: error })
    }
    const entry = validateKnowledgeEntry(value, `${source}:${index + 1}`)
    if (seen.has(entry.id)) throw new Error(`duplicate knowledge id ${entry.id} in ${source}`)
    seen.add(entry.id)
    return entry
  })
}

export function validateKnowledgeEntry(value, source = 'knowledge entry') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source} must be an object`)
  const keys = Object.keys(value)
  if (keys.length !== ENTRY_KEYS.size || keys.some(key => !ENTRY_KEYS.has(key))) throw new Error(`${source} has unsupported or missing fields`)
  const entry = value
  if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id)) throw new Error(`${source}.id is invalid`)
  assertText(entry.title, `${source}.title`, 200)
  assertText(entry.content, `${source}.content`, 4_000)
  if (!Array.isArray(entry.tags) || entry.tags.length < 1 || entry.tags.length > 20
    || entry.tags.some(tag => typeof tag !== 'string' || tag.trim().length === 0 || tag.trim().length > 64)) throw new Error(`${source}.tags is invalid`)
  if (!CORPORA.has(entry.corpusId)) throw new Error(`${source}.corpusId is invalid`)
  if (entry.status !== 'approved') throw new Error(`${source}.status must be approved`)
  assertText(entry.version, `${source}.version`, 64)
  if (!LANGUAGES.has(entry.language)) throw new Error(`${source}.language is invalid`)
  assertText(entry.capabilityVersion, `${source}.capabilityVersion`, 64)
  assertText(entry.sourceVersion, `${source}.sourceVersion`, 64)
  if (typeof entry.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(entry.reviewedAt)
    || Number.isNaN(Date.parse(entry.reviewedAt))) throw new Error(`${source}.reviewedAt is invalid`)
  return Object.freeze({ ...entry, tags: Object.freeze([...entry.tags]) })
}

export function serializeReleaseKnowledgeJsonl(entries) {
  return `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function mergeReleaseKnowledge(baseEntries, incomingEntries, options = {}) {
  const dedupeTitles = options.dedupeTitles ?? true
  const byId = new Map(baseEntries.map(entry => [entry.id, entry]))
  const additions = []
  const skipped = []
  const conflicts = []
  for (const entry of incomingEntries) {
    const existing = byId.get(entry.id)
    if (existing === undefined) {
      byId.set(entry.id, entry)
      additions.push(entry)
      continue
    }
    if (stableEntryJson(existing) === stableEntryJson(entry)) {
      skipped.push({ id: entry.id, reason: 'identical_id' })
    } else {
      conflicts.push({ id: entry.id, reason: 'different_content_for_existing_id' })
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`knowledge merge has ${conflicts.length} id conflict(s): ${conflicts.map(item => item.id).join(', ')}`)
  }
  const merged = dedupeTitles ? dedupeExactTitles(baseEntries, additions, skipped) : [...baseEntries, ...additions]
  return { entries: merged, added: merged.length - baseEntries.length, skipped }
}

export async function writeNewFile(path, body, force = false, mode = 0o600) {
  if (!force) {
    try {
      await access(path)
      throw new Error(`refusing to overwrite ${path}; pass --force to replace it`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, body, { encoding: 'utf8', mode })
  await rename(temporary, path)
}

function dedupeExactTitles(baseEntries, additions, skipped) {
  const normalizedBaseTitles = new Set(baseEntries.map(entry => normalizeTitle(entry.title)))
  const grouped = new Map()
  for (const entry of additions) {
    const title = normalizeTitle(entry.title)
    if (normalizedBaseTitles.has(title)) {
      skipped.push({ id: entry.id, reason: 'duplicate_title_kept_release' })
      continue
    }
    const current = grouped.get(title)
    if (current === undefined || newer(entry, current)) {
      if (current !== undefined) skipped.push({ id: current.id, reason: 'duplicate_title_kept_newer' })
      grouped.set(title, entry)
    } else {
      skipped.push({ id: entry.id, reason: 'duplicate_title_kept_newer' })
    }
  }
  const selected = [...grouped.values()].sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt) || left.id.localeCompare(right.id))
  return [...baseEntries, ...selected]
}

function normalizeTitle(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
}

function newer(left, right) {
  return left.reviewedAt > right.reviewedAt || (left.reviewedAt === right.reviewedAt && left.id < right.id)
}

function stableEntryJson(entry) {
  return JSON.stringify(entry)
}

function assertText(value, name, maximum) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) throw new Error(`${name} is invalid`)
}

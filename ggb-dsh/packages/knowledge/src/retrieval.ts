import type { AgentIntakeDecisionV2, AllowedCorpusId } from '@ggb-copilot/app-protocol'

import type { KnowledgeEntry } from './schema.js'

/** Maximum references injected into the Math Plan stage. */
export const MATH_PLAN_RAG_BUDGET = 3
/** Minimum query-token coverage a candidate must have to be injected. */
export const MIN_RELEVANCE_SCORE = 0.1

export interface RetrievedReference {
  readonly entry: KnowledgeEntry
  readonly score: number
}

export interface ReferenceSearchTrace {
  readonly references: readonly RetrievedReference[]
  readonly candidates: readonly {
    readonly sourceId: string
    readonly sourceVersion: string
    readonly corpusId: KnowledgeEntry['corpusId']
    readonly score: number
    readonly reason: 'provided' | 'weak_match' | 'incompatible' | 'duplicate' | 'conflicting_title' | 'budget'
  }[]
}

/** Runtime-neutral port implemented by browser or Node persistence. */
export interface KnowledgeSource {
  search(query: string, corpusId: AllowedCorpusId, limit: number): readonly KnowledgeEntry[]
}

/** Preserve the exact candidate decisions behind the bounded reference set. */
export function traceReferences(
  retrieval: AgentIntakeDecisionV2['retrieval'],
  source: KnowledgeSource,
  budget: number = MATH_PLAN_RAG_BUDGET,
): ReferenceSearchTrace {
  if (retrieval.kind === 'none') return { references: [], candidates: [] }
  const tokens = queryTokens(retrieval.query)
  if (tokens.length === 0) return { references: [], candidates: [] }
  const seen = new Set<string>()
  const candidates: RetrievedReference[] = []
  const decisions: Array<ReferenceSearchTrace['candidates'][number] & { readonly title: string }> = []
  for (const corpusId of retrieval.corpusIds) {
    for (const entry of source.search(retrieval.query, corpusId, Math.min(10, budget * 3))
      .slice(0, Math.min(10, budget * 3))) {
      const score = relevance(tokens, entry)
      const reason = seen.has(entry.id) ? 'duplicate'
        : score < MIN_RELEVANCE_SCORE ? 'weak_match'
          : !compatible(entry) ? 'incompatible' : 'provided'
      decisions.push({ sourceId: entry.id, sourceVersion: entry.sourceVersion,
        corpusId: entry.corpusId, score, reason, title: entry.title })
      if (reason !== 'provided') continue
      seen.add(entry.id)
      candidates.push({ entry, score })
    }
  }
  const conflicts = conflictingTitles(candidates)
  const references = candidates.filter(item => !conflicts.has(item.entry.title)).sort((left, right) =>
    right.score - left.score || left.entry.id.localeCompare(right.entry.id)).slice(0, budget)
  const provided = new Set(references.map(item => item.entry.id))
  return { references, candidates: decisions.map(({ title, ...item }) => ({ ...item,
    reason: item.reason !== 'provided' ? item.reason
      : conflicts.has(title) ? 'conflicting_title'
        : provided.has(item.sourceId) ? 'provided' : 'budget' })) }
}

function queryTokens(query: string): readonly string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(token => token.length > 1)
  const grams = words.flatMap(word => /[\p{Script=Han}]/u.test(word)
    ? Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2)) : [])
  return [...new Set([...words, ...grams])].slice(0, 64)
}

function relevance(tokens: readonly string[], entry: KnowledgeEntry): number {
  const text = `${entry.title} ${entry.tags.join(' ')} ${entry.content}`.toLowerCase()
  const matches = tokens.filter(token => text.includes(token)
    || entry.tags.some(tag => meaningfulTagMatch(token, tag))).length
  return matches / tokens.length
}

function meaningfulTagMatch(token: string, tag: string): boolean {
  const normalized = tag.toLowerCase()
  return normalized.length > 1 && token.includes(normalized)
}

function compatible(entry: KnowledgeEntry): boolean {
  return entry.status === 'approved' && /^geometry-contract-v[12]$/.test(entry.capabilityVersion)
    && !(entry.corpusId === 'solved_tasks' && entry.id.startsWith('solved-auto-')
      && !['verified-script-v2', 'verified-plan-v3'].includes(entry.version))
}

function conflictingTitles(references: readonly RetrievedReference[]): ReadonlySet<string> {
  const contents = new Map<string, Set<string>>()
  for (const { entry } of references) {
    const values = contents.get(entry.title) ?? new Set<string>()
    values.add(entry.content)
    contents.set(entry.title, values)
  }
  return new Set([...contents].filter(([, values]) => values.size > 1).map(([title]) => title))
}

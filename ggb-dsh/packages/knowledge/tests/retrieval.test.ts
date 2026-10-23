import { describe, expect, it } from 'vitest'

import type { AgentIntakeDecisionV2 } from '@ggb-copilot/app-protocol'

import {
  traceReferences,
  type KnowledgeEntry, type KnowledgeSource,
} from '../src/index.js'

const entry = (id: string, title: string, content: string, tags: string[]): KnowledgeEntry => ({
  id, title, content, tags, corpusId: 'construction_patterns', status: 'approved', version: 'v1',
  language: 'multilingual', capabilityVersion: 'geometry-contract-v2', sourceVersion: 'test-v1',
  reviewedAt: '2026-09-08T00:00:00.000Z',
})

const source: KnowledgeSource = {
  search: (_query, corpusId) => corpusId === 'construction_patterns'
    ? [entry('circumcenter', '外心', '垂直平分线交点', ['外心'])] : [],
}

function retrieval(kind: 'none' | 'search'): AgentIntakeDecisionV2['retrieval'] {
  return kind === 'none' ? { kind: 'none' }
    : { kind: 'search', corpusIds: ['construction_patterns'], query: '外心 垂直平分线' }
}

describe('shared knowledge retrieval', () => {
  it('uses No-RAG when Intake does not request retrieval', () => {
    expect(traceReferences(retrieval('none'), source).references).toEqual([])
  })

  it('does not retrieve legacy auto cases that lack an actual verified script', () => {
    const legacy: KnowledgeEntry = { ...entry('solved-auto-legacy', '圆内接正多边形',
      '作正多边形: 预期结果', ['内接']), corpusId: 'solved_tasks' }
    const caseSource: KnowledgeSource = { search: () => [legacy] }
    expect(traceReferences({ kind: 'search', corpusIds: ['solved_tasks'],
      query: '圆内接正多边形' }, caseSource).references).toEqual([])
  })

  it('retrieves an allowlisted relevant reference', () => {
    const references = traceReferences(retrieval('search'), source).references
    expect(references.map(item => item.entry.id)).toEqual(['circumcenter'])
  })

  it('records why bounded release candidates were provided or filtered', () => {
    const first = entry('first', '圆的半径', '作圆时先选圆心', ['圆'])
    const second = entry('second', '圆的切线', '在圆上取切点', ['圆'])
    const incompatible = { ...entry('draft', '圆的半径草案', '连接两点', ['圆']), status: 'draft' as const }
    const local: KnowledgeSource = { search: (_query, corpusId) => corpusId === 'construction_patterns'
      ? [first, first, incompatible] : [{ ...second, corpusId: 'solved_tasks' }] }
    const trace = traceReferences({ kind: 'search', corpusIds: ['construction_patterns', 'solved_tasks'],
      query: '圆的半径 圆的切线' }, local, 1)
    expect(trace.references.map(item => item.entry.id)).toEqual(['first'])
    expect(trace.candidates.map(item => [item.sourceId, item.reason])).toEqual([
      ['first', 'provided'], ['first', 'duplicate'], ['draft', 'incompatible'], ['second', 'budget'],
    ])

  })

  it('drops conflicting records with the same title', () => {
    const conflictSource: KnowledgeSource = {
      search: () => [entry('a', '规则', '圆的半径', ['圆']), entry('b', '规则', '圆的直径', ['圆'])],
    }
    expect(traceReferences({ kind: 'search', corpusIds: ['construction_patterns'], query: '圆的半径' }, conflictSource).references)
      .toEqual([])
  })

  it('uses No-RAG for an empty or unmatched query', () => {
    expect(traceReferences({
      kind: 'search', corpusIds: ['construction_patterns'], query: '  ',
    }, source).references).toEqual([])
    expect(traceReferences({
      kind: 'search', corpusIds: ['solved_tasks'], query: '外心',
    }, source).references).toEqual([])
  })

  it('does not promote an unrelated entry through a generic one-character tag', () => {
    const genericSource: KnowledgeSource = {
      search: () => [entry('tangent', '圆的切线验证', '切线应通过明确切点', ['切线', '圆'])],
    }
    expect(traceReferences({
      kind: 'search', corpusIds: ['construction_patterns'], query: '画一个圆并在圆内作一个内接正多边形',
    }, genericSource).references).toEqual([])
  })
})

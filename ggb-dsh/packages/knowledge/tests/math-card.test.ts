import { describe, expect, it } from 'vitest'

import { mathKnowledgeCardSchema, selectMathGoal } from '../src/index.js'

const card = mathKnowledgeCardSchema.parse({
  schemaVersion: 1, id: 'midpoint-example', name: '中点性质', aliases: ['midpoint property'],
  prerequisites: ['M 是线段 AB 的中点'],
  symbols: [{ symbol: 'M', meaning: '线段 AB 的中点' }],
  relations: [
    { statement: 'AM = MB', justification: '中点的定义',
      verification: { kind: 'geometry_assertion', assertionKind: 'equalLength' } },
    { statement: '中点将线段平分', justification: '中点的定义',
      verification: { kind: 'explanation_only' } },
  ],
  displayRequirements: ['标出 A、M、B 与两段线段'],
  review: { status: 'approved', reviewer: 'test-reviewer', reviewedAt: '2026-09-08T00:00:00.000Z',
    sourceVersion: 'fixture-v1' },
})

describe('math knowledge card', () => {
  it('selects a card only for its exact name or alias', () => {
    expect(selectMathGoal('请解释中点性质并画图', { searchMath: () => [card] })?.id).toBe(card.id)
    expect(selectMathGoal('midpoint property', { searchMath: () => [card] })?.id).toBe(card.id)
    expect(selectMathGoal('画线段', { searchMath: () => [card] })).toBeUndefined()
  })

  it('rejects executable fields and unsupported verification claims', () => {
    expect(mathKnowledgeCardSchema.safeParse({ ...card, command: 'Segment(A,B)' }).success).toBe(false)
    expect(mathKnowledgeCardSchema.safeParse({ ...card, relations: [{ ...card.relations[0],
      verification: { kind: 'geometry_assertion', assertionKind: 'areaIdentity' } }] }).success).toBe(false)
  })
})

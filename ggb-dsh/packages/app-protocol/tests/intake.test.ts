import { describe, expect, it } from 'vitest'

import { agentIntakeDecisionV2Schema } from '../src/index.js'

const decision = {
  schemaVersion: 2 as const,
  status: 'ready' as const,
  restatedRequest: '画一个圆',
  orderedGoals: [{ goalId: 'g1', description: '先画圆', dependsOn: [] }],
  constraints: [], ambiguities: [], unreadableParts: [], intent: 'construct' as const,
  complexity: 'simple' as const, retrieval: { kind: 'none' as const },
  requiresCanvasObservation: false, uncertainties: [],
}

describe('AgentIntakeDecisionV2', () => {
  it('accepts an ordered ready geometry brief', () => {
    expect(agentIntakeDecisionV2Schema.parse(decision).orderedGoals[0]?.goalId).toBe('g1')
  })

  it('accepts a current Intake brief without the Planning-owned complexity field', () => {
    const current = { ...decision } as Partial<typeof decision>
    delete current.complexity
    expect(agentIntakeDecisionV2Schema.parse(current)).not.toHaveProperty('complexity')
  })

  it('rejects forward goal dependencies', () => {
    expect(agentIntakeDecisionV2Schema.safeParse({
      ...decision,
      orderedGoals: [{ goalId: 'g1', description: '后画多边形', dependsOn: ['g2'] }],
    }).success).toBe(false)
  })

  it('accepts a clarification requested by an unresolved parameter without a duplicate ambiguity', () => {
    expect(agentIntakeDecisionV2Schema.parse({
      ...decision, status: 'needs_clarification', intent: 'clarify',
      clarificationQuestion: '半径是多少？',
      uncertainties: [{ parameter: '圆的半径', classification: 'requires_clarification' }],
    })).toMatchObject({ status: 'needs_clarification', clarificationQuestion: '半径是多少？' })
  })

  it('rejects an invalid reviewed slider range', () => {
    expect(agentIntakeDecisionV2Schema.safeParse({
      ...decision, uncertainties: [{ parameter: '圆的半径', classification: 'safe_parameterization',
        slider: { min: 10, max: 1, step: 0.5, initialValue: 3, integer: false } }],
    }).success).toBe(false)
  })


})

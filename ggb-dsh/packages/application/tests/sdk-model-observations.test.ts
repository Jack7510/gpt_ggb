import { describe, expect, it } from 'vitest'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { sdkFailureCode, sdkTurnOutcome, dshModelCallObservations } from '../src/sdk-model-observations.js'

function event(type: string, data: Record<string, unknown>): RunResult['events'][number] {
  return { type, seq: 1 as never, time: 1, data } as RunResult['events'][number]
}

function run(events: RunResult['events']): RunResult {
  return { sessionId: 'dsh-test', finalResponse: '', events, notifications: [] }
}

describe('SDK model observations for Native verification', () => {
  it('includes cache reads and writes in total input, without retaining content', () => {
    const result = dshModelCallObservations(run([event('step/start', { turn: 1, step: 1 }),
      event('assistant/message', { turn: 1, step: 1,
        usage: { inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 20, outputTokens: 7 },
        message: { content: [{ type: 'reasoning', text: 'private fixture content' }] } })]))
    expect(result).toEqual([{ callOrdinal: 1, sdkTurn: 1, sdkStep: 1, outcome: 'completed',
      inputTokens: 110, outputTokens: 7, reasoningTokens: null, cacheReadTokens: 80, usageComplete: true }])
    expect(JSON.stringify(result)).not.toContain('private fixture content')
  })

  it('keeps interrupted, failed and started-only calls visible with unknown usage', () => {
    const result = dshModelCallObservations(run([
      event('step/start', { turn: 1, step: 1 }),
      event('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 120, outputTokens: 35,
        reasoningTokens: 10 }, message: { content: [] } }),
      event('step/start', { turn: 1, step: 2 }),
      event('assistant/attempt', { turn: 1, step: 2 }),
      event('step/start', { turn: 1, step: 3 }),
      event('assistant/message', { turn: 1, step: 3, interrupted: true }),
      event('step/start', { turn: 1, step: 4 }),
    ]))
    expect(result.map(call => [call.callOrdinal, call.outcome, call.inputTokens, call.usageComplete]))
      .toEqual([[1, 'completed', 120, true], [2, 'attempt_without_message', null, false],
        [3, 'interrupted', null, false], [4, 'incomplete', null, false]])
  })

  it('does not count replayed events twice or overwrite a completed message with an attempt', () => {
    const result = dshModelCallObservations(run([
      event('step/start', { turn: 2, step: 1 }), event('step/start', { turn: 2, step: 1 }),
      event('assistant/message', { turn: 2, step: 1, usage: { inputTokens: 5, outputTokens: 7 } }),
      event('assistant/attempt', { turn: 2, step: 1 }),
    ]))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ sdkTurn: 2, sdkStep: 1, outcome: 'completed',
      inputTokens: 5, outputTokens: 7, usageComplete: true })
  })

  it('ignores invalid step identities and does not invent invalid token counters', () => {
    const result = dshModelCallObservations(run([
      event('assistant/message', { usage: { inputTokens: 500, outputTokens: 7 } }),
      event('step/start', { turn: 0, step: 1 }), event('step/start', { turn: 1, step: 0.5 }),
      event('assistant/message', { turn: 1, step: 1,
        usage: { inputTokens: -1, outputTokens: NaN, reasoningTokens: -2, cacheReadTokens: Infinity } }),
    ]))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ inputTokens: null, outputTokens: null,
      reasoningTokens: null, cacheReadTokens: null, usageComplete: false })
  })
})


describe('SDK turn lifecycle', () => {
  it.each(['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked'])(
    'uses %s rather than idle status or a plausible final answer', kind => {
      const outcome = sdkTurnOutcome(run([event('turn/end', { reason: { kind,
        error: { code: 'RATE_LIMIT', message: 'secret provider response' } } })]))
      expect(outcome).toEqual({ kind, handoff: kind === 'completed',
        failureCode: kind === 'error' ? 'RATE_LIMIT' : null })
      expect(JSON.stringify(outcome)).not.toContain('secret')
    })
  it('refuses missing lifecycle evidence and normalizes unknown failures', () => {
    expect(sdkTurnOutcome(run([]))).toEqual({ kind: 'missing', handoff: false, failureCode: null })
    expect(sdkFailureCode({ code: 'secret', message: 'secret' })).toBe('UNCLASSIFIED_STREAM_FAILURE')
  })
})

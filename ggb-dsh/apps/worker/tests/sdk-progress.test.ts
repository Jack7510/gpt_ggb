import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { pluginCoreProgressFactSchema, type PluginCoreProgressFact } from '@ggb-copilot/application'
import { sdkProgress } from '../src/plugin-core/sdk-progress.js'

function notification(type: string, step?: unknown, sessionId = 'session'): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data: { turn: 1, step } } } } as HarnessNotification
}

describe('live SDK model-step facts', () => {
  it('pairs real steps and ignores wrong sessions, invalid, duplicate and out-of-order events', () => {
    const facts: PluginCoreProgressFact[] = []
    const observer = sdkProgress('session', fact => { facts.push(fact) })
    for (const event of [notification('step/start', 1, 'other'), notification('step/end', 1),
      notification('step/start', '1'), notification('step/start', 0), notification('step/start', 1.5),
      notification('tool/call', 1), { method: 'other' } as HarnessNotification]) observer.notification(event)
    expect(facts).toEqual([])
    observer.notification(notification('step/start', 1))
    observer.notification(notification('step/start', 1))
    observer.notification(notification('step/end', 2))
    observer.notification(notification('step/end', 1))
    observer.notification(notification('step/end', 1))
    observer.notification(notification('step/start', 1))
    observer.notification(notification('step/start', 2))
    expect(facts.map(p => [p.step, p.status])).toEqual([[1, 'started'], [1, 'finished'], [2, 'started']])
    expect(facts[0]?.callId).toBe(facts[1]?.callId)
    expect(facts[2]?.callId).not.toBe(facts[0]?.callId)
    expect(facts.every(fact => pluginCoreProgressFactSchema.safeParse(fact).success)).toBe(true)
  })
  it.each(['turn/end', 'close'])('suppresses late events after %s and isolates failing observers', ending => {
    const emit = vi.fn(() => { throw new Error('observer failure') })
    const observer = sdkProgress('session', emit)
    expect(() => observer.notification(notification('step/start', 1))).not.toThrow()
    if (ending === 'close') observer.close()
    else observer.notification(notification('turn/end'))
    observer.notification(notification('step/end', 1))
    observer.notification(notification('step/start', 2))
    expect(emit).toHaveBeenCalledOnce()
  })
  it('rejects fabricated source/status combinations and incomplete budget metadata', () => {
    const fact = { tool: 'model', status: 'started', step: 1, callId: randomUUID() }
    for (const invalid of [{ ...fact, step: undefined }, { ...fact, status: 'accepted' },
      { ...fact, tool: 'ggb_build' }, { ...fact, attempt: 2 }, { ...fact, attempt: 4, limit: 3 },
      { ...fact, providerText: 'private' }]) {
      expect(pluginCoreProgressFactSchema.safeParse(invalid).success).toBe(false)
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { PluginCoreEvent, PluginCoreProgress } from '@ggb-copilot/application/browser'
import { initialProjectedState } from '../src/runtime/run-state.js'
import { applyPluginEvent, pluginViewState } from '../src/runtime/plugin-core-projector.js'
import { describeRunStatus } from '../src/app/run-status.js'
import { reconnectPluginStream } from '../src/runtime/reconnect-plugin-stream.js'
import { RunAdapterError } from '../src/runtime/adapter-error.js'

const progress: PluginCoreProgress = { tool: 'ggb_build', status: 'started',
  callId: '11111111-1111-4111-8111-111111111111', buildId: '22222222-2222-4222-8222-222222222222',
  attempt: 2, limit: 3, sequence: 1, occurredAt: '2026-10-23T00:00:00.000Z' }
function event(eventId = 3): PluginCoreEvent {
  return { schemaVersion: 1, runId: 'run', eventId, occurredAt: progress.occurredAt,
    payload: { type: 'plugin_core.progress', progress } }
}

describe('factual tool progress', () => {
  it('projects progress without changing lifecycle or claiming finer execution stages', () => {
    const state = applyPluginEvent(initialProjectedState('run', 'running'), event())
    expect(state.phase).toBe('running')
    expect(state.progress).toEqual(progress)
    expect(describeRunStatus(state, true, 0, 'zh-CN').detail).toBe('构造与核验 (2/3) · 调用中')
    expect(describeRunStatus({ ...state, progress: { ...progress, status: 'rejected' } }, true, 0, 'en').detail)
      .toContain('Call rejected; awaiting further processing')
  })
  it.each(['completed', 'failed', 'cancelled'])('never revives %s with late progress or phase', phase => {
    const state = { ...initialProjectedState('run', phase), terminal: true, eventCursor: 4 }
    expect(applyPluginEvent(state, event(5))).toBe(state)
    expect(applyPluginEvent(state, { ...event(6), payload: { type: 'plugin_core.phase', phase: 'running' } })).toBe(state)
  })
  it('rejects foreign, duplicate, stale sequence and stopping progress', () => {
    const state = applyPluginEvent(initialProjectedState('run', 'running'), event())
    expect(applyPluginEvent(state, { ...event(5), runId: 'other' })).toBe(state)
    expect(applyPluginEvent(state, event(3))).toBe(state)
    expect(applyPluginEvent(state, { ...event(5), payload: { type: 'plugin_core.progress',
      progress: { ...progress, status: 'rejected' } } }).progress).toEqual(progress)
    expect(applyPluginEvent({ ...state, stopRequested: true }, { ...event(6), payload: {
      type: 'plugin_core.progress', progress: { ...progress, sequence: 2 } } }).progress).toEqual(progress)
  })
  it('restores the last tool fact from a ready snapshot at its high watermark', () => {
    const state = pluginViewState({ runId: 'run', phase: 'running', createdAt: progress.occurredAt,
      events: { latestEventId: 5, earliestEventId: 1 }, progress, terminal: false,
      stopRequested: true, failure: null, finalResponse: null } as never)
    expect(state.progress).toEqual(progress)
    expect(state.eventCursor).toBe(5)
    expect(state.stopRequested).toBe(true)
    expect(applyPluginEvent(state, event(4))).toBe(state)
  })
  it('reconnects from the current cursor after EOF and network failure without recreating the run', async () => {
    vi.useFakeTimers()
    try {
      let cursor = 0
      let terminal = false
      const seen: number[] = []
      const task = reconnectPluginStream(async after => {
        seen.push(after)
        if (seen.length === 1) { cursor = 3; return }
        if (seen.length === 2) { cursor = 4; throw new RunAdapterError('network', 'offline') }
        terminal = true
      }, () => cursor, () => terminal, new AbortController().signal)
      await vi.runAllTimersAsync()
      await task
      expect(seen).toEqual([0, 3, 4])
    } finally { vi.useRealTimers() }
  })
  it('bounds repeated EOF reconnects instead of spinning indefinitely', async () => {
    vi.useFakeTimers()
    try {
      const open = vi.fn(async () => undefined)
      const result = expect(reconnectPluginStream(open, () => 0, () => false,
        new AbortController().signal)).rejects.toMatchObject({ code: 'stream_closed' })
      await vi.runAllTimersAsync()
      await result
      expect(open).toHaveBeenCalledTimes(5)
    } finally { vi.useRealTimers() }
  })
  it('aborts reconnect backoff and never retries authorization errors', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const open = vi.fn(async () => undefined)
      const task = reconnectPluginStream(open, () => 3, () => false, controller.signal)
      await Promise.resolve()
      controller.abort()
      await task
      expect(open).toHaveBeenCalledOnce()
      await expect(reconnectPluginStream(async () => { throw new RunAdapterError('not_found', 'gone') },
        () => 0, () => false, new AbortController().signal)).rejects.toMatchObject({ code: 'not_found' })
    } finally { vi.useRealTimers() }
  })
})

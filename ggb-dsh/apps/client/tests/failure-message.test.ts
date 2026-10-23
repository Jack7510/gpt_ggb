import { describe, expect, it } from 'vitest'
import { pluginCoreEventPayloadSchema, type PluginCoreBuildFailure, type PluginCoreRunView } from '@ggb-copilot/application/browser'
import { failureMessage } from '../src/app/failure-message.js'
import { applyPluginEvent, pluginViewState } from '../src/runtime/plugin-core-projector.js'
import { initialProjectedState } from '../src/runtime/run-state.js'
import { describeRunStatus } from '../src/app/run-status.js'

const details: PluginCoreBuildFailure = { kind: 'verification_failed', lastBuildId: '11111111-1111-4111-8111-111111111111',
  error: { code: 'verification_failed', message: 'Required checks did not pass' },
  failedChecks: [{ requirementId: 'shape', checkId: 'shape:2', method: 'type', status: 'failed' }],
  reasons: ['shape/shape:2: type failed'] }
const failure = { code: 'plugin_core_no_delivery' as const, message: 'The last build did not satisfy verification.', details }

describe('build failure presentation and reconnect', () => {
  it('keeps the same structured facts in an SSE event and a restored run view', () => {
    const payload = pluginCoreEventPayloadSchema.parse({ type: 'plugin_core.failed', ...failure, usage: null })
    const live = applyPluginEvent(initialProjectedState('run'), { schemaVersion: 1, runId: 'run',
      eventId: 3, occurredAt: new Date().toISOString(), payload })
    const restored = pluginViewState({ runId: 'run', phase: 'failed', createdAt: '',
      events: { latestEventId: 3 }, failure, terminal: true, finalResponse: null } as PluginCoreRunView)
    expect(live.failure).toEqual(restored.failure)
    const text = failureMessage(live.failure!, 'zh-CN')
    expect(text).toContain('核验失败')
    expect(text).toContain(details.lastBuildId)
    expect(text).toContain('shape:2')
    expect(describeRunStatus(restored, true, Date.now(), 'zh-CN').detail).toBe(text)
  })
  it.each([['not_built', '未执行构建'], ['structure_rejected', '请求结构被拒绝'],
    ['execution_failed', '构建执行故障'], ['verification_failed', '核验失败']] as const)('labels %s without inventing a verification failure', (kind, label) => {
    const text = failureMessage({ ...failure, details: { ...details, kind } }, 'zh-CN')
    expect(text).toContain(label)
  })
  it('still displays failures saved before structured summaries existed', () => {
    expect(failureMessage({ code: 'plugin_core_failed', message: 'older failure' }, 'en')).toBe('plugin_core_failed: older failure')
  })
})

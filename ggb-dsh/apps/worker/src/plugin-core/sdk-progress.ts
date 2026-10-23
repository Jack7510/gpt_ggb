import { randomUUID } from 'node:crypto'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { PluginCoreProgressFact } from '@ggb-copilot/application'

/** One live SDK session owns the monotone model-step observer. Never replay returned events. */
export function sdkProgress(sessionId: string, emit: (fact: PluginCoreProgressFact) => void): {
  notification(notification: HarnessNotification): void
  close(): void
} {
  let closed = false
  let lastStep = 0
  let active: { step: number; callId: string } | null = null
  return {
    close: () => { closed = true },
    notification: notification => {
      if (closed || notification.method !== 'session.event' || notification.params?.sessionId !== sessionId) return
      const event = notification.params.event as { type?: string; data?: { step?: unknown } } | undefined
      if (event?.type === 'turn/end') { closed = true; return }
      const step = event?.data?.step
      if (!Number.isSafeInteger(step) || Number(step) < 1 || Number(step) > 1_000_000) return
      let fact: PluginCoreProgressFact | undefined
      if (event?.type === 'step/start' && Number(step) > lastStep) {
        lastStep = Number(step)
        active = { step: lastStep, callId: randomUUID() }
        fact = { tool: 'model', status: 'started', ...active }
      } else if (event?.type === 'step/end' && active !== null && step === active.step) {
        fact = { tool: 'model', status: 'finished', ...active }
        active = null
      }
      if (fact) { try { emit(fact) } catch { /* Progress cannot fail execution. */ } }
    },
  }
}

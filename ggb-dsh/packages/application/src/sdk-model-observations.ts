import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { totalInputTokensFromDshUsageV1 } from './sdk-token-usage.js'

/** One SDK step's accounting; null means the SDK did not supply that counter. */
export interface DshModelCallObservation {
  readonly callOrdinal: number
  readonly sdkTurn: number
  readonly sdkStep: number
  readonly outcome: 'completed' | 'interrupted' | 'attempt_without_message' | 'incomplete'
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly reasoningTokens: number | null
  readonly cacheReadTokens: number | null
  readonly usageComplete: boolean
}

type TokenKey = 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens'

/** Read call-level facts without inventing usage for failed or incomplete steps. */
export function dshModelCallObservations(result: RunResult): DshModelCallObservation[] {
  const calls = new Map<string, DshModelCallObservation>()
  for (const event of result.events) {
    if (event.type !== 'step/start' && event.type !== 'assistant/message'
      && event.type !== 'assistant/attempt') continue
    const data = record(event.data)
    const key = sdkStepKey(data)
    if (key === null) continue
    const turn = Number(data?.turn)
    const step = Number(data?.step)
    const previous = calls.get(key)
    const base: DshModelCallObservation = previous ?? {
      callOrdinal: calls.size + 1, sdkTurn: turn, sdkStep: step,
      outcome: 'incomplete', inputTokens: null, outputTokens: null,
      reasoningTokens: null, cacheReadTokens: null, usageComplete: false,
    }
    if (event.type === 'step/start') { calls.set(key, base); continue }
    if (event.type === 'assistant/attempt') {
      calls.set(key, base.outcome === 'completed' || base.outcome === 'interrupted'
        ? base : { ...base, outcome: 'attempt_without_message' })
      continue
    }
    const usage = record(data?.usage)
    const inputTokens = totalInputTokensFromDshUsageV1(usage?.inputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens)
    const outputTokens = tokenValue(usage, 'outputTokens') ?? null
    calls.set(key, {
      ...base, outcome: data?.interrupted === true ? 'interrupted' : 'completed',
      inputTokens, outputTokens,
      reasoningTokens: tokenValue(usage, 'reasoningTokens') ?? null,
      cacheReadTokens: tokenValue(usage, 'cacheReadTokens') ?? null,
      usageComplete: inputTokens !== null && outputTokens !== null,
    })
  }
  return [...calls.values()]
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined
}

function sdkStepKey(data: Readonly<Record<string, unknown>> | undefined): string | null {
  const turn = data?.turn
  const step = data?.step
  return Number.isSafeInteger(turn) && Number.isSafeInteger(step)
    && Number(turn) >= 1 && Number(step) >= 1 ? `${turn}:${step}` : null
}

function tokenValue(
  usage: Readonly<Record<string, unknown>> | undefined,
  key: TokenKey,
): number | undefined {
  const value = usage?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Collapse SDK failures to bounded codes; never retain provider messages or envelopes. */
export function sdkFailureCode(error: unknown): string {
  const codes = new Set(['STREAM_CLOSED', 'MALFORMED_RESPONSE', 'EMPTY_RESPONSE', 'MESSAGES_IDLE',
    'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED',
    'AUTH', 'AUTHENTICATION', 'PERMISSION', 'INVALID_REQUEST', 'NO_ADAPTER', 'UNKNOWN'])
  const code = record(error)?.code
  return typeof code === 'string' && codes.has(code) ? code : 'UNCLASSIFIED_STREAM_FAILURE'
}

/** Interpret lifecycle independently of model text and token accounting. */
export function sdkTurnOutcome(result: Pick<RunResult, 'events'>): {
  kind: string; failureCode: string | null; handoff: boolean
} {
  const event = result.events.filter(item => item.type === 'turn/end').at(-1)
  const reason = record(record(event?.data)?.reason)
  const kinds = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'])
  const kind = typeof reason?.kind === 'string' && kinds.has(reason.kind) ? reason.kind : 'missing'
  return { kind, failureCode: kind === 'error' ? sdkFailureCode(reason?.error) : null,
    handoff: kind === 'completed' }
}

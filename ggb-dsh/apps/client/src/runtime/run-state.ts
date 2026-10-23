import type { PluginCoreBuildFailure } from '@ggb-copilot/application/browser'

/** Plugin-core run state folded from the durable view and SSE events. */
export interface ProjectedRunState {
  runId: string
  phase: string
  /** Stop was accepted by the Server; wait for the durable terminal event. */
  stopRequested: boolean
  eventCursor: number
  /** Server admission time; lets the UI show elapsed time after reconnect. */
  startedAt: string | null
  finalMessage: string | null
  failure: { code: string; message: string; details?: PluginCoreBuildFailure | undefined } | null
  terminal: boolean
}

export function initialProjectedState(
  runId: string,
  phase = 'accepted',
  startedAt: string | null = null,
): ProjectedRunState {
  return {
    runId,
    phase,
    stopRequested: false,
    eventCursor: 0,
    startedAt,
    finalMessage: null,
    failure: null,
    terminal: false,
  }
}

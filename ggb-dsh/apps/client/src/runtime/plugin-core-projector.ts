import type {
  PluginCoreEvent, PluginCoreRunView,
} from '@ggb-copilot/application/browser'
import { initialProjectedState, type ProjectedRunState } from './run-state.js'

/** Fold the plugin-core view and events into the shared status state. */
export function pluginViewState(view: PluginCoreRunView): ProjectedRunState {
  const state = initialProjectedState(view.runId, view.phase, view.createdAt)
  state.eventCursor = view.events.latestEventId ?? 0
  state.progress = view.progress ?? null
  state.stopRequested = view.stopRequested
  state.finalMessage = view.finalResponse
  state.failure = view.failure === null ? null : {
    code: view.failure.code, message: view.failure.message,
    ...(view.failure.details === undefined ? {} : { details: view.failure.details }),
  }
  state.terminal = view.terminal
  return state
}

export function applyPluginEvent(state: ProjectedRunState,
  event: PluginCoreEvent): ProjectedRunState {
  if (event.runId !== state.runId || event.eventId <= state.eventCursor || state.terminal) return state
  const next = { ...state, eventCursor: event.eventId }
  const payload = event.payload
  switch (payload.type) {
    case 'plugin_core.progress':
      if (!state.stopRequested && payload.progress.sequence > (state.progress?.sequence ?? 0)) next.progress = payload.progress
      return next
    case 'plugin_core.phase':
      next.phase = payload.phase
      next.terminal = payload.phase === 'completed' || payload.phase === 'failed'
        || payload.phase === 'cancelled'
      return next
    case 'plugin_core.delivery':
      next.phase = 'completed'
      next.terminal = true
      next.finalMessage = payload.finalResponse
      return next
    case 'plugin_core.failed':
      next.phase = 'failed'
      next.terminal = true
      next.failure = { code: payload.code, message: payload.message,
        ...(payload.details === undefined ? {} : { details: payload.details }) }
      return next
    case 'plugin_core.cancelled':
      next.phase = 'cancelled'
      next.terminal = true
      return next
  }
}

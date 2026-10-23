/** Stable error codes shared by API responses, SSE terminal events and diagnostics. */
export type RunErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'payload_too_large'
  | 'provider_not_allowed'
  | 'capacity_unavailable'
  | 'event_cursor_expired'
  | 'duplicate_run_conflict'
  | 'state_not_accepting_input'
  | 'checkpoint_incompatible'
  | 'client_upgrade_required'
  | 'recovery_required'
  | 'worker_not_active'
  | 'receipt_digest_conflict'
  | 'already_terminal'
  | 'engine_not_supported'
  | 'plugin_core_unavailable'
  | 'internal_error'

const httpStatusByCode: Record<RunErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  payload_too_large: 413,
  provider_not_allowed: 403,
  capacity_unavailable: 503,
  event_cursor_expired: 410,
  duplicate_run_conflict: 409,
  state_not_accepting_input: 409,
  checkpoint_incompatible: 409,
  client_upgrade_required: 409,
  recovery_required: 409,
  worker_not_active: 409,
  receipt_digest_conflict: 409,
  already_terminal: 409,
  engine_not_supported: 409,
  plugin_core_unavailable: 503,
  internal_error: 500,
}

export class RunError extends Error {
  readonly code: RunErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: RunErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'RunError'
    this.code = code
    this.details = details
  }

  get httpStatus(): number {
    return httpStatusByCode[this.code]
  }
}

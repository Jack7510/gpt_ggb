export type RunAdapterErrorCode =
  | 'network'
  | 'stream_closed'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'event_cursor_expired'
  | 'invalid_request'
  | 'payload_too_large'
  | 'provider_not_allowed'
  | 'capacity_unavailable'
  | 'engine_not_supported'
  | 'plugin_core_unavailable'
  | 'internal'

/** One stable transport or Server rejection surfaced to the Client. */
export class RunAdapterError extends Error {
  public constructor(
    public readonly code: RunAdapterErrorCode,
    message: string,
    public readonly status: number | null = null,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'RunAdapterError'
  }
}

/**
 * Multi-tab coordination (§3.4). Web Locks elect a single canvas writer per
 * Session and BroadcastChannel tells the other tabs that local data changed;
 * IndexedDB stays the source of truth.
 */
export const SESSION_LOCK_PREFIX = 'ggb-session-writer:'
export const SESSION_CHANNEL_NAME = 'ggb-session-events'

export type SessionChangeKind = 'session_created' | 'session_updated' | 'session_deleted' | 'messages_changed'

export interface SessionChangeEvent {
  kind: SessionChangeKind
  sessionId: string
  at: string
}

export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive'; ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

export interface SessionCoordinatorDeps {
  locks: LockManagerLike
  createChannel(name: string): BroadcastChannelLike
  now(): string
}

/**
 * Tracks which Session this tab currently owns for canvas writing (§3.4).
 */
export class SessionCoordinator {
  private readonly channel: BroadcastChannelLike
  private readonly listeners = new Set<(event: SessionChangeEvent) => void>()
  private heldSessionId: string | null = null

  public constructor(private readonly deps: SessionCoordinatorDeps) {
    this.channel = deps.createChannel(SESSION_CHANNEL_NAME)
    this.channel.addEventListener('message', this.handleMessage)
  }

  public get activeSessionId(): string | null {
    return this.heldSessionId
  }

  /**
   * Runs `work` while holding the exclusive writer lock for `sessionId`.
   * Returns `null` when another tab already owns the Session.
   */
  public async withWriterLock<T>(sessionId: string, work: () => Promise<T>): Promise<T | null> {
    return this.deps.locks.request(
      `${SESSION_LOCK_PREFIX}${sessionId}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (lock === null) return null
        const previous = this.heldSessionId
        this.heldSessionId = sessionId
        try {
          return await work()
        } finally {
          this.heldSessionId = previous
        }
      },
    )
  }

  public publish(kind: SessionChangeKind, sessionId: string): void {
    const event: SessionChangeEvent = { kind, sessionId, at: this.deps.now() }
    this.channel.postMessage(event)
  }

  public onChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public dispose(): void {
    this.channel.removeEventListener('message', this.handleMessage)
    this.channel.close()
    this.listeners.clear()
  }

  private readonly handleMessage = (event: { data: unknown }): void => {
    const parsed = parseSessionChangeEvent(event.data)
    if (parsed === null) return
    for (const listener of this.listeners) listener(parsed)
  }
}

export function parseSessionChangeEvent(value: unknown): SessionChangeEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Record<string, unknown>
  const kinds: readonly SessionChangeKind[] = [
    'session_created',
    'session_updated',
    'session_deleted',
    'messages_changed',
  ]
  if (typeof message['kind'] !== 'string' || !kinds.includes(message['kind'] as SessionChangeKind)) return null
  if (typeof message['sessionId'] !== 'string' || message['sessionId'].length === 0) return null
  return {
    kind: message['kind'] as SessionChangeKind,
    sessionId: message['sessionId'],
    at: typeof message['at'] === 'string' ? message['at'] : '',
  }
}

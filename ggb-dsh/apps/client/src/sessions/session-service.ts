import type { LocalCanvasBinding, LocalMessage, LocalMessageRole, LocalRunBinding, LocalConversationSession, SessionRepository, SessionSummary } from './session-repository.js'

/** Best-effort remote stop used before local deletion (§3.1); never receives a sessionId. */
export interface RemoteStopPort {
  stop(runId: string, runToken: string): Promise<void>
}

/** Reveals a sealed run token; implemented by `runtime/run-capability.ts`. */
export interface RunTokenRevealer {
  reveal(sealed: string): Promise<string>
}

export interface SessionServiceDeps {
  repository: SessionRepository
  tokens: RunTokenRevealer
  runs: RemoteStopPort
  now(): string
  newId(): string
}

export interface CreateSessionOptions {
  title?: string
  sessionId?: string
}

export const DEFAULT_SESSION_TITLE = 'New session'
const DEFAULT_SESSION_TITLES = new Set([DEFAULT_SESSION_TITLE, '新会话'])
const DELETE_STOP_WAIT_MS = 2_000

/**
 * Local Session lifecycle: new/rename/switch/continue/delete. Nothing here
 * talks to the server except the best-effort per-run stop before deletion.
 */
export class SessionService {
  public constructor(private readonly deps: SessionServiceDeps) {}

  public listSessions(): Promise<SessionSummary[]> {
    return this.deps.repository.summaries()
  }

  public async createSession(options: CreateSessionOptions = {}): Promise<LocalConversationSession> {
    const now = this.deps.now()
    const session: LocalConversationSession = {
      sessionId: options.sessionId ?? this.deps.newId(),
      title: options.title ?? DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
      activeCanvasVersion: null,
      lastOpenedMessageId: null,
    }
    await this.deps.repository.createSession(session)
    return session
  }

  public async renameSession(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (trimmed.length === 0) throw new Error('session_title_empty')
    await this.deps.repository.updateSession(sessionId, { title: trimmed.slice(0, 200), updatedAt: this.deps.now() })
  }

  /**
   * Names a new local Session from the first completed Intake. A manual name is
   * authoritative, so late/replayed events cannot replace it.
   */
  public async applySuggestedTitle(sessionId: string, suggestedTitle: string): Promise<boolean> {
    const title = suggestedTitle.replace(/\s+/gu, ' ').trim().slice(0, 120)
    if (title.length === 0) return false
    const session = await this.deps.repository.getSession(sessionId)
    if (session === null || !DEFAULT_SESSION_TITLES.has(session.title)) return false
    await this.deps.repository.updateSession(sessionId, { title, updatedAt: this.deps.now() })
    return true
  }

  /** Marks a Session as the last opened one without changing its content. */
  public async touchSession(sessionId: string, lastOpenedMessageId?: string): Promise<void> {
    await this.deps.repository.updateSession(sessionId, {
      updatedAt: this.deps.now(),
      ...(lastOpenedMessageId === undefined ? {} : { lastOpenedMessageId }),
    })
  }

  public async appendMessage(input: {
    sessionId: string
    role: LocalMessageRole
    content: string
    runId?: string | null
    deliveryState?: LocalMessage['deliveryState']
    messageId?: string
    sourceEventId?: number
    contextKind?: LocalMessage['contextKind']
  }): Promise<LocalMessage> {
    const message: LocalMessage = {
      messageId: input.messageId ?? this.deps.newId(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: this.deps.now(),
      runId: input.runId ?? null,
      deliveryState: input.deliveryState ?? 'local',
      sequence: await this.deps.repository.nextMessageSequence(input.sessionId),
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      ...(input.contextKind === undefined ? {} : { contextKind: input.contextKind }),
    }
    await this.deps.repository.appendMessage(message)
    await this.deps.repository.updateSession(input.sessionId, { updatedAt: message.createdAt })
    return message
  }

  public updateMessage(
    messageId: string,
    patch: { content?: string; deliveryState?: LocalMessage['deliveryState']; runId?: string | null },
  ): Promise<void> {
    return this.deps.repository.updateMessage(messageId, patch)
  }

  public listMessages(sessionId: string): Promise<LocalMessage[]> {
    return this.deps.repository.listMessages(sessionId)
  }

  public bindRun(binding: LocalRunBinding): Promise<void> {
    return this.deps.repository.putRunBinding(binding)
  }

  public listRunBindings(sessionId: string): Promise<LocalRunBinding[]> {
    return this.deps.repository.listRunBindings(sessionId)
  }

  public async setActiveCanvas(binding: LocalCanvasBinding): Promise<void> {
    await this.deps.repository.putCanvasBinding(binding)
    await this.deps.repository.updateSession(binding.sessionId, {
      activeCanvasVersion: binding.canvasVersion,
    })
  }

  public getActiveCanvas(sessionId: string): Promise<LocalCanvasBinding | null> {
    return this.deps.repository.getCanvasBinding(sessionId)
  }

  public deleteCanvasBinding(sessionId: string): Promise<void> {
    return this.deps.repository.deleteCanvasBinding(sessionId)
  }

  /**
   * Deletes local Session data only. Each run is stopped best-effort with its
   * own token; a failed stop must not block deletion and must not leak a
   * sessionId to the server (§14.1).
   */
  public async deleteSession(sessionId: string): Promise<void> {
    const bindings = await this.deps.repository.listRunBindings(sessionId)
    await Promise.all(
      bindings.map(async (binding) => {
        try {
          const token = await this.deps.tokens.reveal(binding.runTokenCiphertext)
          await waitForBestEffortStop(this.deps.runs.stop(binding.runId, token))
        } catch {
          // Best effort only: local data is the user's to delete regardless.
        }
      }),
    )
    await this.deps.repository.deleteSession(sessionId)
  }

  /** Clears every private local record, including sealed run tokens. */
  public async clearAllLocalData(): Promise<void> {
    await this.deps.repository.clearAll()
  }
}

/** A stalled remote stop cannot hold a browser-local delete indefinitely. */
async function waitForBestEffortStop(stop: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      stop,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, DELETE_STOP_WAIT_MS) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

import { DEFAULT_SESSION_TITLES, GENERIC_IMAGE_TITLES } from './session-title.js'
import type { PluginCoreConstructionRecord } from '@ggb-copilot/application/browser'
import type { ClientDatabase } from '../persistence/indexeddb.js'

/** §3.2 local conversation session; the browser is the only source of truth. */
export interface LocalConversationSession {
  sessionId: string
  title: string
  titleSource?: 'manual' | 'automatic'
  createdAt: string
  updatedAt: string
  activeCanvasVersion: string | null
  lastOpenedMessageId: string | null
}

export type LocalMessageRole = 'user' | 'final_report'
export type LocalMessageDeliveryState = 'local' | 'submitting' | 'streaming' | 'complete' | 'failed'

export interface LocalMessage {
  messageId: string
  sessionId: string
  role: LocalMessageRole
  content: string
  createdAt: string
  runId: string | null
  deliveryState: LocalMessageDeliveryState
  /** Monotonic within a session; transcript order survives equal timestamps. */
  sequence: number
  /** Durable Server event that produced this local projection; absent for user turns. */
  sourceEventId?: number
  /**
   * Browser-only semantic marker for the bounded Intake context. It is not a
   * server identifier and lets us select task understanding without parsing
   * translated presentation Markdown.
   */
  contextKind?: 'final_report'
}

export interface LocalPluginDelivery {
  runId: string
  sha256: string
  bytes: number
  ggbOpfsPath: string
  construction?: PluginCoreConstructionRecord
  verification: unknown
  usage: {
    calls: number
    inputTokens: number | null
    outputTokens: number | null
    complete: boolean
  } | null
  createdAt: string
}

export interface LocalRunBinding {
  runId: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string | null
  /** Sealed with a non-extractable CryptoKey; never the raw runToken. */
  runTokenCiphertext: string
  eventCursor: number
  status: string
  createdAt: string
  expiresAt: string
  /** Older bindings are Native; plugin-core binds the same local record. */
  engine?: 'native' | 'plugin_core'
  /** Present after a completed plugin-core delivery. */
  delivery?: LocalPluginDelivery
}

export interface LocalCanvasBinding {
  sessionId: string
  canvasVersion: string
  opfsPath: string
  contentDigest: string
  updatedAt: string
}

export interface SessionSummary extends LocalConversationSession {
  messageCount: number
  activeRunCount: number
}

/**
 * All local Session/message/run-binding/canvas CRUD. The repository never
 * performs network calls, so Session isolation is testable without a server.
 */
export class SessionRepository {
  public constructor(private readonly db: ClientDatabase) {}

  public async createSession(session: LocalConversationSession): Promise<void> {
    await this.db.put('sessions', session)
  }

  public getSession(sessionId: string): Promise<LocalConversationSession | null> {
    return this.db.get<LocalConversationSession>('sessions', sessionId)
  }

  public async listSessions(): Promise<LocalConversationSession[]> {
    const sessions = await this.db.getAll<LocalConversationSession>('sessions')
    return sessions.sort((a, b) => compareCreatedAt(a, b))
  }

  public async updateSession(
    sessionId: string,
    patch: Partial<Omit<LocalConversationSession, 'sessionId'>>,
  ): Promise<LocalConversationSession> {
    const next = await this.db.update<LocalConversationSession>('sessions', sessionId,
      current => current === null ? null : { ...current, ...patch, sessionId })
    if (next === null) throw new Error('session_not_found')
    return next
  }

  public async applySuggestedTitle(sessionId: string, title: string, updatedAt: string): Promise<boolean> {
    let changed = false
    await this.db.update<LocalConversationSession>('sessions', sessionId, current => {
      if (current === null || current.titleSource !== undefined || !DEFAULT_SESSION_TITLES.has(current.title)) return current
      changed = true
      return { ...current, title, titleSource: 'automatic', updatedAt }
    })
    return changed
  }

  /** Upgrade a generic fallback or the expected first-turn title; manual titles stay authoritative. */
  public async applyTopicTitle(sessionId: string, title: string, updatedAt: string,
    expectedAutomaticTitle?: string): Promise<boolean> {
    let changed = false
    await this.db.update<LocalConversationSession>('sessions', sessionId, current => {
      if (current === null || current.titleSource !== 'automatic'
        || (!GENERIC_IMAGE_TITLES.has(current.title) && current.title !== expectedAutomaticTitle)) return current
      changed = true
      return { ...current, title, titleSource: 'automatic', updatedAt }
    })
    return changed
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const [messages, bindings] = await Promise.all([
      this.listMessages(sessionId),
      this.listRunBindings(sessionId),
    ])
    for (const message of messages) await this.db.delete('messages', message.messageId)
    for (const binding of bindings) {
      await this.db.delete('run_bindings', binding.runId)
    }
    await this.db.delete('canvas_bindings', sessionId)
    await this.db.delete('sessions', sessionId)
  }

  public async appendMessage(message: LocalMessage): Promise<void> {
    await this.db.put('messages', message)
  }

  /**
   * Prevent SSE replay from duplicating chat. eventId is only monotonic within
   * one Server run, so a Session may legitimately contain event 1 from many runs.
   */
  public async findMessageBySourceEvent(
    sessionId: string,
    runId: string,
    sourceEventId: number,
  ): Promise<LocalMessage | null> {
    const messages = await this.listMessages(sessionId)
    return messages.find((message) => message.runId === runId && message.sourceEventId === sourceEventId) ?? null
  }

  public getMessage(messageId: string): Promise<LocalMessage | null> {
    return this.db.get<LocalMessage>('messages', messageId)
  }

  public async listMessages(sessionId: string): Promise<LocalMessage[]> {
    const messages = await this.db.getAllByIndex<LocalMessage>('messages', 'sessionId', sessionId)
    return messages.sort((a, b) => a.sequence - b.sequence || a.messageId.localeCompare(b.messageId))
  }

  public async updateMessage(messageId: string, patch: Partial<Omit<LocalMessage, 'messageId'>>): Promise<void> {
    const current = await this.getMessage(messageId)
    if (current === null) return
    await this.db.put('messages', { ...current, ...patch, messageId })
  }

  public async nextMessageSequence(sessionId: string): Promise<number> {
    const messages = await this.listMessages(sessionId)
    const last = messages[messages.length - 1]
    return last === undefined ? 1 : last.sequence + 1
  }

  public async putRunBinding(binding: LocalRunBinding): Promise<void> {
    await this.db.put('run_bindings', binding)
  }

  public getRunBinding(runId: string): Promise<LocalRunBinding | null> {
    return this.db.get<LocalRunBinding>('run_bindings', runId)
  }

  public async listRunBindings(sessionId: string): Promise<LocalRunBinding[]> {
    const bindings = await this.db.getAllByIndex<LocalRunBinding>('run_bindings', 'sessionId', sessionId)
    return bindings.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Bindings whose run has not reached a terminal phase, across all Sessions. */
  public async listLiveRunBindings(): Promise<LocalRunBinding[]> {
    const bindings = await this.db.getAll<LocalRunBinding>('run_bindings')
    return bindings.filter((binding) => !TERMINAL_BINDING_STATUS.has(binding.status))
  }

  public async updateRunBinding(runId: string, patch: Partial<Omit<LocalRunBinding, 'runId'>>): Promise<void> {
    const current = await this.getRunBinding(runId)
    if (current === null) return
    await this.db.put('run_bindings', { ...current, ...patch, runId })
  }

  public async deleteRunBinding(runId: string): Promise<void> {
    await this.db.delete('run_bindings', runId)
  }

  public putCanvasBinding(binding: LocalCanvasBinding): Promise<void> {
    return this.db.put('canvas_bindings', binding)
  }

  public getCanvasBinding(sessionId: string): Promise<LocalCanvasBinding | null> {
    return this.db.get<LocalCanvasBinding>('canvas_bindings', sessionId)
  }

  public deleteCanvasBinding(sessionId: string): Promise<void> {
    return this.db.delete('canvas_bindings', sessionId)
  }

  public async summaries(): Promise<SessionSummary[]> {
    const sessions = await this.listSessions()
    const summaries: SessionSummary[] = []
    for (const session of sessions) {
      const [messages, bindings] = await Promise.all([
        this.listMessages(session.sessionId),
        this.listRunBindings(session.sessionId),
      ])
      summaries.push({
        ...session,
        messageCount: messages.length,
        activeRunCount: bindings.filter((binding) => !TERMINAL_BINDING_STATUS.has(binding.status)).length,
      })
    }
    return summaries
  }

  /** Wipe every private local record; public PWA caches are not touched (§3.1). */
  public async clearAll(): Promise<void> {
    for (const store of ['messages', 'run_bindings', 'canvas_bindings', 'sessions', 'secrets'] as const) {
      await this.db.clear(store)
    }
  }
}

const TERMINAL_BINDING_STATUS = new Set(['completed', 'failed', 'cancelled', 'deleted'])

/**
 * Session placement is intentionally stable: opening or updating a Session
 * must not move it in the sidebar. `sessionId` makes equal timestamps stable.
 */
function compareCreatedAt(a: LocalConversationSession, b: LocalConversationSession): number {
  return a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId)
}

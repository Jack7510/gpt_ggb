import { reconnectPluginStream } from '../runtime/reconnect-plugin-stream.js'
import { imageProblemFromReport, titleFromFinalReport, titleFromPrompt } from '../sessions/session-title.js'
import { failureMessage } from './failure-message.js'
import { pluginCoreImageSchema, type PluginCoreImage, type PluginCoreBuildFailure, type PluginCoreConstructionRecord, pluginCoreDeliverySchema } from '@ggb-copilot/application/browser'
import type { CanvasViews } from '../geogebra/view-settings.js'
import {
  type PluginCoreDelivery,
  type PluginCoreEvent,
  type PluginCoreUsage,
  type PresentationLocale,
} from '@ggb-copilot/application/browser'
import { ByokController } from '../credentials/byok-controller.js'
import { BrowserCredentialVault } from '../credentials/browser-credential-vault.js'
import type { CanvasSummary, GeogebraAppletPort } from '../geogebra/host.js'
import {
  canvasArtifactPath, deliveryArtifactPath, type ArtifactStore,
} from '../persistence/opfs-artifacts.js'
import type { ClientDatabase } from '../persistence/indexeddb.js'
import { decodeBase64, encodeBase64 } from '../geogebra/snapshot.js'
import {
  SessionRepository, type LocalCanvasBinding, type LocalPluginDelivery,
  type LocalRunBinding,
} from '../sessions/session-repository.js'
import { SessionService } from '../sessions/session-service.js'
import { SessionCoordinator } from '../sessions/session-coordinator.js'
import { defaultSessionTitle, text } from './localization.js'
import type { ProjectedRunState } from '../runtime/run-state.js'
import { createRunCapability, RunTokenVault, type RandomSource } from '../runtime/run-capability.js'
import { PluginCoreRunAdapter } from '../runtime/plugin-core-adapter.js'
import { applyPluginEvent, pluginViewState } from '../runtime/plugin-core-projector.js'

export interface ClientRuntimeOptions {
  baseUrl: string
  fetch: typeof globalThis.fetch
  db: ClientDatabase
  artifacts: ArtifactStore
  /** `null` when the applet document is not mounted yet; canvas actions then wait. */
  applet: GeogebraAppletPort | null
  subtle: SubtleCrypto
  random: RandomSource
  now(): string
  newId(): string
  reload(): void
  createChannel(name: string): import('../sessions/session-coordinator.js').BroadcastChannelLike
  locks: import('../sessions/session-coordinator.js').LockManagerLike
  presentationLocale: PresentationLocale
}

export interface SessionView {
  sessionId: string
  title: string
  messages: Awaited<ReturnType<SessionService['listMessages']>>
  runs: ProjectedRunState[]
  canvas: LocalCanvasBinding | null
  /** Latest completed plugin-core delivery in this Session. */
  delivery: LocalPluginDelivery | null
  constructionReports: Record<string, PluginCoreConstructionRecord>
}

export interface ClientRuntimeNotice {
  sessionId: string
  kind: 'credential_required' | 'error'
  detail: string
}

/** Browser-only selection state for the currently mounted single applet. */
export interface CanvasSelectionChange {
  sessionId: string
  summary: CanvasSummary
}

interface PluginConnection {
  runId: string
  sessionId: string
  runToken: string
  state: ProjectedRunState
  abort: AbortController
}

/**
 * Client composition root (§9). Owns local Sessions and the plugin-core run
 * connection; it never calls a stage endpoint or chooses a model.
 */
export class ClientRuntime {
  private readonly repository: SessionRepository
  private readonly sessions: SessionService
  private readonly coordinator: SessionCoordinator
  private readonly pluginAdapter: PluginCoreRunAdapter
  private readonly vault: RunTokenVault
  private readonly credentialVault: BrowserCredentialVault
  private readonly byok = new ByokController()
  private readonly pluginConnections = new Map<string, PluginConnection>()
  private readonly noticeListeners = new Set<(notice: ClientRuntimeNotice) => void>()
  private readonly changeListeners = new Set<(sessionId: string | null) => void>()
  private readonly selectionListeners = new Set<(change: CanvasSelectionChange) => void>()
  private readonly disposeAppletSelection: (() => void) | null
  private currentSessionId: string | null = null
  /** Serializes the single real applet so an earlier slow restore cannot win a later selection. */
  private canvasSwitch: Promise<void> = Promise.resolve()

  public constructor(private readonly options: ClientRuntimeOptions) {
    this.repository = new SessionRepository(options.db)
    this.pluginAdapter = new PluginCoreRunAdapter({
      baseUrl: options.baseUrl, fetch: options.fetch,
    })
    this.vault = new RunTokenVault(options.db, options.subtle)
    this.credentialVault = new BrowserCredentialVault(options.db, options.subtle, options.random)
    this.coordinator = new SessionCoordinator({
      locks: options.locks,
      createChannel: options.createChannel,
      now: options.now,
    })
    this.sessions = new SessionService({
      repository: this.repository,
      tokens: this.vault,
      runs: {
        stop: async (runId, runToken) => {
          await this.pluginAdapter.stop(runId, runToken)
        },
      },
      now: options.now,
      newId: options.newId,
    })
    this.disposeAppletSelection = options.applet?.onSelection?.(summary => this.publishAppletSelection(summary)) ?? null
  }

  public get presentationLocale(): PresentationLocale { return this.options.presentationLocale }

  /** Restores local state and reconnects every live plugin-core run of this browser. */
  public async init(): Promise<void> {
    try {
      this.byok.set(await this.credentialVault.load())
    } catch {
      // A corrupted browser vault must not block Sessions. Remove only the
      // credential records and ask the user to configure BYOK again.
      await this.credentialVault.clear()
    }
    for (const binding of await this.repository.listLiveRunBindings()) {
      try {
        if (binding.engine === 'plugin_core') await this.connectPluginBinding(binding)
        else await this.repository.updateRunBinding(binding.runId, { status: 'unreachable' })
      } catch {
        await this.repository.updateRunBinding(binding.runId, { status: 'unreachable' })
      }
    }
  }

  public listSessions(): ReturnType<SessionService['listSessions']> {
    return this.sessions.listSessions()
  }

  public async createSession(): Promise<string> {
    const session = await this.sessions.createSession({ title: defaultSessionTitle(this.options.presentationLocale) })
    this.coordinator.publish('session_created', session.sessionId)
    this.changed(session.sessionId)
    return session.sessionId
  }

  public async renameSession(sessionId: string, title: string): Promise<void> {
    await this.sessions.renameSession(sessionId, title)
    this.coordinator.publish('session_updated', sessionId)
    this.changed(sessionId)
  }

  public openSession(sessionId: string): Promise<SessionView> {
    const opened = this.canvasSwitch.then(async () => this.openSessionSerial(sessionId))
    this.canvasSwitch = opened.then(() => undefined, () => undefined)
    return opened
  }

  private async openSessionSerial(sessionId: string): Promise<SessionView> {
    const session = await this.repository.getSession(sessionId)
    if (session === null) throw new Error('session_not_found')
    if (this.currentSessionId !== sessionId) {
      if (this.currentSessionId !== null) await this.persistCanvas(this.currentSessionId)
      await this.restoreCanvas(sessionId)
    }
    this.currentSessionId = sessionId
    await this.refreshAppletSelection(sessionId)
    await this.sessions.touchSession(sessionId)
    const view = await this.view(sessionId)
    this.changed(sessionId)
    return view
  }

  public async view(sessionId: string): Promise<SessionView> {
    const session = await this.repository.getSession(sessionId)
    if (session === null) throw new Error('session_not_found')
    const runs = [...this.pluginConnections.values()]
      .filter(connection => connection.sessionId === sessionId)
      .map(connection => connection.state)
    const bindings = await this.repository.listRunBindings(sessionId)
    const delivery = [...bindings].reverse()
      .find(binding => binding.engine === 'plugin_core' && binding.delivery !== undefined)
      ?.delivery ?? null
    return {
      sessionId,
      title: session.title,
      messages: await this.sessions.listMessages(sessionId),
      runs,
      canvas: await this.sessions.getActiveCanvas(sessionId),
      delivery,
      constructionReports: Object.fromEntries(bindings.flatMap(binding => binding.delivery?.construction
        ? [[binding.runId, binding.delivery.construction]] : [])),
    }
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.canvasSwitch
    const deleted = await this.coordinator.withWriterLock(sessionId, async () => {
      const deletingCurrent = this.currentSessionId === sessionId
      for (const connection of [...this.pluginConnections.values()]) {
        if (connection.sessionId !== sessionId) continue
        connection.abort.abort()
        this.pluginConnections.delete(connection.runId)
      }
      await this.sessions.deleteSession(sessionId)
      await this.options.artifacts.deleteSession(sessionId)
      this.coordinator.publish('session_deleted', sessionId)
      if (deletingCurrent) {
        this.currentSessionId = null
        await this.options.applet?.reset().catch(() => undefined)
      }
      this.changed(this.currentSessionId)
      return true
    })
    if (deleted === null) throw new Error('writer_lock_unavailable')
  }

  public async clearAllLocalData(): Promise<void> {
    for (const connection of this.pluginConnections.values()) connection.abort.abort()
    this.pluginConnections.clear()
    await this.vault.destroy()
    await this.credentialVault.clear()
    await this.sessions.clearAllLocalData()
    await this.options.artifacts.clear()
    this.byok.clear()
  }

  public async setProviderKey(key: string | null): Promise<void> {
    this.byok.set(key)
    if (key === null || key.trim().length === 0) await this.credentialVault.clear()
    else await this.credentialVault.save(key)
  }

  public get providerKeyConfigured(): boolean {
    return this.byok.present
  }

  public async forgetProviderKey(): Promise<void> {
    this.byok.clear()
    await this.credentialVault.clear()
  }

  /** Clears only the active browser canvas; it never creates a Server mutation. */
  public async resetCanvas(sessionId: string): Promise<void> {
    if (this.options.applet === null) throw new Error('geogebra_not_ready')
    await this.options.applet.reset()
    await this.sessions.deleteCanvasBinding(sessionId)
    await this.refreshAppletSelection(sessionId)
    this.changed(sessionId)
  }

  /** Best-effort persistence for page hide; switching sessions remains the durable awaitable path. */
  public async saveCurrentCanvas(): Promise<void> {
    const sessionId = this.currentSessionId
    if (sessionId === null) return
    await this.canvasSwitch
    if (this.currentSessionId === sessionId) await this.persistCanvas(sessionId)
  }

  /** Import a user GGB as this Session's canvas and next plugin-core base. */
  public async importGgb(sessionId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024
      || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      this.notify({ sessionId, kind: 'error', detail: 'ggb_import_invalid' })
      throw new Error('ggb_import_invalid')
    }
    if (this.options.applet === null) throw new Error('applet_unavailable')
    await this.canvasSwitch
    await this.options.applet.ready()
    await this.options.applet.restore(encodeBase64(bytes))
    const snapshot = await this.options.applet.snapshot()
    await this.persistSnapshot(sessionId, snapshot)
    this.changed(sessionId)
  }

  /** Read the latest plugin-core GGB for download from local OPFS. */
  public async downloadDelivery(sessionId: string): Promise<{ base64: string; name: string } | null> {
    const bindings = await this.repository.listRunBindings(sessionId)
    const delivery = [...bindings].reverse()
      .find(binding => binding.engine === 'plugin_core' && binding.delivery !== undefined)
      ?.delivery
    if (delivery === undefined || delivery.ggbOpfsPath.length === 0) return null
    const bytes = await this.options.artifacts.get(delivery.ggbOpfsPath)
    if (bytes === null) return null
    return {
      base64: encodeBase64(bytes),
      name: `ggb-${delivery.runId}.ggb`,
    }
  }

  /** Reflow the isolated GeoGebra document after the surrounding workbench changes size. */
  public async setCanvasViews(views: CanvasViews): Promise<void> {
    if (this.options.applet === null) throw new Error('geogebra_not_ready')
    await this.options.applet.setViews(views)
  }

  public async resizeApplet(width: number, height: number): Promise<void> {
    if (this.options.applet === null) return
    await this.options.applet.resize(width, height)
  }

  /** Subscribe to local selection changes; this data is never persisted or sent to the Server by itself. */
  public onCanvasSelection(listener: (change: CanvasSelectionChange) => void): () => void {
    this.selectionListeners.add(listener)
    return () => this.selectionListeners.delete(listener)
  }

  /** Read the currently mounted applet selection after a Session switch. */
  public async currentCanvasSelection(sessionId: string): Promise<CanvasSummary | null> {
    if (this.currentSessionId !== sessionId || this.options.applet === null) return null
    await this.options.applet.ready()
    return await this.options.applet.context()
  }

  /** Sends one user turn to the plugin-core engine. */
  public async sendMessage(sessionId: string, prompt: string, image?: PluginCoreImage): Promise<string> {
    const session = await this.repository.getSession(sessionId)
    if (session === null) throw new Error('session_not_found')
    if (prompt.trim().length === 0 || prompt.length > 12_000) {
      this.notify({ sessionId, kind: 'error',
        detail: 'plugin_core_prompt_must_be_1_to_12000_characters' })
      throw new Error('plugin_core_prompt_invalid')
    }
    const attachment = image === undefined ? undefined : pluginCoreImageSchema.parse(image)
    const providerKey = this.byok.lease().key
    if (providerKey === null) {
      this.notify({ sessionId, kind: 'credential_required',
        detail: 'provider_key_required' })
      throw new Error('provider_key_required')
    }
    const base = await this.pluginBase(sessionId)
    const capability = createRunCapability(this.options.random)
    const sealed = await this.vault.seal(capability.runToken)
    const userMessage = await this.sessions.appendMessage({
      sessionId, role: 'user', content: prompt, runId: capability.runId,
      deliveryState: 'submitting',
    })
    const firstUser = (await this.sessions.listMessages(sessionId)).find(message => message.role === 'user')
    if (firstUser?.messageId === userMessage.messageId && await this.sessions.applySuggestedTitle(sessionId,
      titleFromPrompt(prompt, attachment !== undefined, this.options.presentationLocale))) {
      this.coordinator.publish('session_updated', sessionId)
      this.changed(sessionId)
    }
    const binding: LocalRunBinding = {
      runId: capability.runId,
      sessionId,
      userMessageId: userMessage.messageId,
      assistantMessageId: null,
      runTokenCiphertext: sealed,
      eventCursor: 0,
      status: 'accepted',
      createdAt: this.options.now(),
      expiresAt: this.options.now(),
      engine: 'plugin_core',
    }
    await this.sessions.bindRun(binding)
    this.coordinator.publish('messages_changed', sessionId)
    try {
      await this.pluginAdapter.createRun({
        runId: capability.runId, prompt, base,
        ...(attachment === undefined ? {} : { image: attachment }),
      }, capability.runToken, providerKey)
      await this.sessions.updateMessage(userMessage.messageId, { deliveryState: 'complete' })
    } catch (error) {
      await this.sessions.updateMessage(userMessage.messageId, { deliveryState: 'failed' })
      await this.repository.deleteRunBinding(capability.runId)
      this.notify({ sessionId, kind: 'error', detail: errorText(error) })
      throw error
    }
    await this.connectPluginBinding(binding)
    return capability.runId
  }

  /** The current applet GGB, or null for an empty canvas. */
  private async pluginBase(sessionId: string): Promise<{ dataBase64: string; name: string } | null> {
    const applet = this.options.applet
    if (applet === null) return null
    await applet.ready()
    const summary = await applet.context()
    if (summary.objects.length === 0) return null
    const snapshot = await applet.snapshot()
    return {
      dataBase64: snapshot.contentBase64,
      name: `session-${sessionId}.ggb`,
    }
  }

  private async connectPluginBinding(binding: LocalRunBinding): Promise<void> {
    const token = await this.vault.reveal(binding.runTokenCiphertext)
    const view = await this.pluginAdapter.getRun(binding.runId, token)
    const controller = new AbortController()
    const connection: PluginConnection = {
      runId: binding.runId,
      sessionId: binding.sessionId,
      runToken: token,
      state: pluginViewState(view),
      abort: controller,
    }
    this.pluginConnections.set(binding.runId, connection)
    this.changed(binding.sessionId)
    if (view.terminal) {
      await this.finishPluginRun(binding, view, controller.signal)
      return
    }
    void this.streamPluginRun(binding, connection, controller.signal)
  }

  private async streamPluginRun(binding: LocalRunBinding,
    connection: PluginConnection, signal: AbortSignal): Promise<void> {
    let finalized = false
    try {
      await reconnectPluginStream(after => this.pluginAdapter.openEventStream(binding.runId, connection.runToken,
        after, {
          onReady: async (ready) => {
            if (signal.aborted || (connection.state.terminal && (!ready.terminal || ready.run.phase !== connection.state.phase)) || ready.run.runId !== binding.runId
              || ready.cursor < connection.state.eventCursor) return
            // The snapshot covers persisted events through ready.cursor; retain that resume point.
            await this.repository.updateRunBinding(binding.runId, {
              eventCursor: Math.max(connection.state.eventCursor, ready.cursor),
            })
            connection.state = pluginViewState(ready.run)
            this.changed(binding.sessionId)
            if (ready.terminal) {
              await this.finishPluginRun(binding, ready.run, signal)
              finalized = true
            }
          },
          onEvent: async (event) => {
            if (signal.aborted || connection.state.terminal || event.runId !== binding.runId
              || event.eventId <= connection.state.eventCursor) return
            connection.state = applyPluginEvent(connection.state, event)
            this.changed(binding.sessionId)
            const terminal = event.payload.type === 'plugin_core.delivery'
              || event.payload.type === 'plugin_core.failed'
              || event.payload.type === 'plugin_core.cancelled'
            if (!terminal) {
              await this.repository.updateRunBinding(binding.runId, {
                status: connection.state.phase,
                eventCursor: event.eventId,
              })
              return
            }
            const view = await this.pluginAdapter.getRun(binding.runId, connection.runToken)
            await this.finishPluginRun(binding, view, signal)
            finalized = true
          },
          onCursor: async () => {
            await this.repository.updateRunBinding(binding.runId, { eventCursor: connection.state.eventCursor })
          },
        }, signal), () => connection.state.eventCursor, () => finalized, signal)
    } catch (error) {
      if (signal.aborted) return
      this.notify({ sessionId: binding.sessionId, kind: 'error', detail: errorText(error) })
      await this.repository.updateRunBinding(binding.runId, { status: 'unreachable' })
    }
  }

  private async finishPluginRun(binding: LocalRunBinding, view: {
    phase: string
    finalResponse: string | null
    failure: { code: string; message: string; details?: PluginCoreBuildFailure | undefined } | null
    delivery: PluginCoreDelivery | null
    usage: PluginCoreUsage | null
    durationMs: number | null
  }, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const current = await this.repository.getRunBinding(binding.runId)
    if (current?.delivery !== undefined) return
    if (view.phase === 'cancelled') {
      await this.repository.updateRunBinding(binding.runId, { status: 'cancelled' })
      this.changed(binding.sessionId)
      return
    }
    if (view.phase === 'failed' || view.failure !== null) {
      await this.repository.updateRunBinding(binding.runId, { status: 'failed' })
      this.notify({ sessionId: binding.sessionId, kind: 'error',
        detail: view.failure === null ? 'plugin_core_failed'
          : failureMessage(view.failure, this.options.presentationLocale) })
      this.changed(binding.sessionId)
      return
    }
    if (view.delivery === null) return
    const acceptedDelivery = pluginCoreDeliverySchema.parse(view.delivery)
    const metadata = view.delivery.artifacts.find(artifact => artifact.kind === 'result_ggb')
    if (metadata === undefined) {
      this.notify({ sessionId: binding.sessionId, kind: 'error',
        detail: 'plugin_core_result_artifact_missing' })
      return
    }
    const runToken = await this.vault.reveal(binding.runTokenCiphertext)
    const bytes = await this.pluginAdapter.getArtifact(
      binding.runId, runToken, metadata.artifactId)
    const ggbOpfsPath = deliveryArtifactPath(binding.sessionId, binding.runId)
    // The canvas snapshot is re-serialized by GeoGebra; keep the delivered
    // bytes separately so download matches the reported size and SHA-256.
    await this.options.artifacts.put(ggbOpfsPath, bytes)
    let snapshot: { canvasVersion: string; contentBase64: string; contentDigest: string } | null = null
    if (this.options.applet !== null) {
      await this.options.applet.ready()
      await this.options.applet.restore(encodeBase64(bytes))
      snapshot = await this.options.applet.snapshot()
      await this.persistSnapshot(binding.sessionId, snapshot)
    }
    const delivery: LocalPluginDelivery = {
      runId: binding.runId,
      sha256: metadata.sha256,
      bytes: metadata.sizeBytes,
      ggbOpfsPath,
      ...(acceptedDelivery.construction ? { construction: acceptedDelivery.construction } : {}),
      verification: view.delivery.verification,
      usage: view.usage === null ? null : {
        calls: view.usage.calls,
        inputTokens: view.usage.inputTokens,
        outputTokens: view.usage.outputTokens,
        complete: view.usage.complete,
      },
      createdAt: this.options.now(),
    }
    let assistantMessageId = current?.assistantMessageId ?? null
    if (assistantMessageId === null) {
      const content = renderFinalReport(
        view.finalResponse ?? '',
        undefined,
        view.durationMs ?? undefined,
        view.usage === null ? undefined : {
          inputTokens: view.usage.inputTokens ?? 0,
          outputTokens: view.usage.outputTokens ?? 0,
          modelCalls: view.usage.calls,
          ...(view.usage.complete ? {} : { unknownUsageCalls: view.usage.calls }),
        },
        this.options.presentationLocale)
      const message = await this.sessions.appendMessage({
        sessionId: binding.sessionId, role: 'final_report', content,
        runId: binding.runId, deliveryState: 'complete', contextKind: 'final_report',
      })
      assistantMessageId = message.messageId
    }
    await this.repository.updateRunBinding(binding.runId, {
      status: 'completed', delivery, assistantMessageId,
    })
    const topic = titleFromFinalReport(view.finalResponse ?? '',
      acceptedDelivery.construction?.text, this.options.presentationLocale)
    const firstUser = (await this.sessions.listMessages(binding.sessionId)).find(message => message.role === 'user')
    const expectedTitle = firstUser?.messageId === binding.userMessageId && imageProblemFromReport(view.finalResponse ?? '')
      ? titleFromPrompt(firstUser.content, true, this.options.presentationLocale) : undefined
    if (topic.length > 0 && await this.sessions.applyTopicTitle(binding.sessionId, topic, expectedTitle)) {
      this.coordinator.publish('session_updated', binding.sessionId)
    }
    this.coordinator.publish('messages_changed', binding.sessionId)
    this.changed(binding.sessionId)
  }

  public async stop(sessionId: string): Promise<void> {
    const plugin = this.pluginConnectionFor(sessionId)
    if (plugin === null) return
    await this.pluginAdapter.stop(plugin.runId, plugin.runToken)
    plugin.state = { ...plugin.state, stopRequested: true }
    this.changed(plugin.sessionId)
  }

  /** True while any reconnected plugin-core run has not reached a terminal event. */
  public async hasUnsettledWork(): Promise<boolean> {
    return [...this.pluginConnections.values()].some(connection => !connection.state.terminal)
  }

  public onNotice(listener: (notice: ClientRuntimeNotice) => void): () => void {    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  /** UI projection invalidation; callers re-read browser-local Session state. */
  public onChange(listener: (sessionId: string | null) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  public dispose(): void {
    for (const connection of this.pluginConnections.values()) connection.abort.abort()
    this.pluginConnections.clear()
    this.disposeAppletSelection?.()
    this.selectionListeners.clear()
    this.coordinator.dispose()
  }

  /** Choose the newest live plugin-core connection for a Session. */
  private pluginConnectionFor(sessionId: string): PluginConnection | null {
    return [...this.pluginConnections.values()]
      .filter(connection => connection.sessionId === sessionId
        && !connection.state.terminal)
      .sort((left, right) => right.state.eventCursor - left.state.eventCursor)[0] ?? null
  }

  private notify(notice: ClientRuntimeNotice): void {
    for (const listener of this.noticeListeners) listener(notice)
  }

  private changed(sessionId: string | null): void {
    for (const listener of this.changeListeners) listener(sessionId)
  }

  private async refreshAppletSelection(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId || this.options.applet === null) return
    await this.options.applet.ready()
    this.publishAppletSelection(await this.options.applet.context())
  }

  private publishAppletSelection(summary: CanvasSummary): void {
    const sessionId = this.currentSessionId
    if (sessionId === null) return
    for (const listener of this.selectionListeners) listener({ sessionId, summary })
  }

  /** Save the visible applet as this Session's local authoritative canvas copy. */
  private async persistCanvas(sessionId: string): Promise<void> {
    const applet = this.options.applet
    if (applet === null) return
    await applet.ready()
    const snapshot = await applet.snapshot()
    await this.persistSnapshot(sessionId, snapshot)
  }

  /** Bind an already-observed applet snapshot to its local Session immediately. */
  private async persistSnapshot(
    sessionId: string,
    snapshot: { canvasVersion: string; contentBase64: string; contentDigest: string },
  ): Promise<void> {
    const opfsPath = canvasArtifactPath(sessionId, snapshot.canvasVersion)
    await this.options.artifacts.put(opfsPath, decodeBase64(snapshot.contentBase64))
    await this.sessions.setActiveCanvas({
      sessionId,
      canvasVersion: snapshot.canvasVersion,
      opfsPath,
      contentDigest: snapshot.contentDigest,
      updatedAt: this.options.now(),
    })
  }

  /** Restore only the selected Session's browser-local canvas; the Server is never consulted. */
  private async restoreCanvas(sessionId: string): Promise<void> {
    const applet = this.options.applet
    if (applet === null) return
    const binding = await this.sessions.getActiveCanvas(sessionId)
    if (binding === null) {
      await applet.reset()
      return
    }
    const bytes = await this.options.artifacts.get(binding.opfsPath)
    if (bytes === null) {
      await applet.reset()
      this.notify({ sessionId, kind: 'error', detail: 'local_canvas_snapshot_missing' })
      return
    }
    try {
      await applet.restore(encodeBase64(bytes))
      const restored = await applet.snapshot()
      if (restored.contentDigest !== binding.contentDigest) throw new Error('local_canvas_digest_mismatch')
    } catch {
      await applet.reset()
      this.notify({ sessionId, kind: 'error', detail: 'local_canvas_restore_failed' })
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected_error'
}

export function renderFinalReport(
  fallback: string,
  presentation: { constructionSteps: string[]; ggbScript: string } | undefined,
  durationMs: number | undefined,
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; unknownUsageCalls?: number | undefined } | undefined,
  locale: PresentationLocale,
): string {
  const statistics = renderRunStatistics(durationMs, usage, locale)
  if (presentation === undefined) return [fallback, ...(statistics.length === 0 ? [] : ['', statistics])].join('\n')
  const steps = presentation.constructionSteps.map((step, index) => `${index + 1}. ${step}`)
  const script = presentation.ggbScript.length === 0 ? text(locale, 'scriptMissing') : `\`\`\`geogebra\n${presentation.ggbScript}\n\`\`\``
  const stepsBody = [`## ${text(locale, 'constructionSteps')}`, '', ...steps].join('\n')
  const hasSteps = /(?:^|\n)(?:#{1,6}\s*)?(?:作图步骤|Construction steps)/iu.test(fallback)
  const body = [hasSteps ? '' : stepsBody, fallback.trim()].filter(Boolean).join('\n\n')
  return [`## ${text(locale, 'constructionComplete')}`, '', body, '', `## ${text(locale, 'ggbScript')}`, '', script, ...(statistics.length === 0 ? [] : ['', statistics])].join('\n')
}

function renderRunStatistics(
  durationMs: number | undefined,
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; unknownUsageCalls?: number | undefined } | undefined,
  locale: PresentationLocale,
): string {
  if (durationMs === undefined && usage === undefined) return ''
  const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  return [
    `## ${text(locale, 'statistics')}`,
    '',
    ...(durationMs === undefined ? [] : [`${text(locale, 'elapsed')}：${formatSeconds(durationMs)} ${text(locale, 'seconds')}`]),
    ...(usage === undefined ? [] : [`${text(locale, (usage.unknownUsageCalls ?? 0) > 0 ? 'knownTokens' : 'tokens')}：${totalTokens.toLocaleString()}（${text(locale, 'input')} ${usage.inputTokens.toLocaleString()}，${text(locale, 'output')} ${usage.outputTokens.toLocaleString()}；${text(locale, 'modelCalls')} ${usage.modelCalls} ${locale === 'zh-CN' ? '次' : ''}${(usage.unknownUsageCalls ?? 0) > 0 ? `；${text(locale, 'unknownUsageCalls')} ${usage.unknownUsageCalls}` : ''}）`]),
  ].join('\n')
}

function formatSeconds(durationMs: number): string {
  return (Math.max(0, durationMs) / 1_000).toFixed(1)
}

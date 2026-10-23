<template>
  <main class="workspace" :class="{ 'sessions-collapsed': !sessionsVisible, 'chat-collapsed': !chatVisible }">
    <aside class="session-sidebar" :aria-label="t('sessions')">
      <header class="session-header"><strong>{{ t('sessions') }}</strong><button type="button" data-test="new-session" @click="createSession">{{ t('newSession') }}</button></header>
      <ul class="sessions" data-test="session-list">
        <li v-for="session in sessions" :key="session.sessionId" :class="{ active: current.sessionId === session.sessionId }">
          <input v-if="editingSessionId === session.sessionId" v-model="editingTitle" class="session-title-editor" aria-label="Session title" @keydown.enter.prevent="saveSessionTitle(session.sessionId)" @keydown.escape="cancelRename" @blur="saveSessionTitle(session.sessionId)">
          <button v-else type="button" class="session-open" :title="session.title" @click="open(session.sessionId)" @dblclick.prevent="beginRename(session.sessionId, session.title)"><span>{{ session.title }}</span><small v-if="session.activeRunCount > 0">{{ t('running') }}</small></button>
          <button type="button" class="session-delete" :aria-label="`${t('deleteSession')} ${session.title}`" :title="`${t('deleteSession')} ${session.title}`" :disabled="deletingSessionId === session.sessionId" @click="deleteSession(session.sessionId)">×</button>
        </li>
      </ul>
    </aside>

    <section class="canvas-panel" :aria-label="t('canvas')"><div class="canvas" ref="canvasHost" data-test="canvas-host"></div><p v-if="view === null" class="canvas-empty">{{ t('createOrSelect') }}</p></section>

    <section v-if="chatVisible" class="chat-panel" :aria-label="t('assistant')">
      <header class="chat-header"><strong>GGB Agent</strong><div class="header-actions"><button type="button" data-test="import-ggb" title="导入 GGB" @click="openGgbPicker">GGB</button><button type="button" data-test="settings" :title="t('providerSettings')" @click="toggleSettings">⚙</button></div><input ref="ggbFileInput" type="file" accept=".ggb,application/octet-stream" hidden data-test="ggb-file" @change="onGgbFile"/></header>
      <section v-if="settingsVisible" class="credential-settings" :aria-label="t('providerSettings')">
        <label>{{ t('apiKey') }}<input v-model="providerKeyDraft" type="password" autocomplete="off" :placeholder="t('savedOnlyHere')" @keydown.enter.prevent="saveProviderKey"></label>
        <div class="settings-actions"><button type="button" :disabled="providerKeyDraft.trim().length === 0" @click="saveProviderKey">{{ t('saveOnDevice') }}</button><button v-if="providerConfigured" type="button" @click="forgetProviderKey">{{ t('forget') }}</button></div>
        <p>{{ t('keySafety') }}</p>
        <a class="key-application-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">{{ t('keyApplication') }}</a>
      </section>
      <ol v-if="view !== null" ref="messagesHost" class="messages" data-test="message-list">
        <li v-for="message in conversationMessages" :key="message.messageId" :class="message.role">
          <div class="message-heading">
            <span class="who">{{ message.role === 'user' ? t('you') : t('agent') }}</span><span
              v-if="message.runId !== null" class="message-run" data-test="run-id"
              :title="message.runId">{{ message.runId }}</span>
            <button type="button" class="message-copy" :class="{ copied: copiedMessageId === message.messageId }" data-test="copy-message"
              :aria-label="t(copiedMessageId === message.messageId ? 'copied' : 'copyMessage')"
              :title="t(copiedMessageId === message.messageId ? 'copied' : 'copyMessage')"
              @click="copyMessage(message.messageId, message.content)">
              <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
            </button>
          </div>
          <div v-if="message.role === 'final_report'" class="formatted-message" v-html="renderSafeMarkdown(message.content)"></div><p v-else>{{ message.content }}</p>
        </li>
        <li v-if="showRunStatus || notice" class="run-feedback" :class="notice?.tone === 'error' ? 'error' : runStatus.tone" aria-live="polite">
          <template v-if="showRunStatus">
            <div class="run-status" :class="runStatus.tone"><span></span>{{ runStatus.label }}</div>
            <p class="run-status-detail">{{ runStatus.detail }}</p>
          </template>
          <p v-if="notice" class="notice" :class="notice.tone" data-test="notice" :role="notice.tone === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
        </li>
        <li v-if="view?.delivery" class="delivery-card" data-test="plugin-delivery" :data-run-id="view.delivery.runId">
          <div class="message-heading"><span class="who">GGB</span><span class="message-run">{{ view.delivery.sha256.slice(0, 12) }}</span></div>
          <p>{{ view.delivery.bytes }} bytes · {{ view.delivery.usage === null ? 'usage unknown' : `${view.delivery.usage.calls} calls / ${view.delivery.usage.inputTokens ?? '?'} in / ${view.delivery.usage.outputTokens ?? '?'} out` }}</p>
          <button type="button" data-test="download-ggb" @click="downloadDelivery">下载 GGB</button>
          <span class="hint">继续输入修改指令时，将以当前画布为基线。</span>
        </li>
      </ol>
      <div v-else class="messages empty-chat" data-test="chat-loading">{{ openingSession ? t('loadingConversation') : t('selectConversation') }}</div>
      <footer v-if="view !== null" class="composer"><p v-if="selectedPrefix" class="composer-selection" data-test="selection-prefix">{{ selectedPrefix }},</p><div class="composer-image"><button type="button" data-test="attach-image" :disabled="sending || showStop" @click="openImagePicker">{{ t('attachImage') }}</button><input ref="imageFileInput" type="file" accept="image/png,image/jpeg" hidden data-test="image-file" @change="onImageFile"><button v-if="preparingImage" type="button" data-test="cancel-image-read" @click="current.sessionId !== null && images.remove(current.sessionId)">{{ t('imageReading') }} ×</button><div v-if="pendingImage" class="composer-image-preview" data-test="image-preview"><img :src="pendingImage.previewUrl" :alt="pendingImage.name"><span>{{ pendingImage.name }}</span><button type="button" data-test="remove-image" :aria-label="t('removeImage')" :disabled="sending || showStop" @click="current.sessionId !== null && images.remove(current.sessionId)">×</button></div></div><textarea v-model="prompt" rows="3" :placeholder="t('placeholder')" data-test="prompt-input" :disabled="sending || showStop" @paste="onComposerPaste" @keydown.enter.exact.prevent="send"></textarea><button type="button" class="send-button" :class="{ stopping: showStop }" data-test="send" :aria-label="showStop ? t(stopRequested ? 'stopping' : 'stop') : t('send')" :title="showStop ? t(stopRequested ? 'stopping' : 'stop') : t('send')" :disabled="showStop ? stopRequested : sending || !canSend" @click="composerAction"><span aria-hidden="true">{{ showStop ? '■' : '↑' }}</span></button></footer>
    </section>

    <nav class="tool-rail" :aria-label="t('assistant')">
      <button type="button" :class="{ active: sessionsVisible }" :title="t('toolSessions')" @click="toggleSessions">☰<span>{{ t('toolSessions') }}</span></button>
      <button type="button" :class="{ active: chatVisible }" :title="t('toolAssistant')" @click="toggleChat">✦<span>{{ t('toolAssistant') }}</span></button>
      <button type="button" data-test="views-graphics" :aria-pressed="!canvasViews.algebra && !canvasViews.cas" :class="{ active: !canvasViews.algebra && !canvasViews.cas }" :disabled="changingViews" @click="changeCanvasViews({ algebra: false, cas: false })">□<span>{{ t('onlyCanvas') }}</span></button>
      <button type="button" data-test="views-algebra" :aria-pressed="canvasViews.algebra" :class="{ active: canvasViews.algebra }" :disabled="changingViews" @click="changeCanvasViews({ ...canvasViews, algebra: !canvasViews.algebra })">ƒ<span>{{ t('algebraView') }}</span></button>
      <button type="button" data-test="views-cas" :aria-pressed="canvasViews.cas" :class="{ active: canvasViews.cas }" :disabled="changingViews" @click="changeCanvasViews({ ...canvasViews, cas: !canvasViews.cas })">CAS<span>{{ t('casView') }}</span></button>
      <button type="button" :class="{ active: settingsVisible }" :title="t('settings')" @click="toggleSettings">⚙<span>{{ t('settings') }}</span></button>
      <button type="button" class="about-trigger" data-test="about-trigger" :class="{ active: aboutOpen }" :title="t('about')" @click="openAbout">ⓘ<span>{{ t('about') }}</span></button>
    </nav>
    <dialog ref="aboutDialog" class="about-dialog" :aria-label="t('about')" @close="aboutOpen = false">
      <header><h2>{{ t('about') }}</h2><form method="dialog"><button type="submit" :aria-label="t('close')">×</button></form></header>
      <p>© 2026 {{ t('copyrightHolder') }}</p>
      <p><strong>{{ t('authorsLabel') }}</strong> {{ t('authors') }}</p>
      <p>{{ t('licenseNotice') }}</p>
      <p><strong>{{ t('email') }}:</strong> <a href="mailto:ggb-app@qq.com">ggb-app@qq.com</a></p>
      <dl>
        <div><dt>{{ t('version') }}</dt><dd>{{ appVersion }}</dd></div>
        <div><dt>{{ t('buildDate') }}</dt><dd>{{ buildDate }}</dd></div>
      </dl>
    </dialog>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue'
import type { ClientRuntime, ClientRuntimeNotice, SessionView } from './runtime.js'
import { readCanvasViews, saveCanvasViews, type CanvasViews } from '../geogebra/view-settings.js'
import type { CanvasSummary } from '../geogebra/host.js'
import { renderSafeMarkdown } from './safe-markdown.js'
import 'katex/dist/katex.min.css'
import { SessionSelection } from './session-selection.js'
import { credentialRequiredNotice, describeRunStatus } from './run-status.js'
import { text } from './localization.js'
import { ComposerImages, clipboardImage } from './composer-images.js'
import { copyMessageContent } from './copy-message.js'

declare const GGB_CLIENT_VERSION: string
declare const GGB_CLIENT_BUILD_TIMESTAMP: string

interface Props { runtime: ClientRuntime; appletElement: HTMLElement; disposeRuntimeOnUnmount?: boolean }
const props = defineProps<Props>()
const sessions: Ref<Awaited<ReturnType<ClientRuntime['listSessions']>>> = ref([])
const view: Ref<SessionView | null> = ref(null)
const current = reactive<{ sessionId: string | null }>({ sessionId: null })
const prompt = ref('')
const images = reactive(new ComposerImages())
const imageFileInput = ref<HTMLInputElement | null>(null)
let imagePickerSessionId: string | null = null
const preparingImage = computed(() => current.sessionId !== null && images.loading.has(current.sessionId))
const pendingImage = computed(() => current.sessionId === null ? undefined : images.entries.get(current.sessionId))
const ggbFileInput = ref<HTMLInputElement | null>(null)
const notice = ref<{ tone: 'info' | 'error'; text: string } | null>(null)
const copiedMessageId = ref<string | null>(null)
const sending = ref(false)
const stopSubmitting = ref(false)
const providerKeyDraft = ref('')
const providerConfigured = ref(false)
const settingsVisible = ref(false)
const sessionsVisible = ref(true)
const chatVisible = ref(true)
const canvasViews = ref(readCanvasViews())
const changingViews = ref(false)
const editingSessionId = ref<string | null>(null)
const deletingSessionId = ref<string | null>(null)
const editingTitle = ref('')
const canvasHost = ref<HTMLElement | null>(null)
const messagesHost = ref<HTMLOListElement | null>(null)
const aboutDialog = ref<HTMLDialogElement | null>(null)
const aboutOpen = ref(false)
const openingSession = ref(false)
const selectedCanvas = ref<CanvasSummary | null>(null)
const sessionSelection = new SessionSelection()
let disposeNotice: (() => void) | null = null
let disposeChange: (() => void) | null = null
let disposeSelection: (() => void) | null = null
let canvasObserver: ResizeObserver | null = null
let resizeFrame: number | null = null
let statusClock: ReturnType<typeof globalThis.setInterval> | null = null
let copyFeedbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null
const statusNowMs = ref(Date.now())
const locale = props.runtime.presentationLocale
const t = (key: Parameters<typeof text>[1]): string => text(locale, key)
const appVersion = GGB_CLIENT_VERSION
const buildDate = `${GGB_CLIENT_BUILD_TIMESTAMP.slice(0, 16).replace('T', ' ')} UTC`
const saveCanvasOnPageHide = (): void => { void props.runtime.saveCurrentCanvas().catch(() => undefined) }

function openAbout(): void {
  aboutDialog.value?.showModal()
  aboutOpen.value = true
}

const latestRun = computed(() => {
  const live = [...(view.value?.runs ?? [])].reverse().find((entry) => !entry.terminal)
  return live ?? view.value?.runs[view.value.runs.length - 1]
})
const runStatus = computed(() => describeRunStatus(latestRun.value, providerConfigured.value, statusNowMs.value, locale))
const showRunStatus = computed(() => latestRun.value !== undefined && !latestRun.value.terminal)
const conversationMessages = computed(() => view.value?.messages ?? [])
const selectedPrefix = computed(() => {
  const canvas = selectedCanvas.value
  if (canvas === null) return ''
  const objects = new Map(canvas.objects.map((object) => [object.label, object]))
  return canvas.selectedLabels.slice(0, 3).map((label) => {
    const object = objects.get(label)
    const kind = object?.kind.trim().toLowerCase() || 'object'
    return `${kind}(${object?.caption ?? label})`
  }).join(', ')
})
/** A clarification reply remains a send action; all other live phases show Stop. */
const showStop = computed(() => latestRun.value !== undefined && !latestRun.value.terminal)
const stopRequested = computed(() => stopSubmitting.value || latestRun.value?.stopRequested === true)
const canSend = computed(() => !preparingImage.value && (prompt.value.trim().length > 0 || pendingImage.value !== undefined))
watch(notice, () => { void scrollChatToEnd() })

onMounted(async () => {
  canvasHost.value?.appendChild(props.appletElement)
  if (typeof ResizeObserver !== 'undefined' && canvasHost.value !== null) {
    canvasObserver = new ResizeObserver(() => scheduleAppletResize())
    canvasObserver.observe(canvasHost.value)
  }
  globalThis.addEventListener('pagehide', saveCanvasOnPageHide)
  statusClock = globalThis.setInterval(() => { statusNowMs.value = Date.now() }, 1_000)
  scheduleAppletResize()
  disposeNotice = props.runtime.onNotice((entry) => {
    if (entry.sessionId === current.sessionId) notice.value = noticeFrom(entry)
  })
  disposeChange = props.runtime.onChange((sessionId) => { void refreshFromRuntime(sessionId) })
  disposeSelection = props.runtime.onCanvasSelection((change) => {
    if (change.sessionId === current.sessionId) selectedCanvas.value = change.summary
  })
  providerConfigured.value = props.runtime.providerKeyConfigured
  await refreshSessions()
  if (sessions.value.length > 0) await open(sessions.value[0]!.sessionId)
})
onBeforeUnmount(() => { images.dispose(); disposeNotice?.(); disposeChange?.(); disposeSelection?.(); canvasObserver?.disconnect(); globalThis.removeEventListener('pagehide', saveCanvasOnPageHide); if (statusClock !== null) globalThis.clearInterval(statusClock); if (copyFeedbackTimer !== null) globalThis.clearTimeout(copyFeedbackTimer); if (resizeFrame !== null) cancelAnimationFrame(resizeFrame); props.appletElement.remove(); if (props.disposeRuntimeOnUnmount !== false) props.runtime.dispose() })

async function changeCanvasViews(views: CanvasViews): Promise<void> {
  changingViews.value = true
  try {
    await props.runtime.setCanvasViews(views)
    canvasViews.value = views
    saveCanvasViews(views)
  } catch {
    notice.value = { tone: 'error', text: t('viewChangeFailed') }
  } finally { changingViews.value = false }
}

async function copyMessage(messageId: string, content: string): Promise<void> {
  try {
    await copyMessageContent(content, (value) => navigator.clipboard.writeText(value))
    copiedMessageId.value = messageId
    if (copyFeedbackTimer !== null) globalThis.clearTimeout(copyFeedbackTimer)
    copyFeedbackTimer = globalThis.setTimeout(() => { copiedMessageId.value = null; copyFeedbackTimer = null }, 2_000)
  } catch {
    notice.value = { tone: 'error', text: t('copyFailed') }
  }
}

async function refreshSessions(): Promise<void> { sessions.value = await props.runtime.listSessions() }

function openGgbPicker(): void { ggbFileInput.value?.click() }

async function onGgbFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const sessionId = view.value?.sessionId
  if (file === undefined || sessionId === undefined) return
  try {
    await props.runtime.importGgb(sessionId, new Uint8Array(await file.arrayBuffer()))
    await refreshFromRuntime(sessionId)
  } catch {
    notice.value = { tone: 'error', text: '无法导入该 GGB 文件。' }
  }
}

async function downloadDelivery(): Promise<void> {
  const sessionId = view.value?.sessionId
  if (sessionId === undefined) return
  const file = await props.runtime.downloadDelivery(sessionId)
  if (file === null) {
    notice.value = { tone: 'error', text: '本地交付文件不可用。' }
    return
  }
  const binary = atob(file.base64)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
async function refreshFromRuntime(sessionId: string | null): Promise<void> {
  await refreshSessions()
  if (sessionId === null || current.sessionId !== sessionId) return
  const refreshed = await props.runtime.view(sessionId)
  if (current.sessionId !== sessionId) return
  view.value = refreshed
  await scrollChatToEnd()
}
async function createSession(): Promise<void> { const sessionId = await props.runtime.createSession(); await refreshSessions(); await open(sessionId) }
async function open(sessionId: string): Promise<void> {
  const request = sessionSelection.begin()
  const previousSessionId = current.sessionId
  current.sessionId = sessionId
  notice.value = null
  selectedCanvas.value = null
  openingSession.value = true
  view.value = null
  try {
    const opened = await props.runtime.openSession(sessionId)
    if (!sessionSelection.isCurrent(request)) return
    view.value = opened
    selectedCanvas.value = await props.runtime.currentCanvasSelection(sessionId)
    if (!sessionSelection.isCurrent(request)) return
    await scrollChatToEnd()
  } catch (error) {
    if (!sessionSelection.isCurrent(request)) return
    current.sessionId = previousSessionId
    view.value = previousSessionId === null ? null : await props.runtime.view(previousSessionId).catch(() => null)
    selectedCanvas.value = previousSessionId === null ? null : await props.runtime.currentCanvasSelection(previousSessionId).catch(() => null)
    notice.value = {
      tone: 'error',
      text: error instanceof Error && error.message === 'pending_canvas_transaction'
        ? t('pendingCanvasTransaction') : t('sessionOpenFailed'),
    }
  } finally {
    if (sessionSelection.isCurrent(request)) openingSession.value = false
  }
}
function beginRename(sessionId: string, title: string): void { editingSessionId.value = sessionId; editingTitle.value = title }
function cancelRename(): void { editingSessionId.value = null; editingTitle.value = '' }
function toggleSettings(): void { chatVisible.value = true; settingsVisible.value = !settingsVisible.value; scheduleAppletResize() }
function toggleSessions(): void { sessionsVisible.value = !sessionsVisible.value; scheduleAppletResize() }
function toggleChat(): void { chatVisible.value = !chatVisible.value; scheduleAppletResize() }
async function saveSessionTitle(sessionId: string): Promise<void> { const title = editingTitle.value.trim(); if (editingSessionId.value !== sessionId) return; cancelRename(); if (title.length === 0) return; await props.runtime.renameSession(sessionId, title); await refreshSessions(); if (current.sessionId === sessionId) view.value = await props.runtime.view(sessionId) }
async function deleteSession(sessionId: string): Promise<void> {
  const target = sessions.value.find((entry) => entry.sessionId === sessionId)
  if (target === undefined || deletingSessionId.value !== null) return
  const confirmation = target.activeRunCount > 0 ? t('deleteRunningConfirm') : t('deleteConfirm')
  if (!globalThis.confirm(`${confirmation} “${target.title}”`)) return
  deletingSessionId.value = sessionId
  try {
    await props.runtime.deleteSession(sessionId)
    images.remove(sessionId)
    if (current.sessionId === sessionId) {
      sessionSelection.invalidate()
      current.sessionId = null
      view.value = null
      notice.value = null
    }
    await refreshSessions()
    if (current.sessionId === null && sessions.value.length > 0) await open(sessions.value[0]!.sessionId)
  } catch (error) {
    notice.value = { tone: 'error', text: error instanceof Error && error.message === 'writer_lock_unavailable'
      ? t('deleteWhileWriting') : t('deleteFailed') }
    await refreshSessions().catch(() => undefined)
    if (current.sessionId === sessionId && !sessions.value.some((session) => session.sessionId === sessionId)) {
      sessionSelection.invalidate()
      current.sessionId = null
      view.value = null
      if (sessions.value.length > 0) await open(sessions.value[0]!.sessionId)
    }
  } finally {
    deletingSessionId.value = null
  }
}
async function saveProviderKey(): Promise<void> {
  const value = providerKeyDraft.value.trim()
  if (value.length === 0) return
  try {
    await props.runtime.setProviderKey(value)
    providerKeyDraft.value = ''
    providerConfigured.value = true
    notice.value = { tone: 'info', text: t('keySaved') }
  } catch (error) {
    notice.value = { tone: 'error', text: error instanceof Error ? error.message : 'provider_key_save_failed' }
  }
}
async function forgetProviderKey(): Promise<void> { await props.runtime.forgetProviderKey(); providerKeyDraft.value = ''; providerConfigured.value = false; notice.value = { tone: 'info', text: t('keyForgotten') } }
async function composerAction(): Promise<void> { if (showStop.value) await stopCurrentRun(); else await send() }
async function stopCurrentRun(): Promise<void> {
  if (current.sessionId === null || stopRequested.value) return
  stopSubmitting.value = true
  notice.value = null
  try {
    await props.runtime.stop(current.sessionId)
    view.value = await props.runtime.view(current.sessionId)
  } catch (error) {
    notice.value = { tone: 'error', text: error instanceof Error ? error.message : 'stop_failed' }
  } finally {
    stopSubmitting.value = false
  }
}
async function send(): Promise<void> {
  if (showStop.value || preparingImage.value) return
  const image = pendingImage.value
  const text = prompt.value.trim() || (image === undefined ? '' : t('imageOnlyPrompt'))
  const sessionId = current.sessionId
  if (text.length === 0 || sessionId === null) return
  sending.value = true
  notice.value = null
  try {
    await props.runtime.sendMessage(sessionId, text, image === undefined ? undefined
      : { mediaType: image.mediaType, dataBase64: image.dataBase64 })
    if (image !== undefined) images.remove(sessionId, image)
    if (current.sessionId === sessionId) {
      prompt.value = ''
      view.value = await props.runtime.view(sessionId)
    }
  } catch (error) { notice.value = { tone: 'error', text: error instanceof Error ? error.message : 'send_failed' } } finally { sending.value = false }
}

function openImagePicker(): void {
  imagePickerSessionId = current.sessionId
  imageFileInput.value?.click()
}
async function selectImage(sessionId: string, file: File): Promise<void> {
  if (!sessions.value.some(session => session.sessionId === sessionId)) return
  try { await images.select(sessionId, file) }
  catch { if (current.sessionId === sessionId) notice.value = { tone: 'error', text: t('imageInvalid') } }
}
function onImageFile(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const sessionId = imagePickerSessionId
  imagePickerSessionId = null
  if (file !== undefined && sessionId !== null && !sending.value && !showStop.value) void selectImage(sessionId, file)
}
function onComposerPaste(event: ClipboardEvent): void {
  if (event.clipboardData === null || current.sessionId === null || sending.value || showStop.value) return
  try {
    const file = clipboardImage(event.clipboardData)
    if (file === null) return
    event.preventDefault()
    void selectImage(current.sessionId, file)
  } catch {
    event.preventDefault()
    notice.value = { tone: 'error', text: t('imageInvalid') }
  }
}

async function scrollChatToEnd(): Promise<void> {
  await nextTick()
  const messages = messagesHost.value
  if (messages !== null) messages.scrollTop = messages.scrollHeight
}

function scheduleAppletResize(): void {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    const host = canvasHost.value
    if (host === null) return
    void props.runtime.resizeApplet(host.clientWidth, host.clientHeight).catch(() => undefined)
  })
}

function noticeFrom(entry: ClientRuntimeNotice): { tone: 'info' | 'error'; text: string } {
  if (entry.kind === 'error') return { tone: 'error', text: `${t('runError')}: ${entry.detail}` }
  if (entry.kind === 'credential_required') return { tone: 'info', text: credentialRequiredNotice(providerConfigured.value, locale) }
  return { tone: 'info', text: entry.detail }
}
</script>

<style>
.composer-image { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.composer-image-preview { display: flex; min-width: 0; gap: 6px; align-items: center; }
.composer-image-preview img { width: 48px; height: 48px; object-fit: contain; }
.composer-image-preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

:root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1f2937; background: #f8fafc; } body { margin: 0; } button, input, textarea { font: inherit; } button { cursor: pointer; }
.workspace { --rail-width: 64px; box-sizing: border-box; display: grid; grid-template-columns: 260px minmax(0, 1fr) minmax(340px, 420px); height: 100vh; padding-right: var(--rail-width); overflow: hidden; background: #fff; }.workspace.sessions-collapsed { grid-template-columns: 0 minmax(0, 1fr) minmax(340px, 420px); }.workspace.chat-collapsed { grid-template-columns: 260px minmax(0, 1fr) 0; }.workspace.sessions-collapsed.chat-collapsed { grid-template-columns: 0 minmax(0, 1fr) 0; }
.session-sidebar { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid #e2e8f0; background: #f8fafc; overflow: hidden; }.sessions-collapsed .session-sidebar, .chat-collapsed .chat-panel { visibility: hidden; }.session-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 14px; border-bottom: 1px solid #e2e8f0; }.session-header button { color: #2563eb; background: transparent; border: 0; font-size: 13px; }.sessions { list-style: none; margin: 0; padding: 10px 8px; overflow-y: auto; display: grid; gap: 3px; }.sessions li { display: grid; grid-template-columns: minmax(0, 1fr) 26px; align-items: center; border-radius: 7px; }.sessions li.active { background: #dbeafe; }.session-open { min-width: 0; border: 0; background: transparent; padding: 9px 8px; text-align: left; overflow: hidden; }.session-open span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.session-open small { color: #2563eb; font-size: 10px; }.session-delete { visibility: visible; border: 0; background: transparent; color: #64748b; font-size: 18px; }.session-delete:hover, .session-delete:focus-visible { color: #b91c1c; }.session-title-editor { min-width: 0; margin: 4px; padding: 5px; border: 1px solid #60a5fa; border-radius: 4px; }
.canvas-panel { min-width: 0; min-height: 0; position: relative; background: #fff; }.canvas, .canvas iframe { width: 100%; height: 100%; border: 0; display: block; }.canvas-empty { position: absolute; inset: 50% auto auto 50%; transform: translate(-50%, -50%); color: #64748b; }.chat-panel { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid #e2e8f0; background: #fff; }.chat-header { padding: 14px 16px; display: flex; justify-content: space-between; align-items: start; border-bottom: 1px solid #e2e8f0; }.chat-header p { margin: 3px 0 0; font-size: 12px; color: #64748b; }.chat-header button { border: 0; background: transparent; font-size: 18px; }.run-status { display: flex; align-items: center; gap: 6px; font-weight: 650; }.run-status span { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }.run-status.ready { color: #2563eb; }.run-status.working { color: #7c3aed; }.run-status.waiting { color: #a16207; }.run-status.success { color: #15803d; }.run-status.error { color: #b91c1c; }.run-status-detail { max-width: 300px; }.credential-settings { padding: 12px 16px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }.credential-settings label { display: grid; gap: 5px; font-size: 12px; font-weight: 600; }.credential-settings input { padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; }.credential-settings p { color: #64748b; font-size: 11px; line-height: 1.4; margin: 8px 0 0; }.key-application-link { display: inline-block; margin-top: 8px; color: #1d4ed8; font-size: 12px; }.settings-actions { display: flex; gap: 8px; margin-top: 8px; }.settings-actions button { border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; padding: 5px 8px; border-radius: 5px; font-size: 12px; }.notice { margin: 0; padding: 8px 14px; background: #eff6ff; color: #1d4ed8; font-size: 12px; }.notice.error { background: #fef2f2; color: #b91c1c; }.messages { list-style: none; margin: 0; padding: 16px; overflow-y: auto; display: grid; align-content: start; gap: 14px; }.messages > li { display: grid; gap: 4px; }.messages > li.user { justify-items: end; }.who { color: #64748b; font-size: 11px; font-weight: 700; }.messages p { max-width: 92%; margin: 0; padding: 9px 11px; border-radius: 9px; background: #f1f5f9; white-space: pre-wrap; line-height: 1.45; font-size: 14px; }.messages .user p { background: #dbeafe; }.messages .final_report pre { margin: 8px 0 0; padding: 10px; overflow-x: auto; border-radius: 6px; background: #172033; color: #e2e8f0; font-size: 12px; }.messages .final_report { padding: 12px; border: 1px solid #bbf7d0; border-radius: 8px; background: #f0fdf4; }.messages .final_report h3 { margin: 8px 0; font-size: 14px; }.messages .final_report p { max-width: none; padding: 0; background: transparent; }.messages .final_report ol, .messages .final_report ul { margin: 6px 0; padding-left: 22px; }.empty-chat { padding: 20px; color: #64748b; }.composer { position: relative; padding: 12px; border-top: 1px solid #e2e8f0; }.composer textarea { box-sizing: border-box; width: 100%; min-height: 88px; resize: none; padding: 9px 50px 9px 9px; border: 1px solid #cbd5e1; border-radius: 10px; }.send-button { position: absolute; right: 20px; bottom: 20px; display: grid; width: 30px; height: 30px; place-items: center; padding: 0; border: 0; border-radius: 50%; background: #2563eb; color: #fff; font-size: 20px; font-weight: 600; line-height: 1; }.send-button span { transform: translateY(-1px); }.send-button:not(:disabled):hover { background: #1d4ed8; }.send-button:disabled { background: #cbd5e1; color: #f8fafc; cursor: default; }.tool-rail { box-sizing: border-box; position: fixed; z-index: 10; top: 0; right: 0; bottom: 0; width: var(--rail-width); display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 6px; border-left: 1px solid #e2e8f0; background: #f8fafc; }.tool-rail button { width: 52px; display: grid; gap: 2px; justify-items: center; padding: 8px 2px; border: 0; border-radius: 7px; background: transparent; color: #475569; font-size: 17px; }.tool-rail button span { font-size: 10px; }.tool-rail button:hover, .tool-rail button.active { color: #2563eb; background: #dbeafe; }.tool-rail button:disabled { opacity: .4; cursor: default; }.tool-rail { box-sizing: border-box; position: fixed; z-index: 10; top: 0; right: 0; bottom: 0; width: var(--rail-width); display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 6px; border-left: 1px solid #e2e8f0; background: #f8fafc; }.tool-rail button { width: 52px; display: grid; gap: 2px; justify-items: center; padding: 8px 2px; border: 0; border-radius: 7px; background: transparent; color: #475569; font-size: 17px; }.tool-rail button span { font-size: 10px; }.tool-rail button:hover, .tool-rail button.active { color: #2563eb; background: #dbeafe; }.tool-rail button:disabled { opacity: .4; cursor: default; }
.composer-selection { margin: 0 0 6px; overflow: hidden; color: #4f46e5; font: 600 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
.messages .final_report ol { list-style: decimal outside; }
.messages .final_report ul { list-style: disc outside; }
.messages .formatted-message { min-width: 0; overflow-wrap: anywhere; }
.messages .formatted-message .katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
.messages .formatted-message li > p { margin: 0 0 8px; }
.messages > li .message-heading { width: 100%; display: flex; align-items: center; gap: 8px; justify-content: space-between; } .message-run { margin-right: auto; color: #94a3b8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 1.3; overflow-wrap: anywhere; user-select: all; }
.messages > li.user .message-heading { justify-content: flex-end; gap: 8px; }
.message-copy { display: grid; width: 24px; height: 24px; place-items: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #64748b; }
.message-copy:hover, .message-copy:focus-visible { background: #e2e8f0; color: #1d4ed8; }
.message-copy.copied { color: #15803d; }
.about-dialog { box-sizing: border-box; width: min(430px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 20px 24px; border: 1px solid #cbd5e1; border-radius: 12px; color: #1f2937; box-shadow: 0 16px 48px #0f172a33; }
.about-dialog::backdrop { background: #0f172a80; }
.about-dialog header { display: flex; align-items: center; justify-content: space-between; }
.about-dialog h2 { margin: 0; font-size: 18px; }
.about-dialog header button { border: 0; background: transparent; color: #64748b; font-size: 24px; }
.about-dialog p { line-height: 1.5; }
.about-dialog dl { margin: 18px 0 0; border-top: 1px solid #e2e8f0; }
.about-dialog dl div { display: flex; justify-content: space-between; gap: 12px; padding-top: 10px; }
.about-dialog dt { color: #64748b; }
.about-dialog dd { margin: 0; text-align: right; }
.messages > li.run-feedback { gap: 5px; padding: 10px 12px; border-left: 3px solid #94a3b8; border-radius: 6px; background: #f8fafc; }
.messages > li.run-feedback.working { border-color: #8b5cf6; background: #f5f3ff; }
.messages > li.run-feedback.waiting { border-color: #d97706; background: #fffbeb; }
.messages > li.run-feedback.error { border-color: #dc2626; background: #fef2f2; }
.messages .run-feedback p { max-width: none; padding: 0; background: transparent; }
.messages .run-feedback .run-status-detail { color: #475569; font-size: 12px; }
.messages .run-feedback .notice { margin-top: 4px; color: #1d4ed8; font-size: 12px; }
.messages .run-feedback .notice.error { color: #b91c1c; }
@media (max-width: 1100px) { .workspace { --rail-width: 58px; grid-template-columns: 220px minmax(0, 1fr) 340px; }.workspace.sessions-collapsed { grid-template-columns: 0 minmax(0, 1fr) 340px; }.workspace.chat-collapsed { grid-template-columns: 220px minmax(0, 1fr) 0; }.workspace.sessions-collapsed.chat-collapsed { grid-template-columns: 0 minmax(0, 1fr) 0; }.tool-rail button { width: 46px; } }
.header-actions { display: flex; align-items: center; gap: 4px; }
.header-actions button[data-test="import-ggb"] { padding: 2px 6px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 11px; font-weight: 700; color: #475569; }
.messages > li.delivery-card { gap: 6px; padding: 12px; border: 1px solid #bbf7d0; border-radius: 8px; background: #f0fdf4; }
.messages .delivery-card p { max-width: none; padding: 0; background: transparent; color: #475569; font-size: 12px; }
.messages .delivery-card button { justify-self: start; padding: 6px 10px; border: 1px solid #15803d; border-radius: 6px; background: #dcfce7; color: #166534; font-size: 12px; font-weight: 650; }
.messages .delivery-card .hint { color: #64748b; font-size: 11px; }
</style>

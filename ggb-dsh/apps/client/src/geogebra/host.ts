import type { RestrictedGeoGebraApiV1 } from '@ggb-copilot/geometry-geogebra/renderer'
import { applyCanvasViews, parseCanvasViews, readCanvasViews, type CanvasViews } from './view-settings.js'
import { digestCanonicalXml } from './snapshot.js'

export const APPLET_REQUEST_CHANNEL = 'ggb-client'
export const APPLET_RESPONSE_CHANNEL = 'ggb-applet'

export type AppletOperation =
  | 'ready'
  | 'currentVersion'
  | 'context'
  | 'snapshot'
  | 'restore'
  | 'reset'
  | 'setSpace'
  | 'setViews'
  | 'resize'

export interface AppletRequestMessage {
  channel: typeof APPLET_REQUEST_CHANNEL
  id: number
  op: AppletOperation
  payload?: unknown
}

export type AppletResponseMessage =
  | { channel: typeof APPLET_RESPONSE_CHANNEL; id: number; ok: true; result: unknown }
  | { channel: typeof APPLET_RESPONSE_CHANNEL; id: number; ok: false; error: string }
  | { channel: typeof APPLET_RESPONSE_CHANNEL; event: 'progress'; payload: unknown }
  | { channel: typeof APPLET_RESPONSE_CHANNEL; event: 'selection'; payload: CanvasSummary }
  | { channel: typeof APPLET_RESPONSE_CHANNEL; event: 'ready' }

export interface CanvasSummary {
  objects: readonly { label: string; caption?: string; kind: string; definition: string }[]
  objectsTruncated?: boolean
  selectedLabels: readonly string[]
}

export interface CanvasSnapshot {
  contentBase64: string
  contentDigest: string
  canvasVersion: string
}

/** Narrow surface the Client needs from whichever applet document is in use. */
export interface GeogebraAppletPort {
  ready(): Promise<void>
  currentVersion(): Promise<string>
  context(): Promise<CanvasSummary>
  /** Subscribe to same-origin GeoGebra selection changes. */
  onSelection?(listener: (summary: CanvasSummary) => void): () => void
  snapshot(): Promise<CanvasSnapshot>
  restore(contentBase64: string): Promise<void>
  reset(): Promise<void>
  setSpace(space: '2d' | '3d'): Promise<void>
  setViews(views: CanvasViews): Promise<void>
  /** Resize the real applet viewport; CSS resizing the iframe alone is insufficient. */
  resize(width: number, height: number): Promise<void>
  dispose(): void
}

/**
 * `postMessage` supports structured-clone values. Keep the envelope as an
 * object so the receiver can validate its channel and fields without an
 * implicit JSON decoding boundary.
 */
export function encodeAppletRequest(message: AppletRequestMessage): AppletRequestMessage {
  return message
}

export function parseAppletRequest(value: unknown): AppletRequestMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Record<string, unknown>
  if (message['channel'] !== APPLET_REQUEST_CHANNEL) return null
  if (typeof message['id'] !== 'number' || !Number.isInteger(message['id'])) return null
  if (typeof message['op'] !== 'string') return null
  return message as unknown as AppletRequestMessage
}

export function parseAppletResponse(value: unknown): AppletResponseMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Record<string, unknown>
  if (message['channel'] !== APPLET_RESPONSE_CHANNEL) return null
  if (message['event'] === 'ready') return { channel: APPLET_RESPONSE_CHANNEL, event: 'ready' }
  if (message['event'] === 'progress') {
    return { channel: APPLET_RESPONSE_CHANNEL, event: 'progress', payload: message['payload'] }
  }
  if (message['event'] === 'selection') {
    const summary = parseCanvasSummary(message['payload'])
    return summary === null ? null : { channel: APPLET_RESPONSE_CHANNEL, event: 'selection', payload: summary }
  }
  if (typeof message['id'] !== 'number' || !Number.isInteger(message['id'])) return null
  if (message['ok'] === true) {
    return { channel: APPLET_RESPONSE_CHANNEL, id: message['id'], ok: true, result: message['result'] }
  }
  if (message['ok'] === false) {
    return {
      channel: APPLET_RESPONSE_CHANNEL,
      id: message['id'],
      ok: false,
      error: typeof message['error'] === 'string' ? message['error'] : 'applet_error',
    }
  }
  return null
}

/** Path of the dedicated applet document (§12: wide GeoGebra privileges stay isolated). */
export const APPLET_DOCUMENT_PATH = '/geogebra-host.html'

export interface IframeAppletPortOptions {
  /** Same-origin applet document URL. */
  url?: string
  /** Extra origin check for postMessage; defaults to the current origin. */
  origin?: string
  timeoutMs?: number
}

/**
 * Talks to the dedicated GeoGebra document over a validated postMessage RPC.
 * Origin and source are both checked, and unknown channels are ignored, so a
 * third-party frame cannot drive the applet.
 */
export function createIframeAppletPort(options: IframeAppletPortOptions = {}): {
  port: GeogebraAppletPort
  element: HTMLIFrameElement
} {
  const origin = options.origin ?? globalThis.location.origin
  const timeoutMs = options.timeoutMs ?? 30_000
  const element = document.createElement('iframe')
  element.title = 'GeoGebra'
  element.setAttribute('allow', 'clipboard-write')
  let nextId = 1
  let disposed = false
  let resolveChildReady: (() => void) | null = null
  const childReady = new Promise<void>((resolve) => { resolveChildReady = resolve })
  // `src` may begin loading while the iframe is detached. In that case the
  // child document can post its ready notification before the parent listener
  // exists. `load` is the durable readiness barrier: the child has installed
  // its RPC listener before its document can finish loading.
  const onLoad = (): void => {
    resolveChildReady?.()
    resolveChildReady = null
  }
  element.addEventListener('load', onLoad, { once: true })
  element.src = options.url ?? APPLET_DOCUMENT_PATH
  const selectionListeners = new Set<(summary: CanvasSummary) => void>()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== origin || event.source !== element.contentWindow) return
    const message = parseAppletResponse(event.data)
    if (message === null) return
    if ('event' in message) {
      if (message.event === 'ready') {
        resolveChildReady?.()
        resolveChildReady = null
        return
      }
      if (message.event !== 'progress') for (const listener of selectionListeners) listener(message.payload)
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  }
  globalThis.addEventListener('message', onMessage)

  const call = <T>(op: AppletOperation, payload?: unknown): Promise<T> => {
    if (disposed) return Promise.reject(new Error('applet_port_disposed'))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('applet_request_timeout'))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      void childReady.then(() => {
        if (!disposed) element.contentWindow?.postMessage(encodeAppletRequest({ channel: APPLET_REQUEST_CHANNEL, id, op, payload }), origin)
      })
    })
  }

  const port: GeogebraAppletPort = {
    ready: () => call<void>('ready'),
    currentVersion: () => call<string>('currentVersion'),
    context: () => call<CanvasSummary>('context'),
    onSelection: (listener) => {
      selectionListeners.add(listener)
      return () => selectionListeners.delete(listener)
    },
    snapshot: () => call<CanvasSnapshot>('snapshot'),
    restore: (contentBase64) => call<void>('restore', { contentBase64 }),
    reset: () => call<void>('reset'),
    setSpace: (space) => call<void>('setSpace', { space }),
    setViews: (views) => call<void>('setViews', { views }),
    resize: (width, height) => call<void>('resize', { width, height }),
    dispose: () => {
      disposed = true
      element.removeEventListener('load', onLoad)
      globalThis.removeEventListener('message', onMessage)
      selectionListeners.clear()
      for (const entry of pending.values()) entry.reject(new Error('applet_port_disposed'))
      pending.clear()
    },
  }
  return { port, element }
}

export interface DirectAppletPortOptions {
  container: HTMLElement
  /** Injected GeoGebra runtime version; a mismatch fails the port instead of guessing. */
  runtimeVersion?: string
  codebasePath?: string
}

interface GeoGebraAppletApi extends RestrictedGeoGebraApiV1 {
  remove?(): void
  getVersion(): string
  getBase64(callback: (value: string) => void): void
  setBase64(value: string, callback?: () => void): void
  newConstruction(): void
  setSize?(width: number, height: number): void
  recalculateEnvironments?(): void
  setPerspective(perspective: string): void
  showAlgebraInput(show: boolean): void
  getAllObjectNames?(): string[] | string
  getSelectedObjectNames?(): string[]
  getCaption?(label: string): string
  getValueString?(label: string): string
  registerClientListener?(listener: (event: unknown) => void): void
  unregisterClientListener?(listener: (event: unknown) => void): void
}

interface GgbAppletOptions {
  id: string
  appName: 'classic'
  width: number
  height: number
  autoHeight: boolean
  disableAutoScale: boolean
  allowUpscale: boolean
  language: string
  showToolBar: boolean
  showAlgebraInput: boolean
  showMenuBar: boolean
  allowStyleBar: boolean
  enableLabelDrags: boolean
  enableShiftDragZoom: boolean
  enableRightClick: boolean
  /** §8.3: applet error popups must stay disabled; they persist and block usage. */
  errorDialogsActive: boolean
  perspective: string
  enableUndoRedo?: boolean
  appletOnLoad: (api: GeoGebraAppletApi) => void
}

/** Minimal GeoGebra surface used to normalize the visible 2D Cartesian view. */
export interface CartesianViewSettingsApi {
  evalCommand(command: string): boolean
}

/**
 * Keep the teaching canvas visually consistent across fresh documents and
 * restored local `.ggb` files. These official GeoGebra view commands alter
 * only GUI state, which is excluded from the construction digest.
 */
export function enforceCartesianViewSettings(api: CartesianViewSettingsApi): void {
  api.evalCommand('ShowAxes(1,true)')
  api.evalCommand('ShowGrid(1,false)')
}

interface GeogebraGlobal {
  GGBApplet?: new (
    options: GgbAppletOptions,
    useBrowserForJS: boolean,
  ) => { inject(target: HTMLElement): void; setHTML5Codebase(path: string, offline?: boolean): void }
}

/**
 * Injects the applet into the caller's document. Used when the dedicated applet
 * document is unavailable; it exposes the same narrow snapshot/restore port.
 */
export function createDirectAppletPort(options: DirectAppletPortOptions): GeogebraAppletPort {
  const { container } = options
  const rect = container.getBoundingClientRect()
  let api: GeoGebraAppletApi | undefined
  let views = readCanvasViews()
  let space: '2d' | '3d' = '2d'
  let selectedLabels: string[] = []
  const selectionListeners = new Set<(summary: CanvasSummary) => void>()
  const forwardSelection = (event: unknown): void => {
    if (!isSelectionEvent(event) || api === undefined) return
    selectedLabels = projectSelectedLabels(selectedLabels, event)
    const summary = canvasSummaryFromApi(api, selectedLabels)
    for (const listener of selectionListeners) listener(summary)
  }
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const appletConstructor = (globalThis as GeogebraGlobal).GGBApplet
  if (appletConstructor === undefined) throw new Error('geogebra_runtime_missing')
  const applet = new appletConstructor(
    {
      id: 'ggbApplet',
      appName: 'classic',
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(240, Math.round(rect.height)),
      autoHeight: false,
      disableAutoScale: true,
      allowUpscale: false,
      language: 'en',
      showToolBar: true,
      showAlgebraInput: false,
      showMenuBar: false,
      allowStyleBar: true,
      enableLabelDrags: true,
      enableShiftDragZoom: true,
      enableRightClick: true,
      errorDialogsActive: false,
      perspective: 'G',
      appletOnLoad: (loaded) => {
        if (options.runtimeVersion !== undefined && loaded.getVersion() !== options.runtimeVersion) {
          rejectReady?.(new Error('geogebra_runtime_version_mismatch'))
          return
        }
        api = loaded
        selectedLabels = nativeSelectedLabels(loaded)
        applyCanvasViews(loaded, views, space)
        enforceCartesianViewSettings(loaded)
        loaded.registerClientListener?.(forwardSelection)
        resolveReady?.()
      },
    },
    true,
  )
  applet.setHTML5Codebase(options.codebasePath ?? '/geogebra/HTML5/5.0/web3d/', true)
  applet.inject(container)

  const withApi = async <T>(run: (value: GeoGebraAppletApi) => Promise<T> | T): Promise<T> => {
    await readyPromise
    if (api === undefined) throw new Error('geogebra_not_ready')
    return run(api)
  }

  return {
    ready: () => readyPromise,
    currentVersion: async () => {
      const xml = await withApi((loaded) => loaded.getXML())
      return canvasVersionFromDigest(await digestCanonicalXml(xml))
    },
    context: () => withApi((loaded) => canvasSummaryFromApi(loaded, selectedLabels)),
    onSelection: (listener) => {
      selectionListeners.add(listener)
      return () => selectionListeners.delete(listener)
    },
    snapshot: async () => {
      const contentBase64 = await withApi((loaded) => new Promise<string>((resolve) => loaded.getBase64(resolve)))
      const xml = await withApi((loaded) => loaded.getXML())
      const contentDigest = await digestCanonicalXml(xml)
      return { contentBase64, contentDigest, canvasVersion: canvasVersionFromDigest(contentDigest) }
    },
    restore: async (contentBase64) => {
      await withApi(async (loaded) => {
        await new Promise<void>((resolve) => loaded.setBase64(contentBase64, resolve))
        selectedLabels = []
        applyCanvasViews(loaded, views, space)
        if (space === '2d') enforceCartesianViewSettings(loaded)
      })
    },
    reset: async () => {
      await withApi((loaded) => {
        loaded.newConstruction()
        selectedLabels = []
        applyCanvasViews(loaded, views, space)
        if (space === '2d') enforceCartesianViewSettings(loaded)
      })
    },
    setViews: async (value) => {
      const previous = views
      const next = parseCanvasViews(value)
      views = next
      try { await withApi((loaded) => applyCanvasViews(loaded, views, space)) }
      catch (error) { if (views === next) views = previous; throw error }
    },
    setSpace: async (value) => {
      space = value
      await withApi((loaded) => {
        applyCanvasViews(loaded, views, space)
        if (space === '2d') enforceCartesianViewSettings(loaded)
      })
    },
    resize: async (width, height) => {
      const size = normalizedAppletSize(width, height)
      await withApi((loaded) => {
        container.style.width = `${size.width}px`
        container.style.height = `${size.height}px`
        loaded.setSize?.(size.width, size.height)
        loaded.recalculateEnvironments?.()
      })
    },
    dispose: () => {
      api?.unregisterClientListener?.(forwardSelection)
      selectionListeners.clear()
      api = undefined
    },
  }
}

function canvasSummaryFromApi(loaded: GeoGebraAppletApi, selectedLabels: readonly string[]): CanvasSummary {
  const names = loaded.getAllObjectNames?.() ?? []
  const labels = (Array.isArray(names) ? names : names.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return {
    objectsTruncated: loaded.getAllObjectNames === undefined || labels.length > 64 || labels.some(label => label.length > 64
      || (loaded.getCaption?.(label)?.trim().length ?? 0) > 64),
    objects: labels.slice(0, 64).map((label) => ({
      label: label.slice(0, 64),
      ...(canvasObjectCaption(loaded, label) === label ? {} : { caption: canvasObjectCaption(loaded, label) }),
      kind: (loaded.getObjectType?.(label) ?? 'unknown').slice(0, 64),
      definition: canvasObjectDefinition(loaded, label),
    })),
    selectedLabels,
  }
}

/** Prefer the visible semantic caption when it is available, never an internal execution label. */
function canvasObjectCaption(api: Pick<GeoGebraAppletApi, 'getCaption'>, label: string): string {
  const caption = api.getCaption?.(label)?.trim()
  return (caption === undefined || caption.length === 0 ? label : caption).slice(0, 64)
}

/**
 * GeoGebra returns an empty definition for some valid objects, notably sliders.
 * The API contract requires a non-empty summary definition, so preserve a
 * useful value-string representation instead of sending an invalid run body.
 */
export function canvasObjectDefinition(
  api: Pick<GeoGebraAppletApi, 'getDefinitionString' | 'getValueString'>,
  label: string,
): string {
  const definition = api.getDefinitionString?.(label)?.trim()
  if (definition !== undefined && definition.length > 0) return definition.slice(0, 2_000)
  const value = api.getValueString?.(label)?.trim()
  return (value === undefined || value.length === 0 ? label : value).slice(0, 2_000)
}

interface GeoGebraSelectionEvent {
  type: 'select' | 'deselect'
  target?: unknown
}

function isSelectionEvent(value: unknown): value is GeoGebraSelectionEvent {
  return typeof value === 'object' && value !== null && 'type' in value
    && ((value as { type?: unknown }).type === 'select' || (value as { type?: unknown }).type === 'deselect')
}

/** Mirrors GeoGebra client select/deselect events; native selected-name APIs are not consistently populated. */
export function projectSelectedLabels(labels: readonly string[], event: GeoGebraSelectionEvent): string[] {
  if (typeof event.target !== 'string' || event.target.length === 0) return event.type === 'deselect' ? [] : [...labels]
  const target = event.target.slice(0, 64)
  if (event.type === 'deselect') return labels.filter((label) => label !== target)
  return labels.includes(target) ? [...labels] : [...labels, target].slice(0, 16)
}

function nativeSelectedLabels(loaded: GeoGebraAppletApi): string[] {
  return (loaded.getSelectedObjectNames?.() ?? []).filter((label): label is string => typeof label === 'string').slice(0, 16)
}

function parseCanvasSummary(value: unknown): CanvasSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record['objects']) || !Array.isArray(record['selectedLabels'])) return null
  if (record['objects'].length > 64 || record['selectedLabels'].length > 16) return null
  const objects: Array<{ label: string; kind: string; definition: string }> = []
  for (const value of record['objects']) {
    if (typeof value !== 'object' || value === null) return null
    const object = value as Record<string, unknown>
    if (typeof object['label'] !== 'string' || typeof object['kind'] !== 'string' || typeof object['definition'] !== 'string') return null
    if (object['caption'] !== undefined && typeof object['caption'] !== 'string') return null
    objects.push({ label: object['label'].slice(0, 64),
      ...(typeof object['caption'] === 'string' && object['caption'].trim().length > 0
        ? { caption: object['caption'].slice(0, 64) } : {}),
      kind: object['kind'].slice(0, 64), definition: object['definition'].slice(0, 2_000) })
  }
  if (!record['selectedLabels'].every((label) => typeof label === 'string')) return null
  return { objects, objectsTruncated: record['objectsTruncated'] !== false, selectedLabels: record['selectedLabels'].map((label) => (label as string).slice(0, 64)) }
}

function canvasVersionFromDigest(digest: string): string {
  return `canvas_${digest.slice(0, 32)}`
}

function normalizedAppletSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(320, Math.round(Number.isFinite(width) ? width : 320)),
    height: Math.max(240, Math.round(Number.isFinite(height) ? height : 240)),
  }
}

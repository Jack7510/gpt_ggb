import { parseCanvasViews } from './view-settings.js'
import {
  APPLET_RESPONSE_CHANNEL,
  createDirectAppletPort,
  parseAppletRequest,
  type AppletRequestMessage,
  type GeogebraAppletPort,
} from './host.js'

declare const GGB_GEOGEBRA_VERSION: string
declare const GGB_GEOGEBRA_CODEBASE: string

/**
 * Server half of the applet RPC (§12). The wide GeoGebra privileges stay in
 * this dedicated document; the main UI only ever sees the narrow port protocol.
 */
const container = document.getElementById('applet')
if (container === null) throw new Error('geogebra_mount_target_missing')

const port: GeogebraAppletPort = createDirectAppletPort({
  container,
  runtimeVersion: GGB_GEOGEBRA_VERSION,
  codebasePath: GGB_GEOGEBRA_CODEBASE,
})

const disposeSelection = port.onSelection?.((summary) => {
  globalThis.parent.postMessage({ channel: APPLET_RESPONSE_CHANNEL, event: 'selection', payload: summary }, globalThis.location.origin)
})

globalThis.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== globalThis.parent) return
  const request = parseAppletRequest(event.data)
  if (request === null) return
  void respond(request, event.origin)
})

// Parent may construct the iframe before it is attached; announce that the
// listener exists so its first RPC cannot be lost during document navigation.
globalThis.parent.postMessage({ channel: APPLET_RESPONSE_CHANNEL, event: 'ready' }, globalThis.location.origin)
globalThis.addEventListener('beforeunload', () => disposeSelection?.())

async function respond(request: AppletRequestMessage, origin: string): Promise<void> {
  const reply = (message: Record<string, unknown>): void => {
    globalThis.parent.postMessage({ channel: APPLET_RESPONSE_CHANNEL, ...message }, origin)
  }
  try {
    reply({ id: request.id, ok: true, result: await run(request) })
  } catch (error) {
    reply({ id: request.id, ok: false, error: errorText(error) })
  }
}

async function run(request: AppletRequestMessage): Promise<unknown> {
  const payload = asRecord(request.payload)
  switch (request.op) {
    case 'ready':
      await port.ready()
      return null
    case 'currentVersion':
      return port.currentVersion()
    case 'context':
      return port.context()
    case 'snapshot':
      return port.snapshot()
    case 'restore':
      return port.restore(requireString(payload['contentBase64'], 'contentBase64'))
    case 'reset':
      return port.reset()
    case 'setViews':
      return port.setViews(parseCanvasViews(payload['views']))
    case 'setSpace':
      return port.setSpace(requireSpace(payload['space']))
    case 'resize':
      return port.resize(requireDimension(payload['width'], 'width'), requireDimension(payload['height'], 'height'))
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`applet_payload_invalid:${name}`)
  return value
}

function requireSpace(value: unknown): '2d' | '3d' {
  if (value !== '2d' && value !== '3d') throw new Error('applet_payload_invalid:space')
  return value
}

function requireDimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`applet_payload_invalid:${name}`)
  }
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'applet_error'
}

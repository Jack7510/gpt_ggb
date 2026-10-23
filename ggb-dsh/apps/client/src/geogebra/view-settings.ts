/** Browser presentation preference, independent of GGB/session content. */
export interface CanvasViews { readonly algebra: boolean; readonly cas: boolean }
const STORAGE_KEY = 'ggb-client.canvas-views.v1'

export function parseCanvasViews(value: unknown): CanvasViews {
  if (typeof value !== 'object' || value === null
    || typeof (value as CanvasViews).algebra !== 'boolean'
    || typeof (value as CanvasViews).cas !== 'boolean') {
    throw new Error('applet_payload_invalid:views')
  }
  return { algebra: (value as CanvasViews).algebra, cas: (value as CanvasViews).cas }
}

export function readCanvasViews(): CanvasViews {
  try {
    return parseCanvasViews(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch { return { algebra: false, cas: false } }
}

export function saveCanvasViews(views: CanvasViews): void {
  try { globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(views)) }
  catch { /* View switching still works when browser storage is unavailable. */ }
}

export interface ViewSettingsApi {
  setPerspective(perspective: string): void
  showAlgebraInput(show: boolean): void
}

/** Full layout excludes any secondary graphics/spreadsheet views stored in a file. */
export function applyCanvasViews(api: ViewSettingsApi, views: CanvasViews, space: '2d' | '3d'): void {
  api.setPerspective(`${views.algebra ? 'A' : ''}${space === '3d' ? 'T' : 'G'}${views.cas ? 'C' : ''}`)
  api.showAlgebraInput(views.algebra)
}

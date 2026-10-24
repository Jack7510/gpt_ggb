/**
 * XML sections that describe applet viewport, layout and scripting state rather than construction
 * content. They change through `api.setSize()` whenever the panel is resized, so hashing them would
 * invalidate a version whose construction did not move.
 */
const VOLATILE_XML_SECTION = /<(gui|euclidianView|euclidianView3D|spreadsheetView|probabilityCalculator|tableview|scripting)\b[^>]*(?:\/>|>[\s\S]*?<\/\1>)/g
/** Root applet instance id: a fresh applet reusing the same construction must keep the same version. */
const ROOT_INSTANCE_ID = /(<geogebra\b[^>]*?)\s+id="[^"]*"/

/**
 * Reduce raw applet XML to the content that defines a canvas version: the construction, its object
 * presentation, and the kernel state. Viewport geometry, layout panes and applet instance identity are
 * dropped, so one construction maps to exactly one version across resizes and page reloads.
 */
export function canonicalCanvasXml(xml: string): string {
  return xml
    .replace(VOLATILE_XML_SECTION, '')
    .replace(ROOT_INSTANCE_ID, '$1')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

/**
 * Canvas equality basis (§3.3): sha256 over the canonical XML, which drops
 * viewport/layout/scripting sections and the root applet id. The same
 * construction therefore hashes identically across resizes and reloads.
 */
export async function digestCanonicalXml(xml: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCanvasXml(xml))
  const digest = await subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

export async function digestBytes(bytes: Uint8Array, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes))
  return toHex(new Uint8Array(digest))
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

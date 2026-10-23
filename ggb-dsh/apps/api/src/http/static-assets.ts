import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { RunError } from '@ggb-copilot/application'
import type { HttpContext } from './http-server.js'

/** Pinned release metadata the provisioned GeoGebra runtime must match (§11). */
interface RuntimeConfiguration {
  readonly geogebra: { readonly version: string; readonly source: string; readonly sha256: string }
}

/** Marker written by `tools/provision-geogebra.mjs` next to the provisioned runtime. */
interface RuntimeManifest {
  readonly schemaVersion: 1
  readonly version: string
  readonly source: string
  readonly archiveSha256: string
}

export interface StaticAssetsConfig {
  /** Built Client PWA shell; `null` disables static serving entirely. */
  clientDistDir: string | null
  /** Provisioned fixed GeoGebra runtime; defaults to `<clientDistDir>/geogebra`. */
  geogebraRoot: string | null
  /** Pinned runtime versions file used to validate the provisioned manifest. */
  runtimeVersionsPath: string
}

export interface StaticAssets {
  readonly clientDistDir: string
  readonly geogebraRoot: string
}

const REQUIRED_RUNTIME_FILES = ['deployggb.js', join('HTML5', '5.0', 'web3d', 'web3d.nocache.js')]

/** Dedicated applet document that owns GeoGebra's wider privileges (§12). */
const APPLET_DOCUMENT = '/geogebra-host.html'

/**
 * §12: the main UI gets the minimum policy. The built shell has no inline script
 * or style, so neither needs `unsafe-inline`; the applet is framed same-origin.
 */
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * §12: GeoGebra's wider privileges stay confined to the dedicated document. The
 * applet evaluates its own runtime code, injects styles and uses blob workers,
 * so this policy is deliberately looser than the shell's and applies nowhere else.
 */
const APPLET_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ')

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

/**
 * Locates and validates the provisioned, fixed GeoGebra web runtime before the API
 * listens (§10 keeps this capability; §11 fixes the runtime per release). A missing,
 * incomplete or mismatched runtime fails boot instead of serving a guess.
 */
export function resolveGeoGebraRuntime(geogebraRoot: string, runtimeVersionsPath: string): string {
  const configuration = parseJson<RuntimeConfiguration>(runtimeVersionsPath)
  const manifest = parseJson<RuntimeManifest>(join(dirname(geogebraRoot), 'geogebra-runtime-manifest.json'))
  if (manifest.schemaVersion !== 1
    || manifest.version !== configuration.geogebra.version
    || manifest.source !== configuration.geogebra.source
    || manifest.archiveSha256 !== configuration.geogebra.sha256) {
    throw new Error('geogebra_runtime_manifest_mismatch')
  }
  for (const required of REQUIRED_RUNTIME_FILES) {
    const path = join(geogebraRoot, required)
    if (!isPlainFile(path)) throw new Error('geogebra_runtime_incomplete')
  }
  return geogebraRoot
}

/** Resolves the static roots once at boot; `null` means the API serves only its own routes. */
export function createStaticAssets(config: StaticAssetsConfig): StaticAssets | null {
  if (config.clientDistDir === null) return null
  const clientDistDir = resolve(config.clientDistDir)
  if (!isPlainFile(join(clientDistDir, 'index.html'))) throw new Error('client_dist_index_missing')
  const geogebraRoot = resolveGeoGebraRuntime(
    resolve(config.geogebraRoot ?? join(clientDistDir, 'geogebra')),
    config.runtimeVersionsPath,
  )
  return { clientDistDir, geogebraRoot }
}

/**
 * Serves one static request. Returns `false` when nothing matched so the caller can
 * fall through to the API route table (and its 404).
 */
export async function serveStaticAsset(ctx: HttpContext, assets: StaticAssets): Promise<boolean> {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false
  const pathname = ctx.url.pathname
  // API paths are never static: a malformed run URL must 404, not fall back to the shell.
  if (pathname.startsWith('/api/')) return false
  const isRuntime = pathname === '/geogebra' || pathname.startsWith('/geogebra/')
  if (isRuntime) {
    const file = resolveAssetFile(assets.geogebraRoot, pathname.slice('/geogebra'.length))
    if (file === null) return false
    return sendFile(ctx, file, pathname)
  }
  const requested = pathname === '/' ? '/index.html' : pathname
  const file = resolveAssetFile(assets.clientDistDir, requested)
  // Deep links and unknown paths fall back to the shell (§14.6 deep-link refresh).
  if (file === null) return sendFile(ctx, join(assets.clientDistDir, 'index.html'), '/index.html')
  return sendFile(ctx, file, requested)
}

/**
 * Resolves one URL path inside `root` without permitting traversal, directories or
 * symlinks (§12: never trust a client-supplied file path).
 */
function resolveAssetFile(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const candidate = resolve(root, decoded.replace(/^\/+/, ''))
  const child = relative(root, candidate)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`)) return null
  return isPlainFile(candidate) ? candidate : null
}

function isPlainFile(path: string): boolean {
  if (!existsSync(path)) return false
  const status = lstatSync(path)
  return status.isFile() && !status.isSymbolicLink()
}

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/geogebra/')) return 'public, max-age=86400'
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  // HTML, manifest, Service Worker and release metadata revalidate (§11).
  return 'no-cache'
}

/** §12: HTML documents carry a policy; the applet document gets its own. */
function cspFor(pathname: string): string | null {
  if (pathname === APPLET_DOCUMENT) return APPLET_CSP
  return pathname.endsWith('.html') ? SHELL_CSP : null
}

async function sendFile(ctx: HttpContext, file: string, pathname: string): Promise<boolean> {
  const status = lstatSync(file)
  const csp = cspFor(pathname)
  ctx.res.writeHead(200, {
    'content-type': CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'content-length': status.size,
    'cache-control': cacheControlFor(pathname),
    'x-content-type-options': 'nosniff',
    ...(csp === null ? {} : { 'content-security-policy': csp }),
  })
  if (ctx.method === 'HEAD') {
    ctx.res.end()
    return true
  }
  await new Promise<void>((resolvePipe, rejectPipe) => {
    const stream = createReadStream(file)
    stream.on('error', rejectPipe)
    stream.on('end', resolvePipe)
    stream.pipe(ctx.res)
  })
  return true
}

function parseJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    throw new RunError('internal_error', `static asset metadata unavailable: ${path}`)
  }
}

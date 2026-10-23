import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { RunError } from '@ggb-copilot/application'
import { ZodError } from 'zod'
import { serveStaticAsset, type StaticAssets } from './static-assets.js'

export interface HttpContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  /** Raw request body; empty string when absent. */
  body: string
}

export type ApiHandler = (ctx: HttpContext) => Promise<void>

export interface StartApiServerOptions {
  port: number
  listenHost?: '0.0.0.0' | '127.0.0.1'
  maxBodyBytes: number
  allowedOrigin: string | null
  /** Public Host allowlist. Omit only for local development/tests behind no edge. */
  allowedHosts?: readonly string[]
  handler: ApiHandler
  /** Client shell + fixed GeoGebra runtime; omitted when the API serves only its routes. */
  staticAssets?: StaticAssets
}

export interface RunningApiServer {
  server: Server
  port: number
  close(): Promise<void>
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Parses a JSON body; malformed JSON is a client error, not a crash. */
export function parseJsonBody(body: string): unknown {
  if (body.trim() === '') throw new RunError('invalid_request', 'request body must be JSON')
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new RunError('invalid_request', 'request body is not valid JSON')
  }
}

export async function startApiServer(options: StartApiServerOptions): Promise<RunningApiServer> {
  const server = createServer((req, res) => {
    void handleRequest(options, req, res).catch((error: unknown) => {
      respondError(res, error)
    })
  })
  // Plugin-core turns include model, browser and verification work. The Worker,
  // provider client and plugin runner enforce their own deadlines.
  server.requestTimeout = 15 * 60_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.listenHost ?? '0.0.0.0', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
        // SSE is intentionally long lived; never let it pin a deploy forever.
        server.closeAllConnections()
      }),
  }
}

async function handleRequest(
  options: StartApiServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  enforceHost(options.allowedHosts, req)
  applyCors(options.allowedOrigin, req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  let body: string
  try {
    body = await readBody(req, options.maxBodyBytes)
  } catch (error) {
    respondError(res, error)
    return
  }
  try {
    await options.handler({ req, res, url, method: req.method ?? 'GET', body })
  } catch (error) {
    // The route table owns `/api`, `/bootstrap` and `/health`; anything it does not
    // claim falls through to the static layer (§10 keeps the static service).
    if (options.staticAssets !== undefined
      && error instanceof RunError
      && error.code === 'not_found'
      && await serveStaticAsset({ req, res, url, method: req.method ?? 'GET', body }, options.staticAssets)) {
      return
    }
    respondError(res, error)
  }
}

function applyCors(allowedOrigin: string | null, req: IncomingMessage, res: ServerResponse): void {
  if (allowedOrigin === null) return
  const origin = req.headers.origin
  res.setHeader('vary', 'origin')
  if (origin !== undefined && origin !== allowedOrigin) {
    throw new RunError('not_found', 'unknown endpoint')
  }
  res.setHeader('access-control-allow-origin', allowedOrigin)
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-ggb-provider-key')
  res.setHeader('access-control-max-age', '600')
}

function enforceHost(allowedHosts: readonly string[] | undefined, req: IncomingMessage): void {
  if (allowedHosts === undefined || allowedHosts.length === 0) return
  const host = req.headers.host?.toLowerCase()
  if (host === undefined || !allowedHosts.includes(host)) {
    throw new RunError('not_found', 'unknown endpoint')
  }
}

async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return ''
  const contentLengthHeader = req.headers['content-length']
  if (contentLengthHeader !== undefined) {
    const declared = Number(contentLengthHeader)
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      throw new RunError('payload_too_large', 'request body exceeds the configured limit')
    }
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > maxBodyBytes) {
      throw new RunError('payload_too_large', 'request body exceeds the configured limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function respondError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return
  if (error instanceof RunError) {
    sendJson(res, error.httpStatus, {
      error: { code: error.code, message: error.message, details: error.details },
    })
    return
  }
  if (error instanceof ZodError) {
    sendJson(res, 400, {
      error: {
        code: 'invalid_request',
        message: 'request body failed validation',
        details: { issues: error.issues },
      },
    })
    return
  }
  console.error('[api] unhandled error:', error)
  sendJson(res, 500, {
    error: { code: 'internal_error', message: 'unexpected server error' },
  })
}

import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIdSchema, type RunId } from '@ggb-copilot/application'

export interface HostToolRequest {
  protocolVersion: 2; requestId: string; issuedAt: string; nonce: string; runId: RunId
  turnId: string; epoch: number; toolCallId: string; toolName: 'ggb_inspect' | 'ggb_check' | 'ggb_build'
  arguments: unknown; argumentsDigest: string; authentication: string
}
export interface HostToolResponse {
  protocolVersion: 2; requestId: string; type: 'tool.result' | 'tool.error'; result: unknown | null
  error: 'unauthorized' | 'request_expired' | 'duplicate_request' | 'invalid_request' | 'internal_error' | null
}
export interface HostToolProtocol {
  readonly version: 2
  readonly maxFrameBytes: number
  parse(input: unknown): HostToolRequest
  authenticate(token: string, request: HostToolRequest): boolean
  arguments(request: HostToolRequest): unknown
}

/** No downgrade: only the installed public schema parses and authenticates tools. */
export async function loadInstalledToolProtocol(pluginRoot: string): Promise<HostToolProtocol> {
  const require = createRequire(join(resolve(pluginRoot), 'package.json'))
  const module = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/schemas')).href)
  if (module.HOST_PROTOCOL_VERSION !== 2 || typeof module.parseToolRequest !== 'function'
    || typeof module.authenticateRequest !== 'function') throw new Error('plugin_core_protocol_exports_invalid')
  return { version: 2, maxFrameBytes: module.LIMITS.frameBytes,
    parse(input) { const value = module.parseToolRequest(input); runIdSchema.parse(value.runId); return value },
    authenticate: module.authenticateRequest,
    arguments: request => request.toolName === 'ggb_inspect' ? request.arguments : (request.arguments as { request: unknown }).request }
}

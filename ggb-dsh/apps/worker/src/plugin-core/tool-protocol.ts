import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runIdSchema, type RunId } from '@ggb-copilot/application'

export interface HostToolRequest {
  protocolVersion: 3; requestId: string; issuedAt: string; nonce: string; runId: RunId
  turnId: string; epoch: number; toolCallId: string; toolName: 'ggb_inspect' | 'ggb_request' | 'ggb_check' | 'ggb_build'
  arguments: unknown; argumentsDigest: string; authentication: string
}
export interface HostToolResponse {
  protocolVersion: 3; requestId: string; type: 'tool.result' | 'tool.error'; result: unknown | null
  error: 'unauthorized' | 'request_expired' | 'duplicate_request' | 'invalid_request' | 'internal_error' | null
}
export interface HostDraftSnapshot {
  revision: number; domainRequestDigest: string; request: Record<string, unknown>
}
export interface HostDraftSession {
  operate(input: unknown): Record<string, unknown>
  forCheck(input: unknown): HostDraftSnapshot
  acceptCheck(snapshot: HostDraftSnapshot): Record<string, unknown>
  forBuild(input: unknown): HostDraftSnapshot
}
export interface HostToolProtocol {
  readonly version: 3
  readonly preloadedReferenceTopics?: readonly string[]
  readonly referenceCoverage?: (id: string) => readonly string[]
  readonly maxFrameBytes: number
  readonly maxReferenceBytes?: number
  createDraft(prompt: string): HostDraftSession
  parse(input: unknown): HostToolRequest
  authenticate(token: string, request: HostToolRequest): boolean
  arguments(request: HostToolRequest): unknown
}

/** No downgrade: only the installed public schema parses and authenticates tools. */
export async function loadInstalledToolProtocol(pluginRoot: string): Promise<HostToolProtocol> {
  const require = createRequire(join(resolve(pluginRoot), 'package.json'))
  const module = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/schemas')).href)
  const drafts = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/drafts')).href)
  if (typeof drafts.RequestDraft !== 'function') throw new Error('plugin_core_draft_exports_invalid')
  if (module.HOST_PROTOCOL_VERSION !== 3 || typeof module.parseToolRequest !== 'function'
    || typeof module.authenticateRequest !== 'function') throw new Error('plugin_core_protocol_exports_invalid')
  const preloaded = module.PRELOADED_REFERENCE_TOPICS === undefined ? [] : module.PRELOADED_REFERENCE_TOPICS
  if (!Array.isArray(preloaded) || !preloaded.every(topic => typeof topic === 'string' && module.REFERENCE_TOPICS.includes(topic))) {
    throw new Error('plugin_core_reference_contract_invalid')
  }
  if (module.REFERENCE_SECTIONS !== undefined && typeof module.referenceCoverage !== 'function') {
    throw new Error('plugin_core_reference_contract_invalid')
  }
  return { version: 3, preloadedReferenceTopics: preloaded,
    ...(typeof module.referenceCoverage === 'function' ? { referenceCoverage: module.referenceCoverage } : {}), maxFrameBytes: module.LIMITS.frameBytes,
    maxReferenceBytes: module.LIMITS.referenceBytes,
    createDraft: prompt => new drafts.RequestDraft(prompt),
    parse(input) { const value = module.parseToolRequest(input); runIdSchema.parse(value.runId); return value },
    authenticate: module.authenticateRequest,
    arguments: request => request.arguments }
}

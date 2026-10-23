import { formatRunId, newUuid, type RunId, type RunToken } from '@ggb-copilot/application/browser'
import type { ClientDatabase } from '../persistence/indexeddb.js'

/** Per-run capability the client mints itself so a lost create response is recoverable (§4.2). */
export interface RunCapability {
  runId: RunId
  runToken: RunToken
  /** Idempotency key for this create; equals runId so retries map to one run. */
  clientRequestId: string
}

export interface RandomSource {
  getRandomValues<T extends ArrayBufferView<ArrayBuffer>>(array: T): T
}

/** Mints `run_<uuid>` + a 256-bit base64url token from the browser CSPRNG. */
export function createRunCapability(source: RandomSource): RunCapability {
  const runId = formatRunId(newUuid((size) => new Uint8Array(source.getRandomValues(new Uint8Array(size)))))
  const runToken = base64UrlEncode(source.getRandomValues(new Uint8Array(32))) as RunToken
  return { runId, runToken, clientRequestId: runId }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const VAULT_KEY_NAME = 'run_token_key'
const VAULT_KEY_STORE = 'secrets'

interface SealedKeyRecord {
  name: string
  key: CryptoKey
}

/**
 * Seals run tokens at rest with a non-extractable AES-GCM key (§3.2). This only
 * raises the cost of casual storage inspection; CSP and dependency auditing
 * remain the real XSS boundary.
 */
export class RunTokenVault {
  public constructor(
    private readonly db: ClientDatabase,
    private readonly subtle: SubtleCrypto,
  ) {}

  public async seal(runToken: string): Promise<string> {
    const key = await this.ensureKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(
      await this.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(runToken)),
    )
    const payload = new Uint8Array(iv.length + ciphertext.length)
    payload.set(iv, 0)
    payload.set(ciphertext, iv.length)
    return `v1.${base64UrlEncode(payload)}`
  }

  public async reveal(sealed: string): Promise<string> {
    const [version, body] = splitSealed(sealed)
    if (version !== 'v1') throw new Error('run_token_vault_unsupported_version')
    const key = await this.ensureKey()
    const payload = base64UrlDecode(body)
    const iv = payload.slice(0, 12)
    const ciphertext = payload.slice(12)
    const plaintext = await this.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(plaintext)
  }

  /** Drops the wrapping key, permanently orphaning every sealed token. */
  public async destroy(): Promise<void> {
    await this.db.delete(VAULT_KEY_STORE, VAULT_KEY_NAME)
  }

  private async ensureKey(): Promise<CryptoKey> {
    const existing = await this.db.get<SealedKeyRecord>(VAULT_KEY_STORE, VAULT_KEY_NAME)
    if (existing !== null) return existing.key
    const key = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await this.db.put(VAULT_KEY_STORE, { name: VAULT_KEY_NAME, key } satisfies SealedKeyRecord)
    return key
  }
}

function splitSealed(sealed: string): [string, string] {
  const separator = sealed.indexOf('.')
  if (separator <= 0) throw new Error('run_token_vault_malformed')
  return [sealed.slice(0, separator), sealed.slice(separator + 1)]
}

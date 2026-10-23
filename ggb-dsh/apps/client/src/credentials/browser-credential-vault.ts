import type { ClientDatabase } from '../persistence/indexeddb.js'
import { base64UrlDecode, base64UrlEncode, type RandomSource } from '../runtime/run-capability.js'

const KEY_RECORD = 'provider_key_v1'
const WRAPPING_KEY_RECORD = 'provider_key_wrapping_key_v1'
const STORE = 'secrets'

interface WrappingKeyRecord {
  name: typeof WRAPPING_KEY_RECORD
  key: CryptoKey
}

interface ProviderKeyRecord {
  name: typeof KEY_RECORD
  sealed: string
}

/**
 * Browser-owned remembered BYOK vault. Its non-extractable AES key and
 * ciphertext remain in the same-origin IndexedDB only; neither record belongs
 * to a conversation Session or an exportable artifact.
 *
 * This protects against casual database inspection and copied ciphertext, not
 * a compromised same-origin page or browser profile.
 */
export class BrowserCredentialVault {
  public constructor(
    private readonly db: ClientDatabase,
    private readonly subtle: SubtleCrypto,
    private readonly random: RandomSource,
  ) {}

  public async save(providerKey: string): Promise<void> {
    const normalized = normalize(providerKey)
    if (normalized === null) throw new Error('provider_key_empty')
    const key = await this.ensureKey()
    const iv = this.random.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(normalized)
    try {
      const ciphertext = new Uint8Array(await this.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext))
      const payload = new Uint8Array(iv.byteLength + ciphertext.byteLength)
      payload.set(iv)
      payload.set(ciphertext, iv.byteLength)
      await this.db.put(STORE, { name: KEY_RECORD, sealed: `v1.${base64UrlEncode(payload)}` } satisfies ProviderKeyRecord)
    } finally {
      plaintext.fill(0)
    }
  }

  public async load(): Promise<string | null> {
    const record = await this.db.get<ProviderKeyRecord>(STORE, KEY_RECORD)
    if (record === null) return null
    const [version, body] = split(record.sealed)
    if (version !== 'v1') throw new Error('provider_key_vault_unsupported_version')
    const payload = base64UrlDecode(body)
    if (payload.byteLength <= 12) throw new Error('provider_key_vault_malformed')
    const plaintext = new Uint8Array(await this.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.slice(0, 12) },
      await this.ensureKey(),
      payload.slice(12),
    ))
    try {
      return normalize(new TextDecoder().decode(plaintext))
    } finally {
      plaintext.fill(0)
    }
  }

  public async clear(): Promise<void> {
    await this.db.delete(STORE, KEY_RECORD)
    await this.db.delete(STORE, WRAPPING_KEY_RECORD)
  }

  private async ensureKey(): Promise<CryptoKey> {
    const existing = await this.db.get<WrappingKeyRecord>(STORE, WRAPPING_KEY_RECORD)
    if (existing !== null) return existing.key
    const key = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await this.db.put(STORE, { name: WRAPPING_KEY_RECORD, key } satisfies WrappingKeyRecord)
    return key
  }
}

function normalize(value: string): string | null {
  const normalized = value.trim()
  return normalized.length === 0 ? null : normalized
}

function split(value: string): [string, string] {
  const separator = value.indexOf('.')
  if (separator <= 0 || separator === value.length - 1) throw new Error('provider_key_vault_malformed')
  return [value.slice(0, separator), value.slice(separator + 1)]
}

/**
 * BYOK holder (§3.2, §7.2). The provider key lives in page memory only, is
 * passed per request, and is never written to the Session store, exported with
 * a Session, or persisted across reloads unless a future opt-in device vault
 * exists (§16).
 */
export interface ProviderKeyLease {
  /** Key for the current request; `null` when the user has not supplied one. */
  readonly key: string | null
  /** True when this lease was minted by a `credential.required` handoff. */
  readonly resumed: boolean
}

export class ByokController {
  private key: string | null = null
  private listeners = new Set<(present: boolean) => void>()

  public constructor(key: string | null = null) {
    this.key = normalize(key)
  }

  public get present(): boolean {
    return this.key !== null
  }

  public set(key: string | null): void {
    this.key = normalize(key)
    for (const listener of this.listeners) listener(this.key !== null)
  }

  public clear(): void {
    this.set(null)
  }

  /** Header value for the next request; never logged by the caller. */
  public lease(): ProviderKeyLease {
    return { key: this.key, resumed: this.key !== null }
  }

  public onChange(listener: (present: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

function normalize(key: string | null): string | null {
  if (key === null) return null
  const trimmed = key.trim()
  return trimmed.length === 0 ? null : trimmed
}

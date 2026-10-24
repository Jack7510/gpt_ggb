/** Trusted attachment facts gate saves; mathematical transcription stays owned by the plugin draft. */
export class PluginCoreImageInputContract {
  private transcriptionSaved = false
  constructor(private readonly imageAttached: boolean) {}

  /** Check before draft mutation. Only a successful save may retain transcription for repairs. */
  canSave(input: unknown): boolean {
    if (!this.imageAttached) return true
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false
    const args = input as Record<string, unknown>
    if (typeof args.requestText !== 'string') return false
    if (args.transcription === undefined) return this.transcriptionSaved
    return Array.isArray(args.transcription) && args.transcription.length > 0
      && args.transcription.every(value => typeof value === 'string' && value.trim().length > 0)
  }

  /** Call after the installed draft has validated and saved all arguments atomically. */
  accepted(): void { this.transcriptionSaved = true }
}

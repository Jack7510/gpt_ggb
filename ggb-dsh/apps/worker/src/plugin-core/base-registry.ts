import type { RunId } from '@ggb-copilot/application'

/** One Worker-owned base GGB for the current plugin-core run. */
export interface PluginCoreBase {
  readonly path: string
  readonly sha256: string
  readonly name: string | null
}

/** Keep the base path out of model input while the tool gateway needs it. */
export class PluginCoreBaseRegistry {
  private readonly bases = new Map<string, PluginCoreBase>()

  set(runId: RunId, base: PluginCoreBase): void {
    this.bases.set(runId, base)
  }

  get(runId: RunId): PluginCoreBase | undefined {
    return this.bases.get(runId)
  }

  delete(runId: RunId): void {
    this.bases.delete(runId)
  }
}

import type {
  NewPluginCoreRunSpec, PluginCoreArtifactKind, PluginCoreDelivery,
  PluginCoreEvent, PluginCoreEventAppend, PluginCoreFailure,
  PluginCoreCleanup, PluginCoreRunAccessFacts, PluginCoreRunRecord, PluginCoreUsage,
} from '@ggb-copilot/application'
import type { RunId } from '@ggb-copilot/application'

/** One bounded artifact; content is written with the terminal run transition. */
export interface PluginCoreArtifactInput {
  readonly artifactId: string
  readonly kind: PluginCoreArtifactKind
  readonly sizeBytes: number
  readonly sha256: string
  readonly contentType: string
  readonly contentBase64: string
}

export interface PluginCoreCompleteInput {
  readonly runId: RunId
  readonly cleanup?: PluginCoreCleanup
  readonly finalResponse: string
  readonly delivery: PluginCoreDelivery
  readonly usage: PluginCoreUsage | null
  readonly durationMs: number
  readonly modelId: string
  readonly artifacts: readonly PluginCoreArtifactInput[]
  /** Terminal retention deadline. */
  readonly expiresAt: string
}

export interface PluginCoreFailInput {
  readonly cleanup?: PluginCoreCleanup
  readonly runId: RunId
  readonly failure: PluginCoreFailure
  readonly usage: PluginCoreUsage | null
  readonly durationMs: number | null
  readonly modelId: string
  readonly expiresAt: string
}

export type PluginCoreCreateResult =
  | { readonly kind: 'created' | 'existing'; readonly record: PluginCoreRunRecord }
  | { readonly kind: 'conflict'; readonly record: PluginCoreRunRecord }

export type PluginCoreCompleteResult = 'committed' | 'cancelled' | 'conflict'
export type PluginCoreRunningResult = 'running' | 'cancelled' | 'conflict' | 'missing'

/**
 * Durable facts for the independent plugin-core engine. This is deliberately
 * separate from `RunStore`: plugin runs have no Native checkpoint, lease,
 * transaction or recovery semantics.
 */
export interface PluginCoreStore {
  createRun(spec: NewPluginCoreRunSpec): Promise<PluginCoreCreateResult>
  getRunAccessFacts(runId: RunId): Promise<PluginCoreRunAccessFacts | null>
  getRun(runId: RunId): Promise<PluginCoreRunRecord | null>
  /** CAS accepted → running; a stop request wins and returns `cancelled`. */
  markRunning(runId: RunId): Promise<PluginCoreRunningResult>
  /** Set the stop flag without changing the phase; terminal runs return false. */
  requestStop(runId: RunId): Promise<boolean>
  /** Atomic completion with artifacts, usage and the terminal delivery event. */
  completeRun(input: PluginCoreCompleteInput): Promise<PluginCoreCompleteResult>
  failRun(input: PluginCoreFailInput): Promise<PluginCoreCompleteResult>
  /** Running cancellation requires cleanup proof; accepted has no execution resources. */
  cancelRun(runId: RunId, expiresAt: string, cleanup?: PluginCoreCleanup): Promise<boolean>
  appendEvents(runId: RunId, events: readonly PluginCoreEventAppend[]): Promise<PluginCoreEvent[]>
  listEvents(runId: RunId, afterEventId: number, limit: number): Promise<PluginCoreEvent[]>
  earliestEventId(runId: RunId): Promise<number | null>
  latestEventId(runId: RunId): Promise<number | null>
  getArtifact(runId: RunId, artifactId: string): Promise<
    { record: PluginCoreArtifactRecordView; contentBase64: string } | null>
  countActiveRuns(): Promise<number>
  /** Fail active runs past execution expiry, then delete expired terminal runs. */
  sweepExpired(now: string, limit: number): Promise<number>
  deleteRun(runId: RunId): Promise<boolean>
}

export interface PluginCoreArtifactRecordView {
  artifactId: string
  runId: RunId
  kind: PluginCoreArtifactKind
  sizeBytes: number
  sha256: string
  contentType: string
  createdAt: string
  expiresAt: string
}

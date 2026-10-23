import type { PluginCoreCleanup } from '@ggb-copilot/application'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  NewPluginCoreRunSpec, PluginCoreEvent, PluginCoreEventAppend,
  PluginCoreRunAccessFacts, PluginCoreRunRecord,
} from '@ggb-copilot/application'
import type { RunId } from '@ggb-copilot/application'
import {
  MemoryPluginCoreStore, type PluginCoreStoreDocument,
} from './memory-plugin-core-store.js'
import type {
  PluginCoreArtifactRecordView, PluginCoreCompleteInput, PluginCoreCreateResult,
  PluginCoreFailInput, PluginCoreRunningResult, PluginCoreStore,
} from './plugin-core-store.js'

/** SQLite persists the memory document in one row; local/dev only, not multi-writer. */
export class SqlitePluginCoreStore implements PluginCoreStore {
  private readonly db: DatabaseSync
  private writes: Promise<void> = Promise.resolve()

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS plugin_core_store_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    )`)
  }

  close(): void { this.db.close() }

  async createRun(spec: NewPluginCoreRunSpec): Promise<PluginCoreCreateResult> {
    return this.write(store => store.createRun(spec))
  }

  async getRunAccessFacts(runId: RunId): Promise<PluginCoreRunAccessFacts | null> {
    return this.read(store => store.getRunAccessFacts(runId))
  }

  async getRun(runId: RunId): Promise<PluginCoreRunRecord | null> {
    return this.read(store => store.getRun(runId))
  }

  async markRunning(runId: RunId): Promise<PluginCoreRunningResult> {
    return this.write(store => store.markRunning(runId))
  }

  async requestStop(runId: RunId): Promise<boolean> {
    return this.write(store => store.requestStop(runId))
  }

  async completeRun(input: PluginCoreCompleteInput) {
    return this.write(store => store.completeRun(input))
  }

  async failRun(input: PluginCoreFailInput) {
    return this.write(store => store.failRun(input))
  }

  async cancelRun(runId: RunId, expiresAt: string, cleanup?: PluginCoreCleanup): Promise<boolean> {
    return this.write(store => store.cancelRun(runId, expiresAt, cleanup))
  }

  async appendEvents(runId: RunId, events: readonly PluginCoreEventAppend[]): Promise<PluginCoreEvent[]> {
    return this.write(store => store.appendEvents(runId, events))
  }

  async listEvents(runId: RunId, afterEventId: number, limit: number): Promise<PluginCoreEvent[]> {
    return this.read(store => store.listEvents(runId, afterEventId, limit))
  }

  async earliestEventId(runId: RunId): Promise<number | null> {
    return this.read(store => store.earliestEventId(runId))
  }

  async latestEventId(runId: RunId): Promise<number | null> {
    return this.read(store => store.latestEventId(runId))
  }

  async getArtifact(runId: RunId, artifactId: string): Promise<
    { record: PluginCoreArtifactRecordView; contentBase64: string } | null> {
    return this.read(store => store.getArtifact(runId, artifactId))
  }

  async countActiveRuns(): Promise<number> {
    return this.read(store => store.countActiveRuns())
  }

  async sweepExpired(now: string, limit: number): Promise<number> {
    return this.write(store => store.sweepExpired(now, limit))
  }

  async deleteRun(runId: RunId): Promise<boolean> {
    return this.write(store => store.deleteRun(runId))
  }

  private read<T>(work: (store: MemoryPluginCoreStore) => Promise<T>): Promise<T> {
    return this.writes.then(() => work(this.load()))
  }

  private write<T>(work: (store: MemoryPluginCoreStore) => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => {
      const store = this.load()
      const value = await work(store)
      this.save(store.toDocument())
      return value
    })
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }

  private load(): MemoryPluginCoreStore {
    const row = this.db.prepare(
      'SELECT payload FROM plugin_core_store_snapshot WHERE id = 1',
    ).get() as { payload?: string } | undefined
    if (row?.payload === undefined) return new MemoryPluginCoreStore()
    let document: PluginCoreStoreDocument
    try {
      document = JSON.parse(row.payload) as PluginCoreStoreDocument
    } catch {
      throw new Error('plugin_core_store_snapshot_invalid')
    }
    if (document.schemaVersion !== 1 || !Array.isArray(document.runs)
      || typeof document.events !== 'object' || typeof document.artifacts !== 'object') {
      throw new Error('plugin_core_store_snapshot_invalid')
    }
    return MemoryPluginCoreStore.fromDocument(document)
  }

  private save(document: PluginCoreStoreDocument): void {
    this.db.prepare(`INSERT INTO plugin_core_store_snapshot (id, payload)
      VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`)
      .run(JSON.stringify(document))
  }
}

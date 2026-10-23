import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelPluginCoreDelivery, PluginCoreBuildFailure, RunId } from '@ggb-copilot/application'

/** Shared candidate and quarantine ownership; never scans a delivery directory. */
export class PluginCoreExecutionState {
  private readonly builds = new Map<string, { buildId: string; failure?: PluginCoreBuildFailure }>()
  startBuild(runId: RunId, buildId: string): void {
    this.builds.set(runId, { buildId, failure: { kind: 'execution_failed', lastBuildId: buildId,
      error: { code: 'build_interrupted', message: 'The build did not return a validated result.' },
      failedChecks: [], reasons: ['The build did not return a validated result.'] } })
  }
  finishBuild(runId: RunId, buildId: string, failure?: PluginCoreBuildFailure): void {
    this.builds.set(runId, { buildId, ...(failure === undefined ? {} : { failure }) })
  }
  buildFailure(runId: RunId): PluginCoreBuildFailure | undefined {
    const latest = this.builds.get(runId)
    return latest === undefined ? { kind: 'not_built', failedChecks: [], reasons: [] } : latest.failure
  }
  missingDeliveryFailure(runId: RunId): PluginCoreBuildFailure {
    return this.buildFailure(runId) ?? { kind: 'execution_failed', lastBuildId: this.builds.get(runId)!.buildId,
      error: { code: 'accepted_receipt_missing', message: 'No accepted receipt is available for the last build.' },
      failedChecks: [], reasons: ['No accepted receipt is available for the last build.'] }
  }
  private readonly deadlines = new Map<string, number>()
  setDeadline(runId: RunId, deadline: number): void { this.deadlines.set(runId, deadline) }
  deadline(runId: RunId): number { return this.deadlines.get(runId) ?? Number.POSITIVE_INFINITY }
  release(runId: RunId): void { this.deadlines.delete(runId); this.builds.delete(runId); this.invalidate(runId) }
  private readonly candidates = new Map<string, ChannelPluginCoreDelivery>()
  private readonly failed = new Set<string>()
  constructor(private readonly root: string) {}

  /** Exclusive persisted ownership prevents a restarted Worker from reusing an unknown run. */
  async acquireEpoch(runId: RunId): Promise<number> {
    const dir = join(this.root, runId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    let owner
    try { owner = await open(join(dir, 'owner.json'), 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await this.quarantine(runId)
      throw new Error('plugin_core_cleanup_failed')
    }
    try {
      let previous = 0
      try { previous = JSON.parse(await readFile(join(dir, 'epoch.json'), 'utf8')).epoch }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
        throw new Error('plugin_core_epoch_invalid')
      }
      const epoch = previous + 1
      await writeFile(join(dir, 'epoch.json'), JSON.stringify({ epoch }), { mode: 0o600 })
      await owner.writeFile(JSON.stringify({ runId, epoch }))
      return epoch
    } catch (error) { await this.quarantine(runId); throw error }
    finally { await owner.close() }
  }
  async releaseOwner(runId: RunId): Promise<void> {
    if (!this.unsafe(runId)) await rm(join(this.root, runId, 'owner.json'), { force: true })
  }
  /** Boot has no active runs: leftover owners are unknown and reserve their slots. */
  async fenceOrphans(): Promise<void> {
    let entries: string[]
    try { entries = await readdir(this.root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of entries.filter(name => /^run_[a-f0-9-]{36}$/u.test(name))) {
      try { await readFile(join(this.root, name, 'owner.json')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      await this.quarantine(name as RunId)
    }
  }
  invalidate(runId: RunId): void { this.candidates.delete(runId) }
  accept(runId: RunId, delivery: ChannelPluginCoreDelivery): void {
    if (this.failed.has(runId)) throw new Error('plugin_core_cleanup_failed')
    this.candidates.set(runId, delivery)
  }
  candidate(runId: RunId): ChannelPluginCoreDelivery | null {
    return this.candidates.get(runId) ?? null
  }
  async quarantine(runId: RunId): Promise<void> {
    this.failed.add(runId)
    this.invalidate(runId)
    const dir = join(this.root, runId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'quarantine.json'), JSON.stringify({ runId,
      reason: 'plugin_core_cleanup_failed', createdAt: new Date().toISOString() }), { mode: 0o600 })
  }
  unsafe(runId: RunId): boolean { return this.failed.has(runId) }
  async quarantinedCount(): Promise<number> {
    let entries: string[]
    try { entries = await readdir(this.root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.failed.size
      throw error
    }
    for (const run of entries.filter(name => name.startsWith('run_'))) {
      try { await readFile(join(this.root, run, 'quarantine.json')); this.failed.add(run) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return this.failed.size
  }
  /** Persisted failures fence their slot across a Worker restart. */
  async assertRunSafe(runId: RunId): Promise<void> {
    try {
      await readFile(join(this.root, runId, 'quarantine.json'))
      this.failed.add(runId)
      throw new Error('plugin_core_cleanup_failed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * Update coordination (§11): a waiting Service Worker must not force an
 * activate/reload while a plugin-core run is still unsettled.
 */
export interface UpdateCoordinatorDeps {
  /** True while a plugin-core run has not reached a terminal event. */
  hasUnsettledWork(): Promise<boolean>
  reload(): void
  notifyPendingUpdate?(): void
}

export interface UpdateState {
  waiting: boolean
  deferred: boolean
}

export class UpdateCoordinator {
  private waiting = false
  private deferred = false

  public constructor(private readonly deps: UpdateCoordinatorDeps) {}

  /** Called when a new Service Worker reaches `waiting`. */
  public async onWaiting(): Promise<UpdateState> {
    this.waiting = true
    if (await this.deps.hasUnsettledWork()) {
      this.deferred = true
      this.deps.notifyPendingUpdate?.()
      return this.state
    }
    this.deferred = false
    return this.state
  }

  /** Called after a run settles; applies a previously deferred update. */
  public async applyIfIdle(): Promise<UpdateState> {
    if (!this.waiting) return this.state
    if (await this.deps.hasUnsettledWork()) return this.state
    this.deferred = false
    this.deps.reload()
    return this.state
  }

  public get state(): UpdateState {
    return { waiting: this.waiting, deferred: this.deferred }
  }
}

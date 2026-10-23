import { UpdateCoordinator } from './update-coordinator.js'

export interface RegisterServiceWorkerOptions {
  url?: string
  /** True while a plugin-core run is still unsettled. */
  hasUnsettledWork(): Promise<boolean>
  reload(): void
  notifyPendingUpdate?(): void
}

/**
 * Registers the module Service Worker and defers activation while the browser
 * still owns an unsettled execution (§11). Reloads are never forced.
 */
export async function registerServiceWorker(options: RegisterServiceWorkerOptions): Promise<UpdateCoordinator | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  const coordinator = new UpdateCoordinator({
    hasUnsettledWork: options.hasUnsettledWork,
    reload: options.reload,
    ...(options.notifyPendingUpdate === undefined ? {} : { notifyPendingUpdate: options.notifyPendingUpdate }),
  })
  const registration = await navigator.serviceWorker.register(options.url ?? '/service-worker.js', { type: 'module' })
  const track = (worker: ServiceWorker | null): void => {
    if (worker === null) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller !== null) void coordinator.onWaiting()
    })
  }
  track(registration.waiting)
  track(registration.installing)
  registration.addEventListener('updatefound', () => track(registration.installing))
  return coordinator
}

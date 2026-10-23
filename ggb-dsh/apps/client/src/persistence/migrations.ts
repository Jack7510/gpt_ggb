/**
 * Client-local IndexedDB schema (§3.2). Every store here is browser-only data:
 * conversation sessions, messages, run bindings, canvas references and sealed
 * run tokens. No server state is mirrored.
 */
export const CLIENT_SCHEMA_VERSION = 2

export type ClientStoreName =
  | 'sessions'
  | 'messages'
  | 'run_bindings'
  | 'canvas_bindings'
  | 'secrets'

export interface ClientIndexSpec {
  readonly name: string
  readonly keyPath: string
}

export interface ClientStoreSpec {
  readonly name: ClientStoreName
  readonly keyPath: string
  readonly indexes: readonly ClientIndexSpec[]
}

export const CLIENT_STORES: readonly ClientStoreSpec[] = [
  { name: 'sessions', keyPath: 'sessionId', indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }] },
  { name: 'messages', keyPath: 'messageId', indexes: [{ name: 'sessionId', keyPath: 'sessionId' }] },
  { name: 'run_bindings', keyPath: 'runId', indexes: [{ name: 'sessionId', keyPath: 'sessionId' }] },
  { name: 'canvas_bindings', keyPath: 'sessionId', indexes: [] },
  { name: 'secrets', keyPath: 'name', indexes: [] },
]

/**
 * Forward-only schema upgrade. Version 1 creates the initial stores; later
 * versions must append an `oldVersion < N` block instead of editing this one so
 * existing browsers migrate instead of losing local sessions.
 */
export function upgradeClientSchema(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    for (const spec of CLIENT_STORES) {
      const store = db.createObjectStore(spec.name, { keyPath: spec.keyPath })
      for (const index of spec.indexes) store.createIndex(index.name, index.keyPath, { unique: false })
    }
  }
  // Version 2 removes the retired Native execution journal. A fresh database
  // never creates it; existing browsers drop the orphaned store on upgrade.
  if (oldVersion < 2 && db.objectStoreNames.contains('journal')) {
    db.deleteObjectStore('journal')
  }
}

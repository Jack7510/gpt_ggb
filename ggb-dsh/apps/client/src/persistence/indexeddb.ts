import { CLIENT_SCHEMA_VERSION, CLIENT_STORES, upgradeClientSchema, type ClientStoreName } from './migrations.js'

/**
 * Narrow persistence port the session repository and token vault share.
 * Implementations: real IndexedDB in the browser, in-memory for tests and for
 * browsers where private-mode storage is unavailable.
 */
export interface ClientDatabase {
  readonly schemaVersion: number
  put(store: ClientStoreName, value: unknown): Promise<void>
  get<T>(store: ClientStoreName, key: string): Promise<T | null>
  getAll<T>(store: ClientStoreName): Promise<T[]>
  getAllByIndex<T>(store: ClientStoreName, index: string, key: string): Promise<T[]>
  delete(store: ClientStoreName, key: string): Promise<void>
  clear(store: ClientStoreName): Promise<void>
  close(): void
}

export const CLIENT_DATABASE_NAME = 'ggb-copilot-client'

export function isIndexedDbAvailable(scope: unknown = globalThis): boolean {
  return typeof (scope as { indexedDB?: unknown }).indexedDB !== 'undefined'
}

/** Opens (and migrates) the browser database. Callers must handle rejection. */
export function openClientDatabase(
  factory: IDBFactory,
  name: string = CLIENT_DATABASE_NAME,
): Promise<ClientDatabase> {
  return new Promise<ClientDatabase>((resolve, reject) => {
    const request = factory.open(name, CLIENT_SCHEMA_VERSION)
    request.onupgradeneeded = (event) => {
      upgradeClientSchema(request.result, event.oldVersion)
    }
    request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'))
    request.onblocked = () => reject(new Error('indexeddb_open_blocked'))
    request.onsuccess = () => resolve(new IndexedDbClientDatabase(request.result))
  })
}

class IndexedDbClientDatabase implements ClientDatabase {
  public readonly schemaVersion = CLIENT_SCHEMA_VERSION

  public constructor(private readonly db: IDBDatabase) {}

  public put(store: ClientStoreName, value: unknown): Promise<void> {
    return this.transact(store, 'readwrite', (objectStore) => objectStore.put(value))
  }

  public async get<T>(store: ClientStoreName, key: string): Promise<T | null> {
    const value = await this.request<T | undefined>(store, 'readonly', (objectStore) => objectStore.get(key))
    return value ?? null
  }

  public getAll<T>(store: ClientStoreName): Promise<T[]> {
    return this.request<T[]>(store, 'readonly', (objectStore) => objectStore.getAll())
  }

  public getAllByIndex<T>(store: ClientStoreName, index: string, key: string): Promise<T[]> {
    return this.request<T[]>(store, 'readonly', (objectStore) => objectStore.index(index).getAll(key))
  }

  public delete(store: ClientStoreName, key: string): Promise<void> {
    return this.transact(store, 'readwrite', (objectStore) => objectStore.delete(key))
  }

  public clear(store: ClientStoreName): Promise<void> {
    return this.transact(store, 'readwrite', (objectStore) => objectStore.clear())
  }

  public close(): void {
    this.db.close()
  }

  private request<T>(
    store: ClientStoreName,
    mode: IDBTransactionMode,
    run: (objectStore: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transaction = this.db.transaction(store, mode)
      const request = run(transaction.objectStore(store))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => reject(request.error ?? new Error('indexeddb_request_failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb_transaction_aborted'))
    })
  }

  private transact(
    store: ClientStoreName,
    mode: IDBTransactionMode,
    run: (objectStore: IDBObjectStore) => IDBRequest,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transaction = this.db.transaction(store, mode)
      run(transaction.objectStore(store))
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb_transaction_aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb_transaction_failed'))
    })
  }
}

/** In-memory adapter used by tests and by hosts without usable IndexedDB. */
export function createMemoryDatabase(): ClientDatabase {
  const stores = new Map<ClientStoreName, Map<string, unknown>>(
    CLIENT_STORES.map((spec) => [spec.name, new Map<string, unknown>()]),
  )
  const keyPathOf = (store: ClientStoreName): string =>
    CLIENT_STORES.find((spec) => spec.name === store)?.keyPath ?? 'id'
  const indexKeyPathOf = (store: ClientStoreName, index: string): string | null =>
    CLIENT_STORES.find((spec) => spec.name === store)?.indexes.find((entry) => entry.name === index)?.keyPath ?? null
  const bucket = (store: ClientStoreName): Map<string, unknown> => {
    const existing = stores.get(store)
    if (existing === undefined) throw new Error(`unknown client store: ${store}`)
    return existing
  }

  return {
    schemaVersion: CLIENT_SCHEMA_VERSION,
    put: async (store, value) => {
      const keyPath = keyPathOf(store)
      const key = (value as Record<string, unknown>)[keyPath]
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error(`client store ${store} requires a string ${keyPath}`)
      }
      bucket(store).set(key, structuredClone(value))
    },
    get: async <T>(store: ClientStoreName, key: string): Promise<T | null> => {
      const value = bucket(store).get(key)
      return value === undefined ? null : (structuredClone(value) as T)
    },
    getAll: async <T>(store: ClientStoreName): Promise<T[]> =>
      [...bucket(store).values()].map((value) => structuredClone(value) as T),
    getAllByIndex: async <T>(store: ClientStoreName, index: string, key: string): Promise<T[]> => {
      const keyPath = indexKeyPathOf(store, index)
      if (keyPath === null) throw new Error(`unknown index ${index} on client store ${store}`)
      return [...bucket(store).values()]
        .filter((value) => (value as Record<string, unknown>)[keyPath] === key)
        .map((value) => structuredClone(value) as T)
    },
    delete: async (store, key) => {
      bucket(store).delete(key)
    },
    clear: async (store) => {
      bucket(store).clear()
    },
    close: () => undefined,
  }
}

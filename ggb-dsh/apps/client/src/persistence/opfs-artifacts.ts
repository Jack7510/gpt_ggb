/**
 * Binary artifact storage for `.ggb` canvas copies (§3.2). OPFS is the browser
 * implementation; the memory adapter keeps tests and unsupported hosts working.
 */
export interface ArtifactStore {
  put(path: string, bytes: Uint8Array): Promise<void>
  get(path: string): Promise<Uint8Array | null>
  delete(path: string): Promise<void>
  /** Deletes all private canvas artifacts belonging to one local Session. */
  deleteSession(sessionId: string): Promise<void>
  clear(): Promise<void>
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Canvas paths are locally generated, but they still reach the filesystem, so
 * reject traversal and separators instead of trusting the caller.
 */
export function assertArtifactPath(path: string): readonly string[] {
  const segments = path.split('/')
  if (segments.length === 0 || segments.length > 4) throw new Error('artifact_path_invalid')
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error('artifact_path_invalid')
    }
  }
  return segments
}

/** Build the deterministic OPFS path for one session's canvas version. */
export function canvasArtifactPath(sessionId: string, canvasVersion: string): string {
  const session = canvasArtifactDirectory(sessionId)
  const version = canvasVersion.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return `${session}/${version}.ggb`
}

/**
 * Keep the exact Server-delivered GGB for download. The canvas snapshot is a
 * GeoGebra re-serialization, so it can differ in bytes and SHA-256.
 */
export function deliveryArtifactPath(sessionId: string, runId: string): string {
  const session = canvasArtifactDirectory(sessionId)
  const run = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return `${session}/deliveries/${run}.ggb`
}

/** Stable, traversal-safe OPFS directory name for a locally generated Session id. */
export function canvasArtifactDirectory(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
}

export async function createOpfsArtifactStore(root?: FileSystemDirectoryHandle): Promise<ArtifactStore> {
  const base = root ?? (await navigator.storage.getDirectory())
  return new OpfsArtifactStore(base)
}

class OpfsArtifactStore implements ArtifactStore {
  public constructor(private readonly root: FileSystemDirectoryHandle) {}

  public async put(path: string, bytes: Uint8Array): Promise<void> {
    const segments = assertArtifactPath(path)
    const directory = await this.directory(segments.slice(0, -1), true)
    const handle = await directory!.getFileHandle(segments[segments.length - 1]!, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(new Uint8Array(bytes))
    } finally {
      await writable.close()
    }
  }

  public async get(path: string): Promise<Uint8Array | null> {
    const segments = assertArtifactPath(path)
    const directory = await this.directory(segments.slice(0, -1), false)
    if (directory === null) return null
    const handle = await directory
      .getFileHandle(segments[segments.length - 1]!)
      .catch(() => null)
    if (handle === null) return null
    const file = await handle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  }

  public async delete(path: string): Promise<void> {
    const segments = assertArtifactPath(path)
    const fileName = segments[segments.length - 1]!
    const directory = await this.directory(segments.slice(0, -1), false)
    await directory?.removeEntry(fileName).catch(() => undefined)
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const directory = canvasArtifactDirectory(sessionId)
    await this.root.removeEntry(directory, { recursive: true }).catch(() => undefined)
  }

  public async clear(): Promise<void> {
    for await (const name of this.root.keys()) {
      await this.root.removeEntry(name, { recursive: true }).catch(() => undefined)
    }
  }

  private async directory(segments: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let current = this.root
    for (const segment of segments) {
      try {
        current = await current.getDirectoryHandle(segment, { create })
      } catch (error) {
        if (!create && error instanceof DOMException && error.name === 'NotFoundError') return null
        throw error
      }
    }
    return current
  }
}

export function createMemoryArtifactStore(): ArtifactStore {
  const files = new Map<string, Uint8Array>()
  return {
    put: async (path, bytes) => {
      assertArtifactPath(path)
      files.set(path, Uint8Array.from(bytes))
    },
    get: async (path) => {
      assertArtifactPath(path)
      const value = files.get(path)
      return value === undefined ? null : Uint8Array.from(value)
    },
    delete: async (path) => {
      assertArtifactPath(path)
      files.delete(path)
    },
    deleteSession: async (sessionId) => {
      const prefix = `${canvasArtifactDirectory(sessionId)}/`
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) files.delete(path)
      }
    },
    clear: async () => {
      files.clear()
    },
  }
}

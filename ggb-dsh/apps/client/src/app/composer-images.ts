import { MAX_PLUGIN_IMAGE_BYTES, pluginCoreImageSchema, type PluginCoreImage } from '@ggb-copilot/application/browser'
import { encodeBase64 } from '../geogebra/snapshot.js'

export interface ComposerImage extends PluginCoreImage { name: string; previewUrl: string }

/** Clipboard text keeps native paste behavior. Files never become prompt text. */
export function clipboardImage(data: DataTransfer): File | null {
  const files = Array.from(data.files)
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file !== null) files.push(file)
      }
    }
  }
  if (files.length === 0) return null
  if (files.length !== 1) throw new Error('image_single_only')
  return files[0]!
}

/** Drafts belong to a session; late reads cannot replace a newer selection. */
export class ComposerImages {
  readonly loading = new Set<string>()
  readonly entries = new Map<string, ComposerImage>()
  private readonly revisions = new Map<string, number>()
  private disposed = false

  async select(sessionId: string, file: File): Promise<void> {
    if (this.disposed) return
    const revision = (this.revisions.get(sessionId) ?? 0) + 1
    this.revisions.set(sessionId, revision)
    this.loading.add(sessionId)
    try {
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size === 0
        || file.size > MAX_PLUGIN_IMAGE_BYTES) throw new Error('image_invalid')
      const image = pluginCoreImageSchema.safeParse({ mediaType: file.type,
        dataBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())) })
      if (!image.success) throw new Error('image_invalid')
      // Decode locally: a plausible header alone is not a previewable image.
      const bitmap = await createImageBitmap(file)
      const valid = bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= 20_000_000
      bitmap.close()
      if (!valid) throw new Error('image_invalid')
      if (this.disposed || this.revisions.get(sessionId) !== revision) return
      const previewUrl = URL.createObjectURL(file)
      this.remove(sessionId)
      this.entries.set(sessionId, { ...image.data, name: file.name, previewUrl })
    } finally {
      if (this.revisions.get(sessionId) === revision) this.loading.delete(sessionId)
    }
  }

  remove(sessionId: string, expected?: ComposerImage): void {
    const previous = this.entries.get(sessionId)
    if (expected !== undefined && previous !== expected) return
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1)
    if (previous !== undefined) URL.revokeObjectURL(previous.previewUrl)
    this.entries.delete(sessionId)
    this.loading.delete(sessionId)
  }

  dispose(): void {
    this.disposed = true
    for (const id of new Set([...this.entries.keys(), ...this.loading])) this.remove(id)
  }
}

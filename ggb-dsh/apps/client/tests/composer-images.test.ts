import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerImages, clipboardImage } from '../src/app/composer-images.js'
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
const file = (name = 'problem.png') => new File([bytes], name, { type: 'image/png' })
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  let id = 0
  const revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => `blob:${++id}`, revokeObjectURL: revoke })
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })))
  return { drafts: new ComposerImages(), revoke }
}
describe('composer image drafts', () => {
  it('supports clipboard files/items and leaves text alone; rejects multiple files', () => {
    const image = file()
    expect(clipboardImage({ files: [], items: [] } as unknown as DataTransfer)).toBeNull()
    expect(clipboardImage({ files: [image], items: [] } as unknown as DataTransfer)).toBe(image)
    expect(clipboardImage({ files: [], items: [{ kind: 'file', getAsFile: () => image }] } as unknown as DataTransfer)).toBe(image)
    expect(() => clipboardImage({ files: [image, image] } as unknown as DataTransfer)).toThrow('image_single_only')
  })
  it('isolates sessions, preserves failed submissions, revokes previews on replacement/removal/dispose', async () => {
    const { drafts, revoke } = fixture()
    await drafts.select('a', file('a.png'))
    const a = drafts.entries.get('a')!
    await drafts.select('b', file('b.png'))
    expect(drafts.entries.get('a')).toBe(a)
    // Failed requests do not call remove; both drafts survive.
    expect(drafts.entries.size).toBe(2)
    await drafts.select('a', file('new.png'))
    expect(revoke).toHaveBeenCalledWith(a.previewUrl)
    drafts.remove('a', a) // completion of an old submission cannot remove a new image
    expect(drafts.entries.get('a')?.name).toBe('new.png')
    drafts.remove('b')
    drafts.dispose()
    expect(drafts.entries.size).toBe(0)
    expect(revoke).toHaveBeenCalledTimes(3)
  })
  it('keeps the previous draft when type, bytes, size or decoding fails', async () => {
    const { drafts } = fixture()
    await drafts.select('a', file())
    const previous = drafts.entries.get('a')
    for (const invalid of [new File([bytes], 'x.svg', { type: 'image/svg+xml' }),
      new File([], 'empty.png', { type: 'image/png' }),
      new File(['text'], 'fake.png', { type: 'image/png' }),
      new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })]) {
      await expect(drafts.select('a', invalid)).rejects.toThrow()
      expect(drafts.entries.get('a')).toBe(previous)
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed') }))
    await expect(drafts.select('a', file())).rejects.toThrow()
    expect(drafts.entries.get('a')).toBe(previous)
    drafts.dispose()
  })
  it('ignores reads that finish after removal, newer selection or disposal', async () => {
    const { drafts } = fixture()
    let finish!: (buffer: ArrayBuffer) => void
    const slow = file('slow.png')
    slow.arrayBuffer = () => new Promise(resolve => { finish = resolve })
    const pending = drafts.select('a', slow)
    expect(drafts.loading.has('a')).toBe(true)
    await drafts.select('a', file('latest.png'))
    finish(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    await pending
    expect(drafts.entries.get('a')?.name).toBe('latest.png')
    expect(drafts.loading.has('a')).toBe(false)
    const removed = drafts.select('b', slow)
    drafts.remove('b')
    expect(drafts.loading.has('b')).toBe(false)
    finish(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    await removed
    expect(drafts.entries.has('b')).toBe(false)
    const disposed = drafts.select('a', slow)
    drafts.dispose()
    finish(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    await disposed
    expect(drafts.entries.size).toBe(0)
  })
  it('rejects decoded images above the pixel limit and closes the bitmap', async () => {
    const { drafts } = fixture()
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10000, height: 10000, close }))
    await expect(drafts.select('a', file())).rejects.toThrow('image_invalid')
    expect(close).toHaveBeenCalledOnce()
    expect(drafts.entries.size).toBe(0)
  })
})

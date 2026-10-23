import { describe, expect, it } from 'vitest'
import { MAX_PLUGIN_IMAGE_BYTES, pluginCoreImageSchema } from '../src/plugin-core-image.js'
import { channelPluginCoreRequestSchema } from '../src/internal-channel.js'
const image = { mediaType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' }
describe('ephemeral plugin image contract', () => {
  it('accepts PNG and JPEG, rejects MIME spoofing and extra fields', () => {
    expect(pluginCoreImageSchema.parse(image)).toEqual(image)
    expect(pluginCoreImageSchema.safeParse({ mediaType: 'image/jpeg', dataBase64: '/9j/2Q==' }).success).toBe(true)
    for (const value of [null, { ...image, mediaType: 'image/svg+xml' }, { ...image, mediaType: 'image/jpeg' },
      { ...image, name: 'injected' }, { ...image, dataBase64: 'data:image/png;base64,' + image.dataBase64 }]) {
      expect(pluginCoreImageSchema.safeParse(value).success).toBe(false)
    }
  })
  it('rejects malformed, noncanonical, empty, truncated and oversized bytes', () => {
    for (const dataBase64 of ['', '!!!!', 'A===', 'Zh==', 'AAAA\n', 'iVBORw0KGgo=',
      Buffer.alloc(MAX_PLUGIN_IMAGE_BYTES + 1).toString('base64')]) {
      expect(pluginCoreImageSchema.safeParse({ ...image, dataBase64 }).success).toBe(false)
    }
  })
  it('keeps maximum image and base below the 16 MiB request frame', () => {
    const request = { prompt: 'x'.repeat(12000), image: { dataBase64: Buffer.alloc(MAX_PLUGIN_IMAGE_BYTES).toString('base64') },
      base: { dataBase64: Buffer.alloc(8 * 1024 * 1024).toString('base64') } }
    expect(Buffer.byteLength(JSON.stringify(request)) + 4096).toBeLessThan(16 * 1024 * 1024)
  })
  it('authenticates and validates the image as part of the internal request', () => {
    expect(channelPluginCoreRequestSchema.shape.image.safeParse(image).success).toBe(true)
    expect(channelPluginCoreRequestSchema.shape.image.safeParse({ ...image, dataBase64: 'bad' }).success).toBe(false)
  })
})

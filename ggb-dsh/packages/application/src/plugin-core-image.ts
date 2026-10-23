import { z } from 'zod'

/** Three MiB plus the eight MiB base fits the authenticated 16 MiB frame. */
export const MAX_PLUGIN_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_PLUGIN_IMAGE_BYTES / 3)

/** Ephemeral image input: never part of a persisted run or diagnostic payload. */
export const pluginCoreImageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg']),
  dataBase64: z.string().min(1).max(MAX_BASE64_CHARS),
}).strict().superRefine((image, ctx) => {
  const text = image.dataBase64
  if (text.length > MAX_BASE64_CHARS || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
    ctx.addIssue({ code: 'custom', message: 'image_base64_invalid' })
    return
  }
  const bytes = atob(text)
  if (btoa(bytes) !== text || bytes.length > MAX_PLUGIN_IMAGE_BYTES || bytes.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'image_base64_invalid' })
    return
  }
  const png = bytes.startsWith('\x89PNG\r\n\x1a\n') && bytes.length >= 24
    && bytes.slice(12, 16) === 'IHDR'
  const jpeg = bytes.startsWith('\xff\xd8\xff') && bytes.length >= 4
    && bytes.endsWith('\xff\xd9')
  if (!(image.mediaType === 'image/png' ? png : jpeg)) {
    ctx.addIssue({ code: 'custom', message: 'image_signature_invalid' })
  }
})
export type PluginCoreImage = z.infer<typeof pluginCoreImageSchema>

import { z } from 'zod'

/** The browser-selected language for all user-visible output. */
export const presentationLocaleSchema = z.enum(['zh-CN', 'en'])
export type PresentationLocale = z.infer<typeof presentationLocaleSchema>

import { z } from 'zod'

import { allowedCorpusIdSchema } from './corpus-id.js'

/** Version-controlled, reviewed knowledge record shared by both runtimes. */
export const knowledgeEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4_000),
  tags: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  corpusId: allowedCorpusIdSchema,
  status: z.literal('approved'),
  version: z.string().trim().min(1).max(64),
  language: z.enum(['zh', 'en', 'multilingual']),
  capabilityVersion: z.string().trim().min(1).max(64),
  sourceVersion: z.string().trim().min(1).max(64),
  reviewedAt: z.iso.datetime({ offset: true }),
}).strict()
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>

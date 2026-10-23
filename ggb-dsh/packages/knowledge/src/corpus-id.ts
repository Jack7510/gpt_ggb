import { z } from 'zod'

/** Reviewed knowledge corpora retained for the optional RAG corpus. */
export const allowedCorpusIdSchema = z.enum([
  'construction_patterns', 'solved_tasks', 'ggb_manual_commands', 'failure_guidance',
])
export type AllowedCorpusId = z.infer<typeof allowedCorpusIdSchema>

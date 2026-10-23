import { z } from 'zod'

import {
  isDeclarativeGeoGebraManualCommandV1,
} from '@ggb-copilot/geometry-contract'

/** Pinned overload body, including examples/notes. Empty text is missing documentation. */
export const manualCommandUsageSchema = z.object({
  text: z.string().max(12_000),
  truncated: z.boolean(),
}).strict()

/** Public page introduction and one-hop official references from the same pinned source. */
export const manualCommandContextSchema = z.object({
  overview: manualCommandUsageSchema,
  related: z.array(z.object({ sourcePath: z.string().min(1).max(300), sourceUrl: z.url(),
    available: z.boolean(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(12_000), truncated: z.boolean() }).strict()).max(4),
  omittedRelated: z.number().int().nonnegative(),
}).strict()

export const manualCommandCardSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,95}$/),
  command: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
  signature: z.string().trim().min(3).max(500),
  parameterTypes: z.array(z.string().trim().min(1).max(100)).max(16),
  parameterRoles: z.array(z.string().trim().min(1).max(100)).max(16).optional(),
  arity: z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative().nullable(),
    variadic: z.boolean() }).strict().optional(),
  outputKind: z.string().trim().min(1).max(80).optional(),
  outputCardinality: z.enum(['zero', 'one', 'many', 'unknown']).optional(),
  effect: z.enum(['construction', 'presentation', 'side_effect', 'unknown']).optional(),
  dimension: z.enum(['2d', '3d', 'both', 'unknown']).optional(),
  safety: z.enum(['safe', 'restricted', 'unknown']).optional(),
  description: z.string().trim().max(500),
  usage: manualCommandUsageSchema,
  context: manualCommandContextSchema,
  sourcePath: z.string().trim().min(1).max(300),
  sourceUrl: z.url(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const manualCommandIndexSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    repository: z.literal('https://github.com/geogebra/manual'),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    language: z.literal('en'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  cards: z.array(manualCommandCardSchema),
  documents: z.array(z.object({
    documentRef: z.string().min(1).max(300), title: z.string().max(500), aliases: z.array(z.string()),
    sourcePath: z.string().min(1).max(300), sourceUrl: z.url(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/), text: z.string(), links: z.array(z.string()),
  }).strict()),
}).strict()

export type ManualCommandCard = z.infer<typeof manualCommandCardSchema>
export type ManualCommandIndex = z.infer<typeof manualCommandIndexSchema>
export type ManualDocument = ManualCommandIndex['documents'][number]

/** Treat pinned Manual construction commands as executable unless they cross a known side-effect boundary. */
export function isDeclarativeManualCommand(command: string): boolean {
  return isDeclarativeGeoGebraManualCommandV1(command)
}

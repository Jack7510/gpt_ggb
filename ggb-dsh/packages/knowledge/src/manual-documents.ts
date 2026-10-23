import { z } from 'zod'
import { OFFICIAL_GGB_MANUAL_INDEX } from './generated/official-manual-index.js'
import type { ManualDocument } from './manual-command.js'

export const manualDocumentMetadataSchema = z.object({ documentRef: z.string().min(1).max(300),
  title: z.string().max(500), sourceUrl: z.url(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const manualDocumentReadSchema = z.discriminatedUnion('status', [
  manualDocumentMetadataSchema.extend({ status: z.literal('found'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    offset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(), totalCharacters: z.number().int().nonnegative(),
    text: z.string().max(16000), complete: z.boolean(), nextOffset: z.number().int().nonnegative().nullable(),
    links: z.array(z.string().max(300)).max(16), omittedLinks: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('document_not_found'), documentRef: z.string().max(300) }).strict(),
  z.object({ status: z.literal('invalid_document_offset'), documentRef: z.string().max(300), totalCharacters: z.number().int().nonnegative() }).strict(),
])

const PAGE_BYTES = 16_000
const normalize = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Search official titles and xref labels only; results confer no execution or binding authority. */
export function searchManualConcept(concept: string): readonly ManualDocument[] {
  const query = normalize(concept)
  if (query.length === 0) return []
  return OFFICIAL_GGB_MANUAL_INDEX.documents.map(document => {
    const names = [document.title, document.documentRef, ...document.aliases].map(normalize)
    const score = names.includes(query) ? 2 : names.some(name => name.includes(query)) ? 1 : 0
    return { document, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score
    || a.document.documentRef.localeCompare(b.document.documentRef)).map(item => item.document)
}

/** Stable official identity, independent of a command overload or an execution object. */
export function manualDocumentMetadata(document: Pick<ManualDocument, 'documentRef' | 'title' | 'sourceUrl' | 'contentHash'>) {
  return { documentRef: document.documentRef, title: document.title, sourceUrl: document.sourceUrl,
    contentHash: document.contentHash }
}

/** Resolve a command page and its explicit one-hop official references from the pinned corpus. */
export function linkedManualDocuments(sourcePaths: readonly string[]): readonly ManualDocument[] {
  const pages = OFFICIAL_GGB_MANUAL_INDEX.documents.filter(document => sourcePaths.includes(document.sourcePath))
  const refs = new Set(pages.flatMap(document => [document.documentRef, ...document.links]))
  return [...refs].flatMap(ref => {
    const document = OFFICIAL_GGB_MANUAL_INDEX.documents.find(item => item.documentRef === ref)
    return document === undefined ? [] : [document]
  })
}

/** Read a lossless, resumable source range. Offsets count Unicode code points and never address files. */
export function readManualDocument(documentRef: string, offset = 0) {
  const document = OFFICIAL_GGB_MANUAL_INDEX.documents.find(item => item.documentRef === documentRef)
  if (document === undefined) return { status: 'document_not_found' as const, documentRef }
  const characters = [...document.text]
  if (!Number.isInteger(offset) || offset < 0 || offset > characters.length) {
    return { status: 'invalid_document_offset' as const, documentRef, totalCharacters: characters.length }
  }
  let bytes = 0
  let end = offset
  let paragraph = -1
  let line = -1
  while (end < characters.length) {
    const count = new TextEncoder().encode(characters[end]!).length
    if (bytes + count > PAGE_BYTES) break
    bytes += count
    if (characters[end] === '\n') {
      line = end + 1
      if (characters[end - 1] === '\n') paragraph = end + 1
    }
    end += 1
  }
  if (end < characters.length) end = paragraph > offset ? paragraph : line > offset ? line : end
  return { status: 'found' as const, ...manualDocumentMetadata(document),
    sourceCommit: OFFICIAL_GGB_MANUAL_INDEX.source.commit, offset, endOffset: end,
    totalCharacters: characters.length, text: characters.slice(offset, end).join(''),
    complete: offset === 0 && end === characters.length,
    nextOffset: end === characters.length ? null : end,
    links: document.links.slice(0, 16), omittedLinks: Math.max(0, document.links.length - 16) }
}

import { describe, expect, it } from 'vitest'
import { OFFICIAL_GGB_MANUAL_INDEX, searchManualConcept, readManualDocument, linkedManualDocuments } from '../src/index.js'

describe('pinned official concept documents', () => {
  it('finds the parameter definition through official link text and preserves the complete table', () => {
    expect(searchManualConcept('path parameter').map(doc => doc.documentRef)).toContain('commands/PathParameter')
    const doc = readManualDocument('commands/PathParameter')
    expect(doc).toMatchObject({ status: 'found', complete: true, nextOffset: null })
    if (doc.status !== 'found') throw new Error('missing document')
    expect(doc.text).toContain('Ellipse with center')
    expect(doc.text).toContain('\\frac{\\alpha+\\pi}{2\\pi}')
    const cards = OFFICIAL_GGB_MANUAL_INDEX.cards.filter(card => card.command === 'PathParameter')
    expect(cards[0]!.usage.text).toContain('Ellipse with center')
    expect(linkedManualDocuments(['en/modules/ROOT/pages/commands/Point.adoc'])
      .map(item => item.documentRef)).toContain('commands/PathParameter')
  })

  it('reads a long official page losslessly with returned continuation offsets', () => {
    const source = OFFICIAL_GGB_MANUAL_INDEX.documents.find(doc => new TextEncoder().encode(doc.text).length > 16_000)!
    expect(source).toBeDefined()
    let offset = 0
    let text = ''
    for (;;) {
      const doc = readManualDocument(source.documentRef, offset)
      if (doc.status !== 'found') throw new Error('missing range')
      expect(new TextEncoder().encode(doc.text).length).toBeLessThanOrEqual(16_000)
      text += doc.text
      if (doc.nextOffset === null) break
      expect(doc.nextOffset).toBeGreaterThan(offset)
      expect(doc.complete).toBe(false)
      offset = doc.nextOffset
    }
    expect(text).toBe(source.text)
  })

  it('cannot read arbitrary files or invent missing definitions', () => {
    expect(readManualDocument('../../.env')).toMatchObject({ status: 'document_not_found' })
    expect(readManualDocument('commands/Point', 1_000_000)).toMatchObject({ status: 'invalid_document_offset' })
    expect(searchManualConcept('nonexistent-concept-123')).toEqual([])
  })
})

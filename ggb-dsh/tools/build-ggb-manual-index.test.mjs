import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandCards, manualDocuments, writeNamingLabels } from './build-ggb-manual-index.mjs'

test('publishes reserved labels and all official command pages as browser-safe naming facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ggb-naming-facts-'))
  try {
    const output = join(root, 'names.ts')
    writeNamingLabels({ source: { commit: 'pinned' }, documents: [
      { documentRef: 'Naming_Objects', text: "These are the labels you can't use for objects: x, y, sin\n\nEnd" },
      { documentRef: 'commands/Center' }, { documentRef: 'commands/Focus' }, { documentRef: 'tools/Point' },
    ] }, output)
    const text = readFileSync(output, 'utf8')
    assert.match(text, /\["x","y","sin"\]/u)
    assert.match(text, /\["Center","Focus"\]/u)
    assert.doesNotMatch(text, /"Point"/u)
    assert.throws(() => writeNamingLabels({ documents: [] }, output), /official_reserved_labels_missing/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function cards(text) {
  const root = mkdtempSync(join(tmpdir(), 'ggb-manual-usage-'))
  try {
    const path = join(root, 'Point.adoc')
    writeFileSync(path, text)
    return commandCards(path, root, 'a'.repeat(40))
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('retains examples, notes and restrictions with the exact overload', () => {
  const result = cards(`= Point Command
Point( <Object> )::
Creates a point on the object.

[EXAMPLE]
====
Point(c) creates a movable point.
====

[NOTE]
====
The object must be a path.
====

Point( <Object>, <Parameter> )::
Uses a path parameter.

== CAS Syntax
Other text.
`)
  assert.equal(result.length, 2)
  assert.equal(result[0].description, 'Creates a point on the object.')
  assert.match(result[0].usage.text, /Point\(c\)/)
  assert.match(result[0].usage.text, /The object must be a path/)
  assert.equal(result[0].usage.truncated, false)
  assert.doesNotMatch(result[0].usage.text, /Uses a path parameter/)
  assert.doesNotMatch(result[1].usage.text, /Other text/)
})

test('marks bounded usage explicitly and hashes the full original body', () => {
  const prefix = 'Point( <Object> )::\n' + 'x'.repeat(13_000)
  const first = cards(prefix + 'a')[0]
  const second = cards(prefix + 'b')[0]
  assert.equal(first.usage.text.length, 12_000)
  assert.equal(first.usage.truncated, true)
  assert.equal(first.usage.text, second.usage.text)
  assert.notEqual(first.contentHash, second.contentHash)
})

test('keeps mathematical continuation lines and the following parameter table', () => {
  const result = cards('Example( <Point> )::\n[EXAMPLE]\n====\nThe value is _a\n= 0.47_.\n====\n\n[cols=",",]\n|===\n|Path |Formula\n|Ellipse |parameter definition\n|===\n')[0]
  assert.match(result.usage.text, /= 0.47/)
  assert.match(result.usage.text, /Ellipse \|parameter definition/)
  assert.equal(result.usage.truncated, false)
})

test('indexes complete concept pages and official xref labels without excerpt limits', async () => {
  const { mkdirSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'ggb-manual-documents-'))
  try {
    const pages = join(root, 'en/modules/ROOT/pages')
    mkdirSync(join(pages, 'commands'), { recursive: true })
    const body = '= Special Meaning\n' + 'x'.repeat(20_000) + '\nFinal definition.'
    writeFileSync(join(pages, 'Meaning.adoc'), body)
    writeFileSync(join(pages, 'commands/Example.adoc'), '= Example Command\nxref:/Meaning.adoc[parameter meaning]')
    const documents = manualDocuments(root)
    assert.equal(documents.find(doc => doc.documentRef === 'Meaning').text, body)
    assert.ok(documents.find(doc => doc.documentRef === 'Meaning').aliases.includes('parameter meaning'))
    assert.deepEqual(documents.find(doc => doc.documentRef === 'commands/Example').links, ['Meaning'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('keeps missing usage explicit instead of inventing semantics', () => {
  const result = cards('Point( <Object> )::\n\nPoint( <Object>, <Parameter> )::\nSome usage.')[0]
  assert.deepEqual(result.usage, { text: '', truncated: false })
})

test('retains public context and related official pages from the pinned source', async () => {
  const { mkdirSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'ggb-manual-context-'))
  try {
    mkdirSync(join(root, 'en/modules/ROOT/pages/tools'), { recursive: true })
    const path = join(root, 'Example.adoc')
    writeFileSync(path, '= Example Command\n:page-en: commands/Example\nPublic roles.\nExample( <Point> )::\nMakes an object.\nxref:/tools/Example.adoc[Example]\nxref:/tools/Missing.adoc[Missing]')
    const linked = join(root, 'en/modules/ROOT/pages/tools/Example.adoc')
    writeFileSync(linked, '= Example Tool\nThe point is a vertex.\nxref:/tools/Another.adoc[Another]')
    const first = commandCards(path, root, 'a'.repeat(40))[0]
    assert.equal(first.context.overview.text, 'Public roles.')
    assert.equal(first.context.related.length, 2)
    assert.match(first.context.related[0].text, /point is a vertex/)
    assert.equal(first.context.related[0].available, true)
    assert.equal(first.context.related[1].available, false)
    writeFileSync(linked, 'Changed roles.')
    assert.notEqual(first.contentHash, commandCards(path, root, 'a'.repeat(40))[0].contentHash)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bounds linked documents and reports omitted references', () => {
  const result = cards('Point( <Object> )::\nUsage.\n' + Array.from({ length: 6 }, (_, i) => `xref:/tools/Item${i}.adoc[Item]`).join('\n'))[0]
  assert.equal(result.context.related.length, 4)
  assert.equal(result.context.omittedRelated, 2)
})

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutput = resolve(root, 'packages/knowledge/src/generated/official-manual-index.ts')

/** @returns {{manualRoot: string, output: string}} */
function argumentsFromCommandLine() {
  const values = process.argv.slice(2)
  const option = name => {
    const index = values.indexOf(name)
    return index < 0 ? undefined : values[index + 1]
  }
  const manualRoot = option('--manual-root')
  if (!manualRoot) throw new Error('usage: pnpm manual:index -- --manual-root /path/to/geogebra/manual [--output path]')
  return { manualRoot: resolve(manualRoot), output: resolve(option('--output') ?? defaultOutput) }
}

/** Remove adoc macros that hide their display text inside brackets. Must run before any bracket rewrite. */
function stripMarkup(text) {
  return text.replace(/`\+\+|\+\+`|xref:[^[]+\[([^\]]+)\]|image:[^[]+\[[^\]]*\]/g, '$1')
}

/** @param {string} text @returns {string} */
function cleanText(text) {
  return stripMarkup(text)
    .replaceAll('[', '').replaceAll(']', '').replace(/[_*#]/g, '').replace(/\s+/g, ' ').trim()
}

/** @param {string[]} lines @param {number} start @returns {{signature: string, end: number} | null} */
function signatureAt(lines, start) {
  if (!/^[A-Z][A-Za-z0-9]*(?:\(|\[)/.test(lines[start]?.trim() ?? '')) return null
  let value = ''
  for (let index = start; index < Math.min(lines.length, start + 5); index += 1) {
    value += `${value.length === 0 ? '' : ' '}${lines[index]?.trim() ?? ''}`
    const marker = value.indexOf('::')
    // Strip the macros first: rewriting their brackets into parentheses would hide the display text
    // from cleanText and leak `xref:...adoc(...)` into parameterTypes and parameterRoles.
    if (marker >= 0) return { signature: stripMarkup(value.slice(0, marker)).replaceAll('[', '(').replaceAll(']', ')'), end: index }
  }
  return null
}

/** @param {string[]} lines @param {number} start @returns {string} */
function descriptionAfter(lines, start) {
  const parts = []
  let began = false
  for (let index = start; index < Math.min(lines.length, start + 12); index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.length === 0) {
      if (began) break
      continue
    }
    if (/^\[|^====|^[A-Z][A-Za-z0-9]*(?:\(|\[)/.test(line)) break
    began = true
    parts.push(line)
  }
  return cleanText(parts.join(' ')).slice(0, 500)
}

/** Preserve the whole overload body (adoc examples, notes and restrictions), without mixing overloads.
 * @param {string[]} lines @param {number} start @returns {{text: string, truncated: boolean, source: string}}
 */
function usageAfter(lines, start) {
  const parts = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    // A single '=' also starts mathematical continuation lines inside examples.
    // Only actual subsection headings delimit overload bodies.
    if (signatureAt(lines, index) !== null || /^={2,3}\s+\S/.test(line)) break
    parts.push(line)
  }
  const source = parts.join('\n').trim()
  return { text: source.slice(0, 12_000), truncated: source.length > 12_000, source }
}

/** @param {string} signature @returns {string[]} */
function parameterTypes(signature) {
  return [...signature.matchAll(/<([^>]+)>/g)].map(match => normalizeParameterType(cleanText(match[1] ?? '')))
}

/** @param {string} signature @returns {string[]} */
function parameterRoles(signature) {
  return [...signature.matchAll(/<([^>]+)>/g)].map(match => cleanText(match[1] ?? ''))
}

/** @param {string} signature @returns {{min: number, max: number | null, variadic: boolean}} */
function arity(signature) {
  const count = parameterRoles(signature).length
  return { min: count, max: signature.includes('...') ? null : count, variadic: signature.includes('...') }
}

/** @param {string} value @returns {string} */
function normalizeParameterType(value) {
  const normalized = value.toLowerCase()
  const typed = normalized.match(/^(?:(?:first|second|third) )?(point|line|segment|vector|circle|conic|curve|polygon|plane|number)(?: [a-z])?$/)
  return typed?.[1] ?? normalized
}

/** @param {string} command @param {string} signature @returns {string} */
function signatureId(command, signature) {
  const digest = createHash('sha256').update(signature).digest('hex').slice(0, 12)
  return `${command.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}-${digest}`
}

/** Bounded public introduction and explicitly linked official pages; never follow links recursively.
 * @param {string[]} lines @param {string} manualRoot @returns {object}
 */
function pageContext(lines, manualRoot) {
  const first = lines.findIndex((_line, index) => signatureAt(lines, index) !== null)
  const text = lines.slice(0, first < 0 ? lines.length : first)
    .filter(line => !/^(?:=|:|ifdef::|endif::)/u.test(line)).join('\n').trim()
  const links = [...new Set([...lines.join('\n').matchAll(/xref:\/?((?:(?:tools|commands)\/)?[A-Za-z0-9_]+\.adoc)\[/gu)]
    .map(match => match[1]))].sort()
  const related = links.slice(0, 4).map(link => {
    const path = resolve(manualRoot, 'en/modules/ROOT/pages', link)
    const available = existsSync(path)
    const source = available ? readFileSync(path, 'utf8') : ''
    return { sourcePath: relative(manualRoot, path).replaceAll('\\', '/'),
      sourceUrl: `https://geogebra.github.io/docs/manual/en/${link.replace(/\.adoc$/u, '')}/`,
      available, contentHash: createHash('sha256').update(source).digest('hex'),
      text: source.slice(0, 12_000), truncated: source.length > 12_000 }
  })
  return { overview: { text: text.slice(0, 12_000), truncated: text.length > 12_000 },
    related, omittedRelated: Math.max(0, links.length - related.length) }
}

/** @param {string} path @param {string} manualRoot @param {string} sourceCommit @returns {object[]} */
export function commandCards(path, manualRoot, sourceCommit) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const cards = []
  const context = pageContext(lines, manualRoot)
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = signatureAt(lines, index)
    if (parsed === null) continue
    const command = parsed.signature.match(/^([A-Z][A-Za-z0-9]*)/)?.[1]
    if (!command) continue
    const usage = usageAfter(lines, parsed.end + 1)
    cards.push({
      id: signatureId(command, parsed.signature), command, signature: parsed.signature,
      parameterTypes: parameterTypes(parsed.signature), parameterRoles: parameterRoles(parsed.signature),
      arity: arity(parsed.signature), outputKind: 'unknown', outputCardinality: 'unknown',
      effect: 'unknown', dimension: 'unknown', safety: 'unknown',
      description: descriptionAfter(lines, parsed.end + 1),
      usage: { text: usage.text, truncated: usage.truncated },
      context,
      sourcePath: relative(manualRoot, path).replaceAll('\\', '/'),
      sourceUrl: `https://geogebra.github.io/docs/manual/en/commands/${command}/`,
      sourceCommit,
      contentHash: createHash('sha256').update(parsed.signature).update('\n')
        .update(usage.source).update('\n').update(lines.join('\n')).update(JSON.stringify(context)).digest('hex'),
    })
    index = parsed.end
  }
  return cards
}

/**
 * Refuse to publish a card whose signature or parameter types still carry adoc markup.
 * A leaked `xref:` makes every downstream role lookup return `unknown`, so this must fail the build
 * instead of shipping a poisoned index.
 * @param {{command: string, signature: string, parameterTypes: string[], parameterRoles: string[]}[]} cards
 * @returns {void}
 */
function assertPublishableCards(cards) {
  const offenders = []
  for (const card of cards) {
    if (/xref:|image:|\.adoc/iu.test(card.signature)) offenders.push(`${card.command} signature`)
    for (const value of [...card.parameterTypes, ...card.parameterRoles]) {
      if (/xref:|image:|\.adoc/iu.test(value)) offenders.push(`${card.command} type ${value}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error('refusing to publish a manual index that still carries adoc markup: '
      + `${offenders.slice(0, 5).join('; ')} (${String(offenders.length)} entries)`)
  }
}

/** @param {string} manualRoot @returns {object} */
function buildIndex(manualRoot) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: manualRoot, encoding: 'utf8' }).trim()
  const commandsRoot = resolve(manualRoot, 'en/modules/ROOT/pages/commands')
  const paths = readdirSync(commandsRoot).filter(name => name.endsWith('.adoc')).sort()
  const bySignature = new Map()
  for (const name of paths) {
    for (const card of commandCards(resolve(commandsRoot, name), manualRoot, sourceCommit)) {
      bySignature.set(card.signature, card)
    }
  }
  const cards = [...bySignature.values()].sort((left, right) =>
    left.command.localeCompare(right.command) || left.signature.localeCompare(right.signature))
  assertPublishableCards(cards)
  const documents = manualDocuments(manualRoot)
  const digest = createHash('sha256').update(JSON.stringify({ cards, documents })).digest('hex')
  return {
    schemaVersion: 1,
    source: { repository: 'https://github.com/geogebra/manual', commit: sourceCommit, language: 'en', digest },
    cards,
    documents,
  }
}

/** Complete pinned pages and official link labels; no inferred geometry or recursive runtime fetch.
 * @param {string} manualRoot @returns {object[]}
 */
export function manualDocuments(manualRoot) {
  const pagesRoot = resolve(manualRoot, 'en/modules/ROOT/pages')
  const paths = readdirSync(pagesRoot, { recursive: true }).filter(path => typeof path === 'string'
    && path.endsWith('.adoc')).sort()
  const documents = paths.map(path => {
    const text = readFileSync(resolve(pagesRoot, path), 'utf8')
    const documentRef = path.replaceAll('\\', '/').replace(/\.adoc$/u, '')
    const title = cleanText(text.match(/^=\s+(.+)$/mu)?.[1] ?? documentRef)
    const links = [...new Set([...text.matchAll(/xref:\/?((?:(?:tools|commands)\/)?[A-Za-z0-9_]+)\.adoc\[/gu)]
      .map(match => match[1]))]
    return { documentRef, title, aliases: [title.replace(/ (?:Command|Tool)$/u, ''),
      documentRef.split('/').at(-1).replace(/([a-z])([A-Z])/gu, '$1 $2').replaceAll('_', ' ')],
    sourcePath: `en/modules/ROOT/pages/${path.replaceAll('\\', '/')}`,
    sourceUrl: `https://geogebra.github.io/docs/manual/en/${documentRef}/`,
    contentHash: createHash('sha256').update(text).digest('hex'), text, links }
  })
  const byRef = new Map(documents.map(document => [document.documentRef, document]))
  for (const document of documents) {
    for (const match of document.text.matchAll(/xref:\/?((?:(?:tools|commands)\/)?[A-Za-z0-9_]+)\.adoc\[([^\]]+)\]/gu)) {
      const linked = byRef.get(match[1])
      if (linked) linked.aliases.push(cleanText(match[2]))
    }
  }
  return documents.map(document => ({ ...document, aliases: [...new Set(document.aliases.filter(Boolean))] }))
}

/** @param {object} index @param {string} output @returns {void} */
function writeIndex(index, output) {
  const body = [
    "import type { ManualCommandIndex } from '../manual-command.js'",
    '',
    '/**',
    ' * Generated from the pinned official GeoGebra Manual source. Do not edit by hand.',
    ' * Agent: do not read this file in full. Search command/signature and read matching cards only.',
    ' * See AGENTS.md in this directory; edit tools/build-ggb-manual-index.mjs for generator changes.',
    ' */',
    `export const OFFICIAL_GGB_MANUAL_INDEX: ManualCommandIndex = ${JSON.stringify(index, null, 2)}`,
    '',
  ].join('\n')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, body)
  process.stdout.write(`wrote ${String(index.cards.length)} command signatures to ${output}\n`)
  if (output === defaultOutput) writeNamingLabels(index,
    resolve(root, 'packages/geometry-contract/src/generated/geogebra-names.ts'))
}

/** Publish browser-safe naming facts without a contract → knowledge dependency.
 * @param {object} index @param {string} output @returns {void}
 */
export function writeNamingLabels(index, output) {
  const text = index.documents.find(document => document.documentRef === 'Naming_Objects')?.text ?? ''
  const section = text.match(/These are the labels you can't use for objects: ([\s\S]*?)\n\n/u)?.[1]
  if (!section) throw new Error('official_reserved_labels_missing')
  const reserved = section.split(/,\s*/u).map(name => name.trim())
  const commands = [...new Set(index.documents.filter(document => document.documentRef.startsWith('commands/'))
    .map(document => document.documentRef.slice('commands/'.length)).filter(name => /^[A-Z][A-Za-z0-9]*$/u.test(name)))].sort()
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `/** Generated by tools/build-ggb-manual-index.mjs from official Manual ${index.source.commit}. */\n`
    + `export const GEOGEBRA_RESERVED_LABELS = ${JSON.stringify(reserved)} as const\n`
    + `export const GEOGEBRA_COMMAND_NAMES = ${JSON.stringify(commands)} as const\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = argumentsFromCommandLine()
  writeIndex(buildIndex(options.manualRoot), options.output)
  process.stdout.write('[Agent reading] Search the generated index by command/signature; do not read it in full.\n')
}

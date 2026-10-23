import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @returns {string[]} Repository files owned by this workspace. */
function trackedFiles() {
  const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim()
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'ggb-dsh'], { cwd: repository, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map(path => resolve(repository, path)).filter(existsSync)
}

/** @param {string[]} files Files to inspect. @returns {void} */
function checkSecrets(files) {
  const forbiddenName = /(^|\/)\.env($|\.)|\.(pem|p12|key)$/i
  const secretPattern = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9]{30,})\b/
  for (const path of files) {
    if (forbiddenName.test(path)) throw new Error(`sensitive filename is tracked: ${path}`)
    if (secretPattern.test(readFileSync(path, 'utf8'))) throw new Error(`possible live credential in ${path}`)
  }
}

/** @param {string[]} files Files to inspect. @returns {void} */
function checkMarkdown(files) {
  for (const path of files.filter(value => value.endsWith('.md'))) {
    const text = readFileSync(path, 'utf8')
    if (text.includes('\r')) throw new Error(`CRLF is not allowed: ${path}`)
    if (!text.endsWith('\n')) throw new Error(`missing final newline: ${path}`)
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]?.split('#')[0]
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue
      statSync(resolve(dirname(path), decodeURIComponent(target)))
    }
  }
}

/** @param {string[]} files Files to inspect. @returns {void} */
function checkDependencyDirection(files) {
  const importPattern = /(?:from\s+|import\s*\(|require\()\s*['"][^'"]*ggb-app(?:\/|['"])/
  for (const path of files.filter(value => /\.(?:ts|js|vue)$/.test(value))) {
    if (importPattern.test(readFileSync(path, 'utf8'))) {
      throw new Error(`dependency direction violation in ${path}: ggb-dsh must not import ggb-app`)
    }
  }
}

/** @returns {void} Validates minimum M0 evaluation coverage and reference assertions. */
function checkEvaluation() {
  const suite = JSON.parse(readFileSync(resolve(root, 'evaluation/geometry-m0-v1.json'), 'utf8'))
  const required = ['circumcenter', 'rightTriangle', 'midpoint', 'parallel', 'perpendicular', 'angleBisector', 'tangent', 'ambiguity', 'degenerate']
  const categories = new Set(suite.cases.map(value => value.category))
  for (const category of required) if (!categories.has(category)) throw new Error(`missing evaluation category: ${category}`)
  for (const value of suite.cases) {
    if (!value.id || !value.prompt || !Array.isArray(value.assertions)) throw new Error(`invalid evaluation case: ${JSON.stringify(value)}`)
  }
}

const files = trackedFiles()
checkSecrets(files)
checkMarkdown(files)
checkDependencyDirection(files)
checkEvaluation()
process.stdout.write(`quality checks passed for ${String(files.length)} workspace files\n`)

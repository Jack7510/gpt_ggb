import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'
import { sharedPackages } from './shared-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(root, 'packages')

/** @returns {string} Repository root as reported by git. */
function repositoryRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim()
}

/** @returns {string[]} Repository files owned by this workspace. */
function trackedFiles() {
  const repository = repositoryRoot()
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...sharedPackages.map(name => `ggb-dsh/packages/${name}`)], { cwd: repository, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map(path => resolve(repository, path)).filter(existsSync)
}

/** @param {string} path File to inspect. @returns {boolean} */
function isPackageCode(path) {
  const relative = path.slice(packagesRoot.length + 1)
  return path.startsWith(packagesRoot + sep) && relative.length > 0 && /\.(?:ts|js|json)$/.test(path)
}

/** @param {string} directory Directory to walk. @returns {string[]} All descendant files. */
function descendantFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? descendantFiles(path) : [path]
  })
}

const nodeCapability = [
  { pattern: /\bfrom\s+['"]node:/, label: 'node: builtin import' },
  { pattern: /\brequire\(\s*['"]node:/, label: 'node: builtin require' },
  { pattern: /\bprocess\./, label: 'process global' },
  { pattern: /\bBuffer\b/, label: 'Buffer global' },
  { pattern: /\b__dirname\b/, label: '__dirname' },
  { pattern: /\bimport\.meta\.dirname\b/, label: 'import.meta.dirname' },
  { pattern: /\b(?:Deno|Bun)\./, label: 'non-Node host global' },
]

/** @param {string[]} files Files to inspect. @returns {void} */
function checkBrowserSafe(files) {
  for (const path of files.filter(isPackageCode)) {
    const text = readFileSync(path, 'utf8')
    for (const { pattern, label } of nodeCapability) {
      if (pattern.test(text)) throw new Error(`browser-safe violation (${label}) in ${path}`)
    }
  }
}

/**
 * Requirement references recorded in shared fixtures, for example
 * `backlogRef: 'docs/ggb-shared-tech.md §14.2 …'`. They must name an existing repository document:
 * a reference left behind after its document was deleted is exactly the rot this gate prevents.
 * @param {string[]} files Files to inspect. @returns {void}
 */
function checkRequirementReferences(files) {
  const repository = repositoryRoot()
  for (const path of files.filter(isPackageCode)) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/backlogRef:\s*'([^']+)'/g)) {
      const reference = match[1]
      const [docPath] = reference.split(' §')
      if (docPath === undefined || !/^docs\/[a-z0-9-]+\.md$/u.test(docPath)) {
        throw new Error(`invalid requirement reference in ${path}: ${reference}`)
      }
      if (!existsSync(resolve(repository, docPath))) {
        throw new Error(`requirement reference points at a missing document in ${path}: ${docPath}`)
      }
    }
  }
}

/** @param {string[]} files Files to inspect. @returns {void} */
function checkDependencyDirection(files) {
  for (const path of files.filter(isPackageCode)) {
    const text = readFileSync(path, 'utf8')
    const packageRoot = resolve(packagesRoot, path.slice(packagesRoot.length + 1).split(sep)[0])
    for (const match of text.matchAll(/(?:from\s+|import\s*(?:\(\s*)?|require\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (isBuiltin(specifier)) throw new Error(`browser-safe violation (Node builtin) in ${path}`)
      if (specifier.startsWith('.') && !resolve(dirname(path), specifier).startsWith(packageRoot + sep)) {
        throw new Error(`dependency direction violation in ${path}: cross-package source import ${specifier}`)
      }
    }
    for (const match of text.matchAll(/['"](@(?:ggb-copilot|deepseek-ai)\/[^/'"]+)/g)) {
      if (!sharedPackages.some(name => match[1] === `@ggb-copilot/${name}`)) {
        throw new Error(`dependency direction violation in ${path}: ${match[1]}`)
      }
    }
    if (path.endsWith('package.json') && /"file:/.test(text)) {
      throw new Error(`file: dependency is not allowed in shared packages: ${path}`)
    }
  }
}

/** @returns {void} Enforces public package exports and rejects build output without a source. */
function checkPackageShape() {
  for (const name of sharedPackages) {
    const manifestPath = resolve(packagesRoot, name, 'package.json')
    if (!existsSync(manifestPath)) throw new Error(`missing package.json in packages/${name}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest.name.startsWith('@ggb-copilot/')) throw new Error(`invalid package name: ${manifest.name}`)
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`invalid package version: ${manifest.name}@${manifest.version}`)
    if (!Array.isArray(manifest.files) || !manifest.files.includes('lib')) throw new Error(`package files must ship lib/: ${manifest.name}`)
    const exports = manifest.exports?.['.']
    if (!exports || !exports.types || !exports.default) throw new Error(`package exports must declare types and default: ${manifest.name}`)
    for (const directory of ['src', 'tests']) {
      const path = resolve(packagesRoot, name, directory)
      if (!existsSync(path) || statSync(path).isFile()) throw new Error(`missing ${directory}/ in packages/${name}`)
    }
    const packageRoot = resolve(packagesRoot, name)
    for (const output of descendantFiles(resolve(packageRoot, 'lib')).filter(path => path.endsWith('.js'))) {
      const source = resolve(packageRoot, 'src', output.slice(resolve(packageRoot, 'lib').length + 1).replace(/\.js$/, '.ts'))
      if (!existsSync(source)) throw new Error(`stale build output without source: ${output}`)
    }
  }
}

const files = trackedFiles()
checkBrowserSafe(files)
checkDependencyDirection(files)
checkRequirementReferences(files)
checkPackageShape()
process.stdout.write(`quality checks passed for ${String(files.length)} browser-safe package files\n`)

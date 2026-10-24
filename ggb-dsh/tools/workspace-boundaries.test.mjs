import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Workspace manifests own package identity; directory paths are not public import paths. */
function members() {
  return ['apps', 'packages'].flatMap(section => readdirSync(resolve(root, section))
    .filter(name => existsSync(resolve(root, section, name, 'package.json'))).map(name => {
    const directory = resolve(root, section, name)
    return { directory, manifest: readJson(resolve(directory, 'package.json')) }
  }))
}

test('internal dependencies resolve to local packages and participate in the build graph', () => {
  assert.doesNotMatch(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'), /@ggb-copilot\//)
  const available = members()
  const byName = new Map(available.map(member => [member.manifest.name, member]))
  for (const { directory, manifest } of available) {
    const require = createRequire(resolve(directory, 'package.json'))
    const references = readJson(resolve(directory, 'tsconfig.json')).references ?? []
    for (const section of ['dependencies', 'devDependencies']) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        if (!name.startsWith('@ggb-copilot/')) continue
        const dependency = byName.get(name)
        assert.ok(dependency, `${manifest.name}: unknown internal dependency ${name}`)
        assert.equal(specifier, 'workspace:*', `${manifest.name}: ${name}`)
        assert.equal(realpathSync(resolve(directory, 'node_modules', name)), dependency.directory)
        if (section === 'dependencies') {
          assert.ok(references.some(ref => resolve(directory, ref.path) === dependency.directory),
            `${manifest.name}: missing build reference to ${name}`)
        }
        if (dependency.manifest.exports?.['.']) {
          assert.equal(realpathSync(require.resolve(name)), resolve(dependency.directory, 'lib/index.js'))
          assert.throws(() => require.resolve(`${name}/src/index.ts`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
        }
      }
    }
  }
  const roots = readJson(resolve(root, 'tsconfig.json')).references.map(ref => resolve(root, ref.path))
  for (const { directory } of available) assert.ok(roots.includes(directory), `missing build root: ${directory}`)
})

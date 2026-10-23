import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedPackages } from './shared-packages.mjs'

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
        if (sharedPackages.includes(name.replace('@ggb-copilot/', ''))) {
          assert.equal(realpathSync(require.resolve(name)), resolve(dependency.directory, 'lib/index.js'))
          assert.throws(() => require.resolve(`${name}/src/index.ts`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
        }
      }
    }
  }
  const roots = readJson(resolve(root, 'tsconfig.json')).references.map(ref => resolve(root, ref.path))
  for (const { directory } of available) assert.ok(roots.includes(directory), `missing build root: ${directory}`)
})

test('browser-safe gate accepts domain packages and rejects Node and runtime imports', () => {
  execFileSync(process.execPath, ['tools/quality-shared.mjs'], { cwd: root, stdio: 'pipe' })
  const fixture = resolve(root, 'packages/geometry-contract/src/workspace-boundary-probe.ts')
  try {
    for (const source of ["import { readFileSync } from 'node:fs'\n",
      "import fs from 'fs'\n",
      "import '../../application/src/index.js'\n",
      "import { NativeRunCheckpointSchema } from '@ggb-copilot/application'\n",
      "import '@deepseek-ai/dsh-sdk-client'\n"]) {
      writeFileSync(fixture, source)
      const result = spawnSync(process.execPath, ['tools/quality-shared.mjs'], { cwd: root, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /browser-safe violation|dependency direction violation/)
    }
  } finally {
    rmSync(fixture, { force: true })
  }
})

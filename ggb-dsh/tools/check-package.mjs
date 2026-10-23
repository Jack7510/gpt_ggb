import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { sharedPackages } from './shared-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const selector = process.argv[2]

if (selector === undefined || !/^[a-z][a-z0-9-]*$/.test(selector)) {
  throw new Error('Usage: pnpm run check:package <package-directory>')
}

const packageRoot = resolve(root, 'packages', selector)
if (!sharedPackages.includes(selector) || !existsSync(resolve(packageRoot, 'package.json'))) throw new Error(`Unknown shared package: ${selector}`)

/** @param {string} label @param {string} command @param {string[]} args */
function run(label, command, args) {
  const startedAt = performance.now()
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
  const elapsed = Math.round(performance.now() - startedAt)
  process.stdout.write(`[timing] ${label}: ${String(elapsed)} ms\n`)
}

run('typecheck', 'pnpm', ['exec', 'tsc', '-b', packageRoot, '--pretty', 'false'])
run('lint', 'pnpm', ['exec', 'eslint', packageRoot])
run('test', 'pnpm', ['exec', 'vitest', 'run', packageRoot])
run('quality', 'pnpm', ['run', 'quality'])

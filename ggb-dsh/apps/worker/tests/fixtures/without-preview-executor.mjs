/** Acceptance adapter: real public CLI build, omit preview before public receipt creation. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: Object.fromEntries(
  ['operation', 'request', 'context', 'package-integrity', 'plugin-root'].map(key => [key, { type: 'string' }])) })
assert.equal(values.operation, 'build')
const require = createRequire(join(values['plugin-root'], 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { executeHostOperation } = await load('ggb-plugins-dsh/executor')
const { loadInstallation } = await load('ggb-plugins-dsh/installation')
const playwright = await load('playwright')
const context = JSON.parse(await readFile(values.context, 'utf8'))
const request = JSON.parse(await readFile(values.request, 'utf8'))
const run = promisify(execFile)
const result = await executeHostOperation('build', request, context, values['package-integrity'], undefined, {
  build: async (input, signal) => {
    const path = join(context.outputRoot, 'no-preview-cli-request.json')
    await writeFile(path, JSON.stringify(input), { mode: 0o600 })
    const { stdout } = await run(process.execPath, [loadInstallation().cli, 'build', '--request', path], {
      signal, maxBuffer: 1024 * 1024, env: { ...process.env,
        DSH_GGB_BROWSER: (playwright.default ?? playwright).chromium.executablePath() },
    })
    const envelope = JSON.parse(stdout)
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error))
    await rm(join(envelope.data.delivery, 'preview.png'))
    return envelope.data
  },
})
process.stdout.write(JSON.stringify(result) + '\n')

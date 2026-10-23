#!/usr/bin/env node
import { installedPluginRoot, installedPluginModule } from './local-runtime.mjs'
/**
 * Authorized integrated acceptance for the plugin-core engine.
 *
 * Starts one isolated API/Worker pair with `GGB_AGENT_ENGINE=plugin_core`, runs
 * the plugin-core minimal cases through the authenticated `?wait=1` API, writes the
 * GGB evidence and the usage report, then stops both processes.
 *
 * Requires `--authorized` and DEEPSEEK_API_KEY. The key stays in the caller
 * environment and is sent only in the per-run provider header.
 *
 * Usage:
 *   node tools/plugin-core-integrated-batch.mjs --authorized \
 *     [--case-id id1,id2] [--out ../output/plugin-core-integrated-batch] \
 *     [--plugin-root /absolute/installed-release]
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  freeLocalPort, startLocalProcesses, workspaceRoot,
} from './local-runtime.mjs'

const { values } = parseArgs({ options: {
  authorized: { type: 'boolean' },
  'case-id': { type: 'string' },
  out: { type: 'string' },
  'plugin-root': { type: 'string' },
  'output-root': { type: 'string' },
} })
if (values.authorized !== true) {
  process.stderr.write('Refusing paid Provider calls without --authorized.\n')
  process.exit(2)
}
if ((process.env.DEEPSEEK_API_KEY ?? '').length === 0) {
  process.stderr.write('DEEPSEEK_API_KEY is required; the key stays in this process.\n')
  process.exit(2)
}

const root = resolve(workspaceRoot, '..')
const out = resolve(values.out ?? join(root, 'output/plugin-core-integrated-batch'))
const pluginRoot = installedPluginRoot(values['plugin-root'])
const pluginOutputRoot = resolve(values['output-root'] ?? join(root, 'output/plugin-core-runs'))
const directory = await mkdtemp(join(tmpdir(), 'ggb-plugin-core-integrated-'))
const port = await freeLocalPort()
await mkdir(out, { recursive: true })

const runtime = await startLocalProcesses({
  directory,
  port,
  overrides: {
    GGB_AGENT_ENGINE: 'plugin_core',
    GGB_PLUGIN_ROOT: pluginRoot,
    GGB_PLUGIN_CORE_OUTPUT_ROOT: pluginOutputRoot,
    GGB_PLUGIN_CORE_MAX_CONCURRENT_RUNS: '1',
    GGB_V3_CLIENT_DIST_DIR: join(workspaceRoot, 'apps/client/dist'),
    GGB_V3_GEOGEBRA_ROOT: join(workspaceRoot, 'apps/client/dist/geogebra'),
    GGB_V3_RUNTIME_VERSIONS_PATH: join(workspaceRoot, 'config/runtime-versions.json'),
  },
})
process.stderr.write(`[integrated] runtime ready port=${String(port)} logs=${directory}\n`)
try {
  const args = ['tools/plugin-core-batch.mjs', '--authorized',
    '--api', `http://127.0.0.1:${String(port)}`, '--out', out]
  if (values['case-id'] !== undefined) args.push('--case-id', values['case-id'])
  const batchCode = await run(process.execPath, args)
  process.stderr.write(`[integrated] batch exit ${String(batchCode)}\n`)

  const report = await capture(process.execPath, ['tools/report-plugin-core-usage.mjs',
    '--sqlite', runtime.env.GGB_V3_SQLITE_PATH])
  await writeFile(join(out, 'usage-report.json'), report.stdout)
  await writeFile(join(out, 'runtime.json'),
    `${JSON.stringify({ directory, port, pluginRoot, pluginOutputRoot }, null, 2)}\n`)
  process.stderr.write(`[integrated] usage report exit ${String(report.code)}\n`)
  process.exitCode = batchCode === 0 && report.code === 0 ? 0 : 1
} finally {
  await runtime.stop()
}

function run(command, args) {
  const child = spawn(command, args, {
    cwd: workspaceRoot, env: process.env, stdio: 'inherit',
  })
  return new Promise(resolveExit => child.once('exit', code => resolveExit(code ?? 1)))
}

function capture(command, args) {
  const child = spawn(command, args, { cwd: workspaceRoot, env: process.env })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  return new Promise(resolveExit => child.once('exit', code => resolveExit({
    code: code ?? 1, stdout,
  })))
}

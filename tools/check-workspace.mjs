import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowed = new Set(['check', 'check:fast', 'check:client', 'check:api', 'check:worker',
  'check:deploy', 'typecheck', 'test', 'quality'])

/**
 * Use the workspace's existing script as the sole source of check order.
 * @param {string} workspace
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} scripts
 * @returns {{label: string, args: string[]}[]}
 */
export function checkPlan(workspace, script, args, scripts) {
  if (workspace !== 'ggb-dsh') throw new Error('Unknown workspace')
  if (!allowed.has(script) || typeof scripts[script] !== 'string') throw new Error('Unknown offline check')
  if (args.length && script !== 'test') throw new Error('This check accepts no extra arguments')
  return scripts[script].split(' && ').map((command, index, commands) => {
    // Current check scripts use simple words only. Reject new shell syntax before running any step.
    if (!/^[a-zA-Z0-9_./:@= -]+$/.test(command)) throw new Error('Unsupported check syntax; use the workspace script directly')
    const words = command.trim().split(/\s+/)
    const label = words[0] === 'pnpm' && words[1] === 'run' ? words[2] : words.join(' ')
    return { label, args: ['exec', ...words, ...(index === commands.length - 1 ? args : [])] }
  })
}

/**
 * Run sequentially, preserve child output, record timings, and stop on the first failure.
 * @param {string} cwd
 * @param {{label: string, args: string[]}[]} steps
 * @param {string} reportPath
 * @param {string} command
 * @returns {number}
 */
export function runChecks(cwd, steps, reportPath, command = 'pnpm') {
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const results = []
  for (const step of steps) {
    const stepStart = performance.now()
    const stepStartedAt = new Date().toISOString()
    process.stdout.write(`[check] ${step.label}\n`)
    const result = spawnSync(command, step.args, { cwd, stdio: 'inherit', shell: false })
    const exitCode = result.status ?? 1
    const durationMs = Math.round(performance.now() - stepStart)
    results.push({ label: step.label, startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
      durationMs, exitCode, signal: result.signal, error: result.error?.code ?? null })
    process.stdout.write(`[timing] ${step.label}: ${durationMs} ms; exit=${exitCode}\n`)
    if (exitCode !== 0) break
  }
  const report = { workspace: cwd, startedAt, finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start), plannedSteps: steps.length, steps: results }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`[timing] total: ${report.durationMs} ms; report=${reportPath}\n`)
  return results.at(-1)?.exitCode ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [workspace, script = 'check', ...args] = process.argv.slice(2)
    if (workspace !== 'ggb-dsh') {
      throw new Error('Usage: node tools/check-workspace.mjs ggb-dsh [offline-check] [test-paths]')
    }
    const cwd = resolve(root, workspace)
    const { scripts } = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
    const steps = checkPlan(workspace, script, args, scripts)
    const stamp = new Date().toISOString().replaceAll(':', '-')
    process.exitCode = runChecks(cwd, steps, resolve(root, 'output', 'checks', `${workspace}-${stamp}.json`))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../deploy/local/dev.sh', import.meta.url))

for (const watch of ['0', '1', 'build-failure']) {
  test(`local launcher persists output and rejects failed builds (${watch})`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'ggb-dev-logs-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const command of ['pnpm', 'node']) {
      const path = join(bin, command)
      await writeFile(path, '#!/bin/sh\necho "mock stdout: $*"\necho "mock stderr: $*" >&2\n')
      if (command === 'pnpm' && watch === 'build-failure') await writeFile(path, '#!/bin/sh\necho "mock build failure" >&2\nexit 3\n')
      await chmod(path, 0o700)
    }
    const logs = join(root, 'logs')
    const result = execute('sh', [script], { env: { ...process.env,
      PATH: `${bin}:${process.env.PATH}`, GGB_V3_WATCH: watch, GGB_V3_LOG_DIR: logs,
      GGB_V3_DSH_HOME_ROOT: join(root, 'homes'), GGB_PLUGIN_CORE_OUTPUT_ROOT: join(root, 'runs'),
    } })
    if (watch === 'build-failure') {
      await assert.rejects(result, error => error.code === 1 && error.stderr.includes('mock build failure'))
      assert.match(await readFile(join(logs, 'build.log'), 'utf8'), /mock build failure/)
      await assert.rejects(stat(join(logs, 'api.log')), { code: 'ENOENT' })
      return
    }
    const { stdout } = await result
    assert.ok(stdout.includes(logs))
    assert.ok(stdout.includes(join(root, 'runs')))
    for (const name of ['build', 'worker', 'api', ...(watch === '1' ? ['tsc'] : [])]) {
      const path = join(logs, `${name}.log`)
      assert.match(await readFile(path, 'utf8'), /mock stdout:/)
      assert.match(await readFile(path, 'utf8'), /mock stderr:/)
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }
  })
}

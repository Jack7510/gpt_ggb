#!/usr/bin/env node
/**
 * Authorized validation for the independent plugin-core path.
 *
 * Sends each plugin-core minimal case prompt to the running local API and saves
 * bounded evidence under output/plugin-core-e2e. Continuation prompts are
 * recorded but not sent by this script; the PWA/API base path covers them.
 *
 * Requires --authorized and DEEPSEEK_API_KEY in the process environment.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const value = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const authorized = args.includes('--authorized')
const providerKey = process.env.DEEPSEEK_API_KEY
if (!authorized) {
  process.stderr.write('Refusing paid Provider calls without --authorized.\n')
  process.exit(2)
}
if (providerKey === undefined || providerKey.length === 0) {
  process.stderr.write('DEEPSEEK_API_KEY is required; the key stays in this process.\n')
  process.exit(2)
}

const api = value('--api') ?? 'http://127.0.0.1:8081'
const outputRoot = resolve(value('--out') ?? '../output/plugin-core-e2e')
const list = JSON.parse(await readFile('evaluation/plugin-core-minimal-v1.cases.json', 'utf8'))
const selected = value('--case-id')?.split(',').filter(Boolean)
const cases = selected === undefined ? list.cases
  : list.cases.filter(item => selected.includes(item.caseId))
if (cases.length === 0) {
  process.stderr.write('No matching caseId.\n')
  process.exit(2)
}
await mkdir(outputRoot, { recursive: true })

const results = []
for (const item of cases) {
  const started = Date.now()
  let response
  let body
  try {
    const runId = `run_${randomUUID()}`
    const runToken = randomBytes(32).toString('base64url')
    response = await fetch(`${api}/api/v3/plugin-core/runs?wait=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runToken}`,
        'idempotency-key': runId,
        'x-ggb-provider-key': providerKey,
      },
      body: JSON.stringify({ runId, prompt: item.prompt }),
      signal: AbortSignal.timeout(15 * 60_000),
    })
    body = await response.json()
  } catch (error) {
    results.push({ caseId: item.caseId, title: item.title, status: 'request_failed',
      elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
    continue
  }
  const delivery = body.delivery ?? null
  if (delivery?.ggbBase64 !== undefined && delivery.ggbBase64 !== null) {
    await writeFile(resolve(outputRoot, `${item.caseId}.ggb`),
      Buffer.from(delivery.ggbBase64, 'base64'))
  }
  if (delivery?.screenshotBase64 !== undefined && delivery.screenshotBase64 !== null) {
    await writeFile(resolve(outputRoot, `${item.caseId}.png`),
      Buffer.from(delivery.screenshotBase64, 'base64'))
  }
  const evidence = {
    ...body,
    delivery: delivery === null ? null : { ...delivery, ggbBase64: '<saved separately>',
      screenshotBase64: '<saved separately>' },
  }
  await writeFile(resolve(outputRoot, `${item.caseId}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  results.push({ caseId: item.caseId, title: item.title, status: response.ok ? 'completed' : 'rejected',
    httpStatus: response.status, elapsedMs: Date.now() - started, runId: body.runId ?? null,
    error: body.error ?? null, continuation: item.thenPrompt === null || item.thenPrompt === undefined
      ? 'not_applicable' : 'phase2_required',
    delivery: delivery === null ? null : { id: delivery.id, ggbBytes: delivery.ggbBytes,
      verification: delivery.verification } })
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
process.exitCode = results.every(item => item.status === 'completed' && item.error === null) ? 0 : 1

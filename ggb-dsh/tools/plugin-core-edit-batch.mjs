#!/usr/bin/env node
/**
 * Authorized Phase 2a validation: edit one base GGB over three rounds.
 *
 * Each round sends the current GGB plus a prompt to the running API, saves the
 * returned GGB, and uses it as the base of the next round. The API and Worker
 * own the base path; this script only carries bytes.
 *
 * Requires --authorized, --base, at least one --prompt, and DEEPSEEK_API_KEY.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const args = process.argv.slice(2)
const value = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const prompts = args.flatMap((arg, index) => arg === '--prompt' ? [args[index + 1]] : [])
  .filter(prompt => typeof prompt === 'string' && prompt.length > 0)
const basePath = value('--base')
const providerKey = process.env.DEEPSEEK_API_KEY
if (!args.includes('--authorized')) {
  process.stderr.write('Refusing paid Provider calls without --authorized.\n')
  process.exit(2)
}
if (basePath === undefined || prompts.length === 0) {
  process.stderr.write('Usage: node tools/plugin-core-edit-batch.mjs --authorized --base <file> --prompt "<edit>" [--prompt ...]\n')
  process.exit(2)
}
if (providerKey === undefined || providerKey.length === 0) {
  process.stderr.write('DEEPSEEK_API_KEY is required; the key stays in this process.\n')
  process.exit(2)
}

const api = value('--api') ?? 'http://127.0.0.1:8081'
const outputRoot = resolve(value('--out') ?? '../output/plugin-core-edit-e2e')
await mkdir(outputRoot, { recursive: true })

let current = await readFile(resolve(basePath))
let currentName = basename(basePath)
const results = []
for (const [index, prompt] of prompts.entries()) {
  const started = Date.now()
  const sentBytes = current.length
  let body
  let status
  try {
    const runId = `run_${randomUUID()}`
    const runToken = randomBytes(32).toString('base64url')
    const response = await fetch(`${api}/api/v3/plugin-core/runs?wait=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runToken}`,
        'idempotency-key': runId,
        'x-ggb-provider-key': providerKey,
      },
      body: JSON.stringify({ runId, prompt, base: {
        dataBase64: current.toString('base64'), name: currentName,
      } }),
      signal: AbortSignal.timeout(15 * 60_000),
    })
    status = response.status
    body = await response.json()
  } catch (error) {
    results.push({ round: index + 1, prompt, status: 'request_failed',
      error: error instanceof Error ? error.message : String(error) })
    break
  }
  const delivery = body.delivery ?? null
  if (delivery?.ggbBase64 !== undefined && delivery.ggbBase64 !== null) {
    current = Buffer.from(delivery.ggbBase64, 'base64')
    currentName = `round-${String(index + 1)}.ggb`
    await writeFile(resolve(outputRoot, currentName), current)
  }
  const evidence = { ...body, delivery: delivery === null ? null
    : { ...delivery, ggbBase64: '<saved separately>', screenshotBase64: '<saved separately>' } }
  await writeFile(resolve(outputRoot, `round-${String(index + 1)}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`)
  results.push({ round: index + 1, prompt, sentBaseBytes: sentBytes,
    status: status === 200 && delivery !== null && body.error === null ? 'delivered' : 'failed',
    httpStatus: status, elapsedMs: Date.now() - started, runId: body.runId ?? null,
    error: body.error ?? null, delivery: delivery === null ? null
      : { id: delivery.id, ggbBytes: delivery.ggbBytes, verification: delivery.verification },
    finalResponse: (body.finalResponse ?? '').slice(0, 1200) })
  if (results.at(-1).status !== 'delivered') break
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
process.exitCode = results.length > 0 && results.every(item => item.status === 'delivered') ? 0 : 1

import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runIdSchema } from '@ggb-copilot/application'
import { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'
import { PluginCoreEvidenceStore } from '../src/plugin-core/evidence.js'
import { installedRoot, toolProtocol } from './fixtures/installed-plugin.js'

describe('host policy in the pinned SDK Server, local SSE only', () => {
  it.each([false, true])('plugin omits restrictions; extra tool=%s', async extra => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-host-policy-'))
    let requests = 0
    const http = createServer(async (req, res) => {
      for await (const _ of req) { /* no headers or body retained */ }
      requests++
      const events = [{ type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as { port: number }).port
    const patch = join(root, 'unrestricted-plugin.patch.json')
    await writeFile(patch, JSON.stringify([{ insert: [
      { id: 'ggb-construct-server', name: join(installedRoot, 'dsh/server.js'), config: { sdkVersion: '0.2.1-rc.2' } },
      ...(extra ? [{ id: 'extra-test-tool', name: new URL('./fixtures/unexpected-sdk-tool.mjs', import.meta.url).pathname }] : []),
    ] }]))
    const gateway = new PluginCoreToolGatewayServer(join(root, 'tools.sock'), new PluginCoreGateway({
      check: async () => { throw new Error('no tool call expected') },
      build: async () => { throw new Error('no build expected') },
    }), 1000, { protocol: toolProtocol })
    await gateway.listen()
    const runId = runIdSchema.parse(`run_${randomUUID()}`); const turnId = randomUUID()
    try {
      const runner = new PluginCoreDshRunner({ workspaceRoot: process.cwd(), dshHomeRoot: join(root, 'homes'),
        provider: 'deepseek-official', baseUrl: `http://127.0.0.1:${port}`, modelId: 'deepseek-flash',
        reasoningEffort: 'off', maxTokens: 100, serverPatch: patch, sdkVersion: '0.2.1-rc.2',
        evidence: new PluginCoreEvidenceStore(root) }, gateway)
      const result = runner.run({ runId, turnId, epoch: 1, providerKey: 'local-fixture-only', prompt: 'fixture', baseAttached: false })
      if (extra) {
        await expect(result).rejects.toThrow('plugin_core_failed')
        expect(await readFile(join(root, runId, 'diagnostics', `${turnId}.json`), 'utf8'))
          .toContain('plugin_core_host_tool_policy_violation')
        expect(requests).toBe(0)
      } else {
        expect((await result).finalResponse).toBe('done')
        expect(requests).toBe(1)
      }
    } finally {
      await gateway.close()
      await new Promise<void>(resolve => http.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

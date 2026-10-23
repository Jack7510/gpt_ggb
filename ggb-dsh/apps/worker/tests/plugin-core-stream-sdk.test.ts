import { PLUGIN_CORE_MODEL_POLICY_V1 } from '@ggb-copilot/application'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installedRoot } from './fixtures/installed-plugin.js'
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runIdSchema } from '@ggb-copilot/application'
import { PluginCoreDshRunner } from '../src/plugin-core/dsh-runner.js'
import { PluginCoreGateway } from '../src/plugin-core/gateway.js'
import { PluginCoreToolGatewayServer } from '../src/plugin-core/tool-gateway-server.js'
import { PluginCoreEvidenceStore } from '../src/plugin-core/evidence.js'
import { serverPatch, toolProtocol } from './fixtures/installed-plugin.js'

// A real SDK process against local SSE; never the public Provider or a browser.
describe('wire diagnostics across a real SDK Server', () => {
  it('completes a local SDK turn beyond the optional 16-request diagnostic budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-wire-limit-'))
    let requests = 0
    let calls = 0
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* local fixture only */ }
      const index = ++requests
      const block = index <= 17 ? { type: 'tool_use', id: `call_${index}`, name: 'ggb_check', input: {} }
        : { type: 'text', text: '' }
      const delta = index <= 17 ? { type: 'input_json_delta', partial_json: JSON.stringify({ request: { protocolVersion: 2, prompt: 'fixture' } }) }
        : { type: 'text_delta', text: 'done' }
      const events = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: index <= 17 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const runId = runIdSchema.parse(`run_${randomUUID()}`); const turnId = randomUUID()
    const gateway = new PluginCoreToolGatewayServer(join(root, 'tools.sock'), new PluginCoreGateway({
      check: async () => { calls++; return { ok: true, check: { validation: 'structural' } } },
      build: async () => { throw new Error('must not build') },
    }), 1000, { protocol: toolProtocol })
    await gateway.listen()
    try {
      const runner = new PluginCoreDshRunner({ workspaceRoot: process.cwd(), dshHomeRoot: join(root, 'homes'),
        provider: 'deepseek-official', baseUrl: `http://127.0.0.1:${address.port}`, modelId: 'deepseek-flash',
        reasoningEffort: 'off', maxTokens: 100, serverPatch, sdkVersion: '0.2.1-rc.2',
        evidence: new PluginCoreEvidenceStore(root) }, gateway)
      const result = await runner.run({ runId, turnId, epoch: 1, providerKey: 'fake-local-only', prompt: 'fixture', baseAttached: false })
      expect(result.finalResponse).toBe('done')
      expect(calls).toBe(17)
      expect(requests).toBe(18)
      const stream = JSON.parse(await readFile(join(root, runId, 'diagnostics', `${turnId}.stream.json`), 'utf8'))
      expect(stream.requests).toHaveLength(16)
      expect(stream.droppedRequests).toBe(2)
    } finally {
      await gateway.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
  it('sends the installed schemas and complete argument example unchanged with thinking enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-contract-'))
    let body!: { thinking: unknown; output_config: unknown; system: string;
      tools: { name: string; input_schema: unknown; strict?: boolean }[] }
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = JSON.parse(Buffer.concat(chunks).toString())
      const events = [{ type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta',
          delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const runId = runIdSchema.parse(`run_${randomUUID()}`); const turnId = randomUUID()
    const gateway = new PluginCoreToolGatewayServer(join(root, 'tools.sock'), new PluginCoreGateway({
      check: async () => { throw new Error('no tool execution') }, build: async () => { throw new Error('no build') },
    }), 1000, { protocol: toolProtocol })
    await gateway.listen()
    try {
      const runner = new PluginCoreDshRunner({ workspaceRoot: process.cwd(), dshHomeRoot: join(root, 'homes'),
        provider: 'deepseek-official', baseUrl: `http://127.0.0.1:${address.port}`, modelId: PLUGIN_CORE_MODEL_POLICY_V1.model,
        reasoningEffort: PLUGIN_CORE_MODEL_POLICY_V1.reasoning, maxTokens: PLUGIN_CORE_MODEL_POLICY_V1.maxTokens,
        serverPatch, sdkVersion: '0.2.1-rc.2', evidence: new PluginCoreEvidenceStore(root) }, gateway)
      expect((await runner.run({ runId, turnId, epoch: 1, providerKey: 'fake-contract-key', prompt: 'fixture', baseAttached: false })).finalResponse).toBe('done')
      expect(body.thinking).toEqual({ type: 'enabled' })
      expect(body.output_config).toEqual({ effort: 'high' })
      const req = createRequire(join(installedRoot, 'package.json'))
      const { createTool } = await import(pathToFileURL(req.resolve('ggb-plugins-dsh/server')).href)
      expect(body.tools).toHaveLength(3)
      for (const tool of body.tools) {
        expect(tool.input_schema).toEqual(createTool(tool.name).parameters)
        expect(tool.strict).toBeUndefined() // Messages adapter does not promise strict mode.
      }
      expect(body.system).toContain('wrap the domain request exactly once')
      const stream = JSON.parse(await readFile(join(root, runId, 'diagnostics', `${turnId}.stream.json`), 'utf8'))
      const request = stream.requests[0]
      expect(request.providerRequest).toMatchObject({ thinking: 'enabled', effort: 'high' })
      expect(request.providerRequest.jsonExamples).toContainEqual(expect.objectContaining({ validJson: true, rootKeys: ['request'] }))
      expect(request.sdkRequest.tools).toHaveLength(3)
      expect(request.providerRequest.tools).toHaveLength(3)
      for (const tool of request.sdkRequest.tools) expect(request.providerRequest.tools)
        .toContainEqual(expect.objectContaining({ name: tool.name, schemaSha256: tool.schemaSha256 }))
      expect(JSON.stringify(stream)).not.toContain('fake-contract-key')
    } finally {
      await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
  it('retains identical malformed wire and SDK arguments before Harness closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-wire-'))
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain fixture request, do not save headers/body */ }
      const events = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'ggb_build', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"request":' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const runId = runIdSchema.parse(`run_${randomUUID()}`)
    const turnId = randomUUID()
    const gateway = new PluginCoreToolGatewayServer(join(root, 'tools.sock'), new PluginCoreGateway({
      check: async () => { throw new Error('must not dispatch') }, build: async () => { throw new Error('must not dispatch') },
    }), 1000, { protocol: toolProtocol })
    await gateway.listen()
    try {
      const runner = new PluginCoreDshRunner({ workspaceRoot: process.cwd(), dshHomeRoot: join(root, 'homes'),
        provider: 'deepseek-official', baseUrl: `http://127.0.0.1:${address.port}`, modelId: 'deepseek-flash',
        reasoningEffort: 'off', maxTokens: 100, serverPatch, sdkVersion: '0.2.1-rc.2',
        evidence: new PluginCoreEvidenceStore(root) }, gateway)
      await expect(runner.run({ runId, turnId, epoch: 1, providerKey: 'fake-local-only', prompt: 'fixture',
        baseAttached: false })).rejects.toThrow('plugin_core_failed')
      const files = await readdir(join(root, runId, 'diagnostics'))
      const stream = JSON.parse(await readFile(join(root, runId, 'diagnostics', files.find(file => file.endsWith('.stream.json'))!), 'utf8'))
      expect(stream.requests[0].tools[0]).toMatchObject({ wireJsonValid: false, sdkJsonValid: false, assembly: 'identical' })
      expect(JSON.stringify(stream)).not.toContain('fake-local-only')
    } finally {
      await gateway.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

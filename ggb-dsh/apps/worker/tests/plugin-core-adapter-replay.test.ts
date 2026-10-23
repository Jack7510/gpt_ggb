import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ProviderToolStream } from '../src/plugin-core/provider-stream-evidence.js'
const host = createRequire(import.meta.url)
const sdk = createRequire(host.resolve('@deepseek-ai/dsh-sdk-client/package.json'))
const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-llm-deepseek')).href)
afterEach(() => vi.unstubAllGlobals())

async function replay(args: string) {
  const capture = new ProviderToolStream(1, [])
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'ggb_build', input: {} } },
    ...[args.slice(0, 9), args.slice(9)].map(partial_json => ({ type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json } })), { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]
  const bytes = Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) {
      const chunk = bytes.subarray(i, i + 7); capture.bytes(chunk); controller.enqueue(chunk)
    }
    controller.close()
  } }))))
  const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({
    baseURL: 'http://127.0.0.1:1', thinking: 'disabled' }),
    prepareExtensions: async () => ({ fields: {}, accept: async () => undefined }),
    resolveAuth: async () => ({ headers: {} }), resolveUserId: () => 'offline-replay' })
  let failure: unknown
  try {
    for await (const chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'offline fixture' }] }],
      reasoningEffort: 'off', maxTokens: 100, signal: new AbortController().signal })) capture.sdk(chunk)
  } catch (error) { capture.failed(error); failure = error }
  return { snapshot: capture.snapshot(), failure }
}
describe('actual pinned DeepSeek adapter replay, no network', () => {
  it('assembles fragmented Unicode tool JSON byte-for-byte', async () => {
    const result = await replay('{"request":{"prompt":"画圆"}}')
    expect(result.failure).toBeUndefined()
    expect((result.snapshot.tools as unknown[])[0]).toMatchObject({ wireJsonValid: true, sdkJsonValid: true, assembly: 'identical' })
  })
  it.each(['{"request":{}}}', '{"request":{}}}}'])('rejects complete extra-brace JSON without repair: %s', async args => {
    const result = await replay(args)
    expect(result.failure).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect((result.snapshot.tools as unknown[])[0]).toMatchObject({
      complete: true, wireJsonValid: false, sdkJsonValid: false, assembly: 'identical' })
  })
  it('attributes malformed concatenated wire input to the provider boundary', async () => {
    const result = await replay('{"request":')
    expect(result.failure).toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect((result.snapshot.tools as unknown[])[0]).toMatchObject({ wireJsonValid: false, sdkJsonValid: false, assembly: 'identical' })
  })
})

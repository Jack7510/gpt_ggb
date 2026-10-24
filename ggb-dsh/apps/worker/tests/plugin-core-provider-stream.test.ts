import { describe, expect, it, vi } from 'vitest'
import { EVIDENCE_LIMITS } from '../src/plugin-core/evidence.js'
import { ProviderToolStream, ProviderStreamEvidence } from '../src/plugin-core/provider-stream-evidence.js'
import { apply } from '../src/plugin-core/provider-stream-plugin.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function events(argumentsText: string) {
  return [{ type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'ggb_build', input: {} } },
    ...[argumentsText.slice(0, 12), argumentsText.slice(12)].map(partial_json => ({
      type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]
}
function tool(capture: ProviderToolStream) { return (capture.snapshot().tools as Record<string, unknown>[])[0]! }

describe('wire versus public SDK tool stream evidence', () => {
  it('separates observed wait and content timestamps without retaining content or signatures', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const capture = new ProviderToolStream(1, [])
      clock.mockReturnValue(1010)
      capture.providerRequest({})
      clock.mockReturnValue(1100)
      capture.httpStatus(200)
      clock.mockReturnValue(1120)
      capture.bytes(Buffer.from(': heartbeat\n\n'))
      clock.mockReturnValue(1150)
      capture.wire({ type: 'message_start' })
      capture.wire({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } })
      clock.mockReturnValue(1200)
      capture.wire({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '秘密' } })
      capture.wire({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } })
      clock.mockReturnValue(1500)
      capture.wire({ type: 'content_block_start', content_block: { type: 'text', text: 'PRIVATE_TEXT' } })
      capture.wire({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', input: {}, id: 'call', name: 'ggb_check' } })
      clock.mockReturnValue(1700)
      capture.wire({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"revision":1}' } })
      clock.mockReturnValue(1800)
      capture.wire({ type: 'message_stop' })
      clock.mockReturnValue(1850)
      capture.finish()
      expect(capture.snapshot().performance).toEqual({ timing: {
        requestSentMs: 10, responseHeadersMs: 100, firstByteMs: 120, firstEventMs: 150,
        firstContentMs: 200, firstThinkingMs: 200, firstTextMs: 500, firstToolInputMs: 700,
        lastContentMs: 700, streamEndMs: 800, observedContentSpanMs: 500, postStreamMs: 50,
      }, content: { thinking: { starts: 1, deltas: 1, bytes: 6 },
        text: { starts: 1, deltas: 0, bytes: 12 }, toolInput: { starts: 1, deltas: 1, bytes: 14 } } })
      const serialized = JSON.stringify(capture.snapshot())
      for (const value of ['秘密', 'PRIVATE_TEXT', 'PRIVATE_SIGNATURE']) expect(serialized).not.toContain(value)
    } finally { clock.mockRestore() }
  })
  it('leaves unobserved timings unknown on failure and ignores signatures and empty payloads', () => {
    const capture = new ProviderToolStream(1, [])
    capture.bytes(new Uint8Array())
    capture.wire({ type: 'content_block_start', content_block: { type: 'text', text: '' } })
    capture.wire({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'PRIVATE' } })
    capture.wire({ type: 'content_block_delta', delta: { type: 'unknown_delta', text: 'PRIVATE' } })
    capture.failed(new Error('cancelled'))
    capture.finish()
    expect(capture.snapshot()).toMatchObject({ wireMessageStop: false, performance: {
      timing: { requestSentMs: null, responseHeadersMs: null, firstByteMs: null, firstContentMs: null,
        firstThinkingMs: null, firstTextMs: null, firstToolInputMs: null, streamEndMs: null,
        observedContentSpanMs: null, postStreamMs: null },
      content: { thinking: { starts: 0, deltas: 0, bytes: 0 }, text: { starts: 1, deltas: 0, bytes: 0 } },
    } })
    expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE')
  })
  it('records request timing, context sizes and final numeric usage without retaining history', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const capture = new ProviderToolStream(1, [])
      const messages = [{ role: 'user', content: 'PRIVATE_TASK' }, { role: 'assistant', content: 'PRIVATE_HISTORY' }]
      capture.providerRequest({ system: [{ type: 'text', text: 'PRIVATE_SYSTEM' }], messages })
      capture.wire({ type: 'message_start', message: { usage: {
        input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 100, raw: 'PRIVATE_USAGE',
      } } })
      capture.wire({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } })
      clock.mockReturnValue(1450)
      capture.finish()
      expect(capture.snapshot()).toMatchObject({ startedAt: new Date(1000).toISOString(),
        finishedAt: new Date(1450).toISOString(), durationMs: 450, stopReason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 25, cache_read_input_tokens: 100 },
        providerRequest: { systemBytes: 14, messageCount: 2, messagesBytes: Buffer.byteLength(JSON.stringify(messages)),
          messageBytesByRole: { user: Buffer.byteLength(JSON.stringify(messages[0])) } } })
      expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE_')
    } finally { clock.mockRestore() }
  })
  it.each(['\n', '\r\n'])('preserves Unicode and fragmented SSE with %j separators', separator => {
    const args = JSON.stringify({ request: { prompt: '画圆', plan: {} } })
    const text = events(args).map(event => `event: ${event.type}${separator}data: ${JSON.stringify(event)}${separator}${separator}`).join('')
    const bytes = Buffer.from(text)
    const capture = new ProviderToolStream(1, [])
    for (let i = 0; i < bytes.length; i += 7) capture.bytes(bytes.subarray(i, i + 7))
    capture.sdk({ type: 'block-end', block: { type: 'tool-call', id: 'call', arguments: args } })
    expect(tool(capture)).toMatchObject({ complete: true, wireJsonValid: true, sdkJsonValid: true, assembly: 'identical' })
  })
  it('distinguishes malformed provider JSON from a changed SDK assembly', () => {
    const bad = new ProviderToolStream(1, [])
    for (const event of events('{"request":')) bad.wire(event)
    bad.sdk({ type: 'block-end', block: { type: 'tool-call', id: 'call', arguments: '{"request":' } })
    expect(tool(bad)).toMatchObject({ wireJsonValid: false, sdkJsonValid: false, assembly: 'identical' })
    const changed = new ProviderToolStream(2, [])
    for (const event of events('{"request":{}}')) changed.wire(event)
    changed.sdk({ type: 'block-end', block: { type: 'tool-call', id: 'call', arguments: '{' } })
    expect(tool(changed)).toMatchObject({ wireJsonValid: true, sdkJsonValid: false, assembly: 'different' })
  })
  it('redacts split secrets after assembly and retains no free text or reasoning', () => {
    const capture = new ProviderToolStream(1, ['fake-key', 'split-secret'])
    capture.wire({ type: 'content_block_start', index: 9, content_block: { type: 'thinking', thinking: 'private reasoning' } })
    const args = '{"token":"split-secret","prompt":"fake-key"}'
    for (const event of events(args)) capture.wire(event)
    capture.sdk({ type: 'block-end', block: { type: 'tool-call', id: 'call', arguments: args } })
    const text = JSON.stringify(capture.snapshot())
    expect(text).not.toContain('split-secret')
    expect(text).not.toContain('fake-key')
    expect(text).not.toContain('private reasoning')
    expect(tool(capture).wirePreview).toContain('[redacted]')
  })
  it('redacts an unknown credential even when its JSON string is unterminated', () => {
    const capture = new ProviderToolStream(1, [])
    for (const event of events('{"providerKey":"unknown-value')) capture.wire(event)
    expect(JSON.stringify(capture.snapshot())).not.toContain('unknown-value')
  })
  it('marks oversized or incomplete input as unavailable, never as an SDK mismatch', () => {
    const capture = new ProviderToolStream(1, [])
    for (const event of events('x'.repeat(40 * 1024))) capture.wire(event)
    expect(tool(capture)).toMatchObject({ truncated: true, complete: false, assembly: 'unavailable' })
  })
  it('compares full JSON even when small token deltas exceed the fragment metadata limit', () => {
    const capture = new ProviderToolStream(1, [])
    const args = JSON.stringify({ request: { prompt: '画'.repeat(500) } })
    const wire = events(args)
    capture.wire(wire[1]!)
    for (const partial_json of args) capture.wire({ type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json } })
    for (const event of wire.slice(-3)) capture.wire(event)
    capture.sdk({ type: 'block-end', block: { type: 'tool-call', id: 'call', arguments: args } })
    expect(tool(capture)).toMatchObject({ complete: true, truncated: false,
      fragmentMetadataLimited: true, assembly: 'identical' })
    expect(tool(capture).fragments).toHaveLength(256)
  })
  it('keeps all stream chunks after the diagnostic budget and tolerates diagnostic write failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stream-budget-'))
    const key = Symbol.for('ggb.providerStreamEvidence')
    const global = globalThis as unknown as Record<symbol, unknown>
    const previous = global[key]
    type Chunk = Record<string, unknown>
    let hook!: (options: unknown, next: () => AsyncIterable<Chunk>) => AsyncIterable<Chunk>
    try {
      const path = join(root, 'stream.json')
      const evidence = new ProviderStreamEvidence(path, [])
      global[key] = evidence
      apply({ on(_name, handler) { hook = handler } })
      for (let i = 0; i < EVIDENCE_LIMITS.calls + 4; i++) {
        const chunks = []
        for await (const chunk of hook({}, async function* () { yield { index: i }; yield { done: true } })) chunks.push(chunk)
        expect(chunks).toEqual([{ index: i }, { done: true }])
      }
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ droppedRequests: 4 })
      const requests = JSON.parse(await readFile(path, 'utf8')).requests
      expect(requests).toHaveLength(EVIDENCE_LIMITS.calls)
      expect(requests[16]).toMatchObject({ request: 17, durationMs: expect.any(Number), finishedAt: expect.any(String) })
      const blocker = join(root, 'file')
      await writeFile(blocker, 'not a directory')
      global[key] = new ProviderStreamEvidence(join(blocker, 'stream.json'), [])
      const chunks = []
      for await (const chunk of hook({}, async function* () { yield { ok: true } })) chunks.push(chunk)
      expect(chunks).toEqual([{ ok: true }])
      await expect(async () => {
        for await (const _ of hook({}, async function* () { throw new Error('actual SDK error') })) { /* drain */ }
      }).rejects.toThrow('actual SDK error')
    } finally {
      if (previous === undefined) delete global[key]; else global[key] = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})

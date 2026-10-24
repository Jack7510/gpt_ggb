import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderStreamEvidence } from '../src/plugin-core/provider-stream-evidence.js'

const key = Symbol.for('ggb.providerStreamEvidence')
const shared = globalThis as unknown as Record<symbol, ProviderStreamEvidence | undefined>
const original = shared[key]
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules()
  if (original === undefined) delete shared[key]; else shared[key] = original
})

it('attributes timings to the exact Provider POST, excluding image, GET and other-origin fetches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-preload-'))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    clock.mockReturnValue(url === 'https://fixture.invalid/v1/messages' ? 1400 : 1100)
    return new Response('data: {"type":"message_stop"}\n\n', { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  vi.stubEnv('GGB_DSH_TOOL_STREAM_EVIDENCE', join(dir, 'stream.json'))
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://fixture.invalid/v1')
  try {
    await import('../src/plugin-core/provider-stream-preload.js')
    const evidence = shared[key]!
    const capture = evidence.begin()!
    await evidence.scope.run(capture, async () => {
      await globalThis.fetch('https://fixture.invalid/image', { method: 'POST' })
      await globalThis.fetch('https://other.invalid/v1/messages', { method: 'POST' })
      await globalThis.fetch('https://fixture.invalid/v1/messages')
      expect(capture.snapshot()).toMatchObject({ responseStatus: null,
        performance: { timing: { requestSentMs: null, responseHeadersMs: null, firstByteMs: null } } })
      clock.mockReturnValue(1300)
      const init = { method: 'POST', body: '{"messages":[]}', headers: { authorization: 'PRIVATE_HEADER' } }
      const response = await globalThis.fetch('https://fixture.invalid/v1/messages', init)
      expect(fetch).toHaveBeenLastCalledWith('https://fixture.invalid/v1/messages', init)
      expect(await response.text()).toBe('data: {"type":"message_stop"}\n\n')
    })
    capture.finish()
    expect(capture.snapshot()).toMatchObject({ performance: {
      timing: { requestSentMs: 300, responseHeadersMs: 400, firstByteMs: 400 },
    } })
    expect(JSON.stringify(capture.snapshot())).not.toContain('PRIVATE_HEADER')
    const failed = evidence.begin()!
    fetch.mockRejectedValueOnce(new Error('network_failed'))
    await expect(evidence.scope.run(failed, () => globalThis.fetch('https://fixture.invalid/v1/messages', { method: 'POST' })))
      .rejects.toThrow('network_failed')
    expect(failed.snapshot()).toMatchObject({ responseStatus: null, performance: {
      timing: { requestSentMs: expect.any(Number), responseHeadersMs: null, firstByteMs: null },
    } })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

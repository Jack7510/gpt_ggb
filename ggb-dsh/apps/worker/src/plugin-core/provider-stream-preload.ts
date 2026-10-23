import { ProviderStreamEvidence } from './provider-stream-evidence.js'

const path = process.env.GGB_DSH_TOOL_STREAM_EVIDENCE
if (path) {
  const evidence = new ProviderStreamEvidence(path, [process.env.DEEPSEEK_API_KEY ?? '',
    process.env.GGB_PLUGIN_CORE_TOOL_TOKEN ?? ''])
  const original = globalThis.fetch
  const origin = new URL(process.env.DEEPSEEK_BASE_URL!).origin
  Object.assign(globalThis, { [Symbol.for('ggb.providerStreamEvidence')]: evidence })
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const capture = evidence.scope.getStore()
    if (capture && url.origin === origin && url.pathname.endsWith('/messages') && typeof init?.body === 'string') {
      try { capture.providerRequest(JSON.parse(init.body)) } catch { /* Never mutate a request. */ }
    }
    const response = await original(input, init)
    capture?.httpStatus(response.status)
    if (!capture || url.origin !== origin || !url.pathname.endsWith('/messages') || !response.ok || !response.body) return response
    const observed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try { capture.bytes(chunk) } catch { /* Observing must not change bytes. */ }
        controller.enqueue(chunk)
      },
      async flush() { await evidence.flush() },
    }))
    return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

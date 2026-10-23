import { createIframeAppletPort } from './src/geogebra/host.js'

const gateway = 'http://127.0.0.1:4178'
const status = document.getElementById('status') as HTMLParagraphElement
const result = document.getElementById('result') as HTMLPreElement
const start = document.getElementById('start') as HTMLButtonElement
const prompt = document.getElementById('prompt') as HTMLInputElement
const canvas = document.getElementById('canvas') as HTMLDivElement
const { port, element } = createIframeAppletPort({ timeoutMs: 120_000 })
element.style.width = '100%'
element.style.height = '100%'
canvas.append(element)

let handledTransactionId: string | null = null

void port.ready().then(() => {
  status.textContent = 'GeoGebra applet 已就绪'
  start.disabled = false
}).catch((error: unknown) => {
  status.textContent = `applet 加载失败：${String(error)}`
})

start.addEventListener('click', () => {
  start.disabled = true
  void run().catch((error: unknown) => {
    status.textContent = `实验失败：${String(error)}`
  })
})

async function run(): Promise<void> {
  const before = await port.snapshot()
  await post('/start', { prompt: prompt.value, canvasVersion: before.canvasVersion })
  status.textContent = 'DSH 正在推理…'
  for (let tick = 0; tick < 240; tick += 1) {
    const next = await get('/next') as { transaction: unknown } | null
    if (next !== null) {
      const transaction = next.transaction as { transactionId: string }
      if (handledTransactionId !== transaction.transactionId) {
        handledTransactionId = transaction.transactionId
        status.textContent = 'ggb-tool 已调用，applet 正在执行…'
        const observation = await port.apply(transaction)
        const finalization = await port.finalize(transaction as never, 'commit')
        const context = await port.context()
        await post('/result', { transactionId: transaction.transactionId, observation, finalization, context })
        status.textContent = '真实 applet 结果已返回 ggb-tool，等待 DSH 继续…'
      }
    }
    const state = await get('/state') as { phase: string; finalResponse?: string; error?: string; toolCalls?: number; toolResults?: number }
    if (state.phase === 'completed' || state.phase === 'failed') {
      status.textContent = state.phase === 'completed' ? '闭环完成' : `DSH 失败：${state.error ?? 'unknown'}`
      result.textContent = JSON.stringify(state, null, 2)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('experiment_deadline_exceeded')
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${gateway}${path}`)
  if (!response.ok) throw new Error(`${path}:${response.status}`)
  return response.json()
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${gateway}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(`${path}:${JSON.stringify(value)}`)
  return value
}

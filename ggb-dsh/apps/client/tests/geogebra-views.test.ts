import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDirectAppletPort } from '../src/geogebra/host.js'
import { applyCanvasViews, parseCanvasViews, readCanvasViews, saveCanvasViews } from '../src/geogebra/view-settings.js'
import { digestCanonicalXml } from '../src/geogebra/snapshot.js'

afterEach(() => vi.unstubAllGlobals())

function storage(initial: string | null = null) {
  let value = initial
  const store = { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next }) }
  vi.stubGlobal('localStorage', store)
  return store
}

function mounted() {
  let perspective = 'file-layout'
  let input = true
  let loadOptions: { perspective: string; showAlgebraInput: boolean; showMenuBar: boolean } | undefined
  let finishRestore: (() => void) | undefined
  let deferRestore = false
  const api = {
    setPerspective: vi.fn((value: string) => { perspective = value }),
    showAlgebraInput: vi.fn((value: boolean) => { input = value }),
    evalCommand: vi.fn(() => true),
    setBase64: vi.fn((_value: string, callback: () => void) => {
      perspective = 'file-split-layout'
      input = true
      if (deferRestore) finishRestore = callback
      else callback()
    }),
    newConstruction: vi.fn(() => { perspective = 'reset-layout' }),
  }
  vi.stubGlobal('GGBApplet', class {
    constructor(options: NonNullable<typeof loadOptions> & { appletOnLoad(api: unknown): void }) {
      loadOptions = options
      this.load = () => options.appletOnLoad(api)
    }
    load: () => void
    inject() { this.load() }
    setHTML5Codebase() {}
  })
  const container = { getBoundingClientRect: () => ({ width: 800, height: 600 }) } as HTMLElement
  const port = createDirectAppletPort({ container })
  return { port, api, options: loadOptions, layout: () => ({ perspective, input }),
    defer: () => { deferRestore = true }, finish: () => finishRestore?.() }
}

describe('canvas view preference', () => {
  it('defaults to graphics only for absent, invalid or unavailable storage', () => {
    for (const value of [null, 'broken', '{"algebra":"true","cas":false}', '{"algebra":true}']) {
      storage(value)
      expect(readCanvasViews()).toEqual({ algebra: false, cas: false })
    }
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(readCanvasViews()).toEqual({ algebra: false, cas: false })
    expect(() => saveCanvasViews({ algebra: true, cas: true })).not.toThrow()
  })

  it('saves both independent toggles and rejects non-boolean RPC input', () => {
    storage()
    saveCanvasViews({ algebra: true, cas: true })
    expect(readCanvasViews()).toEqual({ algebra: true, cas: true })
    for (const input of [null, {}, { algebra: 'true', cas: false }, { algebra: true, cas: 1 }]) {
      expect(() => parseCanvasViews(input)).toThrow('applet_payload_invalid:views')
    }
  })

  it('changes only view APIs for every allowed layout', () => {
    const api = { setPerspective: vi.fn(), showAlgebraInput: vi.fn() }
    for (const [algebra, cas, layout] of [[false, false, 'G'], [true, false, 'AG'], [false, true, 'GC'], [true, true, 'AGC']] as const) {
      applyCanvasViews(api, { algebra, cas }, '2d')
      expect(api.setPerspective).toHaveBeenLastCalledWith(layout)
      expect(api.showAlgebraInput).toHaveBeenLastCalledWith(algebra)
    }
  })
})

describe('applet file loading and view selection', () => {
  it('starts with one graphics view and no input/menu, retaining drawing tools', async () => {
    storage()
    const app = mounted()
    await app.port.ready()
    expect(app.options).toMatchObject({ perspective: 'G', showAlgebraInput: false, showMenuBar: false, showToolBar: true })
    expect(app.layout()).toEqual({ perspective: 'G', input: false })
    await app.port.restore('file-with-other-views')
    expect(app.layout()).toEqual({ perspective: 'G', input: false })
  })

  it('keeps user selection after every restore/reset and uses it in a fresh applet', async () => {
    storage('{"algebra":true,"cas":false}')
    const app = mounted()
    expect(app.layout()).toEqual({ perspective: 'AG', input: true })
    await app.port.setViews({ algebra: false, cas: true })
    const failure = new Error('view switch failed')
    app.api.setPerspective.mockImplementationOnce(() => { throw failure })
    await expect(app.port.setViews({ algebra: true, cas: true })).rejects.toBe(failure)
    for (const file of ['delivery', 'imported-file', 'session-snapshot']) {
      await app.port.restore(file)
      expect(app.layout()).toEqual({ perspective: 'GC', input: false })
    }
    await app.port.reset()
    expect(app.layout()).toEqual({ perspective: 'GC', input: false })
    await app.port.setViews({ algebra: true, cas: true })
    saveCanvasViews({ algebra: true, cas: true })
    expect(mounted().layout()).toEqual({ perspective: 'AGC', input: true })
    await app.port.setViews({ algebra: false, cas: false })
    await app.port.restore('another-file')
    expect(app.layout()).toEqual({ perspective: 'G', input: false })
    expect(app.api.newConstruction).toHaveBeenCalledTimes(1)
  })

  it('uses the latest choice when an asynchronous file finishes loading', async () => {
    storage()
    const app = mounted()
    app.defer()
    const pending = app.port.restore('slow-file')
    await vi.waitFor(() => expect(app.api.setBase64).toHaveBeenCalled())
    await app.port.setViews({ algebra: false, cas: true })
    app.finish()
    await pending
    expect(app.layout()).toEqual({ perspective: 'GC', input: false })
    await expect(app.port.setViews({ algebra: 'true', cas: false } as never)).rejects.toThrow('applet_payload_invalid:views')
    await app.port.reset()
    expect(app.layout()).toEqual({ perspective: 'GC', input: false })
  })

  it('view changes do not alter the construction digest used by continuation', async () => {
    const construction = '<construction><element type="point" label="A"/></construction>'
    const xml = (layout: string) => `<geogebra><gui><perspectives>${layout}</perspectives></gui>${construction}</geogebra>`
    expect(await digestCanonicalXml(xml('G'))).toBe(await digestCanonicalXml(xml('AGC')))
  })
})

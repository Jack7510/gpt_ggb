import { describe, expect, it } from 'vitest'
import { encodeGeoGebraCallV1 } from '../src/encoder.js'
import { RestrictedGeoGebraAdapterV1, type RestrictedGeoGebraApiV1 } from '../src/applet-adapter.js'

// This fake checks the boundary grammar; actual GeoGebra parsing requires browser validation.
function circleApi(label: string): RestrictedGeoGebraApiV1 & { calls: string[]; deleted: string[] } {
  const calls: string[] = []
  const deleted: string[] = []
  const values = new Map<string, number>()
  return {
    calls, deleted, evalCommand: () => false, getXML: () => '', setXML: () => {},
    exists: candidate => candidate === label || values.has(candidate),
    getObjectType: () => 'circle', getCommandString: () => '',
    evalCommandGetLabels: command => {
      calls.push(command)
      const split = command.indexOf('=')
      const name = command.slice(0, split)
      const expression = command.slice(split + 1)
      const accepted = [`x(Center[${label}])`, `y(Center[${label}])`, `z(Center[${label}])`, `Radius[${label}]`]
      if (!accepted.includes(expression)) return null
      values.set(name, expression.startsWith('Radius[') ? 2 : expression.startsWith('z(') ? 0 : 1)
      return name
    },
    getValue: candidate => values.get(candidate) ?? Number.NaN,
    deleteObject: candidate => { deleted.push(candidate); values.delete(candidate) },
  }
}

describe('shared GeoGebra command encoding boundary', () => {
  it('encodes nested command calls without changing math function syntax', () => {
    const closest = encodeGeoGebraCallV1('ClosestPoint', ['Center', 'Radius'])
    expect(encodeGeoGebraCallV1('AreEqual', ['Radius', closest]))
      .toBe('AreEqual[Radius,ClosestPoint[Center,Radius]]')
    expect(`x(${encodeGeoGebraCallV1('Center', ['Vertex'])})`).toBe('x(Center[Vertex])')
    expect(() => encodeGeoGebraCallV1('Center;DeleteAll', [])).toThrow()
  })

  it.each(['Center', 'Radius', 'Vertex'])('observes an existing circle named %s without creating observation helper commands', async label => {
    const api = circleApi(label)
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    const observed = await adapter.readObject(label, new AbortController().signal)
    expect(observed).toMatchObject({ exists: true, objectType: 'circle' })
    expect(api.calls).toEqual([])
  })
})

it('keeps a created circle when optional analytic APIs are unavailable', async () => {
  const api = circleApi('circ1')
  api.getValue = () => { throw new Error('analytic values unavailable') }
  const raw = await new RestrictedGeoGebraAdapterV1(api).readObject('circ1', new AbortController().signal)
  expect(raw).toMatchObject({ exists: true, objectType: 'circle' })
  expect(api.calls).toEqual([])
  expect(api.deleted).toEqual([])
})

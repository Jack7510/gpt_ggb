import { describe, expect, it } from 'vitest'
import { canonicalCanvasXml } from '../src/geogebra/snapshot.js'

describe('canonicalCanvasXml', () => {
  const xml = (
    id: string,
    gui: string,
    view: string,
    construction: string,
    kernel = '<kernel><decimals val="2"/></kernel>',
  ): string => [
    `<geogebra format="5.0" version="6.0.1" id="${id}" app="classic" platform="html5">`,
    gui, view, kernel, construction, '</geogebra>',
  ].join('\n')

  const compactGui = [
    '<gui>',
    '  <window width="469" height="406"/>',
    '  <pane divider="0.7635" orientation="1"/>',
    '  <view id="1" visible="false" size="310"/>',
    '</gui>',
  ].join('\n')
  const resizedGui = [
    '<gui>',
    '  <window width="469" height="849"/>',
    '  <pane divider="0.8845" orientation="1"/>',
    '  <view id="1" visible="false" size="751"/>',
    '</gui>',
  ].join('\n')
  const compactView = '<euclidianView><size width="469" height="310"/>'
    + '<coordSystem xZero="234.5" yZero="155" scale="50" yscale="50"/></euclidianView>'
  const resizedView = '<euclidianView><size width="469" height="751"/>'
    + '<coordSystem xZero="234.5" yZero="375.5" scale="50" yscale="50"/></euclidianView>'
  const construction = '<construction><element type="point" label="A">'
    + '<coords x="0" y="0" z="1"/></element></construction>'

  it('ignores applet instance, layout and viewport state', () => {
    expect(canonicalCanvasXml(xml('applet-1', compactGui, compactView, construction)))
      .toBe(canonicalCanvasXml(xml('applet-2', resizedGui, resizedView, construction)))
  })

  it('keeps construction, presentation and kernel state significant', () => {
    const base = canonicalCanvasXml(xml('applet-1', compactGui, compactView, construction))
    expect(canonicalCanvasXml(xml('applet-1', compactGui, compactView,
      '<construction><element type="point" label="B"><coords x="0" y="0" z="1"/></element></construction>')))
      .not.toBe(base)
    expect(canonicalCanvasXml(xml('applet-1', compactGui, compactView,
      '<construction><element type="point" label="A"><show object="true" label="1"/>'
      + '<coords x="0" y="0" z="1"/></element></construction>'))).not.toBe(base)
    expect(canonicalCanvasXml(xml('applet-1', compactGui, compactView,
      construction, '<kernel><decimals val="4"/></kernel>'))).not.toBe(base)
    expect(base).toContain('<construction>')
    expect(base).not.toContain('<gui>')
    expect(base).not.toContain('<euclidianView>')
    expect(base).not.toContain('applet-1')
  })
})

import { describe, expect, it } from 'vitest'

import { canvasObjectDefinition, enforceCartesianViewSettings, projectSelectedLabels } from '../src/geogebra/host.js'

describe('enforceCartesianViewSettings', () => {
  it('shows the 2D axes and hides the grid with fixed official commands', () => {
    const commands: string[] = []

    enforceCartesianViewSettings({
      evalCommand: (command) => {
        commands.push(command)
        return true
      },
    })

    expect(commands).toEqual(['ShowAxes(1,true)', 'ShowGrid(1,false)'])
  })
})

describe('GeoGebra client selection projection', () => {
  it('uses select and deselect event targets instead of relying on native selected-name queries', () => {
    let selected: string[] = []
    selected = projectSelectedLabels(selected, { type: 'select', target: 'd' })
    selected = projectSelectedLabels(selected, { type: 'select', target: 'poly1' })
    selected = projectSelectedLabels(selected, { type: 'select', target: 'd' })
    expect(selected).toEqual(['d', 'poly1'])
    expect(projectSelectedLabels(selected, { type: 'deselect', target: 'd' })).toEqual(['poly1'])
    expect(projectSelectedLabels(selected, { type: 'deselect' })).toEqual([])
  })
})

describe('canvas object summary', () => {
  it('uses a non-empty GeoGebra value string when sliders have no definition string', () => {
    expect(canvasObjectDefinition({ getDefinitionString: () => '', getValueString: () => 'r = 3' }, 'r')).toBe('r = 3')
    expect(canvasObjectDefinition({ getDefinitionString: () => 'Circle(A, 2)' }, 'c')).toBe('Circle(A, 2)')
  })
})

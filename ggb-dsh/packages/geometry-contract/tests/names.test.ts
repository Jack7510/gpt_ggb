import { describe, expect, it } from 'vitest'
import { geometryCaptionV1Schema, geometryNameConflictsV1, geometryObjectCaptionV1,
  geometryVariableNameV1Schema, isReservedGeoGebraNameV1, normalizeGeometryNameV1 } from '../src/index.js'

describe('unified label and Caption namespace', () => {
  it('normalizes prime only at the name suffix and defaults Caption to the actual label', () => {
    expect(normalizeGeometryNameV1('Fprime')).toBe("F'")
    expect(normalizeGeometryNameV1('Fprimeprime')).toBe("F''")
    expect(normalizeGeometryNameV1('primePoint')).toBe('primePoint')
    expect(geometryCaptionV1Schema.parse('Fprime')).toBe("F'")
    expect(geometryObjectCaptionV1({ variableName: 'ignored' }, 'A')).toBe('A')
    expect(geometryObjectCaptionV1({ variableName: 'P1', caption: 'Pprime' }, 'P1')).toBe("P'")
  })
  it('uses the official reserved labels and command inventory', () => {
    for (const name of ['x', 'y', 'z', 'sin', 'Center', 'Focus', 'center', 'SetCaption']) {
      expect(isReservedGeoGebraNameV1(name)).toBe(true)
      expect(geometryVariableNameV1Schema.safeParse(name).success).toBe(false)
      expect(geometryCaptionV1Schema.safeParse(name).success).toBe(false)
    }
    for (const name of ['A', 'A2', 'pt1', 'Center1']) expect(geometryVariableNameV1Schema.safeParse(name).success).toBe(true)
  })
  it('deduplicates aliases of one object and rejects cross-object owners', () => {
    expect(geometryNameConflictsV1([{ label: 'A', caption: 'A' }, { label: 'B' }])).toEqual([])
    expect(geometryNameConflictsV1([{ label: 'pt1', caption: 'A' }, { label: 'A', caption: 'B' }]))
      .toEqual([{ name: 'A', owners: [0, 1] }])
    expect(geometryNameConflictsV1([{ label: 'pt1', caption: 'A' }, { label: 'pt2', caption: 'A' }]))
      .toEqual([{ name: 'A', owners: [0, 1] }])
  })
})

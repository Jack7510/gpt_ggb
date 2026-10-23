import { describe, expect, it } from 'vitest'

import {
  geometryObjectIdSchema,
  type GeometryObjectId,
} from '@ggb-copilot/geometry-contract'

import {
  GeometryObservationError,
  normalizeGeoGebraObjectV1,
} from '../src/index.js'

const pointId = geometryObjectIdSchema.parse('obj_00000000-0000-4000-8000-000000000001')
const lineId = geometryObjectIdSchema.parse('obj_00000000-0000-4000-8000-000000000002')

describe('GeoGebra observation normalization', () => {
  it('normalizes point, line, segment and circle facts with dependencies', () => {
    const labels = new Map<string, GeometryObjectId>([['ggb_point', pointId], ['ggb_line', lineId]])
    expect(normalizeGeoGebraObjectV1(pointId, 'ggb_point', {
      exists: true, objectType: 'point', definition: '(1, 2)', properties: { x: 1, y: 2, unsafe: { nested: true } },
    }, labels).properties).toEqual({ x: 1, y: 2, exists: true })
    expect(normalizeGeoGebraObjectV1(lineId, 'ggb_line', {
      exists: true, objectType: 'line', definition: 'Line(A,B)', dependencies: ['ggb_point'],
      properties: { a: 1, b: -1, c: 0 },
    }, labels).dependencies).toEqual([pointId])
    expect(normalizeGeoGebraObjectV1(lineId, 'ggb_segment', {
      exists: true, objectType: 'segment', properties: { length: 3 },
    }).kind).toBe('segment')
    expect(normalizeGeoGebraObjectV1(lineId, 'ggb_circle', {
      exists: true, objectType: 'conic', definition: 'Circle(A,B)',
      properties: { centerX: 0, centerY: 0, radius: 3 },
    }).kind).toBe('circle')
  })

  it('normalizes three-dimensional and conic object families', () => {
    expect(normalizeGeoGebraObjectV1(pointId, 'p3', {
      exists: true, objectType: 'point', properties: { x: 1, y: 2, z: 3 },
    }).properties).toEqual({ x: 1, y: 2, z: 3, exists: true })
    expect(normalizeGeoGebraObjectV1(lineId, 'plane', {
      exists: true, objectType: 'plane', properties: {},
    }).kind).toBe('plane')
    expect(normalizeGeoGebraObjectV1(lineId, 'parabola', {
      exists: true, objectType: 'conic', definition: 'Parabola(F, d)', properties: {},
    }).kind).toBe('conic')
    for (const objectType of ['parabola', 'ellipse', 'hyperbola']) {
      expect(normalizeGeoGebraObjectV1(lineId, objectType, {
        exists: true, objectType, definition: 'y² = 4x', properties: {},
      }).kind).toBe('conic')
    }
    expect(normalizeGeoGebraObjectV1(lineId, 'implicit', {
      exists: true, objectType: 'implicitpoly', definition: 'x^4 + y^3 = 2x y', properties: {},
    }).kind).toBe('curve')
    expect(normalizeGeoGebraObjectV1(lineId, 'trajectory', {
      exists: true, objectType: 'locus', definition: 'Locus(M, Q)', properties: {},
    }).kind).toBe('curve')
    expect(normalizeGeoGebraObjectV1(lineId, 'sphere', {
      exists: true, objectType: 'quadric', definition: 'Sphere(A, B)',
      properties: { centerX: 0, centerY: 0, centerZ: 0, radius: 2 },
    }).kind).toBe('sphere')
    expect(normalizeGeoGebraObjectV1(lineId, 'solid', {
      exists: true, objectType: 'polyhedron', properties: { volume: 6 },
    }).kind).toBe('polyhedron')
  })

  it('maps GeoGebra polygon family types to the polygon kind', () => {
    for (const objectType of ['triangle', 'quadrilateral', 'pentagon', 'hexagon', 'polygon']) {
      expect(normalizeGeoGebraObjectV1(lineId, objectType, {
        exists: true, objectType, definition: 'Polygon(A, B, C)', properties: {},
      }).kind).toBe('polygon')
    }
  })

  it('normalizes a GeoGebra numeric slider with its current value', () => {
    expect(normalizeGeoGebraObjectV1(lineId, 'n', {
      exists: true, objectType: 'numeric', definition: 'Slider(3, 12, 1)', properties: { value: 6 },
    })).toMatchObject({ kind: 'slider', properties: { value: 6 } })
  })

  it('reports missing objects, properties and dependencies while preserving unknown types', () => {
    expect(normalizeGeoGebraObjectV1(pointId, 'ggb_point', { exists: false }))
      .toMatchObject({ properties: { exists: false }, kind: 'object' })
    const failures = [
      () => normalizeGeoGebraObjectV1(pointId, 'ggb_point', { exists: true, objectType: 'point', properties: { x: 1 } }),
      () => normalizeGeoGebraObjectV1(pointId, 'ggb_point', { exists: undefined } as never),
      () => normalizeGeoGebraObjectV1(lineId, 'ggb_line', {
        exists: true, objectType: 'line', dependencies: ['unknown'], properties: { a: 1, b: 0, c: 0 },
      }),
    ]
    const codes = failures.map((failure) => {
      try { failure(); return 'none' } catch (error: unknown) {
        return error instanceof GeometryObservationError ? error.geometryError.code : 'unexpected'
      }
    })
    expect(codes).toEqual([
      'none', 'none', 'OBSERVE_OBJECT_MISSING',
    ])
    expect(normalizeGeoGebraObjectV1(pointId, 'caption', {
      exists: true, objectType: 'text', definition: 'Text("A")',
    })).toMatchObject({ kind: 'object', rawKind: 'text' })
  })
})

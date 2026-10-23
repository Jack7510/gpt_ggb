import {
  geometryObjectObservationV1Schema,
  type GeometryErrorV1,
  type GeometryObjectId,
  type GeometryObjectObservationV1,
} from '@ggb-copilot/geometry-contract'

type ObservationScalar = string | number | boolean | null

export interface RawGeoGebraObjectV1 {
  readonly exists?: boolean
  readonly objectType?: string
  readonly definition?: string
  readonly dependencies?: readonly string[]
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface GeoGebraObservationSourceV1 {
  /** Read one object by its internal, application-controlled label. */
  readObject(label: string, signal: AbortSignal): Promise<RawGeoGebraObjectV1>

}

export class GeometryObservationError extends Error {
  /** Preserve a stable observation failure for protocol and tool callers. */
  public constructor(public readonly geometryError: GeometryErrorV1) {
    super(geometryError.message)
    this.name = 'GeometryObservationError'
  }
}

/** Convert an untrusted applet object snapshot without inventing missing facts. */
export function normalizeGeoGebraObjectV1(
  objectId: GeometryObjectId,
  label: string,
  raw: RawGeoGebraObjectV1,
  objectIdsByLabel: ReadonlyMap<string, GeometryObjectId> = new Map([[label, objectId]]),
): GeometryObjectObservationV1 {
  if (typeof raw.exists !== 'boolean') return geometryObjectObservationV1Schema.parse({
    objectId, label, kind: 'object', definition: '', dependencies: [], properties: {},
  })
  if (!raw.exists) return geometryObjectObservationV1Schema.parse({
    objectId, label, kind: 'object', definition: '', dependencies: [], properties: { exists: false },
  })
  const kind = normalizeGeoGebraObjectKindV1(raw.objectType, raw.definition) ?? 'object'
  const properties = { ...normalizeProperties(raw.properties ?? {}), exists: true }
  const dependencies = (raw.dependencies ?? []).map((dependency) => {
    const resolved = objectIdsByLabel.get(dependency)
    if (resolved === undefined) throw observationError('OBSERVE_OBJECT_MISSING', { objectId, label, dependency })
    return resolved
  })
  return geometryObjectObservationV1Schema.parse({
    objectId, label, kind, ...(raw.objectType !== undefined ? { rawKind: raw.objectType } : {}),
    definition: raw.definition ?? '', dependencies, properties,
  })
}

/** Normalize a recognized GeoGebra runtime type without rejecting open-world object types. */
export function normalizeGeoGebraObjectKindV1(
  type: string | undefined,
  definition: string | undefined,
): GeometryObjectObservationV1['kind'] | null {
  const normalized = type?.trim().toLowerCase()
  if (normalized === 'point' || normalized === 'line' || normalized === 'segment' || normalized === 'vector'
    || normalized === 'plane' || normalized === 'polyhedron') return normalized
  if (normalized === 'numeric' || normalized === 'number' || normalized === 'slider') return 'slider'
  if (normalized === 'triangle' || normalized === 'quadrilateral' || normalized === 'pentagon'
    || normalized === 'hexagon' || normalized === 'regularpolygon' || normalized === 'polygon') return 'polygon'
  if (normalized === 'circle') return 'circle'
  if ((normalized === 'quadric' || normalized === 'conic') && /^\s*sphere\b/i.test(definition ?? '')) return 'sphere'
  if (normalized === 'quadric' && /^\s*(?:cone|cylinder)\b/i.test(definition ?? '')) return 'solid'
  if (normalized === 'conic' && /^\s*circle\b/i.test(definition ?? '')) return 'circle'
  if (normalized === 'conic' || normalized === 'parabola' || normalized === 'ellipse' || normalized === 'hyperbola') return 'conic'
  if (normalized === 'implicitpoly' || normalized === 'implicitcurve' || normalized === 'locus') return 'curve'
  return null
}

function normalizeProperties(raw: Readonly<Record<string, unknown>>): Record<string, ObservationScalar> {
  const entries = Object.entries(raw).flatMap(([key, value]): Array<[string, ObservationScalar]> => {
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key)) return []
    if (typeof value === 'number' && Number.isFinite(value)) return [[key, value]]
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) return [[key, value]]
    return []
  })
  return Object.fromEntries(entries)
}

function observationError(code: GeometryErrorV1['code'], details: GeometryErrorV1['details']): GeometryObservationError {
  return new GeometryObservationError(geometryError(code, 'Required GeoGebra object evidence is unavailable.', details))
}

function geometryError(code: GeometryErrorV1['code'], message: string, details: GeometryErrorV1['details']): GeometryErrorV1 {
  return { schemaVersion: 1, code, phase: 'observe', retry: 'never', message, details }
}

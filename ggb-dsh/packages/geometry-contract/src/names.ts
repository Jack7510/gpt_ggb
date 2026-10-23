import { GEOGEBRA_COMMAND_NAMES, GEOGEBRA_RESERVED_LABELS } from './generated/geogebra-names.js'

const reserved = new Set<string>(GEOGEBRA_RESERVED_LABELS)
const commands = new Set<string>(GEOGEBRA_COMMAND_NAMES.map(name => name.toLowerCase()))

/** Normalize a newly requested name; never rewrite an observed canvas identity. */
export function normalizeGeometryNameV1(name: string): string {
  return name.trim().replace(/′/gu, "'").replace(/″/gu, "''")
    .replace(/(?<=[\p{L}\p{N}_])(?:prime)+$/iu, suffix => "'".repeat(suffix.length / 5))
}

/** Official reserved labels and command names cannot be object labels or Captions. */
export function isReservedGeoGebraNameV1(name: string): boolean {
  return reserved.has(name) || commands.has(name.toLowerCase())
}

/** A label and Caption share one namespace. Two aliases of one object count only once. */
export function geometryNameConflictsV1(objects: readonly { readonly label: string; readonly caption?: string | undefined }[]):
readonly { readonly name: string; readonly owners: readonly number[] }[] {
  const owners = new Map<string, number[]>()
  objects.forEach((object, index) => {
    for (const name of new Set([object.label, object.caption?.trim() || object.label])) {
      owners.set(name, [...(owners.get(name) ?? []), index])
    }
  })
  return [...owners].filter(([, indices]) => indices.length > 1).map(([name, indices]) => ({ name, owners: indices }))
}

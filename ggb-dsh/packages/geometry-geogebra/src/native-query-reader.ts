import type { RestrictedGeoGebraApiV1 } from './applet-adapter.js'

/** Read only typed, defined native outputs; Boolean false must not be confused with undefined. */
export function nativeQueryReaderV1(api: RestrictedGeoGebraApiV1, signal: AbortSignal): {
  assign(expression: string, kinds: readonly string[]): string | null
  scalar(expression: string): number | null
  boolean(expression: string): boolean | null
} {
  let counter = 0
  const assign = (expression: string, kinds: readonly string[]): string | null => {
    if (signal.aborted) throw new Error('query_aborted')
    let target: string
    do { target = `GgbQuery${++counter}` } while (api.exists?.(target) === true)
    const outputs = api.evalCommandGetLabels(`${target}=${expression}`)
    if (typeof outputs !== 'string' || !outputs.split(',').map(value => value.trim()).includes(target)
      || api.exists?.(target) !== true || api.isDefined?.(target) !== true
      || !kinds.includes(api.getObjectType?.(target)?.toLowerCase() ?? '')) return null
    return target
  }
  return { assign, scalar: expression => {
    const target = assign(expression, ['numeric', 'number', 'angle'])
    const value = target === null ? undefined : api.getValue?.(target)
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }, boolean: expression => {
    const target = assign(expression, ['boolean'])
    const value = target === null ? undefined : api.getValue?.(target)
    return value === 1 ? true : value === 0 ? false : null
  } }
}

export const NATIVE_POLYGON_KINDS_V1 = ['polygon', 'triangle', 'quadrilateral', 'pentagon', 'hexagon',
  'heptagon', 'octagon', 'nonagon', 'decagon', 'regularpolygon'] as const

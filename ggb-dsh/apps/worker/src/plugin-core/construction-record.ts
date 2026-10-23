import {
  MAX_CONSTRUCTION_RECORD_BYTES, pluginCoreConstructionRecordSchema,
  type PluginCoreConstructionRecord, type PluginCoreBuildBinding,
} from '@ggb-copilot/application'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Return only executable native GGB commands. The optional report is omitted
 * when it has no command or exceeds the bounded text budget; it must never
 * fail an otherwise accepted build.
 */
export function createConstructionRecord(request: unknown,
  binding: PluginCoreBuildBinding, verification?: unknown): PluginCoreConstructionRecord | null {
  const plan = object(object(request).plan)
  const material = object(object(verification).construction).objects
  const facts = Array.isArray(material) ? material.map(object) : []
  const commands: string[] = []
  for (const value of Array.isArray(plan.program) ? plan.program : []) {
    const step = object(value)
    let source = sourceOf(value)
    if (step.op === 'native' && step.mode === 'cas') {
      const expression = casExpression(facts.find(fact => fact.name === step.id && fact.defined === true))
      if (expression === null) return null
      const result = expression.trim()
      // XML may retain the full declaration, including function arguments.
      const id = String(step.id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      source = new RegExp(`^${id}(?:\\([^\\n=]*\\))?\\s*=`).test(result)
        ? result : `${String(step.id)}=(${result})`
    }
    if (source === null) return null
    commands.push(source)
    if (Array.isArray(step.initial) && step.initial.length === 2 && !repeatsLiteralInitial(step, source)) {
      commands.push(`SetCoords(${String(step.id)},${String(step.initial[0])},${String(step.initial[1])})`)
    }
  }
  const text = commands.join('\n')
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_CONSTRUCTION_RECORD_BYTES) return null
  return pluginCoreConstructionRecordSchema.parse({ schemaVersion: 1, origin: 'host-accepted-build',
    buildId: binding.buildId, domainRequestDigest: binding.domainRequestDigest, baseSha256: binding.baseSha256,
    text })
}

/** Omit only an identical literal point assignment; do not evaluate expressions or CAS. */
function repeatsLiteralInitial(step: Record<string, unknown>, source: string): boolean {
  if (step.op !== 'native' || step.mode === 'cas' || !Array.isArray(step.initial)) return false
  const decimal = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)'
  const match = new RegExp(`^([^=]+)=\\s*\\(\\s*(${decimal})\\s*,\\s*(${decimal})\\s*\\)$`, 'u').exec(source)
  return match !== null && match[1]!.trim() === step.id
    && Number(match[2]) === step.initial[0] && Number(match[3]) === step.initial[1]
}

/** Independent constants can lack XML expressions; never reconstruct dependent definitions from values. */
function casExpression(fact: Record<string, unknown> | undefined): string | null {
  if (typeof fact?.expression === 'string' && fact.expression.trim()) return fact.expression
  if (fact?.independent !== true) return null
  if (fact.type === 'numeric' && typeof fact.value === 'number' && Number.isFinite(fact.value)) return String(fact.value)
  if (fact.type === 'boolean' && typeof fact.value === 'boolean') return String(fact.value)
  if (fact.type === 'point' && typeof fact.x === 'number' && Number.isFinite(fact.x)
    && typeof fact.y === 'number' && Number.isFinite(fact.y)) return `(${fact.x},${fact.y})`
  return null
}

/** Translate the accepted protocol-2 step forms into executable GGB input. */
function sourceOf(value: unknown): string | null {
  const step = object(value)
  if (step.op === 'native' && typeof step.source === 'string') {
    const source = step.source.trim()
    return source.length === 0 ? null : source
  }
  if (typeof step.id !== 'string') return null
  if (step.op === 'freePoint' && typeof step.x === 'number' && typeof step.y === 'number') {
    return `${step.id}=(${String(step.x)},${String(step.y)})`
  }
  if (step.op === 'command' && typeof step.name === 'string' && Array.isArray(step.args)) {
    const args = step.args.map(arg => typeof arg === 'number' ? String(arg)
      : typeof arg === 'object' && arg !== null && typeof (arg as Record<string, unknown>).ref === 'string'
        ? String((arg as Record<string, unknown>).ref) : null)
    return args.some(arg => arg === null) ? null : `${step.id}=${step.name}(${args.join(',')})`
  }
  return null
}

import { PRESENTATION_COMMAND_METHODS_V1 } from '@ggb-copilot/geometry-contract'
import {
  geoGebraCommandV1Schema,
  geometryNameConflictsV1, isReservedGeoGebraNameV1,
  type GeoGebraCommandV1, type PresentationCommandResultV1,
} from '@ggb-copilot/geometry-contract'

import { encodeGeoGebraCommandV1, encodeManualResultSetV1, manualResultListLabel } from './encoder.js'
import type { GeoGebraObservationSourceV1, RawGeoGebraObjectV1 } from './observer.js'

export interface RestrictedGeoGebraApiV1 {
  evalCommand(command: string): boolean
  evalCommandGetLabels(command: string): string | null
  asyncEvalCommandGetLabels?(command: string): Promise<string | null>
  getXML(): string
  setXML(xml: string): void
  exists?(label: string): boolean
  getAllObjectNames?(): string[] | string
  isDefined?(label: string): boolean
  getObjectType?(label: string): string
  getDefinitionString?(label: string): string
  getCommandString?(label: string): string
  getValueString?(label: string): string
  getValue?(label: string): number
  setValue?(label: string, value: number): void
  getXcoord?(label: string): number
  getYcoord?(label: string): number
  getZcoord?(label: string): number
  getColor?(label: string): string
  getFilling?(label: string): number
  getVisible?(label: string): boolean
  getLabelVisible?(label: string): boolean
  getLineThickness?(label: string): number
  getLineStyle?(label: string): number
  getPointSize?(label: string): number
  getCaption?(label: string, substitutePlaceholders?: boolean): string
  getLabelStyle?(label: string): number
  setCaption?(label: string, caption: string): void
  setLabelStyle?(label: string, style: number): void
  setLabelVisible?(label: string, visible: boolean): void
  setVisible?(label: string, visible: boolean): void
  deleteObject?(label: string): void
  setRepaintingActive?(active: boolean): void
  refreshViews?(): void
}

export interface GeoGebraCommandExecutionV1 {
  readonly createdLabels: readonly string[]
  readonly result?: PresentationCommandResultV1
}

/** Narrow, structured boundary around the mutable GeoGebra applet API. */
export class RestrictedGeoGebraAdapterV1 implements GeoGebraObservationSourceV1 {
  private labels = new Set<string>()

  /** Bind the adapter to an applet API without exposing it to tool callers. */
  public constructor(private readonly api: RestrictedGeoGebraApiV1) {}

  /** Execute one schema-validated, allowlisted command and reject unknown variants before API access. */
  public async execute(input: unknown, signal: AbortSignal): Promise<GeoGebraCommandExecutionV1> {
    assertActive(signal)
    const command = geoGebraCommandV1Schema.parse(input)
    switch (command.name) {
      case 'Point': case 'PointOnObject': case 'Line': case 'LineEquation': case 'Segment': case 'Vector': case 'Circle': case 'Conic':
      case 'ConicEquation': case 'ImplicitCurveEquation':
      case 'Parabola': case 'Ellipse': case 'Hyperbola': case 'Polygon': case 'Plane':
      case 'Sphere': case 'Prism': case 'Pyramid': case 'Cone': case 'Cylinder': case 'Cube':
      case 'Intersect': case 'Midpoint':
      case 'PerpendicularLine': case 'ParallelLine': case 'AngleBisector': case 'PerpendicularPlane':
      case 'Slider': case 'Rotate':
        return { createdLabels: await this.executeCreation(command, signal) }
      case 'ManualCommand':
        return command.manual?.effect === 'presentation'
          ? this.executePresentation(command, signal) : { createdLabels: await this.executeCreation(command, signal) }
      case 'SetValue':
        return { createdLabels: this.executeSetValue(command, signal) }
      case 'SetCaption': case 'ShowLabel': case 'SetVisibleInView': case 'SetColor':
      case 'SetLineThickness': case 'SetLineStyle': case 'SetPointSize': case 'SetFilling':
        return this.executePresentation(command, signal)
      default:
        throw new Error('Unsupported GeoGebra command.')
    }
  }

  /** Restrict dependency extraction to application-owned internal labels. */
  public bindLabels(labels: readonly string[]): void {
    this.labels = new Set(labels)
  }

  /** Read only direct object identity, type, definition and caption facts; observation has no geometry side effects. */
  public async readObject(label: string, signal: AbortSignal): Promise<RawGeoGebraObjectV1> {
    assertActive(signal)
    const exists = readOptionalFact(() => this.api.exists?.(label))
    if (typeof exists !== 'boolean') return {}
    if (!exists) return { exists: false }
    const objectType = readOptionalFact(() => this.api.getObjectType?.(label))
    const definition = readOptionalFact(() => this.api.getCommandString?.(label))
      ?? readOptionalFact(() => this.api.getDefinitionString?.(label)) ?? ''
    const kind = objectType?.trim().toLowerCase()
    const coordinate = kind === 'point' || kind === 'vector'
    const numeric = kind === 'numeric' || kind === 'number' || kind === 'slider'
    return {
      exists, ...(objectType === undefined ? {} : { objectType }), definition,
      dependencies: dependencies(definition, label, this.labels),
      properties: { ...compact({ caption: readOptionalFact(() => this.api.getCaption?.(label, false)) }),
        ...compact({ defined: readOptionalFact(() => this.api.isDefined?.(label)) }),
        ...(coordinate ? { ...compact({ x: readOptionalFact(() => this.api.getXcoord?.(label)) }),
          ...compact({ y: readOptionalFact(() => this.api.getYcoord?.(label)) }),
          ...compact({ z: readOptionalFact(() => this.api.getZcoord?.(label)) }) } : {}),
        ...(numeric ? compact({ value: readOptionalFact(() => this.api.getValue?.(label)) }) : {}) },
    }
  }

  /** Capture the applet XML used as an in-memory rollback point. */
  public snapshot(): string { return this.api.getXML() }

  /** Restore an in-memory applet rollback point. */
  public restore(xml: string): void { this.api.setXML(xml) }

  /** Batch applet repaint around a transaction. */
  public repaint(active: boolean): void {
    this.api.setRepaintingActive?.(active)
    if (active) this.api.refreshViews?.()
  }

  private async executeCreation(command: GeoGebraCommandV1, signal: AbortSignal): Promise<readonly string[]> {
    if (command.output === undefined) throw new Error('Creation command requires an output.')
    if (command.name === 'ManualCommand' && (command.manual?.resultOutputs?.length ?? 0) > 1) {
      return this.executeManualResultSet(command, signal)
    }
    if (this.api.exists?.(command.output.label) === true) throw new Error('GeoGebra output label already exists.')
    this.assertNamesAvailable([command.output])
    const labels = await this.evaluateForLabels(encodeGeoGebraCommandV1(command))
    assertActive(signal)
    if (!labels.includes(command.output.label) && !await this.waitForObject(command.output.label, signal)) {
      throw new Error('GeoGebra rejected a creation command.')
    }
    this.applyCaption(command.output.label, command.output.caption)
    return [...new Set([command.output.label, ...labels])].slice(0, 8)
  }

  private async executeManualResultSet(
    command: GeoGebraCommandV1,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const outputs = command.manual?.resultOutputs ?? []
    this.assertNamesAvailable(outputs)
    if (outputs.some(output => this.api.exists?.(output.label) === true)) {
      throw new Error('GeoGebra cannot bind the declared Manual result set.')
    }
    const scripts = encodeManualResultSetV1(command)
    const listLabel = manualResultListLabel(command)
    const createdList = await this.evaluateForLabels(scripts[0]!)
    if (!createdList.includes(listLabel)) throw new Error('GeoGebra Manual command did not create a result List.')
    const bound: string[] = []
    for (const [index, output] of outputs.entries()) {
      const labels = await this.evaluateForLabels(scripts[index + 1]!)
      if (!labels.includes(output.label)) throw new Error('GeoGebra Manual result List is incompatible with the declared index.')
      this.applyCaption(output.label, output.caption)
      bound.push(output.label)
    }
    this.api.setVisible?.(listLabel, false)
    assertActive(signal)
    return bound
  }

  private applyCaption(label: string, caption: string | undefined): void {
    if (caption === undefined) return
    if (this.api.setCaption === undefined || this.api.setLabelStyle === undefined) return
    try {
      this.api.setCaption(label, caption)
      this.api.setLabelStyle(label, 3)
      if (caption !== label) this.api.setLabelVisible?.(label, true)
    } catch { /* A caption is presentation-only; the mathematical object remains valid. */ }
  }

  /** Guard namespace ownership before any creation or Caption side effect. */
  private assertNamesAvailable(outputs: readonly { readonly label: string; readonly caption?: string | undefined }[], replacing?: string): void {
    const reported = this.api.getAllObjectNames?.()
    const labels = typeof reported === 'string' ? reported.split(',').map(label => label.trim()).filter(Boolean)
      : reported ?? [...this.labels].filter(label => this.api.exists?.(label) === true)
    const existing = labels.filter(label => label !== replacing).map(label => ({ label,
      caption: this.api.getCaption?.(label, false) || label }))
    if (outputs.some(output => [output.label, output.caption].some(name => name !== undefined && isReservedGeoGebraNameV1(name)))
      || geometryNameConflictsV1([...existing, ...outputs]).length > 0) throw new Error('GeoGebra label/Caption namespace conflict or reserved name.')
  }

  private async waitForObject(label: string, signal: AbortSignal): Promise<boolean> {
    if (this.api.exists === undefined) return false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assertActive(signal)
      if (this.api.exists(label)) return true
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    return false
  }

  private async executePresentation(command: GeoGebraCommandV1, signal: AbortSignal): Promise<GeoGebraCommandExecutionV1> {
    if (command.name === 'SetCaption' || command.manual?.command === 'SetCaption') {
      const target = command.arguments[0], caption = command.arguments[1]
      if (target?.kind === 'object' && caption?.kind === 'string') this.assertNamesAvailable([{ label: target.label, caption: caption.value }], target.label)
    }
    let accepted: boolean | null = null
    let apiException = false
    try {
      if (command.name === 'SetVisibleInView' && this.api.setVisible !== undefined) {
        const target = command.arguments[0], visible = command.arguments[2]
        if (target?.kind !== 'object' || visible?.kind !== 'boolean') throw new Error('Invalid visibility command.')
        this.api.setVisible(target.label, visible.value)
      } else accepted = this.api.evalCommand(encodeGeoGebraCommandV1(command))
    } catch { apiException = true }
    assertActive(signal)
    const facts = this.presentationFacts(command)
    const available = facts.expected !== null && facts.actual !== null
      && typeof facts.expected === typeof facts.actual
    const equal = available && (typeof facts.actual === 'number' && typeof facts.expected === 'number'
      ? Math.abs(facts.actual - facts.expected) <= 1e-6 : facts.actual === facts.expected)
    const outcome = available ? equal ? 'satisfied' : 'not_satisfied' : 'unverified'
    return { createdLabels: [], result: { apiAccepted: accepted, apiException, ...facts, outcome,
      reason: apiException ? 'api_exception' : !available ? 'property_unavailable' : equal ? 'target_satisfied' : 'target_mismatch' } }
  }

  /** Read only documented direct properties; XML changes are never success/failure evidence. */
  private presentationFacts(command: GeoGebraCommandV1): Pick<PresentationCommandResultV1, 'method' | 'expected' | 'actual'> {
    const name = command.manual?.command ?? command.name
    const target = command.arguments[0]
    if (target?.kind !== 'object' || (name === 'SetVisibleInView'
      && (command.arguments[1]?.kind !== 'number' || command.arguments[1].value !== 1))) {
      return { method: 'unavailable', expected: null, actual: null }
    }
    const arg = command.arguments[name === 'SetVisibleInView' ? 2 : 1]
    const literal = arg?.kind === 'number' || arg?.kind === 'boolean' || arg?.kind === 'string' ? arg.value : null
    const reads: Record<string, () => unknown> = {
      SetLineThickness: () => this.api.getLineThickness?.(target.label),
      SetLineStyle: () => this.api.getLineStyle?.(target.label),
      SetPointSize: () => this.api.getPointSize?.(target.label),
      SetFilling: () => this.api.getFilling?.(target.label),
      ShowLabel: () => this.api.getLabelVisible?.(target.label),
      SetVisibleInView: () => this.api.getVisible?.(target.label),
      SetCaption: () => this.api.getCaption?.(target.label, false),
      SetColor: () => this.api.getColor?.(target.label),
    }
    let expected = literal
    if (name === 'SetColor') {
      const rgb = command.arguments.slice(1)
      expected = rgb.length === 3 && rgb.every(value => value.kind === 'number' && value.value >= 0 && value.value <= 1)
        ? '#' + rgb.map(value => Math.round((value as { value: number }).value * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
        : typeof literal === 'string' && /^#[0-9a-f]{6}$/iu.test(literal) ? literal.toUpperCase() : null
    }
    const raw = readOptionalFact(() => reads[name]?.())
    const actual = typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'boolean' || typeof raw === 'string'
      ? name === 'SetColor' && typeof raw === 'string' ? raw.toUpperCase() : raw : null
    return { method: PRESENTATION_COMMAND_METHODS_V1[name] ?? 'unavailable', expected, actual }
  }

  /** Use the typed Apps API because GeoGebra 5.4 does not accept SetValue through evalCommand. */
  private executeSetValue(command: GeoGebraCommandV1, signal: AbortSignal): readonly string[] {
    const target = command.arguments[0]
    const value = command.arguments[1]
    if (target?.kind !== 'object' || value?.kind !== 'number' || this.api.setValue === undefined) {
      throw new Error('GeoGebra Slider value API is unavailable.')
    }
    this.api.setValue(target.label, value.value)
    if (this.api.getValue !== undefined && this.api.getValue(target.label) !== value.value) {
      throw new Error('GeoGebra did not apply the Slider value.')
    }
    assertActive(signal)
    return []
  }

  private async evaluateForLabels(command: string): Promise<string[]> {
    const raw = this.api.asyncEvalCommandGetLabels === undefined
      ? this.api.evalCommandGetLabels(command) : await this.api.asyncEvalCommandGetLabels(command)
    return raw?.split(',').map(value => value.trim()).filter(isReturnedLabel) ?? []
  }

}

function isReturnedLabel(value: string): boolean {
  return value.length <= 32 && /^[A-Za-z][A-Za-z0-9_]*'*$/.test(value)
    && !['undefined', 'null', 'true', 'false'].includes(value.toLowerCase())
}

function dependencies(definition: string, own: string, known: ReadonlySet<string>): string[] {
  return [...new Set(definition.match(/[A-Za-z][A-Za-z0-9_]*'*/g) ?? [])]
    .filter(label => label !== own && known.has(label)).slice(0, 32)
}

function compact(input: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string | number | boolean] => {
    const value = entry[1]
    return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  }))
}

/** Optional applet evidence may be unavailable; it must not roll back a successful construction. */
function readOptionalFact<T>(read: () => T): T | undefined {
  try { return read() } catch { return undefined }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('GeoGebra execution cancelled.', 'AbortError')
}

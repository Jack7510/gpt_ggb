import {
  canvasVersionSchema, executionObservationV1Schema, executionTransactionV1Schema,
  type CanvasVersion, type CommandObservationV1, type ExecutionObservationV1,
  executionFinalizeResultV1Schema, transactionIdSchema,
  type ExecutionFinalizeResultV1, type ExecutionTransactionV1, type GeometryErrorCode, type GeometryErrorV1,
  type GeometryObjectId,
} from '@ggb-copilot/geometry-contract'

import { RestrictedGeoGebraAdapterV1 } from './applet-adapter.js'
import { encodeGeoGebraCommandV1 } from './encoder.js'
import { runNativeGeometryQueriesV1, type IsolatedGeoGebraFactoryV1 } from './native-queries.js'
import { GeometryObservationError, normalizeGeoGebraObjectV1 } from './observer.js'

export interface CanvasVersionSourceV1 {
  /** Return the current content-derived applet version. */
  current(): Promise<CanvasVersion>
}

export interface CommandExecutionProgressV1 {
  readonly index: number
  readonly total: number
  readonly commandId: ExecutionTransactionV1['commands'][number]['commandId']
  readonly stepId: ExecutionTransactionV1['commands'][number]['stepId']
  readonly name: ExecutionTransactionV1['commands'][number]['name']
  readonly status: 'running' | 'applied' | 'warning' | 'rejected'
}

export type CommandExecutionProgressListenerV1 = (progress: CommandExecutionProgressV1) => void

/**
 * XML sections that describe applet viewport, layout and scripting state rather than construction
 * content. They change through `api.setSize()` whenever the panel is resized, so hashing them would
 * invalidate a version whose construction did not move.
 */
const VOLATILE_XML_SECTION = /<(gui|euclidianView|euclidianView3D|spreadsheetView|probabilityCalculator|tableview|scripting)\b[^>]*(?:\/>|>[\s\S]*?<\/\1>)/g
/** Root applet instance id: a fresh applet reusing the same construction must keep the same version. */
const ROOT_INSTANCE_ID = /(<geogebra\b[^>]*?)\s+id="[^"]*"/

/**
 * Reduce raw applet XML to the content that defines a canvas version: the construction, its object
 * presentation, and the kernel state. Viewport geometry, layout panes and applet instance identity are
 * dropped, so one construction maps to exactly one version across resizes and page reloads.
 */
export function canonicalCanvasXmlV1(xml: string): string {
  return xml
    .replace(VOLATILE_XML_SECTION, '')
    .replace(ROOT_INSTANCE_ID, '$1')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

/** Derive stable canvas versions directly from the applet XML. */
export class XmlCanvasVersionSourceV1 implements CanvasVersionSourceV1 {
  /** Bind version reads to the same restricted adapter used for mutation. */
  public constructor(private readonly adapter: RestrictedGeoGebraAdapterV1) {}

  /** Hash current XML without exposing it outside the browser adapter. */
  public async current(): Promise<CanvasVersion> {
    const bytes = new TextEncoder().encode(canonicalCanvasXmlV1(this.adapter.snapshot()))
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 32).split('')
    digest[12] = '4'
    digest[16] = '8'
    return canvasVersionSchema.parse(`canvas_${formatUuid(digest)}`)
  }
}

/** Browser-owned single-writer transaction queue with version checks and rollback. */
export class GeoGebraTransactionExecutorV1 {
  private tail: Promise<void> = Promise.resolve()
  private pending: PendingTransactionV1 | undefined

  /** Bind transaction execution to one applet and one content-version source. */
  public constructor(
    private readonly adapter: RestrictedGeoGebraAdapterV1,
    private readonly versions: CanvasVersionSourceV1 = new XmlCanvasVersionSourceV1(adapter),
    private readonly isolatedFactory?: IsolatedGeoGebraFactoryV1,
  ) {}

  /** Queue and execute one validated transaction without concurrent applet writes. */
  public apply(
    input: unknown,
    signal: AbortSignal,
    onProgress?: CommandExecutionProgressListenerV1,
  ): Promise<ExecutionObservationV1> {
    const operation = (): Promise<ExecutionObservationV1> => this.execute(input, signal, onProgress)
    const result = this.tail.then(operation, operation)
    this.tail = result.then((): void => undefined, (): void => undefined)
    return result
  }

  /** Commit or roll back the currently observed transaction through the same single-writer queue. */
  public finalize(
    transactionId: string,
    decision: 'commit' | 'rollback',
    signal: AbortSignal,
  ): Promise<ExecutionFinalizeResultV1> {
    const operation = (): Promise<ExecutionFinalizeResultV1> => this.settle(transactionId, decision, signal)
    const result = this.tail.then(operation, operation)
    this.tail = result.then((): void => undefined, (): void => undefined)
    return result
  }

  private async execute(
    input: unknown,
    signal: AbortSignal,
    onProgress?: CommandExecutionProgressListenerV1,
  ): Promise<ExecutionObservationV1> {
    assertActive(signal)
    const transaction = executionTransactionV1Schema.parse(input)
    const before = await this.versions.current()
    if (this.pending !== undefined) return rejectedPending(transaction, before)
    if (transaction.expectedCanvasVersion !== before) return rejectedVersion(transaction, before)
    const baseline = this.adapter.snapshot()
    const commands: CommandObservationV1[] = []
    this.adapter.repaint(false)
    try {
      for (const [index, command] of transaction.commands.entries()) {
        notifyProgress(onProgress, command, index, transaction.commands.length, 'running')
        try {
          await this.executeCommand(command, commands, signal)
          notifyProgress(onProgress, command, index, transaction.commands.length, commands.at(-1)?.status === 'applied' ? 'applied' : 'warning')
        } catch (caught: unknown) {
          notifyProgress(onProgress, command, index, transaction.commands.length, 'rejected')
          throw caught
        }
      }
      const facts = await observe(transaction, this.adapter, signal)
      const after = await this.versions.current()
      const probes = await runNativeGeometryQueriesV1({ queries: transaction.probes,
        xml: this.adapter.snapshot(), canvasVersion: after, factory: this.isolatedFactory, signal,
        versionOf: api => new XmlCanvasVersionSourceV1(new RestrictedGeoGebraAdapterV1(api)).current() })
      if (await this.versions.current() !== after) throw new Error('canvas_changed_during_native_query')
      const result = observation(
        transaction, before, after, commands, facts.objects, probes,
      )
      this.pending = { transactionId: transaction.transactionId, before, after, baseline }
      return result
    } catch (caught: unknown) {
      const result = rollback(transaction, before, baseline, commands, this.adapter, caught)
      if (result.status === 'rolled_back') {
        this.pending = { transactionId: transaction.transactionId, before,
          after: await this.versions.current(), baseline, automaticallyRolledBack: true }
      }
      return result
    } finally {
      this.adapter.repaint(true)
    }
  }

  private async settle(
    transactionId: string,
    decision: 'commit' | 'rollback',
    signal: AbortSignal,
  ): Promise<ExecutionFinalizeResultV1> {
    assertActive(signal)
    const parsedId = transactionIdSchema.parse(transactionId)
    const pending = this.pending
    if (pending === undefined || pending.transactionId !== parsedId) {
      return unknownFinalization(parsedId, decision, await this.versions.current())
    }
    if (pending.automaticallyRolledBack) {
      const current = await this.versions.current()
      if (decision !== 'rollback' || pending.after !== pending.before || current !== pending.before) {
        return unknownFinalization(parsedId, decision, current)
      }
      this.pending = undefined
      return executionFinalizeResultV1Schema.parse({ schemaVersion: 1, transactionId: parsedId,
        decision, status: 'rolled_back', canvasVersion: current,
        rollback: { attempted: true, succeeded: true, restoredCanvasVersion: current } })
    }
    if (decision === 'commit') return this.commit(pending)
    return this.restore(pending)
  }

  private async commit(pending: PendingTransactionV1): Promise<ExecutionFinalizeResultV1> {
    const current = await this.versions.current()
    if (current !== pending.after) return unknownFinalization(pending.transactionId, 'commit', current)
    this.pending = undefined
    return executionFinalizeResultV1Schema.parse({
      schemaVersion: 1, transactionId: pending.transactionId, decision: 'commit', status: 'committed', canvasVersion: current,
    })
  }

  private async restore(pending: PendingTransactionV1): Promise<ExecutionFinalizeResultV1> {
    try {
      this.adapter.restore(pending.baseline)
      const current = await this.versions.current()
      if (current !== pending.before) throw new Error('restored_canvas_version_mismatch')
      this.pending = undefined
      return executionFinalizeResultV1Schema.parse({ schemaVersion: 1, transactionId: pending.transactionId,
        decision: 'rollback', status: 'rolled_back', canvasVersion: current,
        rollback: { attempted: true, succeeded: true, restoredCanvasVersion: current } })
    } catch (caught: unknown) {
      return executionFinalizeResultV1Schema.parse({ schemaVersion: 1, transactionId: pending.transactionId,
        decision: 'rollback', status: 'recovery_required', canvasVersion: pending.after,
        rollback: { attempted: true, succeeded: false }, error: geometryError(
          'RECOVER_ROLLBACK_FAILED', 'GeoGebra semantic rollback failed.', { cause: errorName(caught) }) })
    }
  }

  private async executeCommand(
    command: ExecutionTransactionV1['commands'][number],
    results: CommandObservationV1[],
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now()
    try {
      const execution = await this.adapter.execute(command, signal)
      const result = execution.result
      const status = result === undefined ? 'applied' : result.apiException ? 'unknown'
        : result.outcome === 'satisfied' ? 'applied' : result.outcome === 'not_satisfied' ? 'rejected'
          : result.apiAccepted === true ? 'applied' : 'unknown'
      results.push({ commandId: command.commandId, status, createdLabels: [...execution.createdLabels],
        durationMs: elapsed(started), ...(result === undefined ? {} : { result }) })
    } catch (caught: unknown) {
      results.push({ commandId: command.commandId, status: 'rejected', createdLabels: [], durationMs: elapsed(started),
        error: commandError(command, caught) })
      throw caught
    }
  }
}

interface PendingTransactionV1 {
  readonly transactionId: ExecutionTransactionV1['transactionId']
  readonly before: CanvasVersion
  readonly after: CanvasVersion
  readonly baseline: string
  readonly automaticallyRolledBack?: boolean
}

async function observe(
  transaction: ExecutionTransactionV1,
  adapter: RestrictedGeoGebraAdapterV1,
  signal: AbortSignal,
): Promise<Pick<ExecutionObservationV1, 'objects' | 'probes'>> {
  const mapping = objectMapping(transaction)
  const ids = new Map([...mapping.entries()].map(([objectId, label]) => [label, objectId]))
  adapter.bindLabels([...mapping.values()])
  const objects = []
  for (const [objectId, label] of mapping) {
    objects.push(normalizeGeoGebraObjectV1(objectId, label, await adapter.readObject(label, signal), ids))
  }
  return { objects, probes: [] }
}

function objectMapping(transaction: ExecutionTransactionV1): Map<GeometryObjectId, string> {
  const mapping = new Map<GeometryObjectId, string>()
  for (const command of transaction.commands) {
    if (command.output !== undefined) mapping.set(command.output.objectId, command.output.label)
    for (const output of command.manual?.resultOutputs ?? []) mapping.set(output.objectId, output.label)
    for (const argument of command.arguments) {
      if (argument.kind === 'object') mapping.set(argument.objectId, argument.label)
    }
  }
  return mapping
}

function rejectedVersion(transaction: ExecutionTransactionV1, before: CanvasVersion): ExecutionObservationV1 {
  return executionObservationV1Schema.parse({
    schemaVersion: 1, transactionId: transaction.transactionId, status: 'rejected', beforeCanvasVersion: before,
    commands: [], objects: [], probes: [], error: geometryError(
      'EXECUTE_CANVAS_VERSION_MISMATCH', 'Canvas version does not match the transaction.',
      { expected: transaction.expectedCanvasVersion, actual: before },
    ),
  })
}

function rejectedPending(transaction: ExecutionTransactionV1, before: CanvasVersion): ExecutionObservationV1 {
  return executionObservationV1Schema.parse({ schemaVersion: 1, transactionId: transaction.transactionId,
    status: 'rejected', beforeCanvasVersion: before, commands: [], objects: [], probes: [],
    error: geometryError('EXECUTE_TRANSACTION_PENDING', 'Another transaction is awaiting semantic settlement.', {}) })
}

function unknownFinalization(
  transactionId: ExecutionTransactionV1['transactionId'],
  decision: 'commit' | 'rollback',
  canvasVersion: CanvasVersion,
): ExecutionFinalizeResultV1 {
  return executionFinalizeResultV1Schema.parse({ schemaVersion: 1, transactionId, decision,
    status: 'recovery_required', canvasVersion,
    error: geometryError('RECOVER_OUTCOME_UNKNOWN', 'No matching pending browser transaction exists.', {}) })
}

function observation(
  transaction: ExecutionTransactionV1,
  before: CanvasVersion,
  after: CanvasVersion,
  commands: readonly CommandObservationV1[],
  objects: ExecutionObservationV1['objects'],
  probes: ExecutionObservationV1['probes'],
): ExecutionObservationV1 {
  return executionObservationV1Schema.parse({
    schemaVersion: 1, transactionId: transaction.transactionId, status: 'applied',
    beforeCanvasVersion: before, afterCanvasVersion: after,
    commands: [...commands], objects, probes,
  })
}

function rollback(
  transaction: ExecutionTransactionV1,
  before: CanvasVersion,
  baseline: string,
  commands: readonly CommandObservationV1[],
  adapter: RestrictedGeoGebraAdapterV1,
  caught: unknown,
): ExecutionObservationV1 {
  try {
    adapter.restore(baseline)
    const failure = rollbackFailure(commands, caught)
    return executionObservationV1Schema.parse({
      schemaVersion: 1, transactionId: transaction.transactionId, status: 'rolled_back', beforeCanvasVersion: before,
      commands: [...commands], objects: [], probes: [], rollback: { attempted: true, succeeded: true, restoredCanvasVersion: before },
      error: failure,
    })
  } catch (rollbackError: unknown) {
    return executionObservationV1Schema.parse({
      schemaVersion: 1, transactionId: transaction.transactionId, status: 'outcome_unknown', beforeCanvasVersion: before,
      commands: [...commands], objects: [], probes: [], rollback: { attempted: true, succeeded: false },
      error: geometryError('RECOVER_ROLLBACK_FAILED', 'GeoGebra rollback failed.', { cause: errorName(rollbackError) }),
    })
  }
}

function rollbackFailure(commands: readonly CommandObservationV1[], caught: unknown): GeometryErrorV1 {
  const commandFailure = [...commands].reverse().find(command => command.status === 'rejected')?.error
  if (commandFailure !== undefined) return { ...commandFailure, message: 'GeoGebra transaction failed and was rolled back.' }
  if (caught instanceof GeometryObservationError) return caught.geometryError
  return geometryError(
    'EXECUTE_COMMAND_REJECTED', 'GeoGebra transaction failed and was rolled back.', { cause: errorName(caught) },
  )
}

function geometryError(code: GeometryErrorCode, message: string, details: GeometryErrorV1['details']): GeometryErrorV1 {
  const phase = code.startsWith('RECOVER_') ? 'recover' : 'execute'
  const retry = phase === 'recover' || code === 'EXECUTE_CANVAS_VERSION_MISMATCH' ? 'user_action' : 'after_replan'
  return { schemaVersion: 1, code, phase, retry, message, details }
}

function commandError(
  command: ExecutionTransactionV1['commands'][number],
  caught: unknown,
): GeometryErrorV1 {
  return geometryError(
    'EXECUTE_COMMAND_REJECTED', 'GeoGebra rejected a structured command.',
    {
      commandId: command.commandId,
      stepId: command.stepId,
      commandName: command.name,
      commandScript: encodeGeoGebraCommandV1(command),
      cause: errorMessage(caught),
    },
  )
}

function notifyProgress(
  listener: CommandExecutionProgressListenerV1 | undefined,
  command: ExecutionTransactionV1['commands'][number],
  index: number,
  total: number,
  status: CommandExecutionProgressV1['status'],
): void {
  try {
    listener?.({ index: index + 1, total, commandId: command.commandId, stepId: command.stepId, name: command.name, status })
  } catch { /* Product progress must never affect the transaction. */ }
}

function elapsed(started: number): number { return Math.max(0, Math.round(performance.now() - started)) }
function errorName(value: unknown): string { return value instanceof Error ? value.name : typeof value }
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message.slice(0, 500) : typeof value
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('GeoGebra transaction cancelled.', 'AbortError')
}
function formatUuid(hex: readonly string[]): string {
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

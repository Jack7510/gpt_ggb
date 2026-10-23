import { describe, expect, it } from 'vitest'

import type { ExecutionTransactionV1, GeoGebraCommandV1 } from '@ggb-copilot/geometry-contract'

import {
  canonicalCanvasXmlV1,
  GeoGebraTransactionExecutorV1,
  RestrictedGeoGebraAdapterV1,
  type CanvasVersionSourceV1,
  type RestrictedGeoGebraApiV1,
} from '../src/index.js'

const uuid = (prefix: string, value: number): string => `${prefix}_00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const canvas = (value: number): ExecutionTransactionV1['expectedCanvasVersion'] => uuid('canvas', value) as never

class PointApi implements RestrictedGeoGebraApiV1 {
  public calls: string[] = []
  public xml = '<construction />'
  public readonly captions = new Map<string, string>()
  public readonly labelStyles = new Map<string, number>()
  public readonly labelVisibility = new Map<string, boolean>()
  private points = new Map<string, { x: number; y: number }>()

  public evalCommand(command: string): boolean { this.calls.push(command); return true }
  public evalCommandGetLabels(command: string): string | null {
    this.calls.push(command)
    const match = /^(\w+)=Point\[\{(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\}\]$/.exec(command)
    if (match === null) return null
    this.points.set(match[1]!, { x: Number(match[2]), y: Number(match[3]) })
    this.xml = `<point label="${match[1]!}" />`
    return match[1]!
  }
  public getXML(): string { return this.xml }
  public setXML(xml: string): void { this.xml = xml; if (!xml.includes('<point')) this.points.clear() }
  public exists(label: string): boolean { return this.points.has(label) }
  public getAllObjectNames(): string[] { return [...this.points.keys()] }
  public getObjectType(label: string): string { return this.points.has(label) ? 'point' : 'unknown' }
  public getDefinitionString(label: string): string { return label }
  public getXcoord(label: string): number { return this.points.get(label)?.x ?? Number.NaN }
  public getYcoord(label: string): number { return this.points.get(label)?.y ?? Number.NaN }
  public setCaption(label: string, caption: string): void { this.captions.set(label, caption) }
  public setLabelStyle(label: string, style: number): void { this.labelStyles.set(label, style) }
  public setLabelVisible(label: string, visible: boolean): void { this.labelVisibility.set(label, visible) }
  public getCaption(label: string): string { return this.captions.get(label) ?? '' }
  public getLabelStyle(label: string): number { return this.labelStyles.get(label) ?? 0 }
  public getLabelVisible(label: string): boolean { return this.labelVisibility.get(label) ?? true }
}

class LineApi extends PointApi {
  public constructor(private readonly equation: string) { super() }
  public override exists(_label: string): boolean { return true }
  public override getObjectType(_label: string): string { return 'line' }
  public getCommandString(_label: string): string { return 'Line[P1,P2]' }
  public getValueString(_label: string): string { return this.equation }
}

class BrokenRestoreApi extends PointApi {
  public override setXML(_xml: string): void { throw new Error('restore failed') }
}

class BrokenPresentationApi extends PointApi {
  public setVisible(_label: string, _visible: boolean): void { throw new Error('visibility unavailable') }
}

class FalseReturningPresentationApi extends PointApi {
  public constructor(private readonly mutate: boolean) { super() }
  public override evalCommand(command: string): boolean {
    this.calls.push(command)
    if (this.mutate) this.xml = '<construction color="blue" />'
    return false
  }
}

class UnsupportedObservationApi extends PointApi {
  public override getObjectType(_label: string): string { return 'text' }
  public override getDefinitionString(_label: string): string { return 'unexpected object' }
}

class BrokenCaptionApi extends PointApi {
  public override setCaption(_label: string, _caption: string): void { throw new Error('caption unavailable') }
}

class VisibilityApi extends PointApi {
  private readonly visibility = new Map<string, boolean>()
  public setVisible(label: string, visible: boolean): void { this.visibility.set(label, visible) }
  public getVisible(label: string): boolean { return this.visibility.get(label) ?? true }
}

class MultiOutputApi extends PointApi {
  private created = false
  public override evalCommandGetLabels(command: string): string | null {
    this.calls.push(command)
    this.created = true
    return Array.from({ length: 16 }, (_, index) => index === 0 ? 'ggbPoint1' : `generated${String(index)}`).join(',')
  }
  public override exists(_label: string): boolean { return this.created }
}

class ManualCommandApi extends PointApi {
  private focusCreated = false
  public override evalCommandGetLabels(command: string): string | null {
    this.calls.push(command)
    if (command !== 'F=Focus[c]') return null
    this.focusCreated = true
    return 'F,undefined'
  }
  public override exists(label: string): boolean { return label === 'F' && this.focusCreated }
  public override getObjectType(label: string): string { return label === 'F' ? 'point' : 'unknown' }
}

class ManualResultSetApi extends PointApi {
  private readonly labels = new Set<string>()
  public override evalCommandGetLabels(command: string): string | null {
    this.calls.push(command)
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(?:\{Focus\[c\]\}|Element\[[A-Za-z][A-Za-z0-9_]*,[12]\])$/.exec(command)
    if (match === null) return null
    this.labels.add(match[1]!)
    return match[1]!
  }
  public override exists(label: string): boolean { return this.labels.has(label) }
  public override getObjectType(label: string): string { return this.labels.has(label) ? 'point' : 'unknown' }
}

class SliderApi extends PointApi {
  private created = false
  private value = 3
  public override evalCommandGetLabels(command: string): string | null {
    this.calls.push(command)
    if (command !== 'n=Slider[3,12,1]') return null
    this.created = true
    return 'n'
  }
  public override exists(label: string): boolean { return label === 'n' && this.created }
  public override getObjectType(label: string): string { return label === 'n' ? 'numeric' : 'unknown' }
  public getValue(label: string): number { return label === 'n' ? this.value : Number.NaN }
  public setValue(label: string, value: number): void { if (label === 'n') this.value = value }
}

class SequenceVersions implements CanvasVersionSourceV1 {
  private index = 0
  public constructor(private readonly values: readonly ExecutionTransactionV1['expectedCanvasVersion'][]) {}
  public current(): Promise<ExecutionTransactionV1['expectedCanvasVersion']> {
    return Promise.resolve(this.values[Math.min(this.index++, this.values.length - 1)]!)
  }
}

function pointCommand(value: number): GeoGebraCommandV1 {
  return {
    commandId: uuid('cmd', value) as never, stepId: uuid('step', value) as never, name: 'Point',
    output: { objectId: uuid('obj', value) as never, label: `ggbPoint${String(value)}`, caption: value === 1 ? 'A' : `A${value}` },
    arguments: [{ kind: 'number', value }, { kind: 'number', value: value + 1 }],
  }
}

function visibilityCommand(value: number): GeoGebraCommandV1 {
  return {
    commandId: uuid('cmd', value + 100) as never, stepId: uuid('step', value + 100) as never,
    name: 'SetVisibleInView',
    arguments: [
      { kind: 'object', objectId: uuid('obj', value) as never, label: `ggbPoint${String(value)}` },
      { kind: 'number', value: 1 }, { kind: 'boolean', value: false },
    ],
  }
}

function manualPresentationCommand(): GeoGebraCommandV1 {
  return {
    commandId: uuid('cmd', 501) as never, stepId: uuid('step', 501) as never, name: 'ManualCommand',
    manual: { signatureId: 'set-color-false-return', command: 'SetColor', effect: 'presentation' },
    arguments: [
      { kind: 'object', objectId: uuid('obj', 1) as never, label: 'ggbPoint1' },
      { kind: 'string', value: 'blue' },
    ],
  }
}

function transaction(expected: ExecutionTransactionV1['expectedCanvasVersion']): ExecutionTransactionV1 {
  return {
    schemaVersion: 1, protocolVersion: 1, transactionId: uuid('txn', 20) as never,
    appSessionId: uuid('app', 21) as never, dshSessionId: 'dsh-renderer-test' as never,
    runId: uuid('run', 22) as never, planId: uuid('plan', 23) as never,
    expectedCanvasVersion: expected, issuedAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-09-08T00:01:00.000Z',
    commands: [pointCommand(1)], probes: [], integrity: { algorithm: 'hmac-sha256', value: '44'.repeat(32) },
  }
}

describe('RestrictedGeoGebraAdapterV1', () => {

  it('rejects creation Caption collisions before issuing any GeoGebra command', async () => {
    const api = new PointApi()
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    await adapter.execute(pointCommand(1), new AbortController().signal)
    const before = api.calls.length
    await expect(adapter.execute({ ...pointCommand(2), output: { ...pointCommand(2).output!, caption: 'A' } }, new AbortController().signal))
      .rejects.toThrow('namespace conflict')
    expect(api.calls).toHaveLength(before)
  })

  it('rejects a Caption update that claims another object label', async () => {
    const api = new PointApi()
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    await adapter.execute(pointCommand(1), new AbortController().signal)
    const command = { ...pointCommand(2), output: { ...pointCommand(2).output!, caption: 'B' } }
    await adapter.execute(command, new AbortController().signal)
    const before = api.calls.length
    await expect(adapter.execute({ ...visibilityCommand(1), name: 'SetCaption', arguments: [
      visibilityCommand(1).arguments[0]!, { kind: 'string', value: 'ggbPoint2' },
    ] }, new AbortController().signal)).rejects.toThrow('namespace conflict')
    expect(api.calls).toHaveLength(before)
  })

  it('creates a Slider and applies its initial value through the typed applet API', async () => {
    const api = new SliderApi()
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    const sliderId = uuid('obj', 301) as never
    const slider: GeoGebraCommandV1 = { commandId: uuid('cmd', 301) as never,
      stepId: uuid('step', 301) as never, name: 'Slider',
      output: { objectId: sliderId, label: 'n', caption: 'n' },
      arguments: [{ kind: 'number', value: 3 }, { kind: 'number', value: 12 }, { kind: 'number', value: 1 }] }
    const initial: GeoGebraCommandV1 = { commandId: uuid('cmd', 302) as never,
      stepId: uuid('step', 301) as never, name: 'SetValue',
      arguments: [{ kind: 'object', objectId: sliderId, label: 'n' }, { kind: 'number', value: 6 }] }
    await expect(adapter.execute(slider, new AbortController().signal)).resolves.toEqual({ createdLabels: ['n'] })
    await expect(adapter.execute(initial, new AbortController().signal)).resolves.toMatchObject({ createdLabels: [] })
    expect(api.getValue('n')).toBe(6)
    expect(api.calls).toEqual(['n=Slider[3,12,1]'])
  })

  it('executes a structured creation through the safe encoder', async () => {
    const api = new PointApi()
    const labels = await new RestrictedGeoGebraAdapterV1(api).execute(pointCommand(1), new AbortController().signal)
    expect(labels).toEqual({ createdLabels: ['ggbPoint1'] })
    expect(api.calls).toEqual(['ggbPoint1=Point[{1,2}]'])
    expect(api.captions.get('ggbPoint1')).toBe('A')
    expect(api.labelStyles.get('ggbPoint1')).toBe(3)
  })

  it('sets and observes a reflected point caption independently of its execution label', async () => {
    const api = new PointApi()
    const command = { ...pointCommand(1), output: { ...pointCommand(1).output,
      label: 'ggbPoint1', caption: "P'" } }
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    await adapter.execute(command, new AbortController().signal)
    expect(api.captions.get('ggbPoint1')).toBe("P'")
    expect(api.labelStyles.get('ggbPoint1')).toBe(3)
    expect(api.labelVisibility.get('ggbPoint1')).toBe(true)
    expect((await adapter.readObject('ggbPoint1', new AbortController().signal)).properties)
      .toMatchObject({ caption: "P'" })
  })

  it('executes a pinned declarative Manual command through the generic boundary', async () => {
    const api = new ManualCommandApi()
    const command: GeoGebraCommandV1 = {
      commandId: uuid('cmd', 401) as never, stepId: uuid('step', 401) as never, name: 'ManualCommand',
      manual: { signatureId: 'focus-61f0e85d2eda', command: 'Focus' },
      output: { objectId: uuid('obj', 401) as never, label: 'F' },
      arguments: [{ kind: 'object', objectId: uuid('obj', 400) as never, label: 'c' }],
    }
    await expect(new RestrictedGeoGebraAdapterV1(api).execute(command, new AbortController().signal))
      .resolves.toEqual({ createdLabels: ['F'] })
    expect(api.calls).toEqual(['F=Focus[c]'])
  })

  it('binds one native Manual result set to all declared plan outputs', async () => {
    const api = new ManualResultSetApi()
    const command: GeoGebraCommandV1 = {
      commandId: uuid('cmd', 402) as never, stepId: uuid('step', 402) as never, name: 'ManualCommand',
      manual: { signatureId: 'focus-61f0e85d2eda', command: 'Focus', resultOutputs: [
        { index: 1, objectId: uuid('obj', 402) as never, label: 'F1' },
        { index: 2, objectId: uuid('obj', 403) as never, label: 'F2' },
      ] },
      output: { objectId: uuid('obj', 402) as never, label: 'F1' },
      arguments: [{ kind: 'object', objectId: uuid('obj', 400) as never, label: 'c' }],
    }
    await expect(new RestrictedGeoGebraAdapterV1(api).execute(command, new AbortController().signal))
      .resolves.toEqual({ createdLabels: ['F1', 'F2'] })
    expect(api.exists('F1')).toBe(true)
    expect(api.exists('F2')).toBe(true)
    expect(api.calls).toHaveLength(3)
    expect(api.calls[0]).toMatch(/^ggbList[0-9a-f]+=\{Focus\[c\]\}$/)
    expect(api.calls.slice(1)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^F1=Element\[ggbList[0-9a-f]+,1\]$/),
      expect.stringMatching(/^F2=Element\[ggbList[0-9a-f]+,2\]$/),
    ]))
  })

  it('rejects unknown operations before touching the applet API', async () => {
    const api = new PointApi()
    const invalid = { ...pointCommand(1), name: 'DeleteAll' }
    await expect(new RestrictedGeoGebraAdapterV1(api).execute(invalid, new AbortController().signal)).rejects.toThrow()
    expect(api.calls).toEqual([])
  })

  it('rejects a non-declarative Manual command before touching the applet API', async () => {
    const api = new PointApi()
    const invalid = { ...pointCommand(1), name: 'ManualCommand',
      manual: { signatureId: 'delete-object', command: 'Delete' } }
    await expect(new RestrictedGeoGebraAdapterV1(api).execute(invalid, new AbortController().signal)).rejects.toThrow()
    expect(api.calls).toEqual([])
  })

  it('keeps a created mathematical object when its caption cannot be applied', async () => {
    const api = new BrokenCaptionApi()
    await expect(new RestrictedGeoGebraAdapterV1(api).execute(pointCommand(1), new AbortController().signal))
      .resolves.toEqual({ createdLabels: ['ggbPoint1'] })
    expect(api.exists('ggbPoint1')).toBe(true)
  })

  it('bounds the labels returned by multi-output solid commands', async () => {
    const labels = await new RestrictedGeoGebraAdapterV1(new MultiOutputApi())
      .execute(pointCommand(1), new AbortController().signal)
    expect(labels.createdLabels).toHaveLength(8)
    expect(labels.createdLabels[0]).toBe('ggbPoint1')
  })

  it('does not overwrite an existing semantic output label', async () => {
    const api = new PointApi()
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    await adapter.execute(pointCommand(1), new AbortController().signal)
    await expect(adapter.execute(pointCommand(1), new AbortController().signal))
      .rejects.toThrow('output label already exists')
  })

  it('uses the applet visibility API instead of a compatibility-sensitive command', async () => {
    const api = new VisibilityApi()
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    await adapter.execute(pointCommand(1), new AbortController().signal)
    await expect(adapter.execute(visibilityCommand(1), new AbortController().signal)).resolves.toMatchObject({ createdLabels: [] })
    expect(api.getVisible('ggbPoint1')).toBe(false)
    expect(api.calls).not.toContain('SetVisibleInView(ggbPoint1,1,false)')
  })

  it('reports unavailable target evidence despite XML changing', async () => {
    const api = new FalseReturningPresentationApi(true)
    await expect(new RestrictedGeoGebraAdapterV1(api)
      .execute(manualPresentationCommand(), new AbortController().signal)).resolves.toMatchObject({ createdLabels: [] })
    expect(api.calls).toEqual(['SetColor[ggbPoint1,"blue"]'])
  })

  it('does not reject an unchanged XML snapshot on a false API return', async () => {
    const api = new FalseReturningPresentationApi(false)
    await expect(new RestrictedGeoGebraAdapterV1(api)
      .execute(manualPresentationCommand(), new AbortController().signal))
      .resolves.toMatchObject({ result: { apiAccepted: false, apiException: false, outcome: 'unverified' } })
  })

  it('does not use view-one visibility as evidence for another view', async () => {
    const api = new VisibilityApi()
    const command = { ...manualPresentationCommand(), manual: { ...manualPresentationCommand().manual!, command: 'SetVisibleInView' },
      arguments: [visibilityCommand(1).arguments[0]!, { kind: 'number' as const, value: 2 }, { kind: 'boolean' as const, value: true }] }
    await expect(new RestrictedGeoGebraAdapterV1(api).execute(command, new AbortController().signal))
      .resolves.toMatchObject({ result: { outcome: 'unverified', reason: 'property_unavailable' } })
  })

  it.each([['#0000FF', 'satisfied'], ['#FF0000', 'not_satisfied']] as const)(
    'uses direct target color %s even when XML is unchanged and API returns false', async (color, outcome) => {
      const api = new FalseReturningPresentationApi(false)
      const adapter = new RestrictedGeoGebraAdapterV1(Object.assign(api, { getColor: () => color }))
      const command = { ...manualPresentationCommand(), arguments: [manualPresentationCommand().arguments[0]!,
        { kind: 'number' as const, value: 0 }, { kind: 'number' as const, value: 0 }, { kind: 'number' as const, value: 1 }] }
      await expect(adapter.execute(command, new AbortController().signal)).resolves.toMatchObject({
        result: { apiAccepted: false, apiException: false, outcome, expected: '#0000FF', actual: color } })
      expect(api.xml).toBe('<construction />')
    })

  it.each([
    ['y = 0', { a: 0, b: 1, c: -0 }],
    ['x = 2', { a: 1, b: 0, c: -2 }],
    ['l1: -x - y = -4', { a: -1, b: -1, c: 4 }],
    ['x - y = 1', { a: 1, b: -1, c: -1 }],
  ])('keeps the line definition without evaluating its equation %s', async (equation, _expected) => {
    const object = await new RestrictedGeoGebraAdapterV1(new LineApi(equation))
      .readObject('l1', new AbortController().signal)
    expect(object).toMatchObject({ objectType: 'line', definition: 'Line[P1,P2]'  })
    expect(object.properties).not.toHaveProperty('a')
  })
})

describe('GeoGebraTransactionExecutorV1', () => {
  it('applies, observes and versions one transaction', async () => {
    const api = new PointApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), canvas(2)]),
    )
    const result = await executor.apply(transaction(canvas(1)), new AbortController().signal)
    expect(result).toMatchObject({ status: 'applied', beforeCanvasVersion: canvas(1), afterCanvasVersion: canvas(2) })
    expect(result.objects[0]).toMatchObject({ kind: 'point', properties: { caption: 'A', exists: true } })
  })

  it('keeps the observed transaction pending until an explicit commit', async () => {
    const api = new PointApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), canvas(2), canvas(2)]),
    )
    const current = transaction(canvas(1))
    await expect(executor.apply(current, new AbortController().signal)).resolves.toMatchObject({ status: 'applied' })
    await expect(executor.apply(transaction(canvas(2)), new AbortController().signal))
      .resolves.toMatchObject({ status: 'rejected', error: { code: 'EXECUTE_TRANSACTION_PENDING' } })
    await expect(executor.finalize(current.transactionId, 'commit', new AbortController().signal))
      .resolves.toMatchObject({ status: 'committed', canvasVersion: canvas(2) })
  })

  it('restores the pre-transaction canvas on explicit semantic rollback', async () => {
    const api = new PointApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), canvas(2), canvas(1)]),
    )
    const current = transaction(canvas(1))
    await executor.apply(current, new AbortController().signal)
    await expect(executor.finalize(current.transactionId, 'rollback', new AbortController().signal))
      .resolves.toMatchObject({ status: 'rolled_back', rollback: { succeeded: true } })
    expect(api.xml).toBe('<construction />')
  })

  it('reports recovery_required when explicit rollback cannot restore the applet', async () => {
    const api = new BrokenRestoreApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), canvas(2)]),
    )
    const current = transaction(canvas(1))
    await executor.apply(current, new AbortController().signal)
    await expect(executor.finalize(current.transactionId, 'rollback', new AbortController().signal))
      .resolves.toMatchObject({ status: 'recovery_required', rollback: { succeeded: false },
        error: { code: 'RECOVER_ROLLBACK_FAILED' } })
  })

  it('rejects a stale canvas version without invoking the applet', async () => {
    const api = new PointApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(9)]),
    )
    const result = await executor.apply(transaction(canvas(1)), new AbortController().signal)
    expect(result.error?.code).toBe('EXECUTE_CANVAS_VERSION_MISMATCH')
    expect(result.error?.retry).toBe('user_action')
    expect(api.calls).toEqual([])
  })

  it('rolls back when a structured command is rejected', async () => {
    const api = new PointApi()
    const invalid = transaction(canvas(1))
    invalid.commands[0]!.arguments = [{ kind: 'number', value: 1 }]
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1)]),
    )
    const result = await executor.apply(invalid, new AbortController().signal)
    expect(result.status).toBe('rolled_back')
    expect(api.xml).toBe('<construction />')
    expect(result.error?.details).toMatchObject({ commandName: 'Point', commandScript: 'ggbPoint1=Point[{1}]' })
  })

  it('settles an automatic rollback and then allows a new transaction', async () => {
    const api = new PointApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1)]),
    )
    const invalid = transaction(canvas(1))
    invalid.commands[0]!.arguments = [{ kind: 'number', value: 1 }]
    await expect(executor.apply(invalid, new AbortController().signal)).resolves.toMatchObject({
      status: 'rolled_back', rollback: { succeeded: true },
    })
    await expect(executor.finalize(invalid.transactionId, 'commit', new AbortController().signal))
      .resolves.toMatchObject({ status: 'recovery_required' })
    await expect(executor.apply(transaction(canvas(1)), new AbortController().signal))
      .resolves.toMatchObject({ status: 'rejected', error: { code: 'EXECUTE_TRANSACTION_PENDING' } })
    await expect(executor.finalize(invalid.transactionId, 'rollback', new AbortController().signal))
      .resolves.toMatchObject({ status: 'rolled_back', canvasVersion: canvas(1), rollback: { succeeded: true } })
    expect(api.calls).toEqual(['ggbPoint1=Point[{1}]'])
    await expect(executor.apply(transaction(canvas(1)), new AbortController().signal))
      .resolves.toMatchObject({ status: 'applied' })
  })

  it.each([
    [canvas(2), canvas(2)],
    [canvas(1), canvas(2)],
  ])('requires recovery if the automatic rollback or later canvas changed (%s, %s)', async (after, current) => {
    const api = new PointApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), after, current]),
    )
    const invalid = transaction(canvas(1))
    invalid.commands[0]!.arguments = [{ kind: 'number', value: 1 }]
    await executor.apply(invalid, new AbortController().signal)
    await expect(executor.finalize(invalid.transactionId, 'rollback', new AbortController().signal))
      .resolves.toMatchObject({ status: 'recovery_required', error: { code: 'RECOVER_OUTCOME_UNKNOWN' } })
  })

  it('does not settle a failed automatic restore or an unknown transaction', async () => {
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(new BrokenRestoreApi()), new SequenceVersions([canvas(1)]),
    )
    const invalid = transaction(canvas(1))
    invalid.commands[0]!.arguments = [{ kind: 'number', value: 1 }]
    await expect(executor.apply(invalid, new AbortController().signal)).resolves.toMatchObject({
      status: 'outcome_unknown', rollback: { succeeded: false },
    })
    await expect(executor.finalize(invalid.transactionId, 'rollback', new AbortController().signal))
      .resolves.toMatchObject({ status: 'recovery_required' })
  })

  it('preserves an unknown applet object kind without rolling back a successful command', async () => {
    const api = new UnsupportedObservationApi()
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1)]),
    )
    const result = await executor.apply(transaction(canvas(1)), new AbortController().signal)
    expect(result).toMatchObject({ status: 'applied', objects: [{ kind: 'object', rawKind: 'text' }] })
    expect(result.commands).toMatchObject([{ status: 'applied' }])
    expect(api.xml).not.toBe('<construction />')
  })

  it('records a setter exception separately while keeping complete object evidence', async () => {
    const api = new BrokenPresentationApi()
    const current = transaction(canvas(1))
    current.commands.push(visibilityCommand(1))
    const progress: string[] = []
    const executor = new GeoGebraTransactionExecutorV1(
      new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), canvas(2), canvas(2)]),
    )
    const result = await executor.apply(current, new AbortController().signal, item => progress.push(item.status))
    expect(result).toMatchObject({ status: 'applied', objects: [{ properties: { exists: true } }] })
    expect(result.error).toBeUndefined()
    expect(result.commands[1]).toMatchObject({ status: 'unknown', result: { apiException: true } })
    expect(result.commands.map(command => command.status)).toEqual(['applied', 'unknown'])
    expect(progress).toEqual(['running', 'applied', 'running', 'warning'])
    await expect(executor.finalize(current.transactionId, 'commit', new AbortController().signal))
      .resolves.toMatchObject({ status: 'committed' })
    expect(api.xml).toContain('<point')
  })
})

describe('canonicalCanvasXmlV1', () => {
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
    expect(canonicalCanvasXmlV1(xml('applet-1', compactGui, compactView, construction)))
      .toBe(canonicalCanvasXmlV1(xml('applet-2', resizedGui, resizedView, construction)))
  })

  it('keeps construction, presentation and kernel state significant', () => {
    const base = canonicalCanvasXmlV1(xml('applet-1', compactGui, compactView, construction))
    expect(canonicalCanvasXmlV1(xml('applet-1', compactGui, compactView,
      '<construction><element type="point" label="B"><coords x="0" y="0" z="1"/></element></construction>')))
      .not.toBe(base)
    expect(canonicalCanvasXmlV1(xml('applet-1', compactGui, compactView,
      '<construction><element type="point" label="A"><show object="true" label="1"/>'
      + '<coords x="0" y="0" z="1"/></element></construction>'))).not.toBe(base)
    expect(canonicalCanvasXmlV1(xml('applet-1', compactGui, compactView,
      construction, '<kernel><decimals val="4"/></kernel>'))).not.toBe(base)
    expect(base).toContain('<construction>')
    expect(base).not.toContain('<gui>')
    expect(base).not.toContain('<euclidianView>')
    expect(base).not.toContain('applet-1')
  })
})


describe('direct existence evidence', () => {
  it('reads point coordinates from the native API without treating nonpoints as points', async () => {
    const api = new PointApi()
    await new RestrictedGeoGebraAdapterV1(api).execute(pointCommand(1), new AbortController().signal)
    const adapter = new RestrictedGeoGebraAdapterV1(api)
    expect((await adapter.readObject('ggbPoint1', new AbortController().signal)).properties)
      .toMatchObject({ x: 1, y: 2 })
    const line = await new RestrictedGeoGebraAdapterV1(new LineApi('x=0'))
      .readObject('l1', new AbortController().signal)
    expect(line.properties).not.toHaveProperty('x')
  })
  it('does not turn an unavailable or invalid API result into an absent object', async () => {
    for (const exists of [undefined, () => 'false']) {
      const api = new PointApi()
      Object.defineProperty(api, 'exists', { value: exists })
      const adapter = new RestrictedGeoGebraAdapterV1(api)
      await expect(adapter.readObject('A', new AbortController().signal)).resolves.toEqual({})
    }
  })
})

it('commits a successful construction when optional object properties cannot be read', async () => {
  const api = new PointApi()
  api.getXcoord = () => { throw new Error('analytic coordinates unavailable') }
  api.getYcoord = () => { throw new Error('analytic coordinates unavailable') }
  api.getCaption = () => { throw new Error('caption evidence unavailable') }
  const executor = new GeoGebraTransactionExecutorV1(new RestrictedGeoGebraAdapterV1(api), new SequenceVersions([canvas(1), canvas(2), canvas(2)]))
  const observed = await executor.apply(transaction(canvas(1)), new AbortController().signal)
  expect(observed.status).toBe('applied')
  expect(observed.objects[0]).toMatchObject({ rawKind: 'point', properties: { exists: true } })
  expect(observed.objects[0]!.properties).not.toHaveProperty('caption')
  expect(observed.probes).toEqual([])
  const finalized = await executor.finalize(observed.transactionId, 'commit', new AbortController().signal)
  expect(finalized.status).toBe('committed')
})

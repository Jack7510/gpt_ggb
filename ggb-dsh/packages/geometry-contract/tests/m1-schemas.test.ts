import { describe, expect, it } from 'vitest'

import {
  geometryVariableNameV1Schema, geometryCaptionV1Schema,
  executionObservationV1Schema,
  executionTransactionV1Schema,
  geoGebraLinearEquationV1Schema,
  geoGebraPolynomialEquationV1Schema,
  geometryAssertionV1Schema,
  geometryErrorV1Schema,
  mathConstructionPlanV1Schema,
} from '../src/index.js'

const ids = {
  app: 'app_00000000-0000-4000-8000-000000000001',
  run: 'run_00000000-0000-4000-8000-000000000002',
  transaction: 'txn_00000000-0000-4000-8000-000000000003',
  canvas: 'canvas_00000000-0000-4000-8000-000000000004',
  nextCanvas: 'canvas_00000000-0000-4000-8000-000000000005',
  plan: 'plan_00000000-0000-4000-8000-000000000006',
  step: 'step_00000000-0000-4000-8000-000000000007',
  object: 'obj_00000000-0000-4000-8000-000000000008',
  assertion: 'assert_00000000-0000-4000-8000-000000000009',
  command: 'cmd_00000000-0000-4000-8000-000000000010',
} as const

function validPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    planId: ids.plan,
    problemSummary: 'Create point A.',
    assumptions: [],
    objects: [{ objectId: ids.object, kind: 'point', variableName: 'A', description: 'A point', protected: false }],
    steps: [{
      stepId: ids.step, dependsOn: [], explanation: 'Create A.',
      operation: { kind: 'createPointByCoordinates', output: ids.object, x: 0, y: 0 },
    }],
    assertions: [{ assertionId: ids.assertion, kind: 'exists', subjects: [ids.object], expected: true, required: true }],
  }
}

function validTransaction(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    transactionId: ids.transaction,
    appSessionId: ids.app,
    dshSessionId: 'dsh-session-1',
    runId: ids.run,
    planId: ids.plan,
    expectedCanvasVersion: ids.canvas,
    issuedAt: '2026-09-07T08:00:00.000Z',
    expiresAt: '2026-09-07T08:01:00.000Z',
    commands: [{
      commandId: ids.command, stepId: ids.step, name: 'Point',
      output: { objectId: ids.object, label: 'A' },
      arguments: [{ kind: 'number', value: 0 }, { kind: 'number', value: 0 }],
    }],
    probes: [],
    integrity: { algorithm: 'hmac-sha256', value: 'a'.repeat(64) },
  }
}

describe('geometry plan protocol', () => {
  it('rejects the removed relations field', () => {
    expect(mathConstructionPlanV1Schema.safeParse({ ...validPlan(), relations: [] }).success).toBe(false)
  })

  it('accepts a disclosed inferred construction parameter', () => {
    const plan = { ...validPlan(), assumptions: [{
      id: 'radius-choice', text: 'Use a slider for the unspecified radius.', source: 'inferred',
    }] }
    expect(mathConstructionPlanV1Schema.safeParse(plan).success).toBe(true)
  })
})

function validObservation(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    transactionId: ids.transaction,
    status: 'applied',
    beforeCanvasVersion: ids.canvas,
    afterCanvasVersion: ids.nextCanvas,
    commands: [{ commandId: ids.command, status: 'applied', createdLabels: ['A'], durationMs: 1 }],
    objects: [{ objectId: ids.object, label: 'A', kind: 'point', definition: '(0, 0)', dependencies: [], properties: { x: 0, y: 0 } }],
    probes: [],
  }
}


const cases = [
  { name: 'MathConstructionPlanV1', schema: mathConstructionPlanV1Schema, valid: validPlan, missing: 'planId',
    unknown: (value: Record<string, unknown>): void => { ((value.steps as Array<Record<string, unknown>>)[0]!.operation as Record<string, unknown>).kind = 'executeJavaScript' },
    over: (value: Record<string, unknown>): void => { value.steps = Array.from({ length: 65 }, () => (value.steps as unknown[])[0]) } },
  { name: 'ExecutionTransactionV1', schema: executionTransactionV1Schema, valid: validTransaction, missing: 'transactionId',
    unknown: (value: Record<string, unknown>): void => { ((value.commands as Array<Record<string, unknown>>)[0]!).name = 'Execute' },
    over: (value: Record<string, unknown>): void => { value.commands = Array.from({ length: 129 }, () => (value.commands as unknown[])[0]) } },
  { name: 'ExecutionObservationV1', schema: executionObservationV1Schema, valid: validObservation, missing: 'transactionId',
    unknown: (value: Record<string, unknown>): void => { value.status = 'completed' },
    over: (value: Record<string, unknown>): void => { value.objects = Array.from({ length: 129 }, () => (value.objects as unknown[])[0]) } },
] as const

describe.each(cases)('$name schema', ({ schema, valid, missing, unknown, over }) => {
  it('accepts a valid value', () => {
    expect(schema.safeParse(valid()).success).toBe(true)
  })

  it('rejects a missing required field', () => {
    const value = valid()
    delete value[missing]
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('rejects an unknown discriminant', () => {
    const value = valid()
    unknown(value)
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('rejects an over-limit collection', () => {
    const value = valid()
    over(value)
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('rejects an unknown schema version', () => {
    expect(schema.safeParse({ ...valid(), schemaVersion: 2 }).success).toBe(false)
  })
})

describe('geometry assertion arity', () => {
  it('accepts length as either one measurable object or a two-point distance', () => {
    const oneSubject = validPlan()
    const oneAssertion = (oneSubject.assertions as Array<Record<string, unknown>>)[0]!
    Object.assign(oneAssertion, { kind: 'length', subjects: [ids.object], expected: 3 })
    expect(mathConstructionPlanV1Schema.safeParse(oneSubject).success).toBe(true)

    const twoSubjects = validPlan()
    const objects = twoSubjects.objects as Array<Record<string, unknown>>
    const declaration = objects[0]!
    const secondId = 'obj_00000000-0000-4000-8000-000000000011'
    objects.push({ ...declaration, objectId: secondId, variableName: 'B' })
    const twoAssertion = (twoSubjects.assertions as Array<Record<string, unknown>>)[0]!
    Object.assign(twoAssertion, { kind: 'length', subjects: [ids.object, secondId], expected: 3 })
    expect(mathConstructionPlanV1Schema.safeParse(twoSubjects).success).toBe(true)
  })
})

describe('GeometryErrorV1', () => {
  it.each([
    ['plan', 'PLAN_SCHEMA_INVALID', 'after_replan'],
    ['compile', 'COMPILE_ENCODING_INVALID', 'never'],
    ['execute', 'EXECUTE_COMMAND_TIMEOUT', 'transient'],
    ['observe', 'OBSERVE_PROPERTY_MISSING', 'after_replan'],
    ['validate', 'VALIDATE_ASSERTION_FAILED', 'after_replan'],
    ['recover', 'RECOVER_ROLLBACK_FAILED', 'user_action'],
  ] as const)('accepts a stable %s fixture', (phase, code, retry) => {
    expect(geometryErrorV1Schema.safeParse({
      schemaVersion: 1, phase, code, retry, message: 'Safe summary.', details: { itemId: 'dynamic-value' },
    }).success).toBe(true)
  })

  it('rejects dynamic values embedded in the error code', () => {
    expect(geometryErrorV1Schema.safeParse({
      schemaVersion: 1, phase: 'plan', code: 'PLAN_REFERENCE_MISSING_A', retry: 'after_replan',
      message: 'Safe summary.', details: {},
    }).success).toBe(false)
  })
})

describe('equation assertions and signed probes', () => {
  const assertion = { assertionId: ids.assertion, kind: 'hasEquation', subjects: [ids.object],
    expected: 'x^2/9+y^2/5=1', required: true }
  it('requires exactly one subject and a bounded polynomial equation', () => {
    expect(geometryAssertionV1Schema.safeParse(assertion).success).toBe(true)
    for (const expected of [true, 1, 'Execute({"Delete(A)"})', 'x=1;x=2']) {
      expect(geometryAssertionV1Schema.safeParse({ ...assertion, expected }).success).toBe(false)
    }
    expect(geometryAssertionV1Schema.safeParse({ ...assertion, subjects: [] }).success).toBe(false)
  })
})

describe('bounded GeoGebra polynomial equations', () => {
  it('accepts equations but rejects labels, commands and statement separators', (): void => {
    expect(geoGebraPolynomialEquationV1Schema.safeParse('y^2 = 4x').success).toBe(true)
    expect(geoGebraPolynomialEquationV1Schema.safeParse('(x - 2)^2 + y^2 = 9').success).toBe(true)
    expect(geoGebraPolynomialEquationV1Schema.safeParse('c: y^2 = 4x').success).toBe(false)
    expect(geoGebraPolynomialEquationV1Schema.safeParse('y^2=4x;DeleteAll()').success).toBe(false)
    expect(geoGebraPolynomialEquationV1Schema.safeParse('Execute({"DeleteAll()"})=x').success).toBe(false)
    expect(geoGebraPolynomialEquationV1Schema.safeParse('y^2=4x\nDeleteAll()').success).toBe(false)
  })

  it('accepts linear equations and rejects nonlinear line equations', (): void => {
    for (const equation of ['x = -1', '2x + 3y = 5', 'y = 2*x + 1']) {
      expect(geoGebraLinearEquationV1Schema.safeParse(equation).success).toBe(true)
    }
    for (const equation of ['y^2 = 4x', 'x*y = 1', 'sin(x) = y']) {
      expect(geoGebraLinearEquationV1Schema.safeParse(equation).success).toBe(false)
    }
  })
})

describe('valueInInterval assertion', () => {
  const objectId = 'obj_00000000-0000-4000-8000-000000000001'
  const secondId = 'obj_00000000-0000-4000-8000-000000000002'
  const assertion = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    assertionId: 'assert_00000000-0000-4000-8000-000000000001', kind: 'valueInInterval',
    subjects: [objectId], expected: true, axis: 'y', interval: { min: 0, max: 1 }, ...overrides,
  })

  it('accepts one bounded observation and rejects an incomplete declaration', () => {
    expect(geometryAssertionV1Schema.safeParse(assertion({})).success).toBe(true)
    // The axis and the interval are the checkable content: without them nothing could be evaluated.
    expect(geometryAssertionV1Schema.safeParse(assertion({ axis: undefined })).success).toBe(false)
    expect(geometryAssertionV1Schema.safeParse(assertion({ interval: undefined })).success).toBe(false)
    expect(geometryAssertionV1Schema.safeParse(assertion({ expected: 3 })).success).toBe(false)
    // An interval needs a bound and ordered bounds.
    expect(geometryAssertionV1Schema.safeParse(assertion({ interval: { min: null, max: null } })).success)
      .toBe(false)
    expect(geometryAssertionV1Schema.safeParse(assertion({ interval: { min: 2, max: 1 } })).success)
      .toBe(false)
    // An unbounded side is expressed by null, not by a sentinel number.
    expect(geometryAssertionV1Schema.safeParse(assertion({
      interval: { min: 0, max: null, includeMin: false } })).success).toBe(true)
    // A second subject would make the observed scalar ambiguous.
    expect(geometryAssertionV1Schema.safeParse(assertion({ subjects: [objectId, secondId] })).success)
      .toBe(false)
  })

  it('accepts closed singleton scalar conditions and refuses every empty singleton', () => {
    const singleton = { min: 1, max: 1 }
    expect(geometryAssertionV1Schema.parse(assertion({ interval: singleton })).interval)
      .toEqual({ ...singleton, includeMin: true, includeMax: true })
    for (const [includeMin, includeMax] of [[false, false], [false, true], [true, false]]) {
      expect(geometryAssertionV1Schema.safeParse(assertion({
        interval: { ...singleton, includeMin, includeMax } })).success).toBe(false)
    }
  })

  it('keeps the axis and interval off every other kind', () => {
    expect(geometryAssertionV1Schema.safeParse({ assertionId: 'assert_00000000-0000-4000-8000-000000000002',
      kind: 'length', subjects: [objectId], expected: 3, axis: 'y',
      interval: { min: 0, max: 1 } }).success).toBe(false)
  })
})


describe('requested variable names remain bounded', () => {
  it.each(["F'", "P''", 'A′', 'B″', '焦点'])('accepts %s as a variable name', label => {
    expect(geometryVariableNameV1Schema.parse(label)).toBe(label)
  })
  it.each(["'F", "F'2", 'F);Delete(A)', 'F\nA', 'F'.repeat(33)])('rejects %s', label => {
    expect(geometryVariableNameV1Schema.safeParse(label).success).toBe(false)
  })
})

it('refuses mathematical probe requests and probe receipts in the object MVP', () => {
  expect(executionTransactionV1Schema.safeParse({ ...validTransaction(), probes: [{
    assertionId: ids.assertion, kind: 'exists', subjects: [ids.object] }] }).success).toBe(false)
  expect(executionObservationV1Schema.safeParse({ ...validObservation(), probes: [{
    assertionId: ids.assertion, status: 'observed', method: 'legacy', evidence: {} }] }).success).toBe(false)
})

describe('variable names and Captions', () => {
  it('normalizes requested prime Captions', () => {
    for (const name of ["F'", 'Fprime', "P'", 'Pprime']) {
      expect(geometryVariableNameV1Schema.safeParse(name).success).toBe(true)
    }
    for (const caption of ["F'", "P'", 'F′', 'P″']) {
      expect(geometryCaptionV1Schema.safeParse(caption).success).toBe(true)
    }
    for (const caption of ['Fprime', 'Pprime']) {
      expect(geometryCaptionV1Schema.parse(caption)).toBe(caption.replace(/prime$/u, "'"))
    }
  })
})

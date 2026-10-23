import { describe, expect, it } from 'vitest'

import { mathPlanningPlanV1Schema } from '@ggb-copilot/geometry-contract'

import {
  checkPlanningManual, OFFICIAL_GGB_MANUAL_INDEX, manualCommandIndexSchema,
  type PlanningManualQuery,
} from '../src/index.js'

describe('official GeoGebra Manual query and check', () => {
  it('does not bind a rotation center point as the missing angle', () => {
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'O'), object(3, 'point', 'B')],
      [step(1, 3, [1, 2], '把 A 绕 O 旋转 360°/n 得到 B')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('rotate point around center by angle', ['rotate', 'angle', 'center'], ['Rotate']),
    } })
    expect(result.reviewRequests[0]?.reviewKind).toBe('overload_gap')
    expect(result.reviewRequests[0]?.candidates.every(candidate => candidate.arguments.length === 0)).toBe(true)
    expect(result.stepChecks[0]?.status).toBe('manual_candidate_unbound')
  })
  // FIX-03. A `commandHints` entry is the Plan's frozen construction choice. Retrieval used to widen
  // the candidate set whenever the prose did not spell the command out — "rotating" does not contain
  // "rotate", and 旋转 contains neither — and `Midpoint` binds the same two points, so the widening
  // produced a *legal-looking* binding for a command the Plan had explicitly not chosen.
  it.each([
    ['an English gerund that does not contain the command name', 'rotating A about O by 360°/n'],
    ['a Chinese instruction with no Latin command name at all', '把 A 绕 O 旋转 360°/n 得到 B'],
  ])('keeps a frozen Rotate step inside Rotate given %s', (_label, instruction) => {
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'O'), object(3, 'point', 'B')],
      [step(1, 3, [1, 2], instruction)])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup(instruction, [], ['Rotate']),
    } })
    const commands = new Set(result.reviewRequests.flatMap(request =>
      request.candidates.map(candidate => candidate.command)))
    expect([...commands]).toEqual(['Rotate'])
    expect(result.stepChecks[0]?.status).toBe('manual_candidate_unbound')
    // The same overloads a `manual_review` bind decision would be checked against, so the model's view
    // and the compiler's view cannot disagree about which commands are still in play.
    expect(result.stepChecks[0]?.matchedSignatureIds).toEqual(
      result.reviewRequests[0]?.candidates.map(candidate => candidate.signatureId))
  })

  it('reports a frozen command the pinned Manual does not document instead of binding another one', () => {
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'O'), object(3, 'point', 'B')],
      [step(1, 3, [1, 2], 'Rotatte A about O')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('rotate A about O', ['rotate'], ['Rotatte']),
    } })
    expect(result.status).toBe('blocked')
    expect(result.stepChecks[0]).toMatchObject({ status: 'manual_not_found', reasonCode: 'command_not_found', command: 'Rotatte', matchedSignatureIds: [] })
    expect(result.stepChecks[0]?.actual).toBe('command not found in the pinned Manual: Rotatte')
    expect(result.signatureIds).toEqual([])
    expect(result.stepChecks[0]?.expected).toContain('Rotatte')
    expect(result.reviewRequests).toEqual([])
  })

  it.each([
    ['Segment', 1, 0, 'argument_count_mismatch'],
    ['Segment', 2, 1, 'argument_count_mismatch'],
    ['Circle', 1, 0, 'argument_count_mismatch'],
  ])('keeps %s lookup distinct from parameter failure (%s objects, %s scalars)', (command, count, scalars, reasonCode) => {
    const inputs = Array.from({ length: count }, (_unused, index) => index + 1)
    const plan = planningPlan([...inputs.map(id => object(id, 'point', `P${id}`)), object(10, 'segment', 'Out')],
      [step(1, 10, inputs, command)])
    // A fixed signature makes arity expectations explicit without depending on a Case's geometry.
    const cards = OFFICIAL_GGB_MANUAL_INDEX.cards.filter(card => card.command === command
      && card.parameterTypes.length === 2 && card.parameterTypes.every(type => type === 'point'))
    expect(cards.length).toBeGreaterThan(0)
    const checked = checkPlanningManual(plan, { index: { ...OFFICIAL_GGB_MANUAL_INDEX, cards },
      queries: { [stepId(1)]: lookup(command, [], [command]) },
      scalarCounts: { [stepId(1)]: scalars } })
    expect(checked.stepChecks[0]).toMatchObject({ reasonCode, declaredScalarCount: scalars })
    expect(checked.stepChecks[0]?.status).not.toBe('manual_not_found')
    expect(checked.stepChecks[0]?.expected).toContain(command)
    expect(checked.context).not.toContain('Midpoint')
  })

  it('identifies unconsumed scalars when arity fits but all same-command slots require points', () => {
    const cards = OFFICIAL_GGB_MANUAL_INDEX.cards.filter(card => card.command === 'Circle'
      && card.parameterTypes.length === 3 && card.parameterTypes.every(type => type === 'point'))
    expect(cards).toHaveLength(1)
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'B'), object(3, 'circle', 'Out')],
      [step(1, 3, [1, 2], 'Circle')])
    const checked = checkPlanningManual(plan, { index: { ...OFFICIAL_GGB_MANUAL_INDEX, cards },
      queries: { [stepId(1)]: lookup('Circle', [], ['Circle']) }, scalarCounts: { [stepId(1)]: 1 } })
    expect(checked.stepChecks[0]).toMatchObject({ status: 'missing_plan_input',
      reasonCode: 'argument_binding_mismatch', command: 'Circle', declaredScalarCount: 1 })
    expect(checked.stepChecks[0]?.actual).toContain('No same-command signature can consume all declared scalar values')
    expect(checked.reviewRequests).toEqual([])
  })

  it('reports the conflicting argument position for known types, but leaves unknown types open', () => {
    const card = OFFICIAL_GGB_MANUAL_INDEX.cards.find(card => card.command === 'Segment'
      && card.parameterTypes.length === 2 && card.parameterTypes.every(type => type === 'point'))!
    for (const kind of ['line', 'slider']) {
      const plan = planningPlan([object(1, kind, 'A'), object(2, 'point', 'B'), object(3, 'segment', 'Out')],
        [step(1, 3, [1, 2], 'Segment')])
      const checked = checkPlanningManual(plan, { index: { ...OFFICIAL_GGB_MANUAL_INDEX, cards: [card] },
        queries: { [stepId(1)]: lookup('Segment', [], ['Segment']) } })
      if (kind === 'line') {
        expect(checked.stepChecks[0]?.reasonCode).toBe('argument_type_mismatch')
        expect(checked.stepChecks[0]?.actual).toContain('argument 1: expected <point>, received line')
      } else {
        expect(checked.stepChecks[0]?.reasonCode).not.toBe('argument_type_mismatch')
        expect(checked.status).not.toBe('passed')
      }
    }
  })

  it('ships a schema-valid complete index pinned to an official source commit', () => {
    const index = manualCommandIndexSchema.parse(OFFICIAL_GGB_MANUAL_INDEX)
    expect(index.cards.length).toBeGreaterThan(900)
    expect(new Set(index.cards.map(card => card.command)).size).toBe(500)
    expect(index.source.commit).toMatch(/^[a-f0-9]{40}$/)
  })

  // run_80001238: the generator rewrote an `xref:` macro's brackets before its cleanup ran, so the
  // Reflect card shipped `xref:/GeometricObjects.adoc(Object)` as a parameter type and every role
  // lookup on it returned `unknown`. `sourcePath` legitimately ends in `.adoc`, so only the three
  // model-facing fields are checked.
  it('publishes no card whose signature or parameter types still carry adoc markup', () => {
    const markup = /xref:|image:|\+\+|\.adoc/iu
    const offenders = OFFICIAL_GGB_MANUAL_INDEX.cards.flatMap(card => [
      ...(markup.test(card.signature) ? [`${card.command} signature`] : []),
      ...[...card.parameterTypes, ...card.parameterRoles]
        .filter(value => markup.test(value)).map(value => `${card.command} type ${value}`),
    ])
    expect(offenders).toEqual([])
  })

  it.each([[2, false], [3, true], [4, true], [5, false]])('honors declared variadic arity bounds for %s ordered participants', (count, fits) => {
    const card = OFFICIAL_GGB_MANUAL_INDEX.cards.find(value => value.command === 'Polygon'
      && value.signature.includes('...'))!
    const index = { ...OFFICIAL_GGB_MANUAL_INDEX, cards: [{ ...card,
      arity: { min: 3, max: 4, variadic: true } }] }
    const points = Array.from({ length: count as number }, (_unused, offset) => offset + 1)
    const plan = planningPlan([...points.map(id => object(id, 'point', `P${String(id)}`)),
      object(10, 'polygon', 'Out')], [step(1, 10, points, 'Polygon from declared vertices')])
    const result = checkPlanningManual(plan, { index, queries: {
      [stepId(1)]: lookup('polygon', ['polygon'], ['Polygon']),
    } })
    expect(result.status === 'passed').toBe(fits)
    if (fits) expect(result.stepChecks[0]?.arguments).toHaveLength(count as number)
    else expect(result.reviewRequests.every(request => request.candidates.every(candidate =>
      candidate.arguments.length === 0))).toBe(true)
  })

  it('retains pinned Polygon two-point syntax and preserves expanded ordered arguments', () => {
    const card = OFFICIAL_GGB_MANUAL_INDEX.cards.find(value => value.command === 'Polygon'
      && value.signature.includes('...'))!
    expect(card.arity).toEqual({ min: 2, max: null, variadic: true })
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'B'), object(3, 'polygon', 'Out')],
      [step(1, 3, [1, 2], 'Polygon from declared vertices')])
    const result = checkPlanningManual(plan, { index: { ...OFFICIAL_GGB_MANUAL_INDEX, cards: [card] },
      queries: { [stepId(1)]: lookup('polygon', ['polygon'], ['Polygon']) } })
    expect(result.status).toBe('passed')
    expect(result.stepChecks[0]?.arguments?.map(argument => argument.kind === 'object' ? argument.objectId : null))
      .toEqual([objectId(1), objectId(2)])
  })

  it('resolves Focus and Directrix from structured queries instead of the input-object noun', () => {
    const plan = planningPlan([
      object(1, 'conic', 'c'), object(2, 'point', 'F'), object(3, 'line', 'd'),
    ], [
      step(1, 2, [1], '作出抛物线 c 的焦点 F'),
      step(2, 3, [1], '作出抛物线 c 的准线 d'),
    ])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('derive the focus of a conic', ['focus', 'conic'], ['Focus']),
      [stepId(2)]: lookup('derive the directrix of a conic', ['directrix', 'conic'], ['Directrix']),
    } })

    expect(result.status).toBe('passed')
    expect(result.stepChecks).toEqual([
      expect.objectContaining({ command: 'Focus', status: 'passed', inputKinds: ['conic'] }),
      expect.objectContaining({ command: 'Directrix', status: 'passed', inputKinds: ['conic'] }),
    ])
    expect(result.context).toContain('Focus( <Conic> )')
    expect(result.context).toContain('Directrix( <Conic> )')
    expect(result.context).not.toContain('Parabola( <Conic> )')
  })

  it('binds a requested moving-point trajectory to the official Locus overload', () => {
    const plan = planningPlan([
      object(1, 'point', 'M'), object(2, 'slider', 't'), object(3, 'curve', 'loc'),
    ], [step(1, 3, [1, 2], '构造点 M 随参数 t 变化形成的轨迹')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('construct locus of dependent point from slider',
        ['locus', 'dependent point', 'slider'], ['Locus']),
    } })
    expect(result.status).toBe('passed')
    expect(result.stepChecks[0]).toMatchObject({ command: 'Locus', status: 'passed',
      inputKinds: ['point', 'slider'], outputKind: 'curve' })
    expect(result.context).toContain('Locus( <Point Creating Locus Line Q>, <Slider t>)')
  })

  it('retrieves bounded candidates and accepts only a supplied-signature review decision', () => {
    const plan = planningPlan([object(1, 'conic', 'c'), object(2, 'point', 'F')], [
      step(1, 2, [1], '作焦点 F'),
    ])
    const queries = { [stepId(1)]: lookup('derive focus from conic', ['focus', 'foci'], []) }
    const unresolved = checkPlanningManual(plan, { queries })
    const focus = unresolved.reviewRequests[0]?.candidates.find(candidate => candidate.command === 'Focus')
    expect(unresolved.status).toBe('needs_review')
    expect(focus?.signatureId).toMatch(/^focus-/)

    const reviewed = checkPlanningManual(plan, { queries, reviewDecisions: [{ stepId: stepId(1),
      status: 'selected', selectedSignatureId: focus?.signatureId, reason: 'Focus derives the requested point' }] })
    expect(reviewed.stepChecks[0]).toMatchObject({ command: 'Focus', status: 'passed' })

    const inconclusive = checkPlanningManual(plan, { queries, reviewDecisions: [{ stepId: stepId(1),
      status: 'ambiguous', reason: 'The supplied evidence cannot distinguish the remaining bindings.' }] })
    expect(inconclusive.status).toBe('passed')
    expect(inconclusive.stepChecks[0]).toMatchObject({ status: 'manual_ambiguous' })
  })

  it('passes corroborated exact ordered Manual commands and keeps their evidence', () => {
    const cases = [
      {
        command: 'Point', outputKind: 'point', inputKinds: ['conic'], roles: ['source_object'],
        intent: 'create point on object', keywords: ['point', 'object'],
      },
      {
        command: 'PerpendicularLine', outputKind: 'line', inputKinds: ['point', 'line'],
        roles: ['through_point', 'reference_line'], intent: 'create perpendicular line through point',
        keywords: ['perpendicular', 'line', 'point'],
      },
      {
        command: 'Intersect', outputKind: 'point', inputKinds: ['line', 'line'],
        roles: ['first_line', 'second_line'], intent: 'intersect first line and second line',
        keywords: ['intersect', 'line'],
      },
    ] as const

    for (const item of cases) {
      const inputs = item.inputKinds.map((kind, index) => object(index + 1, kind, `I${String(index + 1)}`))
      const outputIndex = inputs.length + 1
      const plan = planningPlan([...inputs, object(outputIndex, item.outputKind, 'out')], [
        step(1, outputIndex, inputs.map((_, index) => index + 1), item.intent),
      ])
      const participants = { [stepId(1)]: item.roles.map((role, index) => ({
        objectId: objectId(index + 1), role, variableName: `I${String(index + 1)}`, description: role,
      })) }
      const queries = {
        [stepId(1)]: lookup(item.intent, [...item.keywords], [item.command]),
      }
      const result = checkPlanningManual(plan, { participants, queries })
      expect(result.status, item.command).toBe('passed')
      expect(result.stepChecks[0], item.command).toMatchObject({ status: 'passed', command: item.command })
      expect(result.context, item.command).toContain(`"command":"${item.command}"`)
      expect(result.context, item.command).toContain('BEGIN_UNTRUSTED_GGB_MANUAL_REFERENCE')
    }
  })

  it('routes an opaque canvas object through LLM Review instead of rejecting its Manual overload', () => {
    const existing = { objectId: objectId(1), kind: 'object', variableName: 't',
      description: 'existing canvas object futurePath t', protected: true }
    const plan = planningPlan([existing, object(2, 'point', 'A')], [
      step(1, 2, [1], '在已有对象 t 上取点 A'),
    ])
    const queries = { [stepId(1)]: lookup('create point on existing object', ['point', 'object'], ['Point']) }
    const participants = { [stepId(1)]: [{ objectId: objectId(1), role: 'path', variableName: 't',
      description: 'existing canvas object futurePath t' }] }
    const unresolved = checkPlanningManual(plan, { queries, participants })
    const candidate = unresolved.reviewRequests[0]?.candidates.find(item => item.command === 'Point')

    expect(unresolved.status).toBe('needs_review')
    expect(candidate?.arguments).toEqual([expect.objectContaining({ objectId: objectId(1), semanticRole: 'path' })])
    expect(unresolved.stepChecks[0]).toMatchObject({ status: 'manual_ambiguous', inputKinds: ['object'] })
    const reviewed = checkPlanningManual(plan, { queries, participants,
      reviewDecisions: [selectDecision(unresolved, stepId(1), 'Point')] })
    expect(reviewed.stepChecks[0]).toMatchObject({ status: 'passed', command: 'Point' })
  })

  it('does not let a partial overload discard a typed Plan participant', () => {
    const plan = planningPlan([
      object(1, 'point', 'A'), object(2, 'line', 'l'), object(3, 'line', 'p'),
    ], [step(1, 3, [1, 2], '过 A 作 l 的垂线 p')])
    const participants = { [stepId(1)]: [
      { objectId: objectId(1), role: 'through_point', variableName: 'A', description: 'point A' },
      { objectId: objectId(2), role: 'reference_line', variableName: 'l', description: 'line l' },
    ] }
    const queries = {
      [stepId(1)]: lookup('create perpendicular line through point', ['perpendicular', 'line'],
        ['PerpendicularLine']),
    }
    const result = checkPlanningManual(plan, { participants, queries })

    expect(result.status).toBe('passed')
    expect(result.stepChecks[0]).toMatchObject({ command: 'PerpendicularLine', status: 'passed' })
    expect(result.context).not.toContain('PerpendicularVector')
  })

  it('never permutes Plan arguments to manufacture a Manual overload', () => {
    const plan = planningPlan([
      object(1, 'line', 'l'), object(2, 'point', 'A'), object(3, 'line', 'p'),
    ], [step(1, 3, [1, 2], '过 A 作 l 的垂线 p')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('create perpendicular line through point', ['perpendicular', 'line', 'point'],
        ['PerpendicularLine']),
    } })
    expect(result.status).toBe('needs_review')
    expect(result.reviewRequests.flatMap(request => request.candidates)
      .filter(candidate => candidate.command === 'PerpendicularLine'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ arguments: [] })]))
    expect(result.reviewRequests.flatMap(request => request.candidates)
      .some(candidate => candidate.command === 'PerpendicularLine' && candidate.arguments.length > 0)).toBe(false)
  })

  it('keeps native PerpendicularBisector separate from runtime capability', () => {
    const plan = planningPlan([
      object(1, 'segment', 'FA'), object(2, 'line', 'm'),
    ], [step(1, 2, [1], '作线段 FA 的中垂线')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('construct perpendicular bisector of segment', ['perpendicular bisector'],
        ['PerpendicularBisector']),
    } })

    expect(result.status).toBe('passed')
    expect(result.stepChecks[0]).toMatchObject({ command: 'PerpendicularBisector',
      status: 'passed', inputKinds: ['segment'], outputKind: 'line' })
    expect(result.context).toContain('PerpendicularBisector( <Segment> )')
  })

  // FIX-03 replaced this test's contract. It used to assert the opposite: the step froze `Focus`, the
  // prose said "directrix", and the corroboration gate decided the hint was unsupported and let
  // retrieval bind `Directrix` instead. That widening is what offered `Midpoint` for a frozen `Rotate`.
  // A frozen command is the Plan's own choice, so the candidates stay inside it; a different command
  // is a Plan revision, and this step reports the choice rather than making it.
  it('keeps a frozen command the prose contradicts, and never binds the other one', () => {
    const plan = planningPlan([object(1, 'conic', 'c'), object(2, 'line', 'd')], [
      step(1, 2, [1], '作抛物线 c 的准线 d'),
    ])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('derive directrix from conic', ['directrix'], ['Focus']),
    } })
    const commands = new Set(result.reviewRequests.flatMap(request =>
      request.candidates.map(candidate => candidate.command)))
    expect([...commands]).toEqual(['Focus'])
    expect(result.stepChecks[0]?.command).not.toBe('Directrix')
  })

  it('treats an explicit numeric radius as an overload input without declaring a fake object', () => {
    const plan = planningPlan([object(1, 'point', 'O'), object(2, 'circle', 'c')], [
      step(1, 2, [1], '以 O 为圆心作半径为 2 的圆'),
    ])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('circle by center and radius', ['circle', 'radius'], ['Circle']),
    } })
    expect(result.status).toBe('needs_review')
    expect(result.reviewRequests[0]).toMatchObject({ reviewKind: expect.stringMatching(/binding|overload_gap/) })
    // This layer cannot close the step: a declared radius is the plan's own value, so the caller's
    // controlled-path resolver decides it, and no review answer stands in for that (tech design
    // §5.6.13.3). `defer_to_codegen` is gone, and the step stays open by name instead.
    expect(result.stepChecks[0]).toMatchObject({ status: 'manual_candidate_unbound', inputKinds: ['point'] })
  })

  it('leaves a presentation step to the caller route instead of reviewing it', () => {
    const plan = planningPlan([object(1, 'circle', 'c')], [{
      stepId: stepId(1), dependsOn: [], output: null, inputs: [objectId(1)],
      instruction: '将圆 c 用红色填充', expectedResult: '圆 c 显示红色填充',
    }])
    // A presentation step needs no official lookup: its capability evidence belongs to the caller's own
    // reviewed style route, which reads the pinned index directly (tech design §5.6.13.3).
    const queries = { [stepId(1)]: { mode: 'not_required' as const, reason: 'presentation' as const } }
    const resolved = checkPlanningManual(plan, { queries })
    expect(resolved.status).toBe('passed')
    expect(resolved.reviewRequests).toEqual([])
    expect(resolved.stepChecks[0]).toMatchObject({ status: 'manual_not_required',
      matchedSignatureIds: [], outputKind: null })
    // A lookup query would still be answered — and now by name, not by a selectable deferral.
    const asLookup = checkPlanningManual(plan, { queries: { [stepId(1)]: lookup(
      'change object fill color to red', ['object', 'color', 'fill', 'red'], []) } })
    expect(asLookup.status).toBe('needs_review')
  })

  it('separates dependency order from a reviewed Manual argument binding', () => {
    const plan = planningPlan([
      object(1, 'point', 'B'), object(2, 'point', 'A'), object(3, 'slider', 'n'), object(4, 'point', 'C'),
    ], [step(1, 4, [1, 2, 3], '将 B 绕 A 旋转 360°/n 得到 C')])
    const queries = {
      [stepId(1)]: lookup('rotate point around center by angle', ['rotate', 'angle', 'point'], ['Rotate']),
    }
    const participants = { [stepId(1)]: [
      { objectId: objectId(1), role: 'object_to_rotate', variableName: 'B', description: 'point B' },
      { objectId: objectId(2), role: 'rotation_center', variableName: 'A', description: 'center A' },
      { objectId: objectId(3), role: 'rotation_angle', variableName: 'n', description: 'side count' },
    ] }
    const unresolved = checkPlanningManual(plan, { queries, participants })
    expect(unresolved.status).toBe('needs_review')
    // The reviewed candidates read the slider as a value, never as the missing object operand: that is
    // what keeps the dependency order and the argument binding apart.
    expect(unresolved.stepChecks[0]).toMatchObject({ command: expect.stringContaining('Rotate'),
      status: 'manual_candidate_unbound' })
    expect(unresolved.reviewRequests[0]?.candidates.flatMap(candidate => candidate.arguments)
      .filter(argument => argument.kind === 'number')).toEqual([])
  })

  it('returns a semantic no-match with existing Manual candidates to Plan revision', () => {
    const plan = planningPlan([
      object(1, 'point', 'B'), object(2, 'point', 'A'), object(3, 'slider', 'n'), object(4, 'polygon', 'P'),
    ], [step(1, 4, [1, 2, 3], '以 B、圆心 A 和边数 n 作内接正多边形')])
    const queries = { [stepId(1)]: lookup('regular polygon from adjacent vertices and vertex count',
      ['regular polygon', 'vertices'], ['Polygon']) }
    const participants = { [stepId(1)]: [
      { objectId: objectId(1), role: 'first_vertex', variableName: 'B', description: 'point on circle' },
      { objectId: objectId(2), role: 'circle_center', variableName: 'A', description: 'circle center' },
      { objectId: objectId(3), role: 'vertex_count', variableName: 'n', description: 'side-count slider' },
    ] }
    const unresolved = checkPlanningManual(plan, { queries, participants })
    expect(unresolved.status).toBe('needs_review')

    const reviewed = checkPlanningManual(plan, { queries, participants, reviewDecisions: [{
      stepId: stepId(1), status: 'no_match',
      reason: 'The plan supplies a circle center instead of an adjacent second polygon vertex.',
    }] })
    expect(reviewed.status).toBe('needs_revision')
    expect(reviewed.stepChecks[0]).toMatchObject({ status: 'semantic_role_mismatch' })
  })

  it('shows related Polygon overloads without treating an unbound overload as selected', () => {
    const plan = planningPlan([
      object(1, 'point', 'A'), object(2, 'point', 'B'), object(3, 'polygon', 'P'),
    ], [step(1, 3, [1, 2], '以圆心 A 和首顶点 B 作内接正多边形')])
    const queries = { [stepId(1)]: lookup('regular polygon inscribed from center and vertex with number of sides',
      ['polygon', 'regular', 'vertices'], ['Polygon']) }
    const participants = { [stepId(1)]: [
      { objectId: objectId(1), role: 'circle_center', variableName: 'A', description: 'center' },
      { objectId: objectId(2), role: 'first_vertex', variableName: 'B', description: 'on circle' },
    ] }
    const review = checkPlanningManual(plan, { queries, participants })
    expect(review.status).toBe('needs_review')
    expect(review.reviewRequests[0]?.relatedSignatures?.some(item =>
      item.signature.includes('Number of Vertices'))).toBe(true)
  })

  it('reviews a known command whose semantic participants do not yet form executable arguments', () => {
    const plan = planningPlan([object(1, 'segment', 'FA'), object(2, 'point', 'M')], [
      step(1, 2, [], '作线段 FA 的中点 M'),
    ])
    const queries = {
      [stepId(1)]: lookup('construct midpoint', ['midpoint'], ['Midpoint']),
    }
    const unresolved = checkPlanningManual(plan, { queries })
    expect(unresolved.status).toBe('needs_review')
    expect(unresolved.reviewRequests[0]).toMatchObject({ reviewKind: expect.stringMatching(/binding|overload_gap/) })
    expect(unresolved.stepChecks[0]).toMatchObject({ status: 'manual_candidate_unbound', inputKinds: [] })

    const reviewed = checkPlanningManual(plan, { queries, reviewDecisions: [{ stepId: stepId(1),
      status: 'no_match', reason: 'The required segment participant is absent from the Plan step.' }] })
    expect(reviewed.status).toBe('needs_revision')
    expect(reviewed.stepChecks[0]).toMatchObject({ status: 'missing_plan_input' })
  })

  it('verifies a local coordinate path independently of the skip reason', () => {
    const plan = planningPlan([object(1, 'point', 'O')], [step(1, 1, [], '作原点 O(0,0)')])
    const queries = { [stepId(1)]: { mode: 'not_required' as const, reason: 'direct_equation' as const } }
    const unresolved = checkPlanningManual(plan, { queries })
    expect(unresolved.status).toBe('needs_review')
    expect(unresolved.reviewRequests[0]).toMatchObject({ reviewKind: 'skip', candidates: [] })
    expect(unresolved.stepChecks[0]?.status).toBe('manual_skip_unverified')

    const reviewed = checkPlanningManual(plan, { queries, reviewDecisions: [{ stepId: stepId(1),
      status: 'skip_valid', reason: 'O(0,0) is a direct coordinate input compiled by a native safe operation.' }] })
    expect(reviewed.status).toBe('passed')
    expect(reviewed.stepChecks[0]).toMatchObject({ status: 'manual_not_required',
      actual: 'local coordinate operation verified' })
  })

  it.each(['free_layout', 'local_primitive', 'direct_equation'] as const)(
    'refuses an unsupported circle shortcut %s despite skip_valid', reason => {
      const plan = planningPlan([object(1, 'circle', 'c')], [step(1, 1, [], 'Draw circle c')])
      const result = checkPlanningManual(plan, { queries: { [stepId(1)]: { mode: 'not_required', reason } },
        reviewDecisions: [{ stepId: stepId(1), status: 'skip_valid', reason: 'Because I say so' }] })
      expect(result.status).toBe('needs_revision')
      expect(result.stepChecks[0]?.status).toBe('missing_plan_input')
    })

  it('does not waive missing point operands merely because the instruction contains coordinates', () => {
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'O')],
      [step(1, 2, [1], 'O=(0,0)')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: { mode: 'not_required', reason: 'direct_equation' } },
    reviewDecisions: [{ stepId: stepId(1), status: 'skip_valid', reason: 'Coordinates' }] })
    expect(result.status).toBe('needs_revision')
  })

  it('preserves the existing typed coordinate path with declared slider operands', () => {
    const plan = planningPlan([object(1, 'slider', 't'), object(2, 'point', 'A')],
      [step(1, 2, [1], 'Create A=(-1,t)')])
    const queries = { [stepId(1)]: { mode: 'not_required' as const, reason: 'direct_equation' as const } }
    const initial = checkPlanningManual(plan, { queries })
    expect(initial.reviewRequests[0]?.reviewKind).toBe('skip')
    const reviewed = checkPlanningManual(plan, { queries, reviewDecisions: [
      { stepId: stepId(1), status: 'skip_valid', reason: 'Use a typed coordinate operation' }] })
    expect(reviewed.status).toBe('passed')
    expect(reviewed.stepChecks[0]?.status).toBe('manual_not_required')
  })

  it('retains all corroborated candidates for binding rather than truncating to the display limit', () => {
    const card = OFFICIAL_GGB_MANUAL_INDEX.cards.find(value => value.signature === 'Point( <Object> )')!
    const index = { ...OFFICIAL_GGB_MANUAL_INDEX, cards: Array.from({ length: 9 }, (_value, i) =>
      ({ ...card, id: `point-probe-${String(i)}` })) }
    const plan = planningPlan([object(1, 'circle', 'c'), object(2, 'point', 'P')],
      [step(1, 2, [1], 'Place P on c')])
    const result = checkPlanningManual(plan, { index, queries: {
      [stepId(1)]: lookup('point on object', ['point'], ['Point']) } })
    expect(result.reviewRequests[0]?.candidates).toHaveLength(9)
  })

  it('keeps an unbound candidate open when no reviewed binding fits it', () => {
    const plan = planningPlan([object(1, 'slider', 'r')], [step(1, 1, [], '建立半径滑块 r')])
    const queries = { [stepId(1)]: lookup('create radius slider', ['slider', 'radius'], ['Slider']) }
    const unresolved = checkPlanningManual(plan, { queries })
    expect(unresolved.status).toBe('needs_review')
    expect(unresolved.reviewRequests[0]).toMatchObject({ reviewKind: 'overload_gap' })
    // The step stays open: what closes it is the plan's own local-primitive basis, resolved by the
    // caller, not an answer the reviewer gives about a binding it never had.
    expect(unresolved.stepChecks[0]?.status).toBe('manual_candidate_unbound')
  })

  it('validates not_required reasons instead of silently waiving command checks', () => {
    const plan = planningPlan([object(1, 'conic', 'c')], [step(1, 1, [], '输入方程 y^2=4x')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: { mode: 'not_required', reason: 'direct_equation' },
    } })
    expect(result.status).toBe('passed')
    expect(result.stepChecks[0]?.status).toBe('manual_not_required')
  })

  it('accepts a zero-input slider as a local free-layout control', () => {
    const plan = planningPlan([object(1, 'slider', 'r')], [step(1, 1, [], '建立半径滑块 r')])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: { mode: 'not_required', reason: 'free_layout' },
    } })
    expect(result.status).toBe('passed')
    expect(result.stepChecks[0]?.status).toBe('manual_not_required')
  })

  it('uses Manual-declared compulsory parameters when optional Slider arguments are omitted', () => {
    const plan = planningPlan([object(1, 'slider', 'r')], [
      step(1, 1, [], '作滑块 r，最小值 1，最大值 10，增量 0.5'),
    ])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('create number slider with min max increment',
        ['slider', 'number', 'range', 'increment'], ['Slider']),
    } })

    expect(result.status).toBe('needs_review')
    expect(result.reviewRequests[0]).toMatchObject({ reviewKind: expect.stringMatching(/binding|overload_gap/) })
  })

  it('requires a structured query for every step', () => {
    const plan = planningPlan([object(1, 'point', 'A')], [step(1, 1, [], '作点 A')])
    const result = checkPlanningManual(plan, { queries: {} })
    expect(result.status).toBe('needs_revision')
    expect(result.stepChecks[0]).toMatchObject({ status: 'missing_plan_input', actual: 'query missing from Semantic Plan' })
  })

  it('does not treat a Manual side-effect command as a declarative construction capability', () => {
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'B')], [
      step(1, 2, [1], '删除 A'),
    ])
    const result = checkPlanningManual(plan, { queries: {
      [stepId(1)]: lookup('delete an object', ['delete', 'object'], ['Delete']),
    } })

    expect(result.status).toBe('blocked')
    expect(result.stepChecks[0]).toMatchObject({ command: 'Delete', status: 'missing_capability' })
  })

})

function lookup(intent: string, keywords: string[], commandHints: string[]): PlanningManualQuery {
  return { mode: 'lookup', intent, keywords, commandHints }
}

function selectDecision(
  result: ReturnType<typeof checkPlanningManual>,
  selectedStepId: string,
  command: string,
) {
  const candidate = result.reviewRequests.find(request => request.stepId === selectedStepId)
    ?.candidates.find(item => item.command === command)
  if (candidate === undefined) throw new Error(`missing test candidate ${command}`)
  return { stepId: selectedStepId, status: 'selected' as const, selectedSignatureId: candidate.signatureId,
    arguments: candidate.arguments, reason: `${command} matches the requested action` }
}

function object(index: number, kind: string, variableName: string): Record<string, unknown> {
  return { objectId: objectId(index), kind, variableName, description: variableName, protected: false }
}

function step(index: number, output: number, inputs: number[], instruction: string): Record<string, unknown> {
  return { stepId: stepId(index), dependsOn: [], output: objectId(output), inputs: inputs.map(objectId),
    instruction, expectedResult: instruction }
}

function planningPlan(objects: readonly Record<string, unknown>[], steps: readonly Record<string, unknown>[]) {
  return mathPlanningPlanV1Schema.parse({ schemaVersion: 1,
    planId: 'plan_00000000-0000-4000-8000-000000000001', space: '2d', problemSummary: 'test',
    assumptions: [], objects, steps, assertions: [] })
}

function objectId(index: number): `obj_${string}` {
  return `obj_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function stepId(index: number): `step_${string}` {
  return `step_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

describe('complete frozen Manual arguments', () => {
  it('binds a numeric parameter from its actual value without relying on instruction prose', () => {
    const plan = planningPlan([object(1, 'circle', 'c'), object(2, 'point', 'P')], [step(1, 2, [1], '构造点')])
    const checked = checkPlanningManual(plan, { queries: { [stepId(1)]: lookup('构造点', [], ['Point']) },
      scalarCounts: { [stepId(1)]: 1 }, orderedArguments: { [stepId(1)]: [
        { kind: 'object', objectId: objectId(1), valueKind: 'circle' }, { kind: 'number', value: 0 },
      ] } })
    expect(checked.status).toBe('passed')
    expect(checked.reviewRequests).toEqual([])
    expect(checked.stepChecks[0]?.arguments).toEqual([
      { kind: 'object', objectId: objectId(1), parameterType: 'object' },
      { kind: 'number', value: 0, parameterType: 'parameter' },
    ])
  })
  it('preserves a numeric object dependency instead of sampling its current value', () => {
    const plan = planningPlan([object(1, 'circle', 'c'), object(2, 'slider', 't'), object(3, 'point', 'P')],
      [step(1, 3, [1], 'Point')])
    const checked = checkPlanningManual(plan, { queries: { [stepId(1)]: lookup('Point', [], ['Point']) },
      scalarCounts: { [stepId(1)]: 1 }, orderedArguments: { [stepId(1)]: [
        { kind: 'object', objectId: objectId(1), valueKind: 'circle' },
        { kind: 'object', objectId: objectId(2), valueKind: 'slider' },
      ] } })
    expect(checked.status).toBe('passed')
    expect(checked.stepChecks[0]?.arguments?.[1]).toEqual({ kind: 'object', objectId: objectId(2), parameterType: 'parameter' })
  })
  it.each([true, false])('checks a scalar between object operands in exact order, correct=%s', correct => {
    const plan = planningPlan([object(1, 'point', 'A'), object(2, 'point', 'O'), object(3, 'point', 'B')],
      [step(1, 3, [1, 2], 'Rotate')])
    const first = { kind: 'object' as const, objectId: objectId(1), valueKind: 'point' }
    const last = { kind: 'object' as const, objectId: objectId(2), valueKind: 'point' }
    const value = { kind: 'number' as const, value: Math.PI / 2 }
    const checked = checkPlanningManual(plan, { queries: { [stepId(1)]: lookup('Rotate', [], ['Rotate']) },
      scalarCounts: { [stepId(1)]: 1 }, orderedArguments: { [stepId(1)]: correct ? [first, value, last] : [first, last, value] } })
    expect(checked.status === 'passed').toBe(correct)
    if (correct) expect(checked.stepChecks[0]?.arguments?.map(arg => arg.kind)).toEqual(['object', 'number', 'object'])
  })
  it.each(['missing_object', 'extra_value', 'unknown_object', 'forged_kind', 'nonfinite'])('does not corroborate %s inputs', fault => {
    const plan = planningPlan([object(1, 'circle', 'c'), object(2, 'point', 'P')], [step(1, 2, [1], 'Point')])
    const ordered = [
      { kind: 'object' as const, objectId: fault === 'unknown_object' ? objectId(99) : objectId(1), valueKind: fault === 'forged_kind' ? 'point' : 'circle' },
      { kind: 'number' as const, value: fault === 'nonfinite' ? Number.NaN : 0 },
    ]
    if (fault === 'missing_object') ordered.shift()
    if (fault === 'extra_value') ordered.push({ kind: 'number', value: 1 })
    const checked = checkPlanningManual(plan, { queries: { [stepId(1)]: lookup('Point', [], ['Point']) },
      scalarCounts: { [stepId(1)]: 1 }, orderedArguments: { [stepId(1)]: ordered } })
    expect(checked.status).not.toBe('passed')
  })
})

import type { MathPlanningPlanV1 } from '@ggb-copilot/geometry-contract'

import { OFFICIAL_GGB_MANUAL_INDEX } from './generated/official-manual-index.js'
import { isDeclarativeManualCommand, type ManualCommandCard, type ManualCommandIndex } from './manual-command.js'

export type PlanningManualQuery =
  | { readonly mode: 'lookup'; readonly intent: string; readonly keywords: readonly string[];
      readonly commandHints: readonly string[] }
  | { readonly mode: 'not_required'; readonly reason: 'direct_equation' | 'free_layout' | 'presentation' | 'local_primitive';
      /**
       * The equation the Plan froze, when it froze one. `direct_equation` used to be proven only by
       * finding an equation-shaped string in the step's own prose, so the tool had to smuggle the
       * structural value into the user-facing sentence for the skip to be granted (FIX-08). The value
       * travels here instead.
       */
      readonly equation?: string | undefined }

/**
 * What the reviewer may decide about one open step. `defer_to_codegen` is gone (tech design
 * §5.6.13.3): a step the frozen Plan already determines is resolved by the tool before review, so the
 * only remaining decisions either bind the step to the pinned Manual or say why it cannot be bound.
 */
export interface PlanningManualReviewDecision {
  readonly stepId: string
  readonly status: 'selected' | 'skip_valid' | 'ambiguous' | 'no_match'
  readonly selectedSignatureId?: string
  readonly arguments?: readonly PlanningManualArgumentBinding[]
  readonly resultIndex?: number
  readonly reason: string
}

export type PlanningManualArgumentBinding =
  | { readonly kind: 'object'; readonly objectId: string; readonly parameterType: string;
      readonly semanticRole?: string }
  | { readonly kind: 'number'; readonly value: number; readonly parameterType: string }

export interface PlanningManualParticipant {
  readonly objectId: string
  readonly role: string
  readonly variableName: string
  readonly description: string
}

export interface PlanningManualReviewRequest {
  readonly reviewKind: 'binding' | 'overload_gap' | 'skip'
  readonly stepId: string
  readonly dependsOnStepIds?: readonly string[]
  readonly outputObjectId?: string | null
  readonly instruction: string
  readonly expectedResult: string
  readonly query: PlanningManualQuery
  readonly inputKinds: readonly string[]
  readonly outputKind: string | null
  readonly participants: readonly PlanningManualParticipant[]
  readonly candidates: readonly PlanningManualCandidate[]
  /** Same-command overloads as context, not selectable bindings for this Plan step. */
  readonly relatedSignatures?: readonly { readonly signatureId: string; readonly signature: string;
    readonly description: string }[]
}

export interface PlanningManualCandidate {
  readonly signatureId: string
  readonly command: string
  readonly signature: string
  readonly description: string
  readonly arguments: readonly PlanningManualArgumentBinding[]
}

export interface PlanningManualStepCheck {
  readonly stepId: string
  readonly status: 'passed' | 'manual_not_required' | 'manual_not_found' | 'manual_ambiguous'
    | 'manual_candidate_unbound' | 'manual_skip_unverified'
    | 'missing_capability' | 'missing_plan_input' | 'semantic_role_mismatch'
  readonly command?: string
  readonly reasonCode?: 'command_not_found' | 'argument_count_mismatch' | 'argument_type_mismatch'
    | 'argument_binding_mismatch'
  readonly declaredScalarCount?: number
  readonly inputKinds: readonly string[]
  readonly outputKind: string | null
  readonly matchedSignatureIds: readonly string[]
  readonly arguments?: readonly PlanningManualArgumentBinding[]
  readonly resultIndex?: number
  readonly expected: string
  readonly actual: string
}

export interface PlanningManualCheck {
  readonly status: 'passed' | 'needs_review' | 'needs_revision' | 'blocked'
  readonly stepChecks: readonly PlanningManualStepCheck[]
  readonly reviewRequests: readonly PlanningManualReviewRequest[]
  readonly context: string
  readonly signatureIds: readonly string[]
  readonly sourceCommit: string
}

/** Complete frozen command inputs, in execution order; numeric objects remain object references. */
export type PlanningManualInputArgument =
  | { readonly kind: 'object'; readonly objectId: string; readonly valueKind: string; readonly semanticRole?: string }
  | { readonly kind: 'number'; readonly value: number }

export interface PlanningManualCheckOptions {
  readonly queries: Readonly<Record<string, PlanningManualQuery>>
  readonly reviewDecisions?: readonly PlanningManualReviewDecision[]
  readonly participants?: Readonly<Record<string, readonly PlanningManualParticipant[]>>
  readonly index?: ManualCommandIndex
  /**
   * How many numeric values each step froze outside its object inputs. A command whose Plan states a
   * count cannot bind an overload that has no room for it: `Polygon( <Point>, <Point>, ... )` expands
   * to points alone, so offering it for a step that also declared a vertex count would bind a
   * two-point polygon and silently drop the parameter.
   */
  readonly scalarCounts?: Readonly<Record<string, number>>
  /** Values and order from the caller's frozen command; omitted while an expression has no representable binding. */
  readonly orderedArguments?: Readonly<Record<string, readonly PlanningManualInputArgument[]>>
}

interface StepResolution {
  readonly check: PlanningManualStepCheck
  readonly cards: readonly ManualCommandCard[]
  readonly review?: PlanningManualReviewRequest
}

interface BoundCard {
  readonly card: ManualCommandCard
  readonly arguments: readonly PlanningManualArgumentBinding[]
  readonly compatibility: 'supported' | 'unknown'
}

/** Resolve each semantic query against the complete pinned Manual, then verify its exact input overload. */
export function checkPlanningManual(
  plan: MathPlanningPlanV1,
  options: PlanningManualCheckOptions,
): PlanningManualCheck {
  const index = options.index ?? OFFICIAL_GGB_MANUAL_INDEX
  const kinds = new Map(plan.objects.map(object => [object.objectId, object.kind]))
  const decisions = new Map((options.reviewDecisions ?? []).map(item => [item.stepId, item]))
  const resolutions = plan.steps.map(step => resolveStep(
    step, kinds, options.queries[step.stepId], decisions.get(step.stepId),
    options.participants?.[step.stepId] ?? [], index, options.scalarCounts?.[step.stepId] ?? 0,
    options.orderedArguments?.[step.stepId],
  ))
  const checks = resolutions.map(item => item.check)
  const cards = uniqueCards(resolutions.flatMap(item => item.cards)).slice(0, 24)
  return {
    status: aggregateStatus(checks, resolutions),
    stepChecks: checks,
    reviewRequests: resolutions.flatMap(item => item.review === undefined ? [] : [item.review]),
    context: [renderManualContext(cards, index.source.commit), renderStepChecks(checks)].filter(Boolean).join('\n\n'),
    signatureIds: cards.map(card => card.id),
    sourceCommit: index.source.commit,
  }
}

function resolveStep(
  step: MathPlanningPlanV1['steps'][number],
  kinds: ReadonlyMap<string, string>,
  query: PlanningManualQuery | undefined,
  decision: PlanningManualReviewDecision | undefined,
  participants: readonly PlanningManualParticipant[],
  index: ManualCommandIndex,
  declaredScalars = 0,
  orderedArguments?: readonly PlanningManualInputArgument[],
): StepResolution {
  const participantMap = new Map(participants.map(item => [item.objectId, item]))
  const objectInputs = step.inputs.map(objectId => {
    const semanticRole = participantMap.get(objectId)?.role
    return { kind: 'object' as const, objectId, valueKind: kinds.get(objectId) ?? 'unknown',
      ...(semanticRole === undefined ? {} : { semanticRole }) }
  })
  const commandInputs = orderedArguments ?? objectInputs
  const complete = orderedArguments === undefined || (orderedArguments.length === objectInputs.length + declaredScalars
    && step.inputs.every(id => orderedArguments.some(arg => arg.kind === 'object' && arg.objectId === id))
    && orderedArguments.every(arg => arg.kind === 'number' ? Number.isFinite(arg.value) : kinds.get(arg.objectId) === arg.valueKind))
  const objectInputKinds = objectInputs.map(input => input.valueKind)
  const outputKind = step.output === null ? null : kinds.get(step.output) ?? 'unknown'
  if (query?.mode === 'not_required') {
    return notRequired(step, objectInputKinds, outputKind, query, decision, participants)
  }
  if (query === undefined) return failedResolution(step, 'missing_plan_input', objectInputKinds, outputKind,
    'structured manualQuery', 'query missing from Semantic Plan')
  // A step that produces no object cannot execute a construction overload. Whatever command it named
  // is a presentation command, and presentation capability belongs to the caller's own reviewed style
  // route, which reads the pinned index directly. This layer therefore keeps the step open by name
  // instead of synthesising a lookup the step could never bind.
  if (outputKind === null) {
    return noOverload(step, query, objectInputKinds, outputKind, retrieveCards(query, index), decision, participants)
  }
  // A step that froze a value may only bind an overload with room for it, so the two-point variadic
  // `Polygon` is not an addressable candidate for `Polygon(A, B, 6)`.
  const carriesValues = (card: ManualCommandCard): boolean =>
    hasRoomForValues(card, objectInputs.length, declaredScalars)
  const namedCards = hintedCards(query, index)
  const hinted = namedCards.filter(carriesValues)
  const hintedMatches = hinted.flatMap(card => complete ? bindCard(card, commandInputs) : [])
  const retrieved = retrieveCards(query, index).filter(carriesValues)
  const hintCommandCorroborated = hinted.some(card => queryCorroboratesCommand(query, card.command))
  const supportedHints = hintedMatches.filter(match => match.compatibility === 'supported')
  const hintCorroborated = supportedHints.length === 1
    && (orderedArguments !== undefined || (queryCorroboratesCommand(query, supportedHints[0]!.card.command)
      && participantsCorroborated(query, participants)
      && !hasPotentialScalarOverload(hinted, supportedHints[0]!.card, objectInputs, query)))
  // A `commandHints` entry is the Plan's own frozen construction choice, so it is the only command this
  // step may bind. Cross-command retrieval used to widen the set the moment the prose did not spell the
  // command out — "rotating" does not contain "rotate", and a Chinese instruction contains neither — so
  // a step that froze `Rotate` was handed `Midpoint`, which binds the same two points and therefore
  // looked like the legal repair (FIX-03). Another command is still worth naming as a Plan revision,
  // but it can never be a binding for this step; same-command overloads stay as the repair evidence.
  const candidates = hintCorroborated ? [supportedHints[0]!.card]
    : query.commandHints.length > 0 ? hinted
      : retrieved
  const matches = candidates.flatMap(card => complete ? bindCard(card, commandInputs) : [])
  const inputKinds = objectInputs.map(input => input.valueKind)
  // The Plan froze a command the pinned Manual does not document at all. Nothing can bind and no
  // overload is missing, so naming the frozen command is the whole repair. Widening to retrieval here
  // was the same defect as the spelling gate: a misspelled `Rotate` came back as a `Midpoint` binding.
  if (query.commandHints.length > 0 && namedCards.length === 0) {
    return { check: stepCheck({ stepId: step.stepId, status: 'manual_not_found', inputKinds,
      outputKind, command: query.commandHints.join(', '), reasonCode: 'command_not_found',
      declaredScalarCount: declaredScalars, matchedSignatureIds: [],
      expected: `a command documented in the pinned Manual; the Plan froze ${query.commandHints.join(', ')}`,
      actual: `command not found in the pinned Manual: ${query.commandHints.join(', ')}` }), cards: [] }
  }
  // Command existence is independent of arity and scalar capacity. Keep the same-command
  // signatures as evidence even when none can carry the submitted values.
  if (namedCards.length > 0 && hinted.length === 0) {
    return argumentMismatch(step, inputKinds, outputKind, namedCards, declaredScalars)
  }
  if (hintCommandCorroborated && hintedMatches.length === 0) {
    return noOverload(step, query, inputKinds, outputKind, hinted, decision, participants, declaredScalars)
  }
  if (matches.length === 0) {
    return noOverload(step, query, inputKinds, outputKind, candidates, decision, participants, declaredScalars)
  }
  return reviewedResolution(step, query, inputKinds, outputKind, participants, matches, decision,
    hintCorroborated, hinted)
}

/** Diagnose only signature shape/type contradictions; scalar ordering and semantic roles stay open. */
function argumentMismatch(step: MathPlanningPlanV1['steps'][number], inputKinds: readonly string[],
  outputKind: string | null, cards: readonly ManualCommandCard[], declaredScalars: number): StepResolution {
  const count = inputKinds.length + declaredScalars
  const shapes = cards.flatMap(card => {
    const parameters = expandedParameterTypes(card, count)
    return parameters === null ? [] : [parameters]
  })
  const typeContradicted = declaredScalars === 0 && shapes.length > 0 && shapes.every(parameters =>
    inputKinds.some((valueKind, index) => sourceCompatibility({ kind: 'object', valueKind }, parameters[index]!) === 'contradicted'))
  const reasonCode = shapes.length === 0 ? 'argument_count_mismatch' as const
    : typeContradicted ? 'argument_type_mismatch' as const : 'argument_binding_mismatch' as const
  return { check: stepCheck({ stepId: step.stepId, status: 'missing_plan_input',
    command: uniqueCommands(cards).join('|'), reasonCode, declaredScalarCount: declaredScalars,
    inputKinds, outputKind, matchedSignatureIds: cards.map(card => card.id),
    expected: cards.map(card => card.signature).join(' | '),
    actual: `${reasonCode}: declared object types (${inputKinds.join(', ')});`
      + ` scalar values ${String(declaredScalars)}; total arguments ${String(count)}.`
      + (reasonCode === 'argument_binding_mismatch'
        ? cards.every(card => !hasRoomForValues(card, inputKinds.length, declaredScalars))
          ? ' No same-command signature can consume all declared scalar values.'
          : ' Complete ordered binding is not established; semantic roles are unverified.'
        : typeContradicted ? shapes.map(parameters => parameters.flatMap((parameter, index) =>
          sourceCompatibility({ kind: 'object', valueKind: inputKinds[index]! }, parameter) === 'contradicted'
            ? [`argument ${String(index + 1)}: expected <${parameter}>, received ${inputKinds[index]}`] : []).join('; '))
          .join(' | ') : '') }), cards }
}

function notRequired(
  step: MathPlanningPlanV1['steps'][number],
  inputKinds: readonly string[],
  outputKind: string | null,
  query: Extract<PlanningManualQuery, { readonly mode: 'not_required' }>,
  decision: PlanningManualReviewDecision | undefined,
  participants: readonly PlanningManualParticipant[],
): StepResolution {
  const valid = query.reason === 'presentation' ? step.output === null
    : query.reason === 'direct_equation' ? step.inputs.length === 0
      && ['line', 'conic', 'curve', 'circle'].includes(outputKind ?? '')
      // A structured equation is the frozen fact; prose is only the fallback for callers that state no
      // equation of their own.
      && (query.equation === undefined ? containsEquation(`${step.instruction} ${step.expectedResult}`)
        : containsEquation(query.equation))
    : query.reason === 'free_layout' ? step.inputs.length === 0 && ['point', 'slider'].includes(outputKind ?? '')
    : step.inputs.length === 0 && ['point', 'slider'].includes(outputKind ?? '')
  // The existing typed coordinate operation accepts constants and slider expressions, not geometric
  // object operands. Its expression values are checked by Program; model prose grants no authority.
  const localCoordinates = outputKind === 'point' && inputKinds.every(kind => kind === 'slider')
  if (!valid && (!localCoordinates || decision?.status === 'no_match')) {
    return failedResolution(step, 'missing_plan_input', inputKinds, outputKind,
      `valid ${query.reason} skip`, 'no verified local operation for the declared output and operands')
  }
  if (!valid && decision?.status !== 'skip_valid') {
    const check = stepCheck({ stepId: step.stepId, status: 'manual_skip_unverified', inputKinds, outputKind,
      matchedSignatureIds: [], expected: `valid ${query.reason} skip`,
      actual: 'local shortcut cannot prove that Manual lookup is unnecessary' })
    if (decision?.status === 'ambiguous') return { check, cards: [] }
    return { check, cards: [], review: reviewRequest(
      'skip', step, query, inputKinds, outputKind, participants, [],
    ) }
  }
  return { check: stepCheck({ stepId: step.stepId, status: 'manual_not_required', inputKinds, outputKind,
    matchedSignatureIds: [], expected: `validated ${query.reason}`,
    actual: valid ? 'manual overload not required' : 'local coordinate operation verified' }), cards: [] }
}

function noOverload(
  step: MathPlanningPlanV1['steps'][number],
  query: PlanningManualQuery,
  inputKinds: readonly string[],
  outputKind: string | null,
  candidates: readonly ManualCommandCard[],
  decision: PlanningManualReviewDecision | undefined,
  participants: readonly PlanningManualParticipant[],
  declaredScalars = 0,
): StepResolution {
  if (candidates.length === 0) return failedResolution(step, 'manual_not_found', inputKinds, outputKind,
    'matching command in pinned Manual', query.mode === 'lookup' ? query.intent : query.reason)
  const cards = candidates
  if (decision?.status === 'no_match') return failedResolution(step, 'missing_plan_input', inputKinds, outputKind,
    cards.map(card => card.signature).join(' | '), decision.reason, cards)
  const mismatch = argumentMismatch(step, inputKinds, outputKind, cards, declaredScalars).check
  const check = stepCheck({ ...mismatch, stepId: step.stepId, status: 'manual_candidate_unbound',
    command: uniqueCommands(cards).join('|'), inputKinds, outputKind, matchedSignatureIds: [],
    expected: cards.map(card => card.signature).join(' | '),
    actual: mismatch.actual })
  const evidencedCheck = { ...check, matchedSignatureIds: cards.map(card => card.id) }
  if (decision?.status === 'ambiguous') {
    return { check: evidencedCheck, cards }
  }
  return { check: evidencedCheck, cards, review: reviewRequest(
    'overload_gap', step, query, inputKinds, outputKind, participants,
    cards.map(card => ({ card, arguments: [], compatibility: 'unknown' })),
  ) }
}

function reviewedResolution(
  step: MathPlanningPlanV1['steps'][number],
  query: PlanningManualQuery,
  inputKinds: readonly string[],
  outputKind: string | null,
  participants: readonly PlanningManualParticipant[],
  matches: readonly BoundCard[],
  decision: PlanningManualReviewDecision | undefined,
  exactHint: boolean,
  hinted: readonly ManualCommandCard[],
): StepResolution {
  const candidates = [...matches].sort((left, right) =>
    bindingSemanticScore(right, query) - bindingSemanticScore(left, query))
  if (decision?.status === 'selected') {
    const sameSignature = candidates.filter(candidate => candidate.card.id === decision.selectedSignatureId)
    const selected = decision.arguments === undefined
      ? sameSignature.length === 1 ? sameSignature[0] : undefined
      : sameSignature.find(candidate => bindingsEqual(candidate.arguments, decision.arguments ?? []))
    if (selected !== undefined) return selectedResolution(step, inputKinds, outputKind, selected, decision.resultIndex)
  }
  if (decision === undefined && exactHint && candidates.length === 1) {
    return selectedResolution(step, inputKinds, outputKind, candidates[0]!, undefined)
  }
  if (decision !== undefined) return failedResolution(step,
    decision.status === 'no_match' ? 'semantic_role_mismatch' : 'manual_ambiguous', inputKinds, outputKind,
    'one supplied Manual signature and ordered binding', decision.reason,
    candidates.map(candidate => candidate.card))
  const review = reviewRequest('binding', step, query, inputKinds, outputKind, participants, candidates)
  const boundIds = new Set(candidates.map(candidate => candidate.card.id))
  const commands = new Set(candidates.map(candidate => candidate.card.command))
  const relatedSignatures = hinted.filter(card => commands.has(card.command) && !boundIds.has(card.id))
    .slice(0, 12).map(card => ({ signatureId: card.id, signature: card.signature,
      description: card.description }))
  return { check: stepCheck({ stepId: step.stepId, status: 'manual_ambiguous', inputKinds, outputKind,
    matchedSignatureIds: candidates.map(candidate => candidate.card.id), expected: 'one ordered overload binding selected by bounded review',
    actual: `${String(candidates.length)} arity-compatible ordered bindings requiring semantic review` }),
    cards: candidates.map(candidate => candidate.card),
    review: relatedSignatures.length === 0 ? review : { ...review, relatedSignatures } }
}

function bindingSemanticScore(bound: BoundCard, query: PlanningManualQuery): number {
  if (query.mode !== 'lookup') return 0
  const evidence = normalizeText(`${query.intent} ${query.keywords.join(' ')} ${bound.card.description}`)
  return bound.arguments.reduce((score, argument) => {
    if (argument.kind !== 'object' || argument.semanticRole === undefined) return score
    const terms = normalizeText(argument.semanticRole).split(' ').filter(term => term.length > 2)
    return score + terms.reduce((total, term) => total + (evidence.includes(term) ? 1 : 0), 0)
  }, 0)
}

function selectedResolution(
  step: MathPlanningPlanV1['steps'][number],
  inputKinds: readonly string[],
  outputKind: string | null,
  bound: BoundCard,
  resultIndex: number | undefined,
): StepResolution {
  const { card } = bound
  const supported = outputKind !== null && isDeclarativeManualCommand(card.command)
  return { check: stepCheck({ stepId: step.stepId, status: supported ? 'passed' : 'missing_capability',
    command: card.command, inputKinds, outputKind, matchedSignatureIds: [card.id], arguments: bound.arguments,
    ...(resultIndex === undefined ? {} : { resultIndex }),
    expected: supported ? card.signature : 'runtime capability for selected Manual signature',
    actual: supported ? `${card.command}(${inputKinds.join(', ')})`
      : `native ${card.signature}; command is not eligible for declarative execution` }), cards: [card] }
}

function failedResolution(
  step: MathPlanningPlanV1['steps'][number],
  status: 'manual_not_found' | 'manual_ambiguous' | 'missing_plan_input' | 'semantic_role_mismatch',
  inputKinds: readonly string[],
  outputKind: string | null,
  expected: string,
  actual: string,
  cards: readonly ManualCommandCard[] = [],
): StepResolution {
  return { check: stepCheck({ stepId: step.stepId, status, inputKinds, outputKind,
    matchedSignatureIds: cards.map(card => card.id), expected, actual }), cards }
}

function reviewRequest(
  reviewKind: PlanningManualReviewRequest['reviewKind'],
  step: MathPlanningPlanV1['steps'][number],
  query: PlanningManualQuery,
  inputKinds: readonly string[],
  outputKind: string | null,
  participants: readonly PlanningManualParticipant[],
  candidates: readonly BoundCard[],
): PlanningManualReviewRequest {
  return { reviewKind, stepId: step.stepId, dependsOnStepIds: step.dependsOn,
    instruction: step.instruction,
    expectedResult: step.expectedResult, query, inputKinds, outputKind, participants,
    candidates: candidates.map(toReviewCandidate) }
}

function hintedCards(
  query: Extract<PlanningManualQuery, { readonly mode: 'lookup' }>,
  index: ManualCommandIndex,
): readonly ManualCommandCard[] {
  const normalized = new Set(query.commandHints.map(hint => hint.toLowerCase()))
  return index.cards.filter(card => normalized.has(card.command.toLowerCase()))
}

/** Keep exact-hint fast path only when another same-command overload cannot consume one missing scalar. */
function hasPotentialScalarOverload(
  cards: readonly ManualCommandCard[],
  selected: ManualCommandCard,
  inputs: readonly { readonly kind: 'object'; readonly valueKind: string }[],
  query: Extract<PlanningManualQuery, { readonly mode: 'lookup' }>,
): boolean {
  const evidence = normalizeText(`${query.intent} ${query.keywords.join(' ')}`)
  return cards.some(card => {
    if (card.id === selected.id || card.command !== selected.command
      || card.parameterTypes.length !== inputs.length + 1) return false
    const last = normalizeManualType(card.parameterTypes[inputs.length]!)
    const scalarNamed = normalizeText(card.parameterTypes[inputs.length]!).split(' ')
      .some(term => term.length > 3 && evidence.includes(term))
    return isNumericManualType(last) && scalarNamed && inputs.every((input, index) =>
      sourceCompatibility(input, card.parameterTypes[index]!) !== 'contradicted')
  })
}

/**
 * True when an overload has room for the step's object inputs plus its frozen values.
 *
 * Only the counts are known here, not which positions the caller's values take (`Rotate` states its
 * angle between two points), so this asks the shape question the matcher can answer: the overload
 * must accept that many arguments and own at least that many numeric roles. Which role each value
 * fills is the caller's own typed path to prove.
 */
function hasRoomForValues(card: ManualCommandCard, objectCount: number, valueCount: number): boolean {
  if (valueCount === 0) return true
  const parameters = expandedParameterTypes(card, objectCount + valueCount)
  if (parameters === null) return false
  return parameters.filter(type => isNumericManualType(normalizeManualType(type))).length >= valueCount
}

function bindCard(
  card: ManualCommandCard,
  sources: readonly PlanningManualInputArgument[],
): readonly BoundCard[] {
  const parameters = expandedParameterTypes(card, sources.length)
  if (parameters === null) return []
  const compatibility = sources.map((source, index) => sourceCompatibility(source, parameters[index]!))
  if (compatibility.includes('contradicted')) return []
  const argumentsValue = sources.map((source, index): PlanningManualArgumentBinding => {
    const parameterType = parameters[index]!
    return source.kind === 'object'
      ? { kind: 'object', objectId: source.objectId, parameterType,
          ...(source.semanticRole === undefined ? {} : { semanticRole: source.semanticRole }) }
      : { kind: 'number', value: source.value, parameterType }
  })
  return [{ card, arguments: argumentsValue,
    compatibility: compatibility.every(item => item === 'supported') ? 'supported' : 'unknown' }]
}

function expandedParameterTypes(card: ManualCommandCard, count: number): readonly string[] | null {
  if (card.arity !== undefined && (count < card.arity.min
    || (card.arity.max !== null && count > card.arity.max))) return null
  if (!card.signature.includes('...')) return card.parameterTypes.length === count ? card.parameterTypes : null
  if (card.parameterTypes.length === 0 || count < card.parameterTypes.length) return null
  const ellipsis = card.signature.indexOf('...')
  const prefixCount = (card.signature.slice(0, ellipsis).match(/</g) ?? []).length
  const suffixCount = (card.signature.slice(ellipsis + 3).match(/</g) ?? []).length
  if (prefixCount < 1 || prefixCount + suffixCount !== card.parameterTypes.length) return null
  return [...card.parameterTypes.slice(0, prefixCount),
    ...Array.from({ length: count - card.parameterTypes.length }, () => card.parameterTypes[prefixCount - 1]!),
    ...card.parameterTypes.slice(prefixCount)]
}

function sourceCompatibility(
  source: { readonly kind: 'object'; readonly valueKind: string; readonly semanticRole?: string }
    | { readonly kind: 'number'; readonly value: number },
  parameterType: string,
): 'supported' | 'contradicted' | 'unknown' {
  const expected = normalizeManualType(parameterType)
  if (source.kind === 'number') return isNumericManualType(expected) ? 'supported'
    : ['point', 'line', 'segment', 'vector', 'circle', 'conic', 'curve', 'polygon', 'plane'].includes(expected)
      ? 'contradicted' : 'unknown'
  const actual = normalizeManualType(source.valueKind)
  if (expected === 'object') return actual === 'object' ? 'unknown' : 'supported'
  if (actual === expected || expected.includes(actual)) return 'supported'
  if (expected === 'conic' && actual === 'circle') return 'supported'
  if (expected === 'direction' && ['line', 'segment', 'vector', 'plane'].includes(actual)) return 'supported'
  const stableKinds = new Set(['point', 'line', 'segment', 'vector', 'circle', 'conic', 'curve', 'polygon', 'plane'])
  if (isNumericManualType(expected)) {
    if (actual === 'slider') return 'supported'
    if (stableKinds.has(actual)) return 'contradicted'
  }
  return stableKinds.has(expected) && stableKinds.has(actual) ? 'contradicted' : 'unknown'
}

function isNumericManualType(value: string): boolean {
  return ['number', 'numeric', 'integer', 'parameter', 'radius', 'angle', 'count', 'value']
    .some(token => value.includes(token))
}

function bindingsEqual(
  left: readonly PlanningManualArgumentBinding[],
  right: readonly PlanningManualArgumentBinding[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function retrieveCards(
  query: Extract<PlanningManualQuery, { readonly mode: 'lookup' }>,
  index: ManualCommandIndex,
): readonly ManualCommandCard[] {
  const terms = searchTerms(query)
  return index.cards.map(card => ({ card, score: cardScore(card, terms) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.card.signature.localeCompare(right.card.signature))
    .slice(0, 24).map(item => item.card)
}

function searchTerms(query: Extract<PlanningManualQuery, { readonly mode: 'lookup' }>): readonly string[] {
  return [...new Set([query.intent, ...query.keywords, ...query.commandHints]
    .flatMap(value => normalizeText(value).split(' ')).filter(term => term.length > 1))]
}

function queryCorroboratesCommand(
  query: Extract<PlanningManualQuery, { readonly mode: 'lookup' }>,
  command: string,
): boolean {
  const evidence = normalizeText(`${query.intent} ${query.keywords.join(' ')}`)
  return normalizeText(splitCommandName(command)).split(' ').every(term => evidence.includes(term))
}

function participantsCorroborated(
  query: Extract<PlanningManualQuery, { readonly mode: 'lookup' }>,
  participants: readonly PlanningManualParticipant[],
): boolean {
  const evidence = normalizeText(`${query.intent} ${query.keywords.join(' ')}`)
  return participants.every(participant => normalizeText(participant.role).split(' ')
    .filter(term => term.length > 3).some(term => evidence.includes(term)))
}

function cardScore(card: ManualCommandCard, terms: readonly string[]): number {
  const command = normalizeText(splitCommandName(card.command))
  const signature = normalizeText(card.signature)
  const body = normalizeText(`${card.description} ${card.sourcePath}`)
  return terms.reduce((score, term) => score + (command === term ? 40 : command.includes(term) ? 20 : 0)
    + (signature.includes(term) ? 8 : 0) + (body.includes(term) ? 3 : 0), 0)
}

function splitCommandName(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function normalizeText(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function normalizeManualType(value: string): string {
  return normalizeText(value.replaceAll('xref:', '').replaceAll('.adoc', '')).replaceAll(' ', '')
}

/**
 * The one aggregate rule. Exported because a caller that resolves steps the matcher left open (the
 * application's controlled-path resolver) has to re-derive the status from the same sentences: with two
 * owners, one view could report `passed` while the other still held an open request.
 */
export function planningManualAggregateStatus(checks: readonly PlanningManualStepCheck[],
  reviewRequestCount: number): PlanningManualCheck['status'] {
  if (reviewRequestCount > 0) return 'needs_review'
  if (checks.some(check => ['missing_plan_input', 'semantic_role_mismatch'].includes(check.status))) {
    return 'needs_revision'
  }
  if (checks.some(check => ['manual_not_found', 'missing_capability'].includes(check.status))) {
    return 'blocked'
  }
  return 'passed'
}

function aggregateStatus(
  checks: readonly PlanningManualStepCheck[],
  resolutions: readonly StepResolution[],
): PlanningManualCheck['status'] {
  return planningManualAggregateStatus(checks, resolutions.filter(item => item.review !== undefined).length)
}

function uniqueCards(cards: readonly ManualCommandCard[]): ManualCommandCard[] {
  return [...new Map(cards.map(card => [card.id, card])).values()]
}

function uniqueCommands(cards: readonly ManualCommandCard[]): string[] {
  return [...new Set(cards.map(card => card.command))]
}

function toReviewCandidate(bound: BoundCard): PlanningManualCandidate {
  const { card } = bound
  return { signatureId: card.id, command: card.command, signature: card.signature,
    description: card.description, arguments: bound.arguments }
}

function containsEquation(text: string): boolean {
  return /[xy][^=]{0,128}=/iu.test(text) || /=.{0,128}[xy]/iu.test(text)
}

function stepCheck(input: PlanningManualStepCheck): PlanningManualStepCheck {
  return input
}

function renderStepChecks(checks: readonly PlanningManualStepCheck[]): string {
  return ['BEGIN_TRUSTED_LOCAL_MANUAL_CHECK', JSON.stringify(checks), 'END_TRUSTED_LOCAL_MANUAL_CHECK'].join('\n')
}

function renderManualContext(cards: readonly ManualCommandCard[], sourceCommit: string): string {
  if (cards.length === 0) return ''
  return [
    'BEGIN_UNTRUSTED_GGB_MANUAL_REFERENCE',
    `Official GeoGebra Manual source commit: ${sourceCommit}`,
    ...cards.map(card => `- [${card.id}] ${card.signature}${card.description.length === 0 ? '' : ` — ${card.description}`}`),
    'END_UNTRUSTED_GGB_MANUAL_REFERENCE',
    'Only the pinned signature IDs are eligible; runtime capability is checked separately.',
  ].join('\n')
}

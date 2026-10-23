import { z } from 'zod'
import { sliderSpecV1Schema } from '@ggb-copilot/geometry-contract'

/** Reviewed knowledge corpora that an Intake decision may request. */
export const allowedCorpusIdSchema = z.enum([
  'construction_patterns', 'solved_tasks', 'ggb_manual_commands', 'failure_guidance',
])
export type AllowedCorpusId = z.infer<typeof allowedCorpusIdSchema>

/** Product-level user intent produced by the single multimodal Intake stage. */
export const userIntentV1Schema = z.enum([
  'construct', 'modify_canvas', 'explain', 'inspect_canvas', 'clarify', 'unsupported',
])
export type UserIntentV1 = z.infer<typeof userIntentV1Schema>

const uncertaintyV1Schema = z.object({
  parameter: z.string().trim().min(1).max(200),
  classification: z.enum(['safe_parameterization', 'geometric_freedom', 'requires_clarification']),
  reason: z.string().trim().min(1).max(500).optional(),
  slider: sliderSpecV1Schema.optional(),
}).strict().superRefine((value, context): void => {
  const slider = value.slider
  if (value.classification !== 'safe_parameterization' && slider !== undefined) {
    context.addIssue({ code: 'custom', path: ['slider'],
      message: 'only a missing numeric parameter may propose a slider' })
    return
  }
})

const orderedGoalV1Schema = z.object({
  goalId: z.string().regex(/^g[1-9][0-9]{0,2}$/),
  description: z.string().trim().min(1).max(1_024),
  dependsOn: z.array(z.string().regex(/^g[1-9][0-9]{0,2}$/)).max(16),
}).strict()

const constraintV1Schema = z.object({
  name: z.string().trim().min(1).max(200),
  value: z.union([z.string().max(1_000), z.number().finite(), z.boolean()]),
  source: z.enum(['user_text', 'image', 'canvas', 'product_default']),
  certainty: z.enum(['explicit', 'inferred']),
}).strict()

const ambiguityV1Schema = z.object({
  phrase: z.string().trim().min(1).max(500),
  kind: z.enum(['missing_value', 'parameter_target_unknown', 'reference_unknown', 'relation_unknown', 'unreadable']),
  blocking: z.boolean(),
  question: z.string().trim().min(1).max(2_000).optional(),
}).strict()

/** One normalized Task Brief and bounded product routing decision. */
export const agentIntakeDecisionV2Schema = z.object({
  schemaVersion: z.literal(2),
  imageTranscription: z.string().trim().max(20_000).optional(),
  status: z.enum(['ready', 'needs_clarification', 'unsupported']),
  restatedRequest: z.string().trim().min(1).max(16_414),
  orderedGoals: z.array(orderedGoalV1Schema).max(32),
  constraints: z.array(constraintV1Schema).max(32),
  ambiguities: z.array(ambiguityV1Schema).max(16),
  unreadableParts: z.array(z.string().trim().min(1).max(500)).max(16),
  intent: userIntentV1Schema,
  /** Whether the user also requested a teaching explanation alongside construction. */
  explanationRequested: z.boolean().optional(),
  /** Deprecated input-only compatibility field. Planning owns complexity classification. */
  complexity: z.enum(['simple', 'complex']).optional(),
  retrieval: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({
      kind: z.literal('search'),
      corpusIds: z.array(allowedCorpusIdSchema).min(1).max(4),
      query: z.string().trim().min(1).max(2_000),
    }).strict(),
  ]),
  requiresCanvasObservation: z.boolean(),
  uncertainties: z.array(uncertaintyV1Schema).max(16),
  clarificationQuestion: z.string().trim().max(2_000).optional(),
}).strict().superRefine(validateTaskBrief)

export type AgentIntakeDecisionV2 = z.infer<typeof agentIntakeDecisionV2Schema>

function validateTaskBrief(value: AgentIntakeDecisionV2, context: z.RefinementCtx): void {
  validateGoalOrder(value, context)
  const blockingAmbiguity = value.ambiguities.some(item => item.blocking)
  const blocking = blockingAmbiguity
    || value.uncertainties.some(item => item.classification === 'requires_clarification')
  if (value.status === 'ready' && (blocking || value.clarificationQuestion !== undefined)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'ready task must have no blocking ambiguity or question' })
  }
  if (value.status === 'needs_clarification' && (!blocking || value.clarificationQuestion === undefined)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'clarification requires a blocking ambiguity and question' })
  }
  if ((value.intent === 'construct' || value.intent === 'modify_canvas')
    && value.status === 'ready' && value.orderedGoals.length === 0) {
    context.addIssue({ code: 'custom', path: ['orderedGoals'], message: 'ready geometry task requires ordered goals' })
  }
  if ((value.intent === 'unsupported') !== (value.status === 'unsupported')) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'unsupported intent and status must agree' })
  }
  if (value.intent === 'clarify' && value.status !== 'needs_clarification') {
    context.addIssue({ code: 'custom', path: ['status'], message: 'clarify intent requires clarification status' })
  }
}

function validateGoalOrder(value: AgentIntakeDecisionV2, context: z.RefinementCtx): void {
  const seen = new Set<string>()
  value.orderedGoals.forEach((goal, index): void => {
    if (seen.has(goal.goalId)) {
      context.addIssue({ code: 'custom', path: ['orderedGoals', index, 'goalId'], message: 'goal id must be unique' })
    }
    for (const dependency of goal.dependsOn) {
      if (!seen.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['orderedGoals', index, 'dependsOn'], message: 'dependency must name an earlier goal' })
      }
    }
    seen.add(goal.goalId)
  })
}

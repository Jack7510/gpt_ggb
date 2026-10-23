import { z } from 'zod'

/** Pure native operations available to bounded verification programs, not a catalogue of claims. */
export const VERIFICATION_PRIMITIVES_V1 = {
  Distance: { result: 'number', arguments: ['point', 'path'], signature: 'Distance( <Point>, <Object> )' },
  AreEqual: { result: 'boolean', arguments: ['object', 'object'], signature: 'AreEqual( <Object>, <Object> )' },
  Midpoint: { result: 'point', arguments: ['point', 'point'], signature: 'Midpoint( <Point>, <Point> )' },
} as const
const reference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subject'), index: z.number().int().min(0).max(3) }).strict(),
  z.object({ kind: z.literal('result'), index: z.number().int().min(0).max(7) }).strict(),
])
export const verificationProgramV1Schema = z.object({
  calls: z.array(z.object({ command: z.enum(['Distance', 'AreEqual', 'Midpoint']),
    arguments: z.array(reference).length(2) }).strict()).min(1).max(8),
  result: z.object({ index: z.number().int().min(0).max(7),
    test: z.enum(['boolean', 'zero', 'equals_expected']) }).strict(),
}).strict().superRefine((program, context) => {
  for (const [i, call] of program.calls.entries()) {
    if (call.arguments.some(arg => arg.kind === 'result' && arg.index >= i)) {
      context.addIssue({ code: 'custom', message: 'verification_forward_or_self_reference' })
    }
    if (JSON.stringify(call.arguments[0]) === JSON.stringify(call.arguments[1])) {
      context.addIssue({ code: 'custom', message: 'verification_identical_operands' })
    }
  }
  const needed = new Set([program.result.index])
  for (let i = program.calls.length - 1; i >= 0; i--) {
    if (!needed.has(i)) continue
    for (const arg of program.calls[i]!.arguments) if (arg.kind === 'result') needed.add(arg.index)
  }
  if (program.calls.some((_, i) => !needed.has(i))) {
    context.addIssue({ code: 'custom', message: 'verification_unused_call' })
  }
  if (program.result.index !== program.calls.length - 1) {
    context.addIssue({ code: 'custom', message: 'verification_result_must_be_last_call' })
  }
})
export type VerificationProgramV1 = z.infer<typeof verificationProgramV1Schema>
export const VERIFICATION_PROGRAM_METHOD_V1 = 'geogebra-verification-program-v1'

export interface VerificationProgramIssueV1 {
  readonly code: string
  readonly path: string
  readonly expected: string
  readonly actual: string
}

/** Explain each invalid operand/result without changing the frozen condition. */
export function verificationProgramDetailsV1(program: VerificationProgramV1,
  subjects: readonly string[], expected: string | number | boolean, scope: string): VerificationProgramIssueV1[] {
  const parsed = verificationProgramV1Schema.safeParse(program)
  if (!parsed.success) return parsed.error.issues.map(issue => ({ code: 'verification_program_invalid',
    path: issue.path.join('.'), expected: issue.message, actual: 'invalid program' }))
  if (scope !== 'single_observation') return [{ code: 'verification_scope_not_supported',
    path: '', expected: 'single_observation', actual: scope }]
  const issues: VerificationProgramIssueV1[] = []
  const types: string[] = []
  const dependencies: Set<number>[] = []
  for (const [callIndex, call] of parsed.data.calls.entries()) {
    const primitive = VERIFICATION_PRIMITIVES_V1[call.command]
    const deps = new Set<number>()
    call.arguments.forEach((arg, i) => {
      const actual = arg.kind === 'subject' ? subjects[arg.index] : types[arg.index]
      if (arg.kind === 'subject') deps.add(arg.index)
      else dependencies[arg.index]?.forEach(index => deps.add(index))
      const required = primitive.arguments[i]
      const fits = required === 'object' ? actual !== undefined && ['point', 'line', 'segment', 'ray', 'vector', 'circle', 'conic', 'curve', 'polygon', 'plane', 'sphere'].includes(actual)
        : required === 'path' ? actual !== undefined && ['point', 'line', 'segment', 'ray', 'circle', 'conic'].includes(actual)
          : actual === required
      if (!fits) issues.push({ code: 'verification_argument_type_mismatch', path: `calls.${callIndex}.arguments.${i}`,
        expected: `${call.command} argument ${i + 1}: ${required}`, actual: `${arg.kind} ${arg.index}: ${actual ?? 'absent'}` })
    })
    types.push(primitive.result)
    dependencies.push(deps)
  }
  const output = types[program.result.index]
  const requiredOutput = program.result.test === 'boolean' ? 'boolean' : 'number'
  if (output !== requiredOutput) issues.push({ code: 'verification_result_type_mismatch', path: 'result.index',
    expected: `${program.result.test} reads ${requiredOutput}`, actual: `result ${program.result.index}: ${output ?? 'absent'}` })
  const requiredExpected = program.result.test === 'equals_expected' ? 'number' : 'boolean'
  if (typeof expected !== requiredExpected) issues.push({ code: 'verification_result_type_mismatch', path: 'result.test',
    expected: `${program.result.test} needs frozen expected:${requiredExpected}`, actual: `${JSON.stringify(expected)}:${typeof expected}` })
  const covered = dependencies[program.result.index] ?? new Set<number>()
  for (const [i, type] of subjects.entries()) if (!covered.has(i)) issues.push({ code: 'verification_subject_not_checked',
    path: 'result.index', expected: `transitive dependency on subject ${i}:${type}`, actual: 'subject not checked' })
  return issues
}

/** Code-only capability consumers use the same detailed validator as Plan feedback. */
export function verificationProgramIssuesV1(program: VerificationProgramV1,
  subjects: readonly string[], expected: string | number | boolean, scope: string): string[] {
  return [...new Set(verificationProgramDetailsV1(program, subjects, expected, scope).map(issue => issue.code))]
}

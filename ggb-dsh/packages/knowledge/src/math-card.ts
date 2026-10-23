import { z } from 'zod'

/** A reviewed proposition is teaching data, never an executable construction. */
export const mathKnowledgeCardSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(2).max(200),
  aliases: z.array(z.string().trim().min(2).max(200)).max(12),
  prerequisites: z.array(z.string().trim().min(1).max(500)).min(1).max(16),
  symbols: z.array(z.object({ symbol: z.string().trim().min(1).max(80),
    meaning: z.string().trim().min(1).max(300) }).strict()).min(1).max(24),
  relations: z.array(z.object({
    statement: z.string().trim().min(1).max(800),
    justification: z.string().trim().min(1).max(1_000),
    verification: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('geometry_assertion'), assertionKind: z.enum([
        'exists', 'hasType', 'dependsOn', 'collinear', 'parallel', 'perpendicular', 'equalLength',
        'pointOnLine', 'pointOnCircle', 'pointOnConic', 'pointOnPlane', 'pointOnSphere', 'coplanar', 'midpoint',
        'concurrent', 'tangent', 'length', 'angle', 'dynamicPointOnCircle',
      ]) }).strict(),
      z.object({ kind: z.literal('explanation_only') }).strict(),
    ]),
  }).strict()).min(1).max(16),
  displayRequirements: z.array(z.string().trim().min(1).max(500)).min(1).max(16),
  review: z.object({ status: z.literal('approved'), reviewer: z.string().trim().min(1).max(120),
    reviewedAt: z.iso.datetime({ offset: true }),
    sourceVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/) }).strict(),
}).strict()

export type MathKnowledgeCard = z.infer<typeof mathKnowledgeCardSchema>

export interface MathKnowledgeSource {
  searchMath(query: string, limit: number): readonly MathKnowledgeCard[]
}

/** Select an exact named proposition from a bounded task. Unnamed lexical overlap is insufficient. */
export function selectMathGoal(query: string, source: MathKnowledgeSource): MathKnowledgeCard | undefined {
  const normalized = query.normalize('NFKC').toLowerCase()
  return source.searchMath(query, 5).find(card => [card.name, ...card.aliases]
    .some(name => normalized.includes(name.normalize('NFKC').toLowerCase())))
}

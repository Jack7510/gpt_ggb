import { z } from 'zod'

declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Run identifier minted by the client: `run_` + UUID v4. */
export type RunId = Brand<string, 'RunId'>
export type TransactionId = Brand<string, 'TransactionId'>
export type QuestionId = Brand<string, 'QuestionId'>
export type ArtifactId = Brand<string, 'ArtifactId'>
/** 256-bit CSPRNG capability token, base64url encoded. */
export type RunToken = Brand<string, 'RunToken'>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const runIdSchema = z
  .string()
  .regex(/^run_[0-9a-f-]{36}$/)
  .refine((value) => uuidPattern.test(value.slice(4)), 'runId must embed a UUID')
  .transform((value) => value as RunId)

export const transactionIdSchema = z
  .string()
  .regex(/^tx_[0-9a-f-]{36}$/)
  .refine((value) => uuidPattern.test(value.slice(3)), 'transactionId must embed a UUID')
  .transform((value) => value as TransactionId)

export const questionIdSchema = z
  .string()
  .regex(/^q_[0-9a-f-]{36}$/)
  .refine((value) => uuidPattern.test(value.slice(2)), 'questionId must embed a UUID')
  .transform((value) => value as QuestionId)

export const artifactIdSchema = z
  .string()
  .regex(/^art_[0-9a-f-]{36}$/)
  .refine((value) => uuidPattern.test(value.slice(4)), 'artifactId must embed a UUID')
  .transform((value) => value as ArtifactId)

/** base64url of exactly 32 random bytes (43 chars, no padding). */
export const runTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .transform((value) => value as RunToken)

export function newUuid(random: (size: number) => Uint8Array): string {
  const bytes = random(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function formatRunId(uuid: string): RunId {
  return `run_${uuid}` as RunId
}

export function formatTransactionId(uuid: string): TransactionId {
  return `tx_${uuid}` as TransactionId
}

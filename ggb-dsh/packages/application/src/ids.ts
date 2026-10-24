import { z } from 'zod'

declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Run identifier minted by the client: `run_` + UUID v4. */
export type RunId = Brand<string, 'RunId'>
/** 256-bit CSPRNG capability token, base64url encoded. */
export type RunToken = Brand<string, 'RunToken'>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const runIdSchema = z
  .string()
  .regex(/^run_[0-9a-f-]{36}$/)
  .refine((value) => uuidPattern.test(value.slice(4)), 'runId must embed a UUID')
  .transform((value) => value as RunId)

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

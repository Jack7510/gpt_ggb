import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RunToken } from './ids.js'

/** Generates a 256-bit CSPRNG capability token, base64url encoded (43 chars). */
export function createRunToken(): RunToken {
  return randomBytes(32).toString('base64url') as RunToken
}

/**
 * Server stores only HMAC-SHA-256(serverPepper, runToken) as the verifier.
 * Constant-time comparison is mandatory for verifier checks.
 */
export function runTokenVerifier(runToken: RunToken, serverPepper: string): string {
  return createHmac('sha256', serverPepper).update(runToken).digest('hex')
}

export function verifiersEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    // Still consume a comparison to keep timing flat for wrong-length inputs.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/** sha256 hex of a raw request body; the idempotency digest. */
export function bodyDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

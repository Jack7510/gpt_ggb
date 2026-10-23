import { describe, expect, it } from 'vitest'
import { createRunToken, bodyDigest, runTokenVerifier, verifiersEqual } from '../src/token.js'

describe('run token', () => {
  it('generates 43-char base64url tokens', () => {
    const token = createRunToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('derives a stable verifier per pepper', () => {
    const token = createRunToken()
    expect(runTokenVerifier(token, 'pepper-a')).toBe(runTokenVerifier(token, 'pepper-a'))
    expect(runTokenVerifier(token, 'pepper-a')).not.toBe(runTokenVerifier(token, 'pepper-b'))
  })

  it('compares verifiers in constant time with wrong-length safety', () => {
    const token = createRunToken()
    const verifier = runTokenVerifier(token, 'p')
    expect(verifiersEqual(verifier, verifier)).toBe(true)
    expect(verifiersEqual(verifier, 'short')).toBe(false)
    expect(verifiersEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false)
  })

  it('bodies of different bytes hash differently', () => {
    expect(bodyDigest('a')).not.toBe(bodyDigest('b'))
    expect(bodyDigest('a')).toBe(bodyDigest('a'))
  })
})

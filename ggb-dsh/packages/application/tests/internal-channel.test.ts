import { describe, expect, it } from 'vitest'
import { formatRunId } from '../src/ids.js'
import {
  INTERNAL_CHANNEL_PROTOCOL_VERSION,
  channelPluginCoreCancelRequestSchema,
  channelPluginCoreRequestSchema,
  channelHandshakeRequestSchema,
  isChannelRequestExpired,
  signChannelMessage,
  verifyChannelAuthentication,
  type ChannelHandshakeRequest,
  type ChannelPluginCoreRequest,
} from '../src/internal-channel.js'

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)

function handshakeMessage(): Omit<ChannelHandshakeRequest, 'authentication'> {
  return {
    protocolVersion: INTERNAL_CHANNEL_PROTOCOL_VERSION,
    type: 'handshake',
    requestId: '01234567-89ab-4cde-8f01-23456789abcd',
    issuedAt: '2026-09-19T00:00:00Z',
    nonce: 'nonce-1234567890',
  }
}

function runMessage(): Omit<ChannelPluginCoreRequest, 'authentication'> {
  return {
    type: 'plugin-core.run',
    requestId: 'fedcba98-7654-4321-8fed-cba987654321',
    issuedAt: '2026-09-19T00:00:00Z',
    expiresAt: '2026-09-19T00:01:00Z',
    nonce: 'nonce-1234567890',
    runId: formatRunId('01234567-89ab-4cde-8f01-23456789abcd'),
    credential: { providerKey: 'sk-test-000' },
    prompt: 'draw a circle',
    base: null,
  }
}

describe('internal channel protocol', () => {
  it('signed handshake and plugin-core messages pass their schemas and verify', () => {
    const signedHandshake = signChannelMessage(SECRET, handshakeMessage())
    expect(() => channelHandshakeRequestSchema.parse(signedHandshake)).not.toThrow()
    expect(verifyChannelAuthentication(SECRET, signedHandshake)).toBe(true)

    const signedRun = signChannelMessage(SECRET, runMessage())
    const parsed = channelPluginCoreRequestSchema.parse(signedRun)
    expect(parsed.type).toBe('plugin-core.run')
    expect(parsed).not.toHaveProperty('checkpoint')
    expect(parsed).not.toHaveProperty('image')
    expect(verifyChannelAuthentication(SECRET, signedRun)).toBe(true)

    const withBase = signChannelMessage(SECRET, {
      ...runMessage(),
      base: { dataBase64: 'UEtiYXNl', sha256: 'b'.repeat(64), name: 'base.ggb' },
    })
    expect(channelPluginCoreRequestSchema.parse(withBase).base).toEqual({
      dataBase64: 'UEtiYXNl', sha256: 'b'.repeat(64), name: 'base.ggb',
    })
    expect(verifyChannelAuthentication(SECRET, withBase)).toBe(true)

    const signedCancel = signChannelMessage(SECRET, {
      type: 'plugin-core.cancel' as const,
      requestId: '01234567-89ab-4cde-8f01-23456789abce',
      issuedAt: '2026-09-19T00:00:00Z',
      expiresAt: '2026-09-19T00:01:00Z',
      nonce: 'nonce-1234567891',
      runId: formatRunId('01234567-89ab-4cde-8f01-23456789abcd'),
    })
    expect(channelPluginCoreCancelRequestSchema.parse(signedCancel).type)
      .toBe('plugin-core.cancel')
    expect(verifyChannelAuthentication(SECRET, signedCancel)).toBe(true)
  })

  it.each([1, 3, 4])('rejects handshake version %s and obsolete dispatch/checkpoint fields', version => {
    const oldHandshake = signChannelMessage(SECRET, { ...handshakeMessage(), protocolVersion: version })
    expect(channelHandshakeRequestSchema.safeParse(oldHandshake).success).toBe(false)
    const oldDispatch = signChannelMessage(SECRET, {
      ...runMessage(),
      type: 'run.dispatch',
      leaseEpoch: 3,
      checkpoint: { schemaVersion: 1, completed: [] },
    })
    expect(verifyChannelAuthentication(SECRET, oldDispatch)).toBe(true)
    expect(channelPluginCoreRequestSchema.safeParse(oldDispatch).success).toBe(false)
  })

  it('rejects tampered payloads, wrong secrets and missing authentication', () => {
    const signed = signChannelMessage(SECRET, runMessage())
    expect(verifyChannelAuthentication(SECRET, { ...signed, nonce: 'nonce-overflow-999' })).toBe(false)
    expect(verifyChannelAuthentication(OTHER_SECRET, signed)).toBe(false)
    const { authentication: _drop, ...unsigned } = signed
    expect(verifyChannelAuthentication(SECRET, unsigned)).toBe(false)
    expect(verifyChannelAuthentication(SECRET, { ...signed, authentication: 'zz' })).toBe(false)
  })

  it('expiry honours clock skew and invalid timestamps', () => {
    const now = Date.parse('2026-09-19T00:01:00Z')
    // Exactly at expiry: not expired within the 30s default skew.
    expect(isChannelRequestExpired('2026-09-19T00:01:00Z', now)).toBe(false)
    // Beyond the skew window: expired.
    expect(isChannelRequestExpired('2026-09-19T00:01:00Z', now + 30_001)).toBe(true)
    expect(isChannelRequestExpired('2026-09-19T00:00:59Z', now)).toBe(false)
    expect(isChannelRequestExpired('not-a-date', now)).toBe(true)
  })
})

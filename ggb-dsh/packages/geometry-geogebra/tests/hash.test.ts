import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../src/hash.js'

describe('browser-safe sha256', () => {
  it('matches the standard NIST test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('matches Node crypto output for unicode and long inputs', () => {
    expect(sha256Hex('GeoGebra 构图-外接圆 ¥')).toBe(
      'b2caa5a1329f471667f23e02e86620de8ccd2ab7ea279013b5f9dbf85c3eaedf',
    )
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })
})

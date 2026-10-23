import { describe, expect, it } from 'vitest'

import { appSessionIdSchema, geometrySchemaVersion } from '../src/index.js'

describe('geometry contract baseline', () => {
  it('accepts the frozen application id and schema version', () => {
    expect(appSessionIdSchema.parse('app_123e4567-e89b-42d3-a456-426614174000'))
      .toBe('app_123e4567-e89b-42d3-a456-426614174000')
    expect(geometrySchemaVersion.parse(1)).toBe(1)
  })

  it('rejects malformed ids and unknown schema versions', () => {
    expect(appSessionIdSchema.safeParse('session-1').success).toBe(false)
    expect(geometrySchemaVersion.safeParse(2).success).toBe(false)
  })
})

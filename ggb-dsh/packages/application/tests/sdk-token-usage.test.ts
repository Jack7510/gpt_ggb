import { describe, expect, it } from 'vitest'
import { totalInputTokensFromDshUsageV1 } from '../src/sdk-token-usage.js'

describe('SDK disjoint input accounting', () => {
  it('counts Messages cache creation and read tokens once in the prompt total', () => {
    expect(totalInputTokensFromDshUsageV1(10, 80, 20)).toBe(110)
    expect(totalInputTokensFromDshUsageV1(10, undefined, 20)).toBe(30)
    expect(totalInputTokensFromDshUsageV1(10, 80)).toBe(90)
  })

  it('retains unknown accounting for malformed or overflowing counters', () => {
    expect(totalInputTokensFromDshUsageV1(10, 80, -1)).toBeNull()
    expect(totalInputTokensFromDshUsageV1(10, '80', 0)).toBeNull()
    expect(totalInputTokensFromDshUsageV1(undefined, 80, 0)).toBeNull()
    expect(totalInputTokensFromDshUsageV1(Number.MAX_SAFE_INTEGER, 0, 1)).toBeNull()
  })
})

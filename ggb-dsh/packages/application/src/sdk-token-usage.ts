/** Convert the DSH SDK's disjoint input/cache counters to provider prompt tokens. */
export function totalInputTokensFromDshUsageV1(inputTokens: unknown,
  cacheReadTokens: unknown, cacheWriteTokens?: unknown): number | null {
  if (!validToken(inputTokens)) return null
  if (cacheReadTokens !== undefined && !validToken(cacheReadTokens)) return null
  if (cacheWriteTokens !== undefined && !validToken(cacheWriteTokens)) return null
  const total = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  return Number.isSafeInteger(total) ? total : null
}

function validToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

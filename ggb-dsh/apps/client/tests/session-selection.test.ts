import { describe, expect, it } from 'vitest'

import { SessionSelection } from '../src/app/session-selection.js'

describe('SessionSelection', () => {
  it('rejects a stale Session load after a newer selection', () => {
    const selection = new SessionSelection()
    const first = selection.begin()
    const second = selection.begin()

    expect(selection.isCurrent(first)).toBe(false)
    expect(selection.isCurrent(second)).toBe(true)

    selection.invalidate()
    expect(selection.isCurrent(second)).toBe(false)
  })
})

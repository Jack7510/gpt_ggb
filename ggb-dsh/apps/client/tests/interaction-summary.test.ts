import { expect, it } from 'vitest'
import { interactionSummary } from '../src/app/interaction-summary.js'

it('distinguishes zero samples from measured passing interactions without changing stored evidence', () => {
  for (const status of ['passed', 'not_sampled']) {
    expect(interactionSummary({ interaction: { status, samples: 0 } }, 'zh-CN')).toContain('未采样')
  }
  expect(interactionSummary({ interaction: { status: 'passed', samples: 2 } }, 'zh-CN')).toContain('通过（2 个样本）')
  expect(interactionSummary({ interaction: { status: 'passed', samples: 0 } }, 'en')).toContain('Not sampled')
  expect(interactionSummary({ interaction: { status: 'passed', samples: 1 } }, 'en')).toContain('1 samples')
  for (const status of ['failed', 'unverified', 'unknown', 'not_sampled']) {
    expect(interactionSummary({ interaction: { status, samples: 2 } }, 'zh-CN')).not.toContain('通过（')
  }
  for (const value of [null, {}, { interaction: null }, { interaction: { status: 'passed' } },
    { interaction: { status: 'passed', samples: -1 } }, { interaction: { status: 'passed', samples: 0.5 } }]) {
    expect(interactionSummary(value, 'zh-CN')).toBe('')
  }
})

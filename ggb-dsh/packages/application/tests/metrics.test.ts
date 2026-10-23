import { describe, expect, it } from 'vitest'
import { createMetrics, MAX_METRIC_SERIES, renderMetrics } from '../src/metrics.js'

describe('metrics registry (§15)', () => {
  it('aggregates counters, histograms and gauges across label sets', () => {
    const metrics = createMetrics()
    metrics.increment('admission_rejected', { reason: 'capacity' })
    metrics.increment('admission_rejected', { reason: 'capacity' })
    metrics.increment('credential_required')
    metrics.observe('recovery_backlog', 10)
    metrics.observe('recovery_backlog', 30)
    metrics.set('runs_active', 7)

    const samples = metrics.snapshot()
    const admission = samples.find((s) => s.name === 'admission_rejected' && s.labels.reason === 'capacity')
    expect(admission?.count).toBe(2)
    expect(admission?.sum).toBe(2)
    const backlog = samples.find((s) => s.name === 'recovery_backlog')
    expect(backlog?.count).toBe(2)
    expect(backlog?.sum).toBe(40)
    expect(backlog?.min).toBe(10)
    expect(backlog?.max).toBe(30)
    const active = samples.find((s) => s.name === 'runs_active')
    expect(active?.count).toBe(7)
  })

  it('adds a dropped-series counter when the registry hits MAX_METRIC_SERIES', () => {
    const metrics = createMetrics()
    for (let i = 0; i < MAX_METRIC_SERIES; i++) {
      metrics.increment('admission_rejected', { reason: `synthetic-${i}` })
    }
    // The registry is now full; the next distinct label set is discarded, not added.
    metrics.increment('admission_rejected', { reason: 'overflow' })
    const samples = metrics.snapshot()
    expect(samples.some((s) => s.labels.reason === 'overflow')).toBe(false)
    expect(samples.filter((s) => s.name === 'admission_rejected')).toHaveLength(MAX_METRIC_SERIES)

    const dropped = samples.find((s) => s.name === 'metrics_series_dropped')
    expect(dropped?.count).toBe(1)
  })

  it('renders a stable single-line snapshot with no unknown labels', () => {
    const metrics = createMetrics()
    metrics.increment('sse_reconnects')
    metrics.increment('sse_backpressure')
    const line = renderMetrics(metrics.snapshot())
    expect(line).toContain('sse_backpressure count=1 sum=1')
    expect(line).toContain('sse_reconnects count=1 sum=1')
    expect(line).not.toMatch(/run_/)
  })
})
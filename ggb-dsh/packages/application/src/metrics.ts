/**
 * §15 operational metrics.
 *
 * The name set is closed and every label key is fixed by its call site, so no code
 * path can introduce an unbounded label. A run ID is deliberately never a label:
 * metrics describe the fleet, and per-run detail belongs to logs and diagnostics.
 */
export type MetricName =
  /** Runs currently holding a non-terminal phase. */
  | 'runs_active'
  /** create rejected before any run row survived (label: reason). */
  | 'admission_rejected'
  /** Dispatch refused because the worker had no capacity. */
  | 'worker_capacity_rejected'
  /** A lease claim lost the race to another owner. */
  | 'worker_lease_lost'
  /** A run parked because no usable BYOK key was available. */
  | 'credential_required'
  /** An SSE stream resumed from a client cursor. */
  | 'sse_reconnects'
  /** An SSE write could not keep up with the client. */
  | 'sse_backpressure'
  /** A transaction entered `recovery_pending` (unknown canvas side effects). */
  | 'transaction_unknown'
  /** Open transactions observed when a run asked about recovery. */
  | 'recovery_backlog'
  /** A runtime cleanup failed (label: kind). */
  | 'cleanup_failures'
  /** Label sets refused because the registry hit `MAX_METRIC_SERIES`. */
  | 'metrics_series_dropped'

export type MetricLabels = Readonly<Record<string, string>>

export interface MetricSample {
  name: MetricName
  labels: MetricLabels
  /** Counter: total events. Gauge: current value. Histogram: observation count. */
  count: number
  /** Counter: same as count. Gauge: current value. Histogram: sum of observations. */
  sum: number
  min: number | null
  max: number | null
}

export interface Metrics {
  /** Adds to a counter (default 1). */
  increment(name: MetricName, labels?: MetricLabels, value?: number): void
  /** Records one observation of a distribution. */
  observe(name: MetricName, value: number, labels?: MetricLabels): void
  /** Sets the current value of a gauge. */
  set(name: MetricName, value: number, labels?: MetricLabels): void
  snapshot(): MetricSample[]
}

/**
 * Hard cap on distinct label sets. A cardinality bug then costs a dropped series
 * instead of unbounded memory, and the cap itself is observable as `dropped`.
 */
export const MAX_METRIC_SERIES = 128

/** Accepts and discards everything; used where a process has no metrics sink. */
export const NOOP_METRICS: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
  set: () => undefined,
  snapshot: () => [],
}

interface Series {
  name: MetricName
  labels: MetricLabels
  count: number
  sum: number
  min: number | null
  max: number | null
}

/** In-process registry. Each process owns one; nothing is shared across the API/worker split. */
export function createMetrics(): Metrics {
  const series = new Map<string, Series>()
  let dropped = 0

  const resolve = (name: MetricName, labels: MetricLabels): Series | null => {
    const key = `${name}|${Object.keys(labels).sort().map((label) => `${label}=${labels[label]}`).join(',')}`
    const existing = series.get(key)
    if (existing !== undefined) return existing
    if (series.size >= MAX_METRIC_SERIES) {
      dropped += 1
      return null
    }
    const created: Series = { name, labels: { ...labels }, count: 0, sum: 0, min: null, max: null }
    series.set(key, created)
    return created
  }

  return {
    increment(name, labels = {}, value = 1): void {
      const target = resolve(name, labels)
      if (target === null) return
      target.count += value
      target.sum += value
    },
    observe(name, value, labels = {}): void {
      const target = resolve(name, labels)
      if (target === null) return
      target.count += 1
      target.sum += value
      target.min = target.min === null ? value : Math.min(target.min, value)
      target.max = target.max === null ? value : Math.max(target.max, value)
    },
    set(name, value, labels = {}): void {
      const target = resolve(name, labels)
      if (target === null) return
      target.count = value
      target.sum = value
      target.min = value
      target.max = value
    },
    snapshot(): MetricSample[] {
      const samples = [...series.values()]
        .map((entry) => ({ ...entry, labels: { ...entry.labels } }))
        .sort((left, right) => left.name.localeCompare(right.name))
      if (dropped > 0) {
        samples.push({
          name: 'metrics_series_dropped',
          labels: {},
          count: dropped,
          sum: dropped,
          min: null,
          max: null,
        })
      }
      return samples
    },
  }
}

/**
 * Renders a snapshot as one log line (§15 keeps logs to stable codes,
 * timings and counts). No prompt, canvas, key or token can appear here because none
 * of them is ever passed to the registry.
 */
export function renderMetrics(samples: readonly MetricSample[]): string {
  return samples
    .map((sample) => {
      const labels = Object.keys(sample.labels).sort()
        .map((key) => `${key}=${sample.labels[key]}`)
        .join(',')
      const min = sample.min === null ? '-' : String(sample.min)
      const max = sample.max === null ? '-' : String(sample.max)
      return `${sample.name}${labels === '' ? '' : `{${labels}}`} count=${sample.count} sum=${sample.sum} min=${min} max=${max}`
    })
    .join(' | ')
}

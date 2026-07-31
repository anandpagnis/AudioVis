interface Sample {
  t: number
  v: number
}

/**
 * A time-windowed sample buffer: push (t, v) pairs, and anything older than
 * `windowSec` (relative to the most recent push) is pruned automatically.
 * Backs the live analytics panel's sparklines and percentile readouts —
 * the one shared version of the time-windowed-array idiom `MoodEstimator`
 * and `BpmEstimator` each already hand-roll privately.
 */
export class RollingWindow {
  private samples: Sample[] = []

  constructor(private windowSec: number) {}

  push(t: number, v: number): void {
    this.samples.push({ t, v })
    this.prune(t)
  }

  private prune(now: number): void {
    let i = 0
    while (i < this.samples.length && now - this.samples[i].t > this.windowSec) i++
    if (i > 0) this.samples.splice(0, i)
  }

  clear(): void {
    this.samples = []
  }

  count(): number {
    return this.samples.length
  }

  /** Raw buffer, oldest first — for sparkline drawing. */
  values(): readonly Sample[] {
    return this.samples
  }

  mean(): number {
    if (this.samples.length === 0) return 0
    let sum = 0
    for (const s of this.samples) sum += s.v
    return sum / this.samples.length
  }

  stdev(): number {
    if (this.samples.length === 0) return 0
    const m = this.mean()
    let sq = 0
    for (const s of this.samples) sq += (s.v - m) * (s.v - m)
    return Math.sqrt(sq / this.samples.length)
  }

  min(): number {
    if (this.samples.length === 0) return 0
    let v = Infinity
    for (const s of this.samples) if (s.v < v) v = s.v
    return v
  }

  max(): number {
    if (this.samples.length === 0) return 0
    let v = -Infinity
    for (const s of this.samples) if (s.v > v) v = s.v
    return v
  }

  /** Nearest-rank percentile, p in 0..1. */
  percentile(p: number): number {
    if (this.samples.length === 0) return 0
    const sorted = this.samples.map((s) => s.v).sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
    return sorted[idx]
  }
}

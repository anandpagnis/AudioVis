/**
 * Show-quality metrics — how well a recorded session's cuts line up with the
 * beat grid, how much a rack is actually on screen versus idle, and how much
 * variety the show found across its own scene/palette pools.
 *
 * Every function here is pure and works over plain numbers or the small
 * per-event records below — never `SessionSample`/`SessionEvent` themselves,
 * so a synthetic fixture can exercise the arithmetic with no session, no
 * clock and no engine running. `sessionLog.ts` owns pulling the raw numbers
 * (`beatInBar`, `beatProgress`, `bar`, rack-engagement booleans) out of state
 * it already samples — see its own "Events are DERIVED, not instrumented"
 * note — and this module owns only what happens to them once they exist.
 */

const BEATS_PER_BAR = 4

/**
 * Distance in beats (0..2) from a beat-grid position to the nearest downbeat
 * (bar boundary). `beatInBar` is 0..3 (which beat of the bar), `beatProgress`
 * is 0..1 through it — together they give a 0..4 position inside the bar,
 * and the downbeat sits at both ends of that range.
 */
export function downbeatOffsetBeats(beatInBar: number, beatProgress: number): number {
  const bib = Number.isFinite(beatInBar) ? Math.min(3, Math.max(0, Math.trunc(beatInBar))) : 0
  const prog = Number.isFinite(beatProgress) ? Math.min(1, Math.max(0, beatProgress)) : 0
  const pos = bib + prog
  return Math.min(pos, BEATS_PER_BAR - pos)
}

/**
 * Distance in beats (0..0.5) from a beat-grid position to the nearest beat of
 * ANY kind, not just the downbeat — how tightly something lands on a beat,
 * full stop, independent of where in the bar that beat falls.
 */
export function beatOffsetBeats(beatProgress: number): number {
  const prog = Number.isFinite(beatProgress) ? Math.min(1, Math.max(0, beatProgress)) : 0
  return Math.min(prog, 1 - prog)
}

export interface OffsetStats {
  n: number
  meanBeats: number
  medianBeats: number
  p90Beats: number
  maxBeats: number
}

const EMPTY_OFFSET_STATS: OffsetStats = { n: 0, meanBeats: 0, medianBeats: 0, p90Beats: 0, maxBeats: 0 }

/** Distribution summary over a list of beat offsets (e.g. from {@link downbeatOffsetBeats}). */
export function offsetDistribution(offsetsBeats: number[]): OffsetStats {
  const v = offsetsBeats.filter((x) => Number.isFinite(x))
  if (v.length === 0) return EMPTY_OFFSET_STATS
  const sorted = [...v].sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    n: v.length,
    meanBeats: v.reduce((a, b) => a + b, 0) / v.length,
    medianBeats: pct(0.5),
    p90Beats: pct(0.9),
    maxBeats: sorted[sorted.length - 1],
  }
}

/** A single cut's position on the beat grid at the moment it happened. */
export interface CutBeatSample {
  /** Bar index (`AudioFeatures.bar`) — which bar the cut fell in. */
  bar: number
  /** 0..3 — which beat of the bar. */
  beatInBar: number
  /** 0..1 — position inside that beat. */
  beatProgress: number
}

/** Default "on the beat" tolerance — an eighth note at a 4/4 grid. */
export const BEAT_HIT_TOLERANCE_BEATS = 0.125

/**
 * Fraction of cuts landing within `toleranceBeats` of ANY beat, not just the
 * downbeat — the show's raw cutting precision, independent of bar position.
 * 0 for no cuts.
 */
export function beatHitScore(cuts: CutBeatSample[], toleranceBeats = BEAT_HIT_TOLERANCE_BEATS): number {
  if (cuts.length === 0) return 0
  const hits = cuts.filter((c) => beatOffsetBeats(c.beatProgress) <= toleranceBeats).length
  return hits / cuts.length
}

/**
 * Fraction of the bars the session actually spanned that landed at least one
 * cut near their downbeat — coverage, as distinct from {@link beatHitScore}'s
 * precision. A show can hit every cut precisely on some beat (high BHS)
 * while only ever cutting near one bar in five (low BCS): the two answer
 * different questions and neither implies the other. `totalBars` is the
 * number of distinct bars the SAMPLE stream (not the cuts) actually covered
 * — cuts are sparse by construction, so counting bars from the cuts alone
 * would make coverage tautologically 100%.
 */
export function beatCoverageScore(
  cuts: CutBeatSample[],
  totalBars: number,
  toleranceBeats = BEAT_HIT_TOLERANCE_BEATS,
): number {
  if (!Number.isFinite(totalBars) || totalBars <= 0) return 0
  const covered = new Set<number>()
  for (const c of cuts) {
    if (downbeatOffsetBeats(c.beatInBar, c.beatProgress) <= toleranceBeats) covered.add(c.bar)
  }
  return Math.min(1, covered.size / totalBars)
}

/** The downbeat-offset distribution (see {@link offsetDistribution}) over a list of cuts. */
export function cutOffsetDistribution(cuts: CutBeatSample[]): OffsetStats {
  return offsetDistribution(cuts.map((c) => downbeatOffsetBeats(c.beatInBar, c.beatProgress)))
}

export interface RackDutyCycle {
  /** Fraction of samples the rack was engaged, 0..1. */
  dutyCycle: number
  /** Longest unbroken run of engagement, in seconds. */
  longestOnSec: number
  /** Longest unbroken run of NOT engaged, in seconds. 0 if never off. */
  longestOffSec: number
}

const EMPTY_DUTY_CYCLE: RackDutyCycle = { dutyCycle: 0, longestOnSec: 0, longestOffSec: 0 }

/**
 * Duty cycle and longest on/off run for a boolean engagement flag sampled at
 * a fixed interval — `SessionSample`'s own 4 Hz, typically. Answers "is this
 * rack a texture the show lives in, or a flourish that flashes on and off,"
 * which a single on-time-percentage cannot: two racks can share a 30% duty
 * cycle while one holds for a minute at a stretch and the other flickers
 * every second.
 */
export function rackDutyCycle(engagedFlags: boolean[], sampleIntervalSec: number): RackDutyCycle {
  if (engagedFlags.length === 0 || !Number.isFinite(sampleIntervalSec) || sampleIntervalSec <= 0)
    return EMPTY_DUTY_CYCLE
  let onCount = 0
  let longestOn = 0
  let longestOff = 0
  let runOn = 0
  let runOff = 0
  for (const flag of engagedFlags) {
    if (flag) {
      onCount++
      runOn++
      runOff = 0
      if (runOn > longestOn) longestOn = runOn
    } else {
      runOff++
      runOn = 0
      if (runOff > longestOff) longestOff = runOff
    }
  }
  return {
    dutyCycle: onCount / engagedFlags.length,
    longestOnSec: longestOn * sampleIntervalSec,
    longestOffSec: longestOff * sampleIntervalSec,
  }
}

/**
 * Shannon entropy, in bits, of the frequency distribution of `labels`. 0 for
 * an empty list or a list with only one distinct label (nothing surprising
 * ever happened); rises toward log2(distinct count) as the distribution
 * flattens toward uniform.
 */
export function shannonEntropyBits(labels: string[]): number {
  const v = labels.filter((l) => l.length > 0)
  if (v.length === 0) return 0
  const counts = new Map<string, number>()
  for (const l of v) counts.set(l, (counts.get(l) ?? 0) + 1)
  let h = 0
  for (const c of counts.values()) {
    const p = c / v.length
    h -= p * Math.log2(p)
  }
  return h
}

/**
 * {@link shannonEntropyBits} normalised 0..1 by the maximum possible entropy
 * for the number of DISTINCT labels actually seen. Lets a show rotating 3
 * scenes and a show rotating 9 read on the same scale: 1.0 means "as evenly
 * spread as what it actually used allows," not "used the whole registry" —
 * that second question is a separate coverage count, not this one.
 */
export function normalisedEntropy(labels: string[]): number {
  const distinct = new Set(labels.filter((l) => l.length > 0)).size
  if (distinct <= 1) return 0
  return shannonEntropyBits(labels) / Math.log2(distinct)
}

export interface TimeToRepeatStats {
  n: number
  meanSec: number
  medianSec: number
  minSec: number
  maxSec: number
}

const EMPTY_TTR: TimeToRepeatStats = { n: 0, meanSec: 0, medianSec: 0, minSec: 0, maxSec: 0 }

/**
 * Gaps, in seconds, between successive occurrences of the SAME label in a
 * chronological `(t, label)` stream — e.g. how long between one scene's
 * appearances and its next. Aggregated across every label that repeated at
 * all; a label seen once contributes no gap. `entries` must already be in
 * non-decreasing `t` order (the order events are recorded in); a gap is
 * skipped rather than going negative if it is not. Exported separately from
 * {@link timeToRepeat} so a caller building a histogram (which needs the raw
 * list) and one only wanting the summary stats share the same one pass.
 */
export function repeatGapsSec(entries: { t: number; label: string }[]): number[] {
  const lastSeen = new Map<string, number>()
  const gaps: number[] = []
  for (const e of entries) {
    if (!e.label || !Number.isFinite(e.t)) continue
    const prev = lastSeen.get(e.label)
    if (prev !== undefined && e.t >= prev) gaps.push(e.t - prev)
    lastSeen.set(e.label, e.t)
  }
  return gaps
}

/** Summary statistics over {@link repeatGapsSec}. */
export function timeToRepeat(entries: { t: number; label: string }[]): TimeToRepeatStats {
  const gaps = repeatGapsSec(entries)
  if (gaps.length === 0) return EMPTY_TTR
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    n: gaps.length,
    meanSec: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    medianSec: sorted[Math.floor(sorted.length / 2)],
    minSec: sorted[0],
    maxSec: sorted[sorted.length - 1],
  }
}

/**
 * Bucket non-negative `values` into `bucketSec`-wide bins starting at 0,
 * capped at `maxBuckets` — a value past the last bucket's edge folds into it
 * rather than growing the array, so a single huge outlier gap cannot blow up
 * a text report's histogram into an unreadable tail.
 */
export function histogramBuckets(values: number[], bucketSec: number, maxBuckets: number): number[] {
  if (!Number.isFinite(bucketSec) || bucketSec <= 0 || maxBuckets <= 0) return []
  const buckets = new Array(maxBuckets).fill(0) as number[]
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) continue
    const idx = Math.min(maxBuckets - 1, Math.floor(v / bucketSec))
    buckets[idx]++
  }
  return buckets
}

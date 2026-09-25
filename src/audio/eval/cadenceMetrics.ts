/**
 * Metrics over a `simulateLegacy` result (phase 0C): the scene-change interval distribution, which trigger produced
 * each change, how many detector edges the dwell discarded, and how the commits relate to the detector's own
 * events (with a random-phase CONTROL, because the fast `sectionChange` flag fires often enough that any commit
 * lands near one by chance).
 *
 * Pure. Nothing here is a measure of correctness against a musical ground truth: none exists. "Alignment" means
 * alignment to what the app's own detectors reported, so it bounds how music-anchored the CURRENT show can be, and
 * says nothing about whether those detectors were right.
 */
import type { CadenceTrace } from './cadenceTrace'
import type { EdgeOutcome, LegacyResult, TriggerKind } from './legacyCadence'

export function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return NaN
  const pos = (sortedAsc.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo)
}

export interface DistStats {
  n: number
  mean: number
  min: number
  p10: number
  median: number
  p90: number
  max: number
}

export function distStats(values: readonly number[]): DistStats {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (s.length === 0) return { n: 0, mean: NaN, min: NaN, p10: NaN, median: NaN, p90: NaN, max: NaN }
  let sum = 0
  for (const v of s) sum += v
  return {
    n: s.length,
    mean: sum / s.length,
    min: s[0],
    p10: quantile(s, 0.1),
    median: quantile(s, 0.5),
    p90: quantile(s, 0.9),
    max: s[s.length - 1],
  }
}

/** Fraction of `values` inside `[lo, hi]` (NaN when empty). */
export function shareWithin(values: readonly number[], lo: number, hi: number): number {
  if (values.length === 0) return NaN
  let k = 0
  for (const v of values) if (v >= lo && v <= hi) k++
  return k / values.length
}

/** Mulberry32: tiny seeded RNG so the chance control is reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- Detector events --------------------------------------------------------------------------------------------

export const EVENT_TYPES = ['sectionChange', 'boundary', 'analyser', 'drop', 'any'] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** Detector event times in seconds, ascending. */
export type DetectorEvents = Record<EventType, number[]>

/** Rising edges of a 0/1 column, in seconds. */
function risingEdges(col: ArrayLike<number>, n: number, dt: number, gate?: ArrayLike<number>): number[] {
  const out: number[] = []
  let prev = 0
  for (let i = 0; i < n; i++) {
    const v = col[i] !== 0 && (!gate || gate[i] !== 0) ? 1 : 0
    if (v === 1 && prev === 0) out.push(i * dt)
    prev = v
  }
  return out
}

/** Time (s) of each beat index: the first frame the beat counter reached it. */
export function beatTimes(trace: CadenceTrace): Map<number, number> {
  const m = new Map<number, number>()
  const { cols, n, frameRate } = trace
  let last = Number.NEGATIVE_INFINITY
  for (let i = 0; i < n; i++) {
    const b = cols.beatIndex[i]
    if (b !== last) {
      if (!m.has(b)) m.set(b, i / frameRate)
      last = b
    }
  }
  return m
}

export function detectorEvents(trace: CadenceTrace): DetectorEvents {
  const { cols, n, frameRate } = trace
  const dt = 1 / frameRate
  const bt = beatTimes(trace)
  const sortedBeats = [...bt.keys()].sort((a, b) => a - b)
  const timeOfBeat = (b: number): number | null => {
    const exact = bt.get(b)
    if (exact !== undefined) return exact
    // The counter can skip (up to 4 per crossing): use the newest known beat at or before it.
    let lo = 0
    let hi = sortedBeats.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sortedBeats[mid] <= b) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return best >= 0 ? (bt.get(sortedBeats[best]) ?? null) : null
  }
  const sectionChange = risingEdges(cols.sectionChange, n, dt)
  const boundary = risingEdges(cols.boundaryChanged, n, dt, cols.structureValid)
  const drop = risingEdges(cols.drop, n, dt)
  const analyser: number[] = []
  for (const ab of trace.analyserBoundaries) {
    const t = timeOfBeat(ab.beat)
    if (t !== null) analyser.push(t)
  }
  analyser.sort((a, b) => a - b)
  const any = [...sectionChange, ...boundary, ...analyser, ...drop].sort((a, b) => a - b)
  return { sectionChange, boundary, analyser, drop, any }
}

// --- Alignment --------------------------------------------------------------------------------------------------

/** Nearest-event distance (|dt|) and time since the latest event at or before `t` (Infinity when none). */
export function alignTimes(times: readonly number[], events: readonly number[]): { abs: number[]; since: number[] } {
  const abs: number[] = []
  const since: number[] = []
  for (const t of times) {
    let lo = 0
    let hi = events.length - 1
    let idx = -1 // latest event <= t
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (events[mid] <= t) {
        idx = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const prev = idx >= 0 ? t - events[idx] : Infinity
    const next = idx + 1 < events.length ? events[idx + 1] - t : Infinity
    abs.push(Math.min(prev, next))
    since.push(prev)
  }
  return { abs, since }
}

export interface AlignSamples {
  /** Real commits. */
  real: { abs: number[]; since: number[] }
  /** The same commits circularly shifted by random offsets (K copies pooled): what "unrelated to the music" looks like. */
  chance: { abs: number[]; since: number[] }
}

export interface TrackCadence {
  id: string
  durationSec: number
  medianBpm: number
  commits: number
  firstCommitSec: number | null
  /** Commits in the first 5 s (a warm-up mood/armed commit at playback start; still counted everywhere). */
  startupCommits: number
  intervalsSec: number[]
  intervalsBars: number[]
  triggers: Record<string, number>
  kinds: Record<TriggerKind, number>
  viaArmed: number
  requests: { accepted: number; refusedDwell: number }
  waitSec: number[]
  /**
   * For every NON-immediate commit after the first: beats between the end of the subject dwell
   * (previous commit + dwellBeats) and this commit. Near 0 means the scene changed at the first opportunity the
   * dwell allowed, i.e. the dwell (not the music) set the timing.
   */
  slackBeats: number[]
  /** Detector event counts on the track. */
  detector: Record<EventType, number>
  edges: {
    sectionChange: EdgeSummary
    boundary: EdgeSummary
  }
  /** Alignment samples per event type. */
  align: Record<EventType, AlignSamples>
  /** Per discarded (dwell) edge: the kind of the NEXT commit, or 'none' when no commit followed. */
  nextCommitAfterDiscard: Array<TriggerKind | 'none'>
  /** For commits that were not event-type: seconds since the latest dwell-discarded edge in that interval (empty when none). */
  lagAfterDiscardSec: number[]
  /** Commits whose inter-commit interval contained a dwell-discarded edge, by kind. */
  commitsAfterDiscard: Record<TriggerKind, number>
  /** Share of frames where `simulateLegacy` was inside the subject dwell. */
  dwellShare: number
}

export interface EdgeSummary {
  total: number
  inDwell: number
  outcomes: Record<EdgeOutcome, number>
  /** Edges followed by a commit within 6 s. */
  commitWithin6s: number
}

const emptyOutcomes = (): Record<EdgeOutcome, number> => ({
  requested: 0,
  armedConfirm: 0,
  otherTrigger: 0,
  dwell: 0,
  pending: 0,
  sameBeat: 0,
  buildHold: 0,
  silence: 0,
})

/** Circularly shift `times` by a random offset inside `[0, duration)`. */
function shifted(times: readonly number[], duration: number, rng: () => number): number[] {
  if (duration <= 0) return [...times]
  const off = rng() * duration
  return times.map((t) => (t + off) % duration)
}

/**
 * Summarise one track's legacy replay. `chanceCopies` random circular shifts of the commit times give the
 * alignment control (deterministic for a `seed`).
 */
export function cadenceOfTrack(
  id: string,
  trace: CadenceTrace,
  result: LegacyResult,
  opts: { chanceCopies?: number; seed?: number } = {},
): TrackCadence {
  const chanceCopies = opts.chanceCopies ?? 20
  const rng = seededRng((opts.seed ?? 1) * 2654435761)
  const { commits, edges } = result
  const dt = 1 / trace.frameRate
  const duration = trace.n * dt

  const intervalsSec: number[] = []
  const intervalsBars: number[] = []
  const triggers: Record<string, number> = {}
  const kinds: Record<TriggerKind, number> = { event: 0, latched: 0, level: 0 }
  let viaArmed = 0
  const waitSec: number[] = []
  const slackBeats: number[] = []
  for (let k = 0; k < commits.length; k++) {
    const cm = commits[k]
    triggers[cm.trigger] = (triggers[cm.trigger] ?? 0) + 1
    kinds[cm.kind]++
    if (cm.via === 'armed') viaArmed++
    waitSec.push(cm.waitSec)
    if (k > 0 && !cm.immediate) slackBeats.push(cm.beat - commits[k - 1].beat - result.options.dwellBeats)
    if (k > 0) {
      intervalsSec.push(cm.timeSec - commits[k - 1].timeSec)
      intervalsBars.push((cm.beat - commits[k - 1].beat) / 4)
    }
  }
  let accepted = 0
  let refusedDwell = 0
  for (const r of result.requests) {
    if (r.outcome === 'accepted') accepted++
    else refusedDwell++
  }

  const bpms: number[] = []
  for (let i = 0; i < trace.n; i += 30) if (trace.cols.bpm10[i] > 0) bpms.push(trace.cols.bpm10[i] / 10)
  bpms.sort((a, b) => a - b)

  const events = detectorEvents(trace)
  const commitTimes = commits.map((c) => c.timeSec)
  const align = {} as Record<EventType, AlignSamples>
  const detector = {} as Record<EventType, number>
  for (const ty of EVENT_TYPES) {
    detector[ty] = events[ty].length
    const real = alignTimes(commitTimes, events[ty])
    const chance = { abs: [] as number[], since: [] as number[] }
    if (commitTimes.length > 0) {
      for (let k = 0; k < chanceCopies; k++) {
        const a = alignTimes(shifted(commitTimes, duration, rng), events[ty])
        chance.abs.push(...a.abs)
        chance.since.push(...a.since)
      }
    }
    align[ty] = { real, chance }
  }

  const summarize = (kind: 'sectionChange' | 'boundary'): EdgeSummary => {
    const es = edges.filter((e) => e.kind === kind)
    const outcomes = emptyOutcomes()
    let inDwell = 0
    let commitWithin6s = 0
    for (const e of es) {
      outcomes[e.outcome]++
      if (e.inDwell) inDwell++
      if (commitTimes.some((t) => t >= e.timeSec && t <= e.timeSec + 6)) commitWithin6s++
    }
    return { total: es.length, inDwell, outcomes, commitWithin6s }
  }

  // Lost edges and what replaced them.
  const nextCommitAfterDiscard: TrackCadence['nextCommitAfterDiscard'] = []
  for (const e of edges) {
    if (e.outcome !== 'dwell') continue
    const next = commits.find((c) => c.timeSec >= e.timeSec)
    nextCommitAfterDiscard.push(next ? next.kind : 'none')
  }
  const lagAfterDiscardSec: number[] = []
  const commitsAfterDiscard: Record<TriggerKind, number> = { event: 0, latched: 0, level: 0 }
  for (let k = 0; k < commits.length; k++) {
    const from = k > 0 ? commits[k - 1].timeSec : -Infinity
    const to = commits[k].timeSec
    let lastDiscard = -Infinity
    for (const e of edges) if (e.outcome === 'dwell' && e.timeSec > from && e.timeSec <= to && e.timeSec > lastDiscard) lastDiscard = e.timeSec
    if (lastDiscard > -Infinity) {
      commitsAfterDiscard[commits[k].kind]++
      if (commits[k].kind !== 'event') lagAfterDiscardSec.push(to - lastDiscard)
    }
  }

  // Share of time spent inside the dwell (does not depend on the trace, only on the commit beats).
  let dwellFrames = 0
  {
    let ci = -1
    for (let i = 0; i < trace.n; i++) {
      while (ci + 1 < commits.length && commits[ci + 1].frame <= i) ci++
      if (ci >= 0 && trace.cols.beatIndex[i] - commits[ci].beat < result.options.dwellBeats) dwellFrames++
    }
  }

  return {
    id,
    durationSec: duration,
    medianBpm: bpms.length ? quantile(bpms, 0.5) : NaN,
    commits: commits.length,
    firstCommitSec: commits.length ? commits[0].timeSec : null,
    startupCommits: commits.filter((c) => c.timeSec < 5).length,
    intervalsSec,
    intervalsBars,
    triggers,
    kinds,
    viaArmed,
    requests: { accepted, refusedDwell },
    waitSec,
    slackBeats,
    detector,
    edges: { sectionChange: summarize('sectionChange'), boundary: summarize('boundary') },
    align,
    nextCommitAfterDiscard,
    lagAfterDiscardSec,
    commitsAfterDiscard,
    dwellShare: trace.n ? dwellFrames / trace.n : 0,
  }
}

// --- Aggregation ------------------------------------------------------------------------------------------------

export interface AlignAggregate {
  events: number
  commits: number
  /** Median of |commit - nearest event| in seconds, real vs chance. */
  medianAbsSec: { real: number; chance: number }
  /** Share of commits within +-2 s / +-4 s of an event, real vs chance. */
  within2s: { real: number; chance: number }
  within4s: { real: number; chance: number }
  /** Share of commits that FOLLOW an event by at most 6 s (a plausible response), real vs chance. */
  causal6s: { real: number; chance: number }
}

export interface CadenceAggregate {
  tracks: number
  commits: number
  /** Commits within the first 5 s of a track (startup transients), included in `commits`. */
  startupCommits: number
  /** Total analysed minutes. */
  minutes: number
  commitsPerMinute: number
  intervalSec: DistStats
  intervalBars: DistStats
  /** Share of intervals inside [4, 32] bars / below 4 / above 32. */
  shareBars: { in4to32: number; below4: number; above32: number }
  /** Share of intervals inside [10, 30] s. */
  shareSec10to30: number
  /** Per-track median interval (s): spread across tracks. */
  perTrackMedianSec: DistStats
  triggers: Array<{ trigger: string; count: number; share: number }>
  kinds: { event: number; latched: number; level: number }
  viaArmed: number
  requests: { accepted: number; refusedDwell: number }
  waitSec: DistStats
  /** Beats after the dwell expired at which non-immediate commits landed (see `TrackCadence.slackBeats`). */
  slackBeats: DistStats
  /** Share of non-immediate commits landing within 4 / 8 / 16 beats of the dwell's end. */
  shareSlack: { within4: number; within8: number; within16: number }
  edges: Record<'sectionChange' | 'boundary', { total: number; inDwell: number; shareInDwell: number; outcomes: Record<EdgeOutcome, number>; commitWithin6s: number }>
  align: Record<EventType, AlignAggregate>
  /** Of the dwell-discarded edges, the kind of the commit that came next. */
  nextCommitAfterDiscard: Record<TriggerKind | 'none', number>
  /** Commits whose interval contained a discarded edge, and how many of those were not event-type. */
  commitsAfterDiscard: Record<TriggerKind, number>
  lagAfterDiscardSec: DistStats
  dwellShare: number
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

function alignAggregate(tracks: readonly TrackCadence[], ty: EventType): AlignAggregate {
  const realAbs = tracks.flatMap((t) => t.align[ty].real.abs)
  const realSince = tracks.flatMap((t) => t.align[ty].real.since)
  const chAbs = tracks.flatMap((t) => t.align[ty].chance.abs)
  const chSince = tracks.flatMap((t) => t.align[ty].chance.since)
  const med = (v: number[]): number => quantile(v.filter(Number.isFinite).sort((a, b) => a - b), 0.5)
  return {
    events: sum(tracks.map((t) => t.detector[ty])),
    commits: realAbs.length,
    medianAbsSec: { real: med(realAbs), chance: med(chAbs) },
    within2s: { real: shareWithin(realAbs, 0, 2), chance: shareWithin(chAbs, 0, 2) },
    within4s: { real: shareWithin(realAbs, 0, 4), chance: shareWithin(chAbs, 0, 4) },
    causal6s: { real: shareWithin(realSince, 0, 6), chance: shareWithin(chSince, 0, 6) },
  }
}

export function aggregateCadence(tracks: readonly TrackCadence[]): CadenceAggregate {
  const intervalsSec = tracks.flatMap((t) => t.intervalsSec)
  const intervalsBars = tracks.flatMap((t) => t.intervalsBars)
  const commits = sum(tracks.map((t) => t.commits))
  const minutes = sum(tracks.map((t) => t.durationSec)) / 60
  const trig: Record<string, number> = {}
  for (const t of tracks) for (const [k, v] of Object.entries(t.triggers)) trig[k] = (trig[k] ?? 0) + v
  const kinds = { event: 0, latched: 0, level: 0 }
  for (const t of tracks) for (const k of ['event', 'latched', 'level'] as const) kinds[k] += t.kinds[k]
  const edgeAgg = (kind: 'sectionChange' | 'boundary') => {
    const outcomes = emptyOutcomes()
    let total = 0
    let inDwell = 0
    let commitWithin6s = 0
    for (const t of tracks) {
      const e = t.edges[kind]
      total += e.total
      inDwell += e.inDwell
      commitWithin6s += e.commitWithin6s
      for (const k of Object.keys(outcomes) as EdgeOutcome[]) outcomes[k] += e.outcomes[k]
    }
    return { total, inDwell, shareInDwell: total ? inDwell / total : NaN, outcomes, commitWithin6s }
  }
  const next: Record<TriggerKind | 'none', number> = { event: 0, latched: 0, level: 0, none: 0 }
  for (const t of tracks) for (const k of t.nextCommitAfterDiscard) next[k]++
  const after: Record<TriggerKind, number> = { event: 0, latched: 0, level: 0 }
  for (const t of tracks) for (const k of ['event', 'latched', 'level'] as const) after[k] += t.commitsAfterDiscard[k]
  const align = {} as Record<EventType, AlignAggregate>
  for (const ty of EVENT_TYPES) align[ty] = alignAggregate(tracks, ty)
  const req = { accepted: 0, refusedDwell: 0 }
  for (const t of tracks) {
    req.accepted += t.requests.accepted
    req.refusedDwell += t.requests.refusedDwell
  }
  return {
    tracks: tracks.length,
    commits,
    startupCommits: sum(tracks.map((t) => t.startupCommits)),
    minutes,
    commitsPerMinute: minutes > 0 ? commits / minutes : NaN,
    intervalSec: distStats(intervalsSec),
    intervalBars: distStats(intervalsBars),
    shareBars: {
      in4to32: shareWithin(intervalsBars, 4, 32),
      below4: intervalsBars.length ? intervalsBars.filter((v) => v < 4).length / intervalsBars.length : NaN,
      above32: intervalsBars.length ? intervalsBars.filter((v) => v > 32).length / intervalsBars.length : NaN,
    },
    shareSec10to30: shareWithin(intervalsSec, 10, 30),
    perTrackMedianSec: distStats(tracks.filter((t) => t.intervalsSec.length > 0).map((t) => distStats(t.intervalsSec).median)),
    triggers: Object.entries(trig)
      .map(([trigger, count]) => ({ trigger, count, share: commits ? count / commits : NaN }))
      .sort((a, b) => b.count - a.count),
    kinds,
    viaArmed: sum(tracks.map((t) => t.viaArmed)),
    requests: req,
    waitSec: distStats(tracks.flatMap((t) => t.waitSec)),
    slackBeats: distStats(tracks.flatMap((t) => t.slackBeats)),
    shareSlack: {
      within4: shareWithin(tracks.flatMap((t) => t.slackBeats), 0, 4),
      within8: shareWithin(tracks.flatMap((t) => t.slackBeats), 0, 8),
      within16: shareWithin(tracks.flatMap((t) => t.slackBeats), 0, 16),
    },
    edges: { sectionChange: edgeAgg('sectionChange'), boundary: edgeAgg('boundary') },
    align,
    nextCommitAfterDiscard: next,
    commitsAfterDiscard: after,
    lagAfterDiscardSec: distStats(tracks.flatMap((t) => t.lagAfterDiscardSec)),
    dwellShare: tracks.length ? sum(tracks.map((t) => t.dwellShare * t.durationSec)) / sum(tracks.map((t) => t.durationSec)) : NaN,
  }
}

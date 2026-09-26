/**
 * Scoring against the SILVER standard (`src/audio/plan/analyzeSong.ts` output, `corpus/structure/silver/<id>.json`): the
 * whole-song, non-causal boundaries of a track, used as a REFERENCE to compare scene-change systems and event detectors.
 *
 * The silver analyser is NOT ground truth. It sees the whole song (future included), shares its features with the live
 * detector (circular), and has not been checked against human labels yet (the tap logs, `?structurelog`, are what settle
 * that). Every number here is RELATIVE evidence between systems scored the same way on the same data; each one is next to
 * a random-phase CHANCE control (the same times circularly shifted by a random offset), because a system that cuts often
 * lands near some boundary by luck. Absolute values say nothing about musical correctness.
 *
 * Two scorers, both pure (no I/O, no audio):
 *  - {@link scoreTrackCuts}: SCENE CUTS against the silver boundaries. Share of cuts within +-1 bar / +-2 s of a boundary
 *    (nearest one, not one-to-one), COVERAGE (the share of boundaries that have a cut in [-1, +4] bars around them: what a
 *    show that follows the music must do), the lag from the preceding boundary to the cut, plus the cadence numbers
 *    (cuts per minute, interval distribution in bars, forced share) so a system cannot look aligned by cutting constantly.
 *  - {@link scoreEventsVsSilver}: an EVENT DETECTOR's boundary times against the silver boundaries: precision / recall
 *    within +-1 bar and +-3 s, and the literature's F0.5 / F3 (`mirEvalStyleDetectionF`, one-to-one, no trimming: silver
 *    events are interior boundaries).
 *
 * Bars come from the SILVER tempo (`barSec = 240 / bpm`, folded into 74-152 BPM by the analyser): one bar length per track
 * for every system, so the systems are compared in one unit even where the app's own beat tracker halves or doubles.
 *
 * Aggregation is by POOLED COUNTS (a track with more boundaries or cuts weighs more), which is why the per-track records
 * carry counts and not ratios. Deterministic: the chance control is seeded per track.
 */
import { seededRng } from './cadenceMetrics'
import { fMeasure, matchEvents, mirEvalStyleDetectionF, percentile } from './structureMetrics'

/** A silver boundary with strength at or above this is a STRONG one (the analyser's median event is ~0.58). */
export const STRONG_STRENGTH = 0.5
/** Cuts in the first seconds are the startup commit, not a reaction to the music: they are left out of the alignment scores. */
export const STARTUP_SEC = 5
/** Coverage window around a boundary, in bars: a cut this many bars before / after counts as covering it (a live system lags). */
export const COVER_BEFORE_BARS = 1
export const COVER_AFTER_BARS = 4

/** The part of a `SongPlan` (`silver/<id>.json` `.plan`) the scorer reads. */
export interface SilverPlanLike {
  bpm: number
  events: ReadonlyArray<{ boundaryTime: number; strength: number; confidence?: number; type?: string }>
  diagnostics?: {
    tempo?: { confidence?: number }
    beatless?: boolean
    downbeat?: { confidence?: number }
  }
}

export interface SilverRef {
  bpm: number
  /** Seconds in one bar at the silver tempo. */
  barSec: number
  /** Every silver boundary (s), ascending; and the strong ones (strength >= {@link STRONG_STRENGTH}). */
  all: number[]
  strong: number[]
  /** Tempo confidence < 0.3, beatless, or downbeat confidence < 0.5: the bar grid (hence the bar units) is unreliable. */
  lowConfidence: boolean
  reasons: string[]
}

export function silverRef(plan: SilverPlanLike): SilverRef {
  const evs = plan.events
    .filter((e) => Number.isFinite(e.boundaryTime))
    .slice()
    .sort((a, b) => a.boundaryTime - b.boundaryTime)
  const reasons: string[] = []
  const d = plan.diagnostics
  if (d?.tempo?.confidence !== undefined && d.tempo.confidence < 0.3) reasons.push('tempo')
  if (d?.beatless === true) reasons.push('beatless')
  if (d?.downbeat?.confidence !== undefined && d.downbeat.confidence < 0.5) reasons.push('downbeat')
  return {
    bpm: plan.bpm,
    barSec: plan.bpm > 0 ? 240 / plan.bpm : 2,
    all: evs.map((e) => e.boundaryTime),
    strong: evs.filter((e) => e.strength >= STRONG_STRENGTH).map((e) => e.boundaryTime),
    lowConfidence: reasons.length > 0,
    reasons,
  }
}

// --- Small helpers -------------------------------------------------------------------------------------------------

/** Index of the last element of `sorted` that is <= `x` (-1 when none). */
function lastAtOrBefore(sorted: readonly number[], x: number): number {
  let lo = 0
  let hi = sorted.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= x) {
      idx = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return idx
}

/** Distance from `x` to the nearest element of `sorted` (Infinity when empty). */
function nearestDistance(sorted: readonly number[], x: number): number {
  const i = lastAtOrBefore(sorted, x)
  const prev = i >= 0 ? x - sorted[i] : Infinity
  const next = i + 1 < sorted.length ? sorted[i + 1] - x : Infinity
  return Math.min(prev, next)
}

/** The first element of `sorted` that is >= `x` (Infinity when none). */
function firstAtOrAfter(sorted: readonly number[], x: number): number {
  const i = lastAtOrBefore(sorted, x - 1e-9)
  return i + 1 < sorted.length ? sorted[i + 1] : Infinity
}

/**
 * How many of the sorted `cuts` follow some boundary by a lag in [`loSec`, `hiSec`] (negative lo = the cut may lead it).
 * The lag-aware way to read alignment for a CAUSAL system: a live show hears a change ~1.5 bars after it began, so it cannot
 * land inside a symmetric +-1 bar window.
 */
export function cutsInLagWindow(cuts: readonly number[], boundaries: readonly number[], loSec: number, hiSec: number): number {
  let n = 0
  for (const c of cuts) {
    // a boundary B with c - B in [lo, hi]  <=>  B in [c - hi, c - lo]
    const b = firstAtOrAfter(boundaries, c - hiSec)
    if (b <= c - loSec + 1e-9) n++
  }
  return n
}

/** `times` circularly shifted inside `[0, duration)` by `offset`, sorted. */
export function circularShift(times: readonly number[], duration: number, offset: number): number[] {
  if (!(duration > 0)) return [...times].sort((a, b) => a - b)
  return times.map((t) => (t + offset) % duration).sort((a, b) => a - b)
}

// --- Scene cuts against the silver boundaries -----------------------------------------------------------------------

/** What one set of cuts scored against one silver reference (counts, so tracks pool exactly). */
export interface CutCounts {
  /** Cuts scored. */
  cuts: number
  /** Cuts within +-1 bar / +-2 s of the nearest silver boundary (all boundaries). */
  within1Bar: number
  within2s: number
  /** ... within +-1 bar of a STRONG boundary. */
  within1BarStrong: number
  /** Cuts inside [-1, +4] bars after some boundary (a cut that follows a change at a musically sensible lag). */
  followsBoundary: number
  /** Boundaries that could be covered (>= 4 bars before the horizon) and how many had a cut in [-1, +4] bars, all / strong. */
  covAll: { boundaries: number; covered: number }
  covStrong: { boundaries: number; covered: number }
}

export interface CutSamples {
  /** Per scored cut: seconds since the latest silver boundary at or before it (cuts before the first boundary are skipped). */
  since: number[]
  /** Per covered strong boundary: the first cut inside its window minus the boundary (s; negative = the cut led it). */
  coverLag: number[]
}

const emptyCounts = (): CutCounts => ({
  cuts: 0,
  within1Bar: 0,
  within2s: 0,
  within1BarStrong: 0,
  followsBoundary: 0,
  covAll: { boundaries: 0, covered: 0 },
  covStrong: { boundaries: 0, covered: 0 },
})

function addCounts(into: CutCounts, x: CutCounts): void {
  into.cuts += x.cuts
  into.within1Bar += x.within1Bar
  into.within2s += x.within2s
  into.within1BarStrong += x.within1BarStrong
  into.followsBoundary += x.followsBoundary
  into.covAll.boundaries += x.covAll.boundaries
  into.covAll.covered += x.covAll.covered
  into.covStrong.boundaries += x.covStrong.boundaries
  into.covStrong.covered += x.covStrong.covered
}

/**
 * Score sorted `cuts` (s) against `ref` over a track of `horizonSec`. Boundaries later than `horizonSec - 4 bars` cannot
 * have their full coverage window inside the scored span, so they are left out of the COVERAGE denominators (not of the
 * per-cut scores).
 */
export function scoreCuts(cuts: readonly number[], ref: SilverRef, horizonSec: number, samples?: CutSamples): CutCounts {
  const out = emptyCounts()
  const bar = ref.barSec
  const before = COVER_BEFORE_BARS * bar
  const after = COVER_AFTER_BARS * bar
  const inTrack = (b: number): boolean => b <= horizonSec
  const all = ref.all.filter(inTrack)
  const strong = ref.strong.filter(inTrack)
  out.cuts = cuts.length
  for (const c of cuts) {
    if (nearestDistance(all, c) <= bar + 1e-9) out.within1Bar++
    if (nearestDistance(all, c) <= 2 + 1e-9) out.within2s++
    if (nearestDistance(strong, c) <= bar + 1e-9) out.within1BarStrong++
    // a boundary B with c in [B - before, B + after]  <=>  B in [c - after, c + before]
    const b = firstAtOrAfter(all, c - after)
    if (b <= c + before + 1e-9) out.followsBoundary++
    if (samples) {
      const i = lastAtOrBefore(all, c)
      if (i >= 0) samples.since.push(c - all[i])
    }
  }
  const lastCoverable = horizonSec - after
  const cover = (bs: readonly number[], into: { boundaries: number; covered: number }, lags?: number[]): void => {
    for (const b of bs) {
      if (b > lastCoverable) continue
      into.boundaries++
      const first = firstAtOrAfter(cuts, b - before)
      if (first <= b + after + 1e-9) {
        into.covered++
        if (lags) lags.push(first - b)
      }
    }
  }
  cover(all, out.covAll)
  cover(strong, out.covStrong, samples?.coverLag)
  return out
}

/** The cuts of one system on one track, all within the scored horizon. */
export interface CutList {
  /** Audio-clock seconds, ascending. */
  times: number[]
  /** The app's beat counter at each cut (for the interval in app bars, as `cadenceMetrics` counts them). */
  beats: number[]
  /** Made by the director's forced ceiling (or, for the legacy model, its level-type timers). */
  forced: boolean[]
}

export interface TrackSilverScore {
  id: string
  family: string
  /** Scored span (s): the minimum of the trace and the event-cell coverage, the same for every system. */
  horizonSec: number
  barSec: number
  lowConfidence: boolean
  /** Boundaries in the span (all / strong). */
  boundaries: { all: number; strong: number }
  /** Every cut in the span, startup included (what the cadence numbers count). */
  cutsAll: number
  forcedCuts: number
  intervalsSec: number[]
  /** Between consecutive cuts: (beat - previous beat) / 4, the app's own count, and seconds / silver bar. */
  intervalsBarsApp: number[]
  intervalsBarsSilver: number[]
  /** Alignment scored on the cuts after {@link STARTUP_SEC} (the primary) and on every cut. */
  post: { real: CutCounts; chance: CutCounts; samples: CutSamples; chanceSamples: CutSamples }
  all: { real: CutCounts; chance: CutCounts }
  /** Chance copies summed into the `chance` counts. */
  copies: number
}

export interface ScoreTrackOptions {
  chanceCopies?: number
  seed?: number
  startupSec?: number
}

/** Score one system's cuts on one track against its silver reference (real + the random-phase chance sums). */
export function scoreTrackCuts(
  id: string,
  family: string,
  ref: SilverRef,
  cuts: CutList,
  horizonSec: number,
  opts: ScoreTrackOptions = {},
): TrackSilverScore {
  const copies = Math.max(1, opts.chanceCopies ?? 20)
  const startup = opts.startupSec ?? STARTUP_SEC
  const rng = seededRng((opts.seed ?? 1) * 2654435761 + hashId(id))
  const t = cuts.times
  const intervalsSec: number[] = []
  const intervalsBarsApp: number[] = []
  const intervalsBarsSilver: number[] = []
  for (let k = 1; k < t.length; k++) {
    intervalsSec.push(t[k] - t[k - 1])
    intervalsBarsApp.push((cuts.beats[k] - cuts.beats[k - 1]) / 4)
    intervalsBarsSilver.push((t[k] - t[k - 1]) / ref.barSec)
  }
  const post = t.filter((x) => x >= startup)
  const offsets: number[] = []
  for (let k = 0; k < copies; k++) offsets.push(rng() * horizonSec)

  const run = (times: readonly number[]): { real: CutCounts; chance: CutCounts; samples: CutSamples; chanceSamples: CutSamples } => {
    const samples: CutSamples = { since: [], coverLag: [] }
    const chanceSamples: CutSamples = { since: [], coverLag: [] }
    const real = scoreCuts(times, ref, horizonSec, samples)
    const chance = emptyCounts()
    for (const off of offsets) addCounts(chance, scoreCuts(circularShift(times, horizonSec, off), ref, horizonSec, chanceSamples))
    return { real, chance, samples, chanceSamples }
  }
  const p = run(post)
  const a = run(t)
  return {
    id,
    family,
    horizonSec,
    barSec: ref.barSec,
    lowConfidence: ref.lowConfidence,
    boundaries: { all: ref.all.filter((b) => b <= horizonSec).length, strong: ref.strong.filter((b) => b <= horizonSec).length },
    cutsAll: t.length,
    forcedCuts: cuts.forced.filter(Boolean).length,
    intervalsSec,
    intervalsBarsApp,
    intervalsBarsSilver,
    post: p,
    all: { real: a.real, chance: a.chance },
    copies,
  }
}

/** A small stable hash of a track id, so each track has its own chance offsets. */
function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// --- Aggregation ------------------------------------------------------------------------------------------------

/** A share with its chance control and the chance-corrected lift `(real - chance) / (1 - chance)` (0 = chance, 1 = perfect). */
export interface Shared {
  real: number
  chance: number
  lift: number
  /** real / chance (NaN when chance is 0). */
  ratio: number
  n: number
}

function shared(realNum: number, realDen: number, chNum: number, chDen: number): Shared {
  const real = realDen > 0 ? realNum / realDen : NaN
  const chance = chDen > 0 ? chNum / chDen : NaN
  return {
    real,
    chance,
    lift: Number.isFinite(real) && Number.isFinite(chance) && chance < 1 ? (real - chance) / (1 - chance) : NaN,
    ratio: chance > 0 ? real / chance : NaN,
    n: realDen,
  }
}

export interface DistSummary {
  n: number
  median: number
  p10: number
  p90: number
}

function dist(values: readonly number[]): DistSummary {
  const v = values.filter((x) => Number.isFinite(x))
  return { n: v.length, median: percentile(v, 0.5), p10: percentile(v, 0.1), p90: percentile(v, 0.9) }
}

const shareIn = (v: readonly number[], lo: number, hi: number): number => (v.length ? v.filter((x) => x >= lo && x <= hi).length / v.length : NaN)

export interface AlignSummary {
  /** Share of cuts within +-1 bar of a silver boundary / within +-2 s / within +-1 bar of a strong one. */
  within1Bar: Shared
  within2s: Shared
  within1BarStrong: Shared
  /** Share of cuts that fall in [-1, +4] bars after some boundary. */
  followsBoundary: Shared
  /** COVERAGE: share of boundaries with a cut in [-1, +4] bars around them (strong, and all). */
  coverStrong: Shared
  coverAll: Shared
  /** Seconds from the preceding boundary to each cut; and from a covered strong boundary to its first cut. */
  sinceMedian: { real: number; chance: number }
  coverLagMedian: { real: number; chance: number }
}

export interface SystemSummary {
  tracks: number
  minutes: number
  cuts: number
  cutsPerMin: number
  /** Cuts scored for alignment (after the startup window). */
  scoredCuts: number
  /** Alignment of the post-startup cuts (the primary numbers) and of every cut. */
  post: AlignSummary
  all: AlignSummary
  intervalSec: DistSummary
  /** Interval in the app's own bars (beat counter / 4, as `cadenceMetrics`) and in silver bars. */
  intervalBarsApp: DistSummary & { in4to32: number; below4: number; above32: number }
  intervalBarsSilver: DistSummary & { in4to32: number }
  forcedShare: number
  silverBoundaries: { all: number; strong: number }
}

function alignSummary(tracks: readonly TrackSilverScore[], pick: (t: TrackSilverScore) => { real: CutCounts; chance: CutCounts }, samples?: (t: TrackSilverScore) => { real: CutSamples; chance: CutSamples }): AlignSummary {
  const R = emptyCounts()
  const C = emptyCounts()
  for (const t of tracks) {
    const p = pick(t)
    addCounts(R, p.real)
    addCounts(C, p.chance)
  }
  // (the chance counts are sums over `copies` shifted copies of every track, so their own denominators are the right ones)
  const sinceReal = samples ? tracks.flatMap((t) => samples(t).real.since) : []
  const sinceChance = samples ? tracks.flatMap((t) => samples(t).chance.since) : []
  const lagReal = samples ? tracks.flatMap((t) => samples(t).real.coverLag) : []
  const lagChance = samples ? tracks.flatMap((t) => samples(t).chance.coverLag) : []
  return {
    within1Bar: shared(R.within1Bar, R.cuts, C.within1Bar, C.cuts),
    within2s: shared(R.within2s, R.cuts, C.within2s, C.cuts),
    within1BarStrong: shared(R.within1BarStrong, R.cuts, C.within1BarStrong, C.cuts),
    followsBoundary: shared(R.followsBoundary, R.cuts, C.followsBoundary, C.cuts),
    coverStrong: shared(R.covStrong.covered, R.covStrong.boundaries, C.covStrong.covered, C.covStrong.boundaries),
    coverAll: shared(R.covAll.covered, R.covAll.boundaries, C.covAll.covered, C.covAll.boundaries),
    sinceMedian: { real: percentile(sinceReal, 0.5), chance: percentile(sinceChance, 0.5) },
    coverLagMedian: { real: percentile(lagReal, 0.5), chance: percentile(lagChance, 0.5) },
  }
}

/** Pool per-track scores into one system summary (a subset of tracks: filter before calling). */
export function summarizeSystem(tracks: readonly TrackSilverScore[]): SystemSummary {
  const minutes = tracks.reduce((s, t) => s + t.horizonSec, 0) / 60
  const cuts = tracks.reduce((s, t) => s + t.cutsAll, 0)
  const app = tracks.flatMap((t) => t.intervalsBarsApp)
  const sil = tracks.flatMap((t) => t.intervalsBarsSilver)
  const forced = tracks.reduce((s, t) => s + t.forcedCuts, 0)
  return {
    tracks: tracks.length,
    minutes,
    cuts,
    cutsPerMin: minutes > 0 ? cuts / minutes : NaN,
    scoredCuts: tracks.reduce((s, t) => s + t.post.real.cuts, 0),
    post: alignSummary(tracks, (t) => t.post, (t) => ({ real: t.post.samples, chance: t.post.chanceSamples })),
    all: alignSummary(tracks, (t) => t.all),
    intervalSec: dist(tracks.flatMap((t) => t.intervalsSec)),
    intervalBarsApp: {
      ...dist(app),
      in4to32: shareIn(app, 4, 32),
      below4: app.length ? app.filter((x) => x < 4).length / app.length : NaN,
      above32: app.length ? app.filter((x) => x > 32).length / app.length : NaN,
    },
    intervalBarsSilver: { ...dist(sil), in4to32: shareIn(sil, 4, 32) },
    forcedShare: cuts > 0 ? forced / cuts : NaN,
    silverBoundaries: { all: tracks.reduce((s, t) => s + t.boundaries.all, 0), strong: tracks.reduce((s, t) => s + t.boundaries.strong, 0) },
  }
}

// --- An event detector against the silver boundaries ---------------------------------------------------------------

export interface EventHits {
  nRef: number
  nEst: number
  /** One-to-one matches within +-1 bar, +-3 s, +-0.5 s. */
  hits1Bar: number
  hits3s: number
  hits05s: number
}

export interface TrackEventScore {
  id: string
  family: string
  horizonSec: number
  lowConfidence: boolean
  real: EventHits
  /** Sum over `copies` circularly shifted copies of the estimate (nEst counts every copy). */
  chance: EventHits
  copies: number
  /** Per-track F at 3 s / 0.5 s (mir_eval, no trim), for the macro average. */
  f3: number
  f05: number
}

function hitsOf(ref: readonly number[], est: readonly number[], barSec: number): EventHits {
  return {
    nRef: ref.length,
    nEst: est.length,
    hits1Bar: matchEvents(ref, est, barSec).pairs.length,
    hits3s: matchEvents(ref, est, 3).pairs.length,
    hits05s: matchEvents(ref, est, 0.5).pairs.length,
  }
}

/**
 * Score a detector's boundary times `est` (s, on the same clock, already limited to the scored span) against the silver
 * boundaries `refTimes` (also limited to it). `refTimes` is `ref.all` or `ref.strong`.
 */
export function scoreEventsVsSilver(
  id: string,
  family: string,
  ref: SilverRef,
  refTimes: readonly number[],
  est: readonly number[],
  horizonSec: number,
  opts: { chanceCopies?: number; seed?: number } = {},
): TrackEventScore {
  const copies = Math.max(1, opts.chanceCopies ?? 20)
  const rng = seededRng((opts.seed ?? 1) * 40503 + hashId(id))
  const r = refTimes.filter((x) => x <= horizonSec)
  const e = est.filter((x) => x <= horizonSec).sort((a, b) => a - b)
  const real = hitsOf(r, e, ref.barSec)
  const chance: EventHits = { nRef: 0, nEst: 0, hits1Bar: 0, hits3s: 0, hits05s: 0 }
  for (let k = 0; k < copies; k++) {
    const h = hitsOf(r, circularShift(e, horizonSec, rng() * horizonSec), ref.barSec)
    chance.nRef += h.nRef
    chance.nEst += h.nEst
    chance.hits1Bar += h.hits1Bar
    chance.hits3s += h.hits3s
    chance.hits05s += h.hits05s
  }
  return {
    id,
    family,
    horizonSec,
    lowConfidence: ref.lowConfidence,
    real,
    chance,
    copies,
    f3: mirEvalStyleDetectionF(r, e, 3).f,
    f05: mirEvalStyleDetectionF(r, e, 0.5).f,
  }
}

export interface PRF {
  precision: number
  recall: number
  f: number
}

export interface EventSummary {
  tracks: number
  nRef: number
  nEst: number
  /** Micro-averaged (pooled counts) within +-1 bar / +-3 s / +-0.5 s. */
  bar1: PRF
  s3: PRF
  s05: PRF
  /** The same under the random-phase control. */
  chanceBar1: PRF
  chanceS3: PRF
  chanceS05: PRF
  /** Macro F (mean of the per-track mir_eval F over tracks that have at least one reference boundary). */
  macroF3: number
  macroF05: number
  estPerMin: number
}

function prf(hits: number, nEst: number, nRef: number): PRF {
  const precision = nEst > 0 ? hits / nEst : 0
  const recall = nRef > 0 ? hits / nRef : 0
  return { precision, recall, f: fMeasure(precision, recall) }
}

export function summarizeEvents(tracks: readonly TrackEventScore[]): EventSummary {
  const sum = (f: (t: TrackEventScore) => number): number => tracks.reduce((s, t) => s + f(t), 0)
  const nRef = sum((t) => t.real.nRef)
  const nEst = sum((t) => t.real.nEst)
  const cRef = sum((t) => t.chance.nRef)
  const cEst = sum((t) => t.chance.nEst)
  const withRef = tracks.filter((t) => t.real.nRef > 0)
  const mean = (f: (t: TrackEventScore) => number): number => (withRef.length ? withRef.reduce((s, t) => s + f(t), 0) / withRef.length : NaN)
  const minutes = sum((t) => t.horizonSec) / 60
  return {
    tracks: tracks.length,
    nRef,
    nEst,
    bar1: prf(sum((t) => t.real.hits1Bar), nEst, nRef),
    s3: prf(sum((t) => t.real.hits3s), nEst, nRef),
    s05: prf(sum((t) => t.real.hits05s), nEst, nRef),
    chanceBar1: prf(sum((t) => t.chance.hits1Bar), cEst, cRef),
    chanceS3: prf(sum((t) => t.chance.hits3s), cEst, cRef),
    chanceS05: prf(sum((t) => t.chance.hits05s), cEst, cRef),
    macroF3: mean((t) => t.f3),
    macroF05: mean((t) => t.f05),
    estPerMin: minutes > 0 ? nEst / minutes : NaN,
  }
}

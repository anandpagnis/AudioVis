import type { EventType } from '../../audio/events/types'

/**
 * The show director's policy: every constant and the small pure formulas around them, in one place so the tuning
 * workflow (and the cadence simulation in the tests) reads the numbers the live director uses.
 *
 * ## The idea
 * Scene changes are decided by ONE score against ONE threshold that falls with how long the scene has been on:
 *
 *   S      = strength * typeWeight * confidence                    (how much the music just changed)
 *   T(a)   = 0.30 + 0.60 * clamp((12 - a) / 8, 0, 1)               (a = scene age in BARS; 0.90 at 4 bars -> 0.30 at 12)
 *   T_eff  = T(a) - 0.15 * P                                       (P = pressure 0..1; it only tips marginal events)
 *   CUT    when age >= minimum and S >= T_eff (a strong drop may cut from 2 bars);
 *   MICRO  when 0.25 <= S < T_eff (a proportionate tweak: palette / mode / layer / effect);
 *   HOLD   otherwise (staying put is a decision, and is logged with its reason).
 *
 * The legacy show gave every non-drop trigger the same 32-beat dwell and discarded edges that arrived during it, so it
 * changed scene at the first opportunity after the dwell, uncorrelated with the music. Here a strong change cuts
 * EARLY (its S clears a high threshold at a young age), weak ones wait for the threshold to fall, and a
 * forced ceiling guarantees the show never stagnates.
 *
 * ## Tuned on the real tracks (lane W2-B, `corpus/structure/director-replay.md`)
 * The first version (T ramp 16 bars, floor 0.35, no drop weighting) was replayed over the 98 cached real traces: the
 * toy simulation had used sectionChange-style noise only and no realistic false drops, and `f.drop` fires ~250 times an
 * hour there (median track 150/h) with only ~6% of the edges behind a build, so the director still cut on ~72% of
 * its cuts at a drop (a lone drop's confidence, the tracker's own drop echo and a coincident section change's constant
 * 0.95 each lifted lone drops into the fast lane: 531 hard cuts where only ~105 drops had a build behind them).
 * Now a drop is scored by what stands behind it (`legacyEvents.ts`: a build / breakdown release keeps the fast lane, a
 * lone drop starts at S = 0.44) and by how RARE the detector's drops are (`dropCredibility`: one of many in 32 bars
 * carries little information). The ramp was shortened to 12 bars / floor 0.30 so the show
 * still changes every 8-16 bars on the events it does trust, and the forced-ceiling share stays under 15%.
 *
 * ## Tempo robustness
 * Ages and cooldowns are measured in BARS (the musical unit) but clamped in SECONDS: the bar length used for the
 * conversion is bounded to [{@link SHOW.barSecMin}, {@link SHOW.barSecMax}] (160..80 BPM). At 60 BPM a bar is 4 s, so
 * bars alone would hold a scene for over a minute before the threshold relaxes; at 200 BPM a bar is 1.2 s and 4 bars
 * would be a 5 s scene. The clamp keeps both sane. The forced ceiling is the smaller of a bar count and a wall-clock.
 *
 * Pure: no React, store or three imports.
 */

export const SHOW = {
  /** `typeWeight`: fill / gain / buildStart weigh 0, so they can never cut (MICRO or arming only). */
  typeWeight: {
    drop: 1.25,
    change: 1.0,
    breakdown: 0.9,
    buildStart: 0,
    fill: 0,
    gain: 0,
  } as const satisfies Record<EventType, number>,
  /**
   * v2 EVENT GAIN. A live (`source: 'live'`, `?events=v2`) `change` / `breakdown` event has its own calibrated strength
   * (median 0.60, p90 0.90 over the 98 real tracks, `EventLayer.STRENGTH_ANCHORS`) and arrives ~1.3 times a minute, where
   * the legacy mapping's `sectionChange` edges arrive ~3.8 times a minute with their median at 0.30 (its strength map is
   * anchored to a noisy detector). Each v2 event therefore carries more information, and at gain 1 a typical one
   * (S ~ 0.4) had to wait for a scene of ~10 bars before it could cut, so many scenes ran to the forced ceiling.
   * The gain multiplies S of those events only; the legacy events, drops and everything else are untouched.
   *
   * Tuned in lane W3 (`corpus/structure/director-vs-silver.md`, sweep over the 98 cached tracks, split-half by even / odd
   * track): 1 -> 1.75 takes the forced-ceiling share 26% -> 21% (even 30% -> 23%, odd 22% -> 19%), cuts/min 1.62 -> 1.80,
   * the median scene 16.0 -> 14.0 bars, and the share of strong silver boundaries with a cut in [-1, +4] bars 45% -> 51%
   * (chance-corrected lift 0.23 -> 0.30, even 0.19 -> 0.27, odd 0.28 -> 0.33). Above ~2.5 every v2 event already cuts at
   * the minimum age (T(4) = 0.9 vs S ~ 0.42 x 2.5), so nothing more is gained. One constant, monotone in every metric, read
   * off the corpus the v2 strength curve was itself anchored on: relative evidence, not a validated optimum.
   */
  liveGain: 1.75,
  beatsPerBar: 4,

  /** T(a) = floor + span * clamp((rampEndBars - a) / rampBars, 0, 1). */
  thresholdFloor: 0.3,
  thresholdSpan: 0.6,
  rampEndBars: 12,
  rampBars: 8,

  /** No cut before this many bars on screen (a strong drop excepted, below). */
  minCutBars: 4,
  /** ... raised in a breakdown: hold the calm look longer. */
  breakdownMinCutBars: 8,
  /** A drop with S >= dropFastMinS may cut from dropFastMinBars. */
  dropFastMinBars: 2,
  dropFastMinS: 1.0,
  /** A drop earns a scene change only with this much history: a preceding build within this many bars. */
  buildMemoryBars: 16,
  /**
   * DROP CREDIBILITY (rarity weighting). On the 98 real tracks `f.drop` fires ~250 times an hour (the densest 10% of
   * tracks about once every 6 s) and only ~6% of the edges have a build behind them: a detector that fires constantly
   * carries little information per firing. A drop's score is multiplied by `dropCredibility[min(n, 3)]`, n = the OTHER
   * drop events seen in the last `dropWindowBars` bars (each physical drop counted once, however often it is
   * re-delivered). A drop that RELEASES a build or a breakdown (one running, or ended within `dropReleaseBars`) is
   * never discounted: it keeps its fast hard-cut lane.
   */
  dropWindowBars: 32,
  dropCredibility: [1, 0.9, 0.75, 0.5] as readonly number[],
  dropReleaseBars: 4,
  /** true: only the fast lane (a release-backed drop) is an IMMEDIATE hard cut; any other drop cut waits for the bar line. */
  dropImmediateOnlyFast: true,
  /** Two events this many beats apart are one physical change (drop + boundary). */
  corroborateBeats: 2,

  /** Forced change ceiling: min(32 bars, 60 s), and 48 bars / 90 s inside a breakdown. */
  ceilingBars: 32,
  ceilingSec: 60,
  breakdownCeilingBars: 48,
  breakdownCeilingSec: 90,
  /** The forced cut prefers the best-scoring event seen in this many trailing bars, else waits for the next bar line. */
  bestWindowBars: 4,

  /** Minimum bars between two CUTs (covers a request that has not committed yet). */
  refractoryBars: 4,

  /** MICRO band: microMinS <= S < T_eff, at most one per microCooldownBars. */
  microMinS: 0.25,
  microCooldownBars: 4,

  /** Pressure: T_eff = T - pressureGain * P; each source is a decaying bump, P is their max. */
  pressureGain: 0.15,
  pressureDecayBars: 8,
  bumpMood: 1.0,
  bumpCharacter: 0.8,
  bumpTrend: 0.6,
  bumpPredicted: 0.5,

  /** Bar length bounds (seconds) for the bars <-> seconds clamp: 160 BPM .. 80 BPM. */
  barSecMin: 1.5,
  barSecMax: 3.0,
} as const

/**
 * S = strength * typeWeight * confidence, each factor clamped to its range; non-finite reads as 0. A live (v2) `change` /
 * `breakdown` event is scaled by {@link SHOW.liveGain}; pass the event's `source` to get that (omitted: the legacy score).
 */
export function eventScore(type: EventType, strength: number, confidence: number, source?: 'live' | 'plan' | 'legacy'): number {
  const w = SHOW.typeWeight[type] ?? 0
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0
  const c = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0
  const gain = source === 'live' && (type === 'change' || type === 'breakdown') ? SHOW.liveGain : 1
  return s * w * c * gain
}

/** Rarity weight of a drop when `others` other drop events were seen inside the window (1 = fully credible). */
export function dropCredibility(others: number): number {
  const t = SHOW.dropCredibility
  const k = Number.isFinite(others) ? Math.min(t.length - 1, Math.max(0, Math.floor(others))) : 0
  return t[k]
}

/** The age threshold T(a), a in bars. Non-finite or negative ages read as a fresh scene (the highest threshold). */
export function ageThreshold(ageBars: number): number {
  const a = Number.isFinite(ageBars) ? ageBars : SHOW.rampEndBars
  const ramp = Math.min(1, Math.max(0, (SHOW.rampEndBars - a) / SHOW.rampBars))
  return SHOW.thresholdFloor + SHOW.thresholdSpan * ramp
}

/** T_eff = T(a) - 0.15 * P, P clamped to 0..1. Pressure lowers the bar, it never removes the score requirement. */
export function effectiveThreshold(ageBars: number, pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0
  return ageThreshold(ageBars) - SHOW.pressureGain * p
}

/**
 * Bars elapsed between two moments, tempo-robust: the beat count says `(beat - beat0) / 4`, but the result is clamped
 * to what the wall clock allows for a bar of [barSecMin, barSecMax] seconds. A frozen or wildly slow beat counter
 * therefore still ages a scene, and a very fast tempo does not shrink the minimum scene time below ~6 s.
 * Negative elapsed (a new source restarted the clocks) reads as 0.
 */
export function barsBetween(beat0: number, time0: number, beat: number, time: number): number {
  // NaN reads as "no elapsed time"; a -Infinity start ("never happened") reads as infinitely long ago.
  let sec = time - time0
  let beats = beat - beat0
  if (sec !== sec) sec = 0
  if (beats !== beats) beats = 0
  const lo = Math.max(0, sec) / SHOW.barSecMax
  const hi = Math.max(0, sec) / SHOW.barSecMin
  const bars = Math.max(0, beats) / SHOW.beatsPerBar
  return Math.min(hi, Math.max(lo, bars))
}

/** The minimum scene age before a non-drop CUT is allowed. */
export function minCutBars(inBreakdown: boolean): number {
  return inBreakdown ? SHOW.breakdownMinCutBars : SHOW.minCutBars
}

/** Has the forced-change ceiling been reached? min(bars, seconds), on the RAW bar count (not the clamped age). */
export function ceilingReached(ageBeats: number, ageSec: number, inBreakdown: boolean): boolean {
  const bars = inBreakdown ? SHOW.breakdownCeilingBars : SHOW.ceilingBars
  const sec = inBreakdown ? SHOW.breakdownCeilingSec : SHOW.ceilingSec
  return ageBeats / SHOW.beatsPerBar >= bars || ageSec >= sec
}

/** Bars until the forced ceiling given the current raw age (0 once reached). For the overlay's ETA. */
export function barsToCeiling(ageBeats: number, ageSec: number, bpm: number, inBreakdown: boolean): number {
  const bars = inBreakdown ? SHOW.breakdownCeilingBars : SHOW.ceilingBars
  const sec = inBreakdown ? SHOW.breakdownCeilingSec : SHOW.ceilingSec
  const byBars = bars - ageBeats / SHOW.beatsPerBar
  const barSec = Number.isFinite(bpm) && bpm > 0 ? (SHOW.beatsPerBar * 60) / bpm : 2
  const bySec = (sec - ageSec) / Math.max(SHOW.barSecMin, Math.min(SHOW.barSecMax, barSec))
  const eta = Math.min(byBars, bySec)
  return Number.isFinite(eta) ? Math.max(0, eta) : 0
}

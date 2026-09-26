/**
 * The LIVE EVENT LAYER (`?events=v2`): turns the per-beat cells of the slow analyser into typed, bar-aligned
 * `SectionEvent`s with a lag of about six beats. It replaces `f.sectionChange` and the analyser's late boundaries as the
 * source of `change` events, and (`gapDrop.ts`) of `drop` events: the low end returning after a dropout of at least a bar. The
 * legacy `f.drop` is demoted under v2 (`eventMux.ts`); build starts stay with `legacyEvents.ts`.
 *
 *   BeatCell --extractFeatures--> FeatureRing --ChangeScorer--> Candidate --type/grid/sim--> SectionEvent --> ring
 *
 * The pieces (all pure, all unit-tested on synthetic feature streams):
 *  - `rawTap.ts`      raw dB channels the engine copies beside its normaliser (so "louder" is visible);
 *  - `barFeatures.ts` the eight change channels and the window arithmetic;
 *  - `changeScorer.ts` whitened score, adaptive threshold, local-max peaks, refractory, persistence;
 *  - `barGrid.ts`     the boundary-anchored bar grid (prior, snap, `beatsToBarLine` for the show adapter);
 *  - this file        typing, silence / jump handling, section signatures (`sim`), calibration, the delivery ring.
 *
 * ## Event types
 *  - `change`     a scene-class change that PERSISTS (the beats after the peak stay unlike the old baseline);
 *  - `fill`       a transient: the score spiked and the beats after it returned to the baseline (`persist` below
 *                 {@link EventLayerConfig.fillPersist} AND the beats after the peak back under
 *                 {@link EventLayerConfig.fillRecentFrac} of the acceptance threshold): a drum fill or a stab. Weight 0 in the
 *                 director: punctuation. A candidate the ratio calls a fill but that still clears that bar is AMBIGUOUS (a change
 *                 that stays, or a fill that has not ended) and is held {@link EventLayerConfig.fillHoldBeats} more beats, then
 *                 typed on the longer stretch after the peak: before this, the first hump of a real change (a saturating peak has
 *                 a small persistence RATIO) was a `fill` and the `change` came 2-4 s later and weaker (tap logs);
 *  - `drop`       the low band (sub+bass) was out (>= 10 dB under its trailing median, >= 4 cells and 1.75 s) and is whole again
 *                 (`gapDrop.ts`; `strength` / `confidence` grow with the gap; `corroborated`: a dropout AND a return);
 *  - `gain`       only the level channel moved (the shape score, which leaves it out, is below
 *                 {@link EventLayerConfig.gainShapeMax}): a volume knob. Weight 0: suppressed;
 *  - `breakdown`  a low-band dropout (sub+bass fell by >= {@link EventLayerConfig.breakdownLowDb} dB and the level with
 *                 it) that is still there `peakHalf` beats after the peak. It is decided at detection time, so it
 *                 cannot wait for two full bars; a one-bar pull-back can be mistaken for a breakdown;
 *  - a SILENCE GAP is never an event: cells that are (mostly) silent, or far below the recent level, are dropped from
 *    every window (with the partial cell before them), the peak window is invalidated, and scoring resumes
 *    {@link EventLayerConfig.postGapBeats} beats after the music returns (the chroma EMA and the normaliser need that to
 *    settle). A gap of >= `gridResetGapBeats` cells forgets the bar phase; >= `resetGapBeats` is a new song and
 *    everything resets. A backwards beat counter is a new source (full reset).
 *
 * ## The bar grid lives in the CELL-SEQUENCE domain
 * The engine's `beatIndex` jumps (a grid re-lock advances it by up to 4 for ONE cell of audio, ~3 times a minute on real
 * music), so `beatIndex % 4` is not a bar phase. The layer numbers the cells it receives itself (+1 per cell, silent
 * ones included), learns the phase from the boundaries in THAT domain (`boundarySeq`), and maps to and from the engine's
 * beat numbers with the latest offset (`beatsToBarLine`, `beatInBar`). An index jump therefore costs nothing; an
 * octave-type tempo re-lock (bpm x2, x0.5, x1.5, x2/3 against its own slow average) changes what a beat is and resets the
 * grid, but keeps the feature history (the features do not depend on the grid). Ordinary tempo wobble does nothing.
 *
 * ## `sim` (return to earlier material)
 * Every section start (and the first beats of the track) stores a SIGNATURE: the mean feature vector of its first
 * {@link EventLayerConfig.sigBeats} beats. At each `change`/`breakdown` the new section's signature is compared, after
 * whitening with the track's own running mean/std per dimension, by cosine with every EARLIER section except the one
 * just left; the best match at or above {@link EventLayerConfig.simMin} becomes `SectionEvent.sim`, so a chorus can
 * reuse its earlier palette / scene family. The level is left out of the signature (a volume change must not hide a
 * repeat).
 *
 * ## Calibration (0..1)
 * `strength` maps the whitened score `s` through a piecewise-linear curve anchored at corpus percentiles of accepted
 * events (`STRENGTH_ANCHORS`: the floor, the median real event -> 0.6, p90 -> 0.9, p99 -> 1). `confidence` is
 * 0.30 + 0.30 * persistence + 0.20 * grid agreement + 0.20 * channel-group agreement (see `confidenceOf`).
 *
 * ## Constants and what they were tuned against
 * All defaults are in `DEFAULT_SCORER` / `DEFAULT_EVENT_LAYER` / `DEFAULT_BAR_GRID`; `corpus/structure/events-v2.md`
 * (`scripts/calibrate/events-report.calib.ts`) reproduces every number: the synthetic suite (recall +-1 bar, false alarms,
 * negatives, lag, three seeds), the event rate per genre on 98 real tracks, the per-track channel noise the sigma floors
 * were read from, and the score distribution the strength curve is anchored on.
 *
 * ## Delivery
 * `push` returns the events created by this beat (a shared empty array when there are none: no allocation in steady
 * state). They are also copied into a fixed ring of {@link EventLayerConfig.ringSize} preallocated events, read with
 * `drain(out)` (one consumer) or `readSince(seq, out)` (any number). Ring events are REUSED: copy what you keep.
 * `detectedAtBeat/Time` are honest: the beat the peak was confirmed on, about six beats after `boundaryBeat`.
 */
import {
  CH_HARMONY,
  CH_HIGH,
  CH_LEVEL,
  CH_LOW,
  CH_MID,
  CH_RHYTHM,
  CH_TEXTURE,
  CH_TIMBRE,
  FEATURE_DIM,
  OFF_CHROMA,
  RunningMoments,
  SIG_DIM,
  SIG_OFF,
  extractFeatures,
} from './barFeatures'
import { BarGrid, type BarGridConfig } from './barGrid'
import { ChangeScorer, DEFAULT_SCORER, copyCandidate, makeCandidate, type Candidate, type ScorerConfig } from './changeScorer'
import { GapDropDetector, type GapDropConfig, type GapDropFire } from './gapDrop'
import type { BeatCell } from '../essentia/structureDsp'
import type { EventType, SectionEvent } from './types'

export interface EventLayerConfig {
  scorer: Partial<ScorerConfig>
  grid: Partial<BarGridConfig>
  /** The gap -> snap-back drop detector (`gapDrop.ts`); `false` turns it off (no `drop` events from this layer). */
  gapDrop: Partial<GapDropConfig> | false
  /** A candidate whose post-peak beats keep less than this share of the peak score is a `fill`. */
  fillPersist: number
  /**
   * ... AND the beats after the peak must also have fallen back under this share of the acceptance threshold (`recentS < fillRecentFrac * thr`).
   * The persistence ratio alone is relative to the PEAK, and a big change's peak saturates (score 30): its two beats after the peak
   * still score 4 against a bar of 5, a ratio of 0.14, and were typed a fill (the first hump of a real change, with the `change`
   * arriving 2-4 s later and weaker). A fill RETURNS to the baseline: in absolute terms too. Infinity restores the ratio-only rule.
   */
  fillRecentFrac: number
  /**
   * A candidate that the ratio calls a fill (`persist < fillPersist`) but whose beats after the peak are still above
   * `fillRecentFrac` of the threshold is AMBIGUOUS: a change that stays, or a fill that has not ended yet (a two-bar fill is
   * still going two beats after its peak). It is HELD for this many more beats, then typed on the longer stretch after the peak
   * (`ChangeScorer.recentScoreOver`): a fill has returned to the baseline by then, a change has not. The event is delivered
   * at that later beat (honest `detectedAt`); unambiguous candidates are not delayed. 0 = do not hold: an ambiguous
   * candidate is typed as a change at once.
   */
  fillHoldBeats: number
  /** Refractory (beats from the peak) after a `fill`, shorter than after a change. */
  fillRefractoryBeats: number
  /** Only-the-level-moved test: the score without the level channel below this is a `gain`. */
  gainShapeMax: number
  /** ... and the level must have moved by at least this many dB. */
  gainMinDb: number
  /** Breakdown: the low band (sub+bass) fell by at least this many dB (negative), the level fell by this much too. */
  breakdownLowDb: number
  breakdownLevelDb: number
  /** Signature length in beats, the similarity that counts as "returns to earlier material", sections remembered. */
  sigBeats: number
  /** Cells at the very start of a source that are left out of the first section's signature. */
  sigSkip: number
  simMin: number
  /** Silence: a cell is a gap when `silent >= gapSilentFrac`, its RMS is under `gapAbsDb`, or `gapRelDb` under the recent level. */
  gapSilentFrac: number
  gapAbsDb: number
  gapRelDb: number
  postGapBeats: number
  resetGapBeats: number
  /** Grid jump / tempo jump handling. */
  /** A bpm change by a ratio within this (relative) tolerance of 2, 1.5, 2/3 or 1/2 is an octave-type re-lock. */
  octaveTolerance: number
  jumpSuppressBeats: number
  /** A silence gap of this many cells forgets the bar phase (a shorter one keeps it). */
  gridResetGapBeats: number
  /** Delivery ring size. */
  ringSize: number
}

export const DEFAULT_EVENT_LAYER: Readonly<EventLayerConfig> = Object.freeze({
  scorer: {},
  grid: {},
  gapDrop: {},
  fillPersist: 0.7,
  fillRecentFrac: 0.8,
  fillHoldBeats: 2,
  fillRefractoryBeats: 4,
  gainShapeMax: 1.8,
  gainMinDb: 1.0,
  breakdownLowDb: -4,
  breakdownLevelDb: -1.5,
  sigBeats: 6,
  sigSkip: 2,
  simMin: 0.75,
  gapSilentFrac: 0.5,
  gapAbsDb: -70,
  gapRelDb: -30,
  postGapBeats: 8,
  resetGapBeats: 16,
  octaveTolerance: 0.1,
  jumpSuppressBeats: 0,
  gridResetGapBeats: 8,
  ringSize: 16,
})

/**
 * Strength calibration: `[score s, strength]` knots, linear between, clamped outside. The score is already whitened
 * per track (z units), so the same curve serves every genre. The knots are percentiles of the scores of ACCEPTED
 * scene-class events over the 98 real corpus tracks (first 240 s each, 411 events, `corpus/structure/events-v2.md`,
 * measured with the default scorer): the acceptance floor (4) -> 0.25, the median (7.2) -> 0.6, p90 (20) -> 0.9 and
 * p99 (48) -> 1.0. A typical real change therefore reads ~0.6 (a tweak to the show director), a big one ~0.9.
 */
export const STRENGTH_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [4, 0.25],
  [7.2, 0.6],
  [20, 0.9],
  [48, 1],
]

export function strengthOf(s: number): number {
  const a = STRENGTH_ANCHORS
  if (Number.isNaN(s) || s <= a[0][0]) return a[0][1]
  for (let i = 1; i < a.length; i++) {
    if (s <= a[i][0]) {
      const t = (s - a[i - 1][0]) / (a[i][0] - a[i - 1][0])
      return a[i - 1][1] + t * (a[i][1] - a[i - 1][1])
    }
  }
  return a[a.length - 1][1]
}

const OCTAVE_RATIOS = [0.5, 2 / 3, 1.5, 2]
/** Is a tempo ratio (new / slow average) an octave-type jump (halving, doubling, 3:2, 2:3)? */
export function isOctaveJump(ratio: number, tol: number): boolean {
  if (!(ratio > 0)) return false
  for (const r of OCTAVE_RATIOS) if (Math.abs(ratio / r - 1) <= tol) return true
  return false
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const NO_EVENTS: readonly SectionEvent[] = Object.freeze([]) as readonly SectionEvent[]

export interface DownbeatHint {
  locked: boolean
  /** `(beatIndex - beatInBar) mod 4` in force: bar lines are the beats with `(beat - offset) % 4 === 0`. */
  offset: number
}

export interface EventLayerStats {
  beats: number
  scored: number
  candidates: number
  changes: number
  fills: number
  gains: number
  breakdowns: number
  drops: number
  gapCells: number
  resets: number
  jumps: number
}

function makeEvent(): SectionEvent {
  return {
    id: 0,
    type: 'change',
    strength: 0,
    confidence: 0,
    boundaryBeat: 0,
    boundaryTime: 0,
    detectedAtBeat: 0,
    detectedAtTime: 0,
    source: 'live',
    phase: 0,
    feats: { level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0 },
    sim: undefined,
    corroborated: false,
  }
}

const MAX_SECTIONS = 16
/** The signature dimensions that take part in the similarity: everything before the chroma block. */
const SIM_DIM = OFF_CHROMA - SIG_OFF

export class EventLayer {
  readonly cfg: EventLayerConfig
  readonly scorer: ChangeScorer
  readonly grid: BarGrid
  /** The gap -> snap-back drop detector (null when `cfg.gapDrop` is false). */
  readonly gapDrop: GapDropDetector | null
  readonly stats: EventLayerStats = {
    beats: 0,
    scored: 0,
    candidates: 0,
    changes: 0,
    fills: 0,
    gains: 0,
    breakdowns: 0,
    drops: 0,
    gapCells: 0,
    resets: 0,
    jumps: 0,
  }

  /**
   * Diagnostics of the last EMITTED event, captured BEFORE it voted for the grid: its unsnapped boundary estimate,
   * whether the grid was confident enough to snap, and whether the estimate already sat on the anchored bar line
   * (within half a beat). A random phase would be "on" a quarter of the time: the gap is the evidence that section
   * changes really fall on bars.
   */
  readonly lastEmit = { rawBoundary: 0, gridReady: false, rawOnGrid: false, s: 0, persist: 0, recentRatio: 0 }

  private readonly moments = new RunningMoments(SIG_DIM)
  private readonly events: SectionEvent[]
  private readonly simObjs: Array<{ boundaryBeat: number; similarity: number }>
  private seq = 0
  private drained = 0
  private nextId = 1
  /** The drop the current `push` completed (set by `stepGap`, delivered by `push`). */
  private pendingDrop: SectionEvent | null = null
  /** An ambiguous candidate being held for `fillHoldBeats` more scored beats (see the config), and its copy. */
  private held = false
  private heldWait = 0
  private readonly heldCand: Candidate = makeCandidate()

  // per-source state
  private lastBeat = Number.NaN
  /** Grid-domain sequence: +1 per incoming cell (silent ones included), unaffected by jumps of the engine's beat index. */
  private seq0 = 0
  /** `beatIndex - seq` of the newest cell: maps the engine's beat numbers into the grid domain (`beatsToBarLine`). */
  private offsetSeq = 0
  private lastTime = Number.NEGATIVE_INFINITY
  private bpmAvg = 0
  private levelRef = Number.NaN
  private validCells = 0
  private inGap = false
  private gapCells = 0
  /** The long-gap reset already happened for the gap in progress (one reset per gap, not one per silent cell). */
  private gapResetDone = false
  /** Valid beats since the last gap ended (Infinity = none); scoring waits for `postGapBeats`. */
  private sinceGap = Number.POSITIVE_INFINITY

  // section signatures
  private readonly secBeat = new Float64Array(MAX_SECTIONS)
  private readonly secSig = new Float64Array(MAX_SECTIONS * SIG_DIM)
  private secCount = 0
  private secHead = 0
  private readonly sigAcc = new Float64Array(SIG_DIM)
  private sigAccN = 0
  private sigFirstBeat = 0
  private readonly tmpMean = new Float64Array(FEATURE_DIM)
  private readonly wA = new Float64Array(SIG_DIM)
  private readonly wB = new Float64Array(SIG_DIM)

  constructor(cfg: Partial<EventLayerConfig> = {}) {
    this.cfg = { ...DEFAULT_EVENT_LAYER, ...cfg }
    this.scorer = new ChangeScorer({ ...DEFAULT_SCORER, ...this.cfg.scorer })
    this.grid = new BarGrid(this.cfg.grid)
    this.gapDrop = this.cfg.gapDrop === false ? null : new GapDropDetector(this.cfg.gapDrop)
    this.events = Array.from({ length: this.cfg.ringSize }, makeEvent)
    this.simObjs = Array.from({ length: this.cfg.ringSize }, () => ({ boundaryBeat: 0, similarity: 0 }))
  }

  /** Forget the current source (a new track, a backwards clock, a long silence). The delivery ring and ids are kept. */
  reset(): void {
    this.scorer.reset()
    this.grid.reset()
    this.gapDrop?.reset()
    this.held = false
    this.moments.reset()
    this.lastBeat = Number.NaN
    this.seq0 = 0
    this.offsetSeq = 0
    this.lastTime = Number.NEGATIVE_INFINITY
    this.bpmAvg = 0
    this.levelRef = Number.NaN
    this.validCells = 0
    this.inGap = false
    this.gapCells = 0
    this.gapResetDone = false
    this.sinceGap = Number.POSITIVE_INFINITY
    this.secCount = 0
    this.secHead = 0
    this.sigAccN = 0
    this.sigAcc.fill(0)
    this.stats.resets++
  }

  /** Beats seen since the source started (for tests and the overlay). */
  get scoreSamples(): number {
    return this.scorer.scoreSamples
  }

  /**
   * Feed one beat cell. `beat` is the engine beat index the cell closed on (`f.beatIndex`), `time` the audio clock,
   * `bpm` the tempo read, `downbeat` the (optional) `DownbeatEstimator` state, used only as a tie-breaker for the grid.
   * Returns the events this beat created (a shared empty array when none).
   */
  push(cell: BeatCell, beat: number, time: number, bpm: number, downbeat?: DownbeatHint): readonly SectionEvent[] {
    this.pendingDrop = null
    const inner = this.pushCell(cell, beat, time, bpm, downbeat)
    const dropEv = this.pendingDrop
    if (dropEv === null) return inner
    this.pendingDrop = null
    return inner.length === 0 ? [dropEv] : [dropEv, ...inner]
  }

  /** The low band of a cell in dB (mean of sub and bass), for the gap detector; NaN when the cell has no raw tap. */
  private stepGap(cell: BeatCell, beat: number, time: number): void {
    const gd = this.gapDrop
    if (gd === null) return
    const raw = cell.raw
    if (raw === undefined || raw.length < 7) return
    const low = 0.5 * (Math.max(-120, raw[0]) + Math.max(-120, raw[1]))
    const fire = gd.push(low, time, beat)
    // delivered NOW so the ring order is drop, then any change candidate of the same beat
    if (fire !== null) this.pendingDrop = this.emitDrop(fire)
  }

  private pushCell(cell: BeatCell, beat: number, time: number, bpm: number, downbeat?: DownbeatHint): readonly SectionEvent[] {
    const c = this.cfg
    if (!Number.isFinite(beat) || !Number.isFinite(time)) return NO_EVENTS
    const bpmOk = Number.isFinite(bpm) && bpm > 20 && bpm < 400 ? bpm : 120
    this.stats.beats++

    // --- a new source, a duplicate, a skipped beat -----------------------------------------------------------------
    if (!Number.isNaN(this.lastBeat)) {
      if (beat < this.lastBeat || time < this.lastTime - 0.25) this.reset()
      else if (beat === this.lastBeat) return NO_EVENTS
      else if (beat - this.lastBeat > 1) {
        // The engine's beat index jumped (a grid re-lock advances it by up to 4 for ONE cell of audio). The cells are
        // still consecutive, so the features, the windows AND the grid (learned in the cell-sequence domain) are fine.
        this.stats.jumps++
      }
    }
    this.lastBeat = beat
    this.lastTime = time
    this.seq0++
    this.offsetSeq = beat - this.seq0
    this.stepGap(cell, beat, time)

    // --- tempo: an octave-type re-lock (halving, doubling, 3:2) changes what a "beat" is, so the bar phase learned so
    // far means nothing. Ordinary tempo wobble does not. -------------------------------------------------------------------
    if (this.bpmAvg <= 0) this.bpmAvg = bpmOk
    else {
      const ratio = bpmOk / this.bpmAvg
      if (isOctaveJump(ratio, c.octaveTolerance)) {
        this.stats.jumps++
        this.grid.reset()
        if (c.jumpSuppressBeats > 0) this.scorer.suppressNext(c.jumpSuppressBeats)
        this.bpmAvg = bpmOk
      } else this.bpmAvg += 0.05 * (bpmOk - this.bpmAvg)
    }
    // the estimator's bar lines are `(beat - offset) % 4 === 0` in engine beats; in the grid domain: (offset - offsetSeq) % 4
    if (downbeat) this.grid.setHint(downbeat.locked, downbeat.offset - this.offsetSeq)

    // --- silence gap ---------------------------------------------------------------------------------------------------
    const rms = cell.raw !== undefined && cell.raw.length >= 7 && Number.isFinite(cell.raw[6]) ? cell.raw[6] : Number.NaN
    const silent = Number.isFinite(cell.silent) ? (cell.silent as number) : 0
    const gapCell =
      silent >= c.gapSilentFrac ||
      (!Number.isNaN(rms) && (rms < c.gapAbsDb || (!Number.isNaN(this.levelRef) && this.validCells >= 8 && rms < this.levelRef + c.gapRelDb)))
    if (gapCell) {
      this.stats.gapCells++
      if (!this.inGap) {
        this.inGap = true
        this.gapCells = 0
        // the newest committed cell overlapped the start of the gap: it is tainted too
        if (this.scorer.ring.count > 0) this.scorer.ring.dropNewest(1)
        this.scorer.invalidate()
        this.held = false
      }
      this.gapCells++
      // A long gap loses the bar phase (the tracker's grid drifts through silence); a short one keeps it.
      if (this.gapCells === c.gridResetGapBeats) this.grid.reset()
      if (this.gapCells >= c.resetGapBeats && !this.gapResetDone) {
        const keepGap = this.gapCells
        this.reset()
        this.lastBeat = beat
        this.lastTime = time
        this.seq0 = 1
        this.offsetSeq = beat - 1
        this.bpmAvg = bpmOk
        this.inGap = true
        this.gapCells = keepGap
        this.gapResetDone = true
      }
      return NO_EVENTS
    }
    if (this.inGap) {
      this.inGap = false
      this.gapResetDone = false
      this.sinceGap = 0
      // the first cell after a gap is partial: leave it out of every window
      return NO_EVENTS
    }
    if (Number.isFinite(rms)) this.levelRef = Number.isNaN(this.levelRef) ? rms : this.levelRef + 0.03 * (rms - this.levelRef)

    // --- features ----------------------------------------------------------------------------------------------------------
    const ring = this.scorer.ring
    const off = ring.writeOffset()
    extractFeatures(cell, ring.data, off)
    ring.commit(beat, time, this.seq0)
    this.moments.add(ring.data, off + SIG_OFF)
    this.validCells++
    this.trackFirstSignature(off, beat)

    if (this.sinceGap < c.postGapBeats) {
      this.sinceGap++
      return NO_EVENTS
    }
    this.stats.scored++
    const cand = this.scorer.step(60 / (this.bpmAvg > 0 ? this.bpmAvg : bpmOk), this.grid)
    if (this.held && --this.heldWait <= 0) {
      const ev = this.resolveHeld()
      if (cand === null) return ev
    }
    if (cand === null) return NO_EVENTS
    this.stats.candidates++
    return this.emit(cand)
  }

  /** The first `sigBeats` cells of the track are the first section's signature. */
  private trackFirstSignature(off: number, beat: number): void {
    // The first cells after the tracker locks are partial (the analyser's chroma and the normaliser are still
    // settling): skip `sigSkip` of them.
    if (this.secCount > 0 || this.sigAccN >= this.cfg.sigBeats) return
    if (this.validCells <= this.cfg.sigSkip) return
    const d = this.scorer.ring.data
    if (this.sigAccN === 0) this.sigFirstBeat = beat
    for (let i = 0; i < SIG_DIM; i++) this.sigAcc[i] += d[off + SIG_OFF + i]
    this.sigAccN++
    if (this.sigAccN === this.cfg.sigBeats) {
      const inv = 1 / this.sigAccN
      const slot = this.secHead
      for (let i = 0; i < SIG_DIM; i++) this.secSig[slot * SIG_DIM + i] = this.sigAcc[i] * inv
      this.secBeat[slot] = this.sigFirstBeat - 1
      this.secHead = (slot + 1) % MAX_SECTIONS
      this.secCount = 1
    }
  }

  /** The type of a candidate, or `hold` when it is ambiguous between a change that stays and a fill that has not ended (see `fillHoldBeats`). */
  private typeOf(cand: Candidate): EventType | 'hold' {
    const c = this.cfg
    if (cand.persist < c.fillPersist) {
      if (cand.recentS < c.fillRecentFrac * cand.thr) return 'fill'
      if (c.fillHoldBeats > 0) return 'hold'
    }
    return this.typeNoFill(cand)
  }

  /** The held candidate, typed on the longer stretch after its peak: a fill has returned to the baseline, a change has not. */
  private resolveHeld(): readonly SectionEvent[] {
    const c = this.cfg
    const cand = this.heldCand
    this.held = false
    const ring = this.scorer.ring
    const k = (c.scorer.peakHalf ?? DEFAULT_SCORER.peakHalf) + c.fillHoldBeats
    const rs = this.scorer.recentScoreOver(k)
    cand.detectedBeat = ring.beatAt(0)
    cand.detectedTime = ring.timeAt(0)
    if (Number.isFinite(rs)) {
      cand.recentS = rs
      cand.persist = cand.s > 0 ? rs / cand.s : 1
    }
    const ended = Number.isFinite(rs) && rs < c.fillRecentFrac * cand.thr
    return this.emit(cand, ended ? 'fill' : this.typeNoFill(cand))
  }

  private typeNoFill(cand: Candidate): EventType {
    const c = this.cfg
    if (cand.shape < c.gainShapeMax && Math.abs(cand.levelDelta) >= c.gainMinDb) return 'gain'
    if (cand.lowAbsDelta <= c.breakdownLowDb && cand.levelDelta <= c.breakdownLevelDb && cand.recentLowAbsDelta <= 0.5 * c.breakdownLowDb) {
      return 'breakdown'
    }
    return 'change'
  }

  private confidenceOf(cand: Candidate, gridAgree: number): number {
    // group agreement: how many of {level, low band, timbre-ish, harmony, rhythm} carry a real z
    const z = cand.z
    const groups =
      (z[CH_LEVEL] >= 2 ? 1 : 0) +
      (z[CH_LOW] >= 2 ? 1 : 0) +
      (Math.max(z[CH_TIMBRE], z[CH_MID], z[CH_HIGH], z[CH_TEXTURE]) >= 2 ? 1 : 0) +
      (z[CH_HARMONY] >= 2 ? 1 : 0) +
      (z[CH_RHYTHM] >= 2 ? 1 : 0)
    const agree = clamp01(groups / 3)
    const persist = clamp01(cand.persist)
    return clamp01(0.3 + 0.3 * persist + 0.2 * gridAgree + 0.2 * agree)
  }

  private emit(cand: Candidate, forced?: EventType): readonly SectionEvent[] {
    const c = this.cfg
    const t0 = forced ?? this.typeOf(cand)
    if (t0 === 'hold') {
      // ambiguous: keep a copy (the scorer reuses its candidate) and decide `fillHoldBeats` scored beats from now
      copyCandidate(this.heldCand, cand)
      this.held = true
      this.heldWait = c.fillHoldBeats
      return NO_EVENTS
    }
    const type: EventType = t0
    const st = this.stats
    let strength = strengthOf(cand.sEff)
    // Typed events choose their own refractory: a fill must not shadow the change that follows it.
    if (type === 'fill') {
      this.scorer.setLastPeakStep(cand.peakStep - (c.scorer.refractoryBeats ?? DEFAULT_SCORER.refractoryBeats) + c.fillRefractoryBeats)
      this.scorer.clearLastBoundary()
      st.fills++
    } else if (type === 'gain') st.gains++
    else if (type === 'breakdown') st.breakdowns++
    else st.changes++

    const sceneClass = type === 'change' || type === 'breakdown'
    this.lastEmit.s = cand.sEff
    this.lastEmit.persist = cand.persist
    this.lastEmit.recentRatio = cand.thr > 0 ? cand.recentS / cand.thr : 0
    this.lastEmit.rawBoundary = cand.boundarySeqRaw
    this.lastEmit.gridReady = this.grid.snapReady()
    this.lastEmit.rawOnGrid = this.lastEmit.gridReady && Math.abs(cand.boundarySeqRaw - this.grid.snap(cand.boundarySeqRaw)) <= 0.5
    let gridAgree = 0.5
    if (this.grid.anchored()) gridAgree = cand.onGrid || this.grid.beatInBar(cand.boundarySeq) === 0 ? 1 : 0
    let sim: { boundaryBeat: number; similarity: number } | null = null
    if (sceneClass) {
      // The raw (unsnapped) estimate votes: the snapped one would confirm the grid with itself.
      this.grid.addBoundary(cand.boundarySeqRaw, Math.max(0.5, strength))
      sim = this.findSimilar(cand)
    }
    if (type === 'gain') strength = Math.min(strength, 0.3)

    const slot = this.seq % this.events.length
    const ev = this.events[slot]
    ev.id = this.nextId++
    ev.type = type
    ev.strength = strength
    ev.confidence = this.confidenceOf(cand, gridAgree)
    ev.boundaryBeat = cand.boundaryBeat
    ev.boundaryTime = cand.boundaryTime
    ev.detectedAtBeat = cand.detectedBeat
    ev.detectedAtTime = cand.detectedTime
    ev.source = 'live'
    const bib = this.grid.beatInBar(cand.boundarySeq)
    ev.phase = bib >= 0 ? bib : 0
    const z = cand.z
    const w = this.scorer.cfg.weights
    ev.feats.level = z[CH_LEVEL]
    ev.feats.low = z[CH_LOW]
    ev.feats.harmony = z[CH_HARMONY]
    ev.feats.rhythm = z[CH_RHYTHM]
    const wt = w[CH_TIMBRE] + w[CH_MID] + w[CH_HIGH] + w[CH_TEXTURE]
    ev.feats.timbre = Math.sqrt(
      (w[CH_TIMBRE] * z[CH_TIMBRE] * z[CH_TIMBRE] +
        w[CH_MID] * z[CH_MID] * z[CH_MID] +
        w[CH_HIGH] * z[CH_HIGH] * z[CH_HIGH] +
        w[CH_TEXTURE] * z[CH_TEXTURE] * z[CH_TEXTURE]) /
        wt,
    )
    if (sim) {
      const o = this.simObjs[slot]
      o.boundaryBeat = sim.boundaryBeat
      o.similarity = sim.similarity
      ev.sim = o
    } else ev.sim = undefined
    ev.corroborated = false
    this.seq++
    return [ev]
  }

  /** Deliver the gap detector's drop through the ring (before any change candidate of the same beat). */
  private emitDrop(d: GapDropFire): SectionEvent {
    const slot = this.seq % this.events.length
    const ev = this.events[slot]
    ev.id = this.nextId++
    ev.type = 'drop'
    ev.strength = d.strength
    ev.confidence = d.confidence
    ev.boundaryBeat = d.boundaryBeat
    ev.boundaryTime = d.boundaryTime
    ev.detectedAtBeat = d.detectedBeat
    ev.detectedAtTime = d.detectedTime
    ev.source = 'live'
    const bib = this.grid.beatInBar(this.seq0)
    ev.phase = bib >= 0 ? bib : 0
    ev.feats.level = 0
    ev.feats.low = d.depthDb / 5
    ev.feats.timbre = 0
    ev.feats.harmony = 0
    ev.feats.rhythm = 0
    ev.sim = undefined
    // a dropout AND a return: two independent observations of one physical drop (the director's gate for a young drop)
    ev.corroborated = true
    this.stats.drops++
    this.seq++
    return ev
  }

  /** Mean of the section's first beats (raw signature), remember it, and return the best earlier match. */
  private findSimilar(cand: Candidate): { boundaryBeat: number; similarity: number } | null {
    const c = this.cfg
    const ring = this.scorer.ring
    // cells b+1 .. b+sigBeats (as many as have arrived)
    const firstAge = ring.ageOfSeq(cand.boundarySeq + 1)
    if (firstAge < 0) return null
    const have = Math.min(c.sigBeats, firstAge + 1)
    if (have < 3) return null
    const mean = this.tmpMean
    if (!ring.meanWindow(firstAge - have + 1, have, mean)) return null

    let best: { boundaryBeat: number; similarity: number } | null = null
    const prev = (this.secHead - 1 + MAX_SECTIONS) % MAX_SECTIONS
    for (let k = 0; k < this.secCount; k++) {
      const slot = (this.secHead - 1 - k + MAX_SECTIONS * 2) % MAX_SECTIONS
      if (slot === prev) continue // the section just left is never a "return"
      const s = this.similarity(mean, slot)
      if (s >= c.simMin && (best === null || s > best.similarity)) best = { boundaryBeat: this.secBeat[slot], similarity: s }
    }
    // remember this section's signature
    const slot = this.secHead
    for (let i = 0; i < SIG_DIM; i++) this.secSig[slot * SIG_DIM + i] = mean[SIG_OFF + i]
    this.secBeat[slot] = cand.boundaryBeat
    this.secHead = (slot + 1) % MAX_SECTIONS
    if (this.secCount < MAX_SECTIONS) this.secCount++
    return best
  }

  /**
   * Cosine of two whitened signatures (the new one is `mean`, the stored one is in `slot`), clamped to 0..1. The chroma
   * dimensions are left out: the analyser's chroma is a 2 s EMA, so the first beats of a section still carry the
   * PREVIOUS section's harmony and would make an exact repeat look different from its first occurrence.
   */
  private similarity(mean: Float64Array, slot: number): number {
    const m = this.moments
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < SIM_DIM; i++) {
      const sd = Math.max(m.std(i), 1e-3)
      const a = (mean[SIG_OFF + i] - m.mean[i]) / sd
      const b = (this.secSig[slot * SIG_DIM + i] - m.mean[i]) / sd
      dot += a * b
      na += a * a
      nb += b * b
    }
    if (na < 1e-9 || nb < 1e-9) return 0
    const cs = dot / Math.sqrt(na * nb)
    return cs > 0 ? (cs > 1 ? 1 : cs) : 0
  }

  /**
   * Beats from the engine beat `beat` (`f.beatIndex`) to the next bar line of the boundary-anchored grid (0 = `beat`
   * IS one), or -1 when the grid is not confident enough to cut on. For the show adapter's CUT alignment.
   */
  beatsToBarLine(beat: number): number {
    return this.grid.beatsToBarLine(beat - this.offsetSeq)
  }

  /** Position of the engine beat `beat` in the anchored bar (0 = bar line), or -1 when there is no phase yet. */
  beatInBar(beat: number): number {
    return this.grid.beatInBar(beat - this.offsetSeq)
  }

  /** Events delivered so far (monotone); pair with {@link EventLayer.readSince}. */
  get sequence(): number {
    return this.seq
  }

  /**
   * Append to `out` every event delivered after `fromSeq` (at most one ring's worth: an older one has been reused)
   * and return the new sequence number to pass next time. Allocation-free.
   */
  readSince(fromSeq: number, out: SectionEvent[]): number {
    const cap = this.events.length
    const start = Math.max(fromSeq, this.seq - cap)
    for (let s = start; s < this.seq; s++) out.push(this.events[s % cap])
    return this.seq
  }

  /** The single-consumer form: append what is new since the last `drain`, return how many. */
  drain(out: SectionEvent[]): number {
    const before = out.length
    this.drained = this.readSince(this.drained, out)
    return out.length - before
  }

  /** Mark everything as consumed without reading it (a consumer that is switched off). */
  discard(): void {
    this.drained = this.seq
  }
}

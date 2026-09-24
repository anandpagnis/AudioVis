import { ChromaKeyEstimator } from '../chromaKey'
import { riserScore, segment, STRUCTURE_DSP, type BeatCell } from '../essentia/structureDsp'
import type { StructureBuild, StructureRaw, StructureSegment } from '../essentia/structureProtocol'
import type { AudioFeatures } from '../types'
import { quality } from '../../engine/quality'
import { OnsetDensityTracker } from './onsetDensity'
import { melBands } from './timbreBands'

/**
 * Always-on, non-Essentia song-structure orchestrator — the main-thread
 * replacement for `essentia/StructureBridge.ts` in every real build (that
 * bridge stays wired for the rare `VITE_ENABLE_ESSENTIA=1` dev build only).
 *
 * Same job as `StructureBridge` + `structure.worker.ts`'s `foldToBeats()`
 * combined, minus Essentia: accumulate a running average of per-frame
 * features into the CURRENT beat cell every `update()` call, fold it into a
 * completed `BeatCell` when `f.beat` fires, and periodically (a self-tuning
 * cadence, not per-frame) run `structureDsp.ts`'s `segment()` + `riserScore()`
 * over the rolling beat-cell window. Runs on the main thread, not a worker —
 * the only reason a worker existed was Essentia's WASM module; the actual
 * arithmetic (self-similarity matrices over a few hundred beat cells) is a few
 * million operations at a ~8s cadence, cheap enough inline, and is throttled
 * further at high `quality.tier` (see `TIER_CADENCE_SCALE`) rather than moved
 * off-thread.
 *
 * TWO RETURN CADENCES. The O(n^2) `segment()` only runs per batch, but
 * `riserScore()` is O(24 cells) and a build (~30 s for a 16-bar build at 120
 * BPM) is far too short to sample at batch cadence — it was seen once or twice,
 * often before the ramp or after the drop. So after the first successful batch,
 * EVERY beat fold also returns a `StructureRaw` whose `build` is a FRESH
 * `riserScore()` and whose `segments`/`boundaries`/`novelty` are the CACHED
 * last-batch arrays (same references — `SectionTracker` tells a replay from a
 * fresh segmentation by array identity). `atBeat` is the newest cell's beat.
 *
 * FEATURE SOURCES (all already computed by `AudioEngine` before its call site
 * runs; nothing here recomputes anything already on `f`):
 *   - `hpcp`  — a SECOND `ChromaKeyEstimator` instance, owned here (not the
 *     10s-tau key-detection instance `AudioEngine` already owns), tuned to a
 *     fast ~2s time constant for structural sensitivity. It needs the same
 *     raw dB spectrum + sample rate `AudioEngine` already reads for its own
 *     instance (`this.lowFreqDb`/`ctx.sampleRate`) — since `AudioFeatures`
 *     carries neither (only the lower-resolution `f.spectrum`, and no sample
 *     rate at all), `update()` takes them as explicit extra parameters rather
 *     than being fed by `f` alone. This keeps the estimator itself, and the
 *     one new `AudioEngine` field, self-contained — the alternative (a SECOND
 *     private `ChromaKeyEstimator` field on `AudioEngine` itself) would add
 *     two new fields there instead of one for no benefit, since the estimator
 *     has no other reason to live outside this class.
 *   - `mfcc` (really: mel-bands, see `timbreBands.ts`'s header) — `melBands()`
 *     over `f.spectrum` (already computed every frame) + the same sample rate.
 *   - `logRms`, `centroid`, `flux`, `flatness`, `air`, `sub`, `bass`, `mid`,
 *     `high` — read directly off `f.*` (`f.loudness` for `logRms`, `f.
 *     spectralFlatness` for `flatness` — see the constants block below for
 *     why those two specifically).
 *   - `onsetDensity` — a private `OnsetDensityTracker`, fed
 *     `f.percussion.hihat.trigger || f.percussion.snare.trigger` every frame.
 *
 * DISABLED MODE (`?structure=off`, via `structureFlags.ts`): `update()`
 * checks the flag FIRST and returns `null` doing no work at all — not even
 * the cheap per-frame accumulation — so the kill switch reproduces exactly
 * today's (pre-this-feature) `structureValid`-never-true behaviour.
 *
 * ALLOCATION: the per-frame accumulation path mutates pre-allocated scratch
 * (`Float64Array` sums), matching this codebase's no-per-frame-allocation
 * discipline — with one unavoidable exception: `melBands()` is a pure
 * function that returns a freshly allocated output vector every call (its own
 * header: "the per-call OUTPUT vector is freshly allocated ... unavoidable for
 * a pure function that returns a value"); its expensive part (the filterbank
 * weight tables) is cached internally, so this only costs one small
 * (`MEL_BANDS`-length) array per frame. The once-per-beat fold and the
 * periodic batch are allowed to allocate freely (a `BeatCell`, the SSMs,
 * segment/boundary arrays).
 *
 * NEVER THROWS: `update()` wraps its real work in try/catch and returns
 * `null` on any unexpected error, matching `MusicIntelProvider`'s contract
 * ("must ... never throw") that this class is a peer of, not a subtype of.
 */

/** Fast structural chroma time constant (s) — vs. the key-detection instance's default 10s
 *  (`DEFAULT_TAU_SEC` in `chromaKey.ts`). Short enough to track a section-to-section harmonic
 *  change within a couple of beats, per the plan's "structural sensitivity" brief. */
const FAST_CHROMA_TAU_SEC = 2

/** Mel-band count fed into `BeatCell.mfcc`. `structureDsp.ts` places no dimension requirement on
 *  `mfcc`/`hpcp` — `segment()`/`riserScore()` only ever compare same-length vectors with cosine
 *  similarity (confirmed by reading `structureDsp.ts` end to end: no `MFCC_COEFFS`-shaped constant
 *  lives there, only in the now-superseded `structure.worker.ts`, where it was 13). 13 is kept here
 *  purely for continuity with the dimensionality the field was originally sized for — not because
 *  the algorithm requires it. */
const MEL_BANDS = 13

/** Base seconds between batch segmentation runs. Was 15 (the same as `StructureBridge`'s private
 *  `CADENCE_SEC`); lowered to 8 because the measured batch cost is tiny (~2.6 ms mean, ~10 ms max on
 *  the calibration corpus) and a boundary is only learned at the next batch, so at 15 s a real
 *  section change could sit unreported for a quarter-minute. The cost-based self-throttle below and
 *  the `quality.tier` backoff both still apply on top. `CADENCE_MAX` is unchanged and still the same
 *  as `StructureBridge`'s (private, unexported there — redeclared locally, that bridge stays
 *  permanently Essentia-path-only). Exported so tests/the debug overlay can reference the real
 *  values instead of duplicating magic numbers. */
export const CADENCE_SEC = 8
export const CADENCE_MAX = 45

/** Wall-clock seconds of buffered beat-cell history required before the FIRST batch may run.
 *  `StructureBridge`'s equivalent (`MIN_HISTORY_SEC = 30`) was dominated by giving the Essentia
 *  rhythm/voice workers time to get their own first reads in first, not by anything the algorithm
 *  itself needs — no such dependency exists here (`f.bpm` is available almost immediately from the
 *  synchronous `BpmEstimator`). The algorithm's real floor is `STRUCTURE_DSP.minSegmentBeats * 2` =
 *  16 beat cells (`segment()` returns empty below that): at typical tempo (76-180 BPM) that is
 *  5.3-12.6s of music. 20s leaves comfortable margin above that across the whole range while landing
 *  `structureValid` around the plan's own stated target of "roughly 20-25s" (vs. the old ~30-38s). */
export const MIN_HISTORY_SEC = 20

/** Wall-clock seconds after this analyzer's first `update()` call before the first batch may run.
 *  `StructureBridge`'s equivalent (`FIRST_JOB_DELAY_SEC = 8`) existed to "let the rhythm + voice
 *  workers get their first reads in first" — again, not a dependency this analyzer has. Kept small
 *  and non-zero anyway so the very first handful of frames (tempo/beat grid still settling right
 *  after a source starts) aren't spent building beat cells against an unstable grid. */
export const FIRST_JOB_DELAY_SEC = 4

/** Rolling beat-cell buffer bound, in BEATS rather than wall-clock seconds — unlike
 *  `StructureBridge`'s `WINDOW_SEC`, there is no PCM ring/resample step to size in seconds here;
 *  cells are already produced directly on the beat grid. 200 beats is ~100s at 120 BPM (the low end
 *  of the plan's suggested 90-120s window), ~150s at 80 BPM, ~67s at 180 BPM — comfortably inside the
 *  "a few million operations" cost estimate for the O(n^2) self-similarity matrices even at the slow
 *  end. */
export const WINDOW_BEATS = 200

/** Quality-tier cadence backoff factor: effective cadence = cost-based cadence * (1 + tier *
 *  TIER_CADENCE_SCALE). Tier 0 (richest) -> 1x; tier 4 (survival) -> 3x. A graceful multiplier
 *  rather than a hard cliff/skip, per the plan's explicit "gate the cadence through quality.ts ...
 *  rather than adding a worker" and this task's "graceful backoff not a hard cliff" brief. */
const TIER_CADENCE_SCALE = 0.5

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export interface StructureAnalyzerStatus {
  /** False only when constructed with `{ disabled: true }` (the `?structure=off` kill switch). */
  enabled: boolean
  /** Beat cells currently buffered (bounded by `WINDOW_BEATS`). */
  historyBeats: number
  /** Completed batch segmentation runs so far. */
  runs: number
  /** Wall-clock cost of the last batch, ms. */
  lastCostMs: number
  /** Boundary count from the last batch. */
  lastBoundaries: number
  /** Peak value of the last batch's fused novelty curve, 0..1. */
  lastNoveltyPeak: number
  /** Current riser/build score, 0..1 — re-read on every beat fold once the first batch has run
   *  (and on each batch), not held between batches. */
  buildScore: number
  buildActive: boolean
  /** Seconds until the next BATCH segmentation is eligible to run (the per-beat riser refresh is
   *  not gated by this). 0 = could run right now, subject to the
   *  history/warm-up gates also being satisfied; a large finite number, not `Infinity`, while no
   *  history has accumulated yet, so a debug readout has something sane to show). */
  nextBatchEtaSec: number
}

export interface StructureAnalyzerOptions {
  /** Wired from `structureOff()` by the caller (`AudioEngine`). Default false (analyzer on). */
  disabled?: boolean
}

/** Placeholder ETA shown before any history exists, so `status.nextBatchEtaSec` stays a finite,
 *  displayable number rather than `Infinity`. */
const UNKNOWN_ETA_SEC = 999

function freshStatus(enabled: boolean): StructureAnalyzerStatus {
  return {
    enabled,
    historyBeats: 0,
    runs: 0,
    lastCostMs: 0,
    lastBoundaries: 0,
    lastNoveltyPeak: 0,
    buildScore: 0,
    buildActive: false,
    nextBatchEtaSec: UNKNOWN_ETA_SEC,
  }
}

export class StructureAnalyzer {
  private readonly disabled: boolean
  private readonly chroma: ChromaKeyEstimator
  private readonly onset = new OnsetDensityTracker()

  // Per-frame scratch accumulators (running SUM since the last fold; divided by `frameCount` on
  // fold). Reused every frame — no allocation on the common path except `melBands()`'s own tiny
  // output vector (see class header).
  private readonly hpcpAcc = new Float64Array(12)
  private readonly melAcc = new Float64Array(MEL_BANDS)
  private logRmsSum = 0
  private centroidSum = 0
  private fluxSum = 0
  private flatnessSum = 0
  private airSum = 0
  private subSum = 0
  private bassSum = 0
  private midSum = 0
  private highSum = 0
  private onsetSum = 0
  private frameCount = 0

  private cells: BeatCell[] = []
  private startedAt = -1
  private firstCellAt = -1
  private lastBatchAt = -1
  private costCadence = CADENCE_SEC
  /** Beat the current build (if any) started on, per `riserScore`'s own `startBeat` — tracked across
   *  batches and per-beat refreshes so a build spanning many reads keeps a stable start rather than
   *  each read re-guessing one from its own window (see `riserScore`'s doc for what happens when this
   *  is -1). Set from `startBeat` on the first active read, reset on the first inactive one. */
  private buildStartBeat = -1
  private runs = 0
  /** The last batch's segmentation, replayed by reference on every per-beat refresh (see the class
   *  header). Null until the first batch has run. */
  private cached: { novelty: number[]; boundaries: number[]; segments: StructureSegment[] } | null = null

  readonly status: StructureAnalyzerStatus

  constructor(opts: StructureAnalyzerOptions = {}) {
    this.disabled = opts.disabled ?? false
    this.chroma = new ChromaKeyEstimator({ tauSec: FAST_CHROMA_TAU_SEC })
    this.status = freshStatus(!this.disabled)
  }

  reset(): void {
    this.chroma.reset()
    this.onset.reset()
    this.resetAccumulator()
    this.cells = []
    this.startedAt = -1
    this.firstCellAt = -1
    this.lastBatchAt = -1
    this.costCadence = CADENCE_SEC
    this.buildStartBeat = -1
    this.runs = 0
    this.cached = null
    const fresh = freshStatus(!this.disabled)
    Object.assign(this.status, fresh)
  }

  /**
   * Call every frame, with `lowFreqDb`/`sampleRate` the SAME raw dB spectrum + sample rate
   * `AudioEngine` already reads for its own (key-detection) `ChromaKeyEstimator` instance — see the
   * class header for why those two are extra parameters rather than read off `f`. Accumulates into
   * the current beat cell, folds a completed cell on `f.beat`, and runs a batch segmentation when the
   * cadence/history conditions are met. Returns a fresh `StructureRaw` on the frame a batch
   * completes, and — once a batch has run — on every frame a beat cell is folded (same segmentation,
   * fresh riser read; see the class header), else `null` (the common case for the ~60 frames between
   * beats) — the same return contract `MusicIntelProvider.updateStructure()` has, so `AudioEngine`'s
   * single integration line can `??` between them.
   */
  update(f: AudioFeatures, lowFreqDb: Float32Array, sampleRate: number): StructureRaw | null {
    if (this.disabled) return null
    try {
      return this.updateInner(f, lowFreqDb, sampleRate)
    } catch {
      // Never throws past this point — a malformed frame degrades to "no read this frame", the same
      // as any other slow/failed structure read `SectionTracker` already tolerates.
      return null
    }
  }

  private updateInner(f: AudioFeatures, lowFreqDb: Float32Array, sampleRate: number): StructureRaw | null {
    this.accumulateFrame(f, lowFreqDb, sampleRate)
    const folded = f.beat && this.foldBeat(f)

    if (this.startedAt < 0) this.startedAt = f.time
    this.status.historyBeats = this.cells.length

    const eta = this.computeEtaSec(f)
    this.status.nextBatchEtaSec = Number.isFinite(eta) ? eta : UNKNOWN_ETA_SEC
    if (f.silence) return null
    if (this.cells.length < STRUCTURE_DSP.minSegmentBeats * 2) return null
    if (eta <= 0) return this.runBatch(f)

    // Between batches: a beat was just folded and a segmentation is cached, so re-read the (cheap)
    // riser and replay the cache. Off-beat frames stay `null`.
    if (folded && this.cached) return this.refreshBuild(f)
    return null
  }

  private accumulateFrame(f: AudioFeatures, lowFreqDb: Float32Array, sampleRate: number): void {
    this.chroma.update(lowFreqDb, sampleRate, f.delta)
    const chroma = this.chroma.read().chroma
    for (let i = 0; i < 12; i++) this.hpcpAcc[i] += chroma[i]

    const mel = melBands(f.spectrum, sampleRate, MEL_BANDS)
    for (let i = 0; i < MEL_BANDS; i++) this.melAcc[i] += mel[i]

    this.onset.update(f.percussion.hihat.trigger || f.percussion.snare.trigger, f.delta)
    this.onsetSum += this.onset.read()

    // `logRms`: `structureDsp.ts`'s own doc calls this "normalised loudness in dB-ish units for
    // slope maths". `f.loudness` (BS.1770 K-weighted, adaptively normalized 0..1) is the closest
    // available match to "normalized loudness" of the fields AudioEngine already computes — closer
    // in spirit than `f.rms` (plain broadband) or `f.energy` (a hand-weighted band blend for mood
    // scoring, not a loudness read). It is not literally log-scaled (nothing already on `f` is), but
    // `riserScore()` only ever takes its SLOPE, which a monotonic loudness proxy serves equally well.
    this.logRmsSum += f.loudness
    this.centroidSum += f.centroid
    this.fluxSum += f.flux
    // `flatness`: `f.spectralFlatness`, NOT a field literally named `flatness` (AudioFeatures has no
    // such field) — same spectral-flatness measurement `BeatCell.flatness`'s doc describes.
    this.flatnessSum += f.spectralFlatness
    this.airSum += f.air
    this.subSum += f.sub
    this.bassSum += f.bass
    this.midSum += f.mid
    this.highSum += f.high
    this.frameCount++
  }

  private resetAccumulator(): void {
    this.hpcpAcc.fill(0)
    this.melAcc.fill(0)
    this.logRmsSum = 0
    this.centroidSum = 0
    this.fluxSum = 0
    this.flatnessSum = 0
    this.airSum = 0
    this.subSum = 0
    this.bassSum = 0
    this.midSum = 0
    this.highSum = 0
    this.onsetSum = 0
    this.frameCount = 0
  }

  /** Push the running accumulator as one completed `BeatCell`, tagged with the beat that just
   *  finished (`f.beatIndex` — `advanceGrid()` has already advanced it by the time `f.beat` reads
   *  true this frame). Mirrors `structure.worker.ts`'s old `foldToBeats()`: average whatever
   *  accumulated since the last fold, reset, repeat. Returns whether a cell was pushed. */
  private foldBeat(f: AudioFeatures): boolean {
    const n = this.frameCount
    if (n <= 0) return false // update() always accumulates before folding, so this only guards a future refactor.
    const inv = 1 / n
    const cell: BeatCell = {
      beat: f.beatIndex,
      hpcp: Array.from(this.hpcpAcc, (v) => v * inv),
      mfcc: Array.from(this.melAcc, (v) => v * inv),
      logRms: clamp01(this.logRmsSum * inv),
      centroid: clamp01(this.centroidSum * inv),
      flux: clamp01(this.fluxSum * inv),
      flatness: clamp01(this.flatnessSum * inv),
      air: clamp01(this.airSum * inv),
      sub: clamp01(this.subSum * inv),
      bass: clamp01(this.bassSum * inv),
      mid: clamp01(this.midSum * inv),
      high: clamp01(this.highSum * inv),
      onsetDensity: clamp01(this.onsetSum * inv),
    }
    this.cells.push(cell)
    if (this.cells.length > WINDOW_BEATS) this.cells.shift()
    if (this.firstCellAt < 0) this.firstCellAt = f.time
    this.resetAccumulator()
    return true
  }

  /** Seconds until the next batch may run — the max of the three independent gates (start delay,
   *  history depth, cadence since the last batch). `Infinity` while no cell has been folded yet
   *  (history cannot be judged). */
  private computeEtaSec(f: AudioFeatures): number {
    const sinceStart = this.startedAt < 0 ? 0 : f.time - this.startedAt
    const startEta = Math.max(0, FIRST_JOB_DELAY_SEC - sinceStart)

    if (this.firstCellAt < 0) return Math.max(startEta, Number.POSITIVE_INFINITY)
    const historyEta = Math.max(0, MIN_HISTORY_SEC - (f.time - this.firstCellAt))

    const tierMul = 1 + quality.tier * TIER_CADENCE_SCALE
    const cadence = this.costCadence * tierMul
    const cadenceEta = this.lastBatchAt < 0 ? 0 : Math.max(0, cadence - (f.time - this.lastBatchAt))

    return Math.max(startEta, historyEta, cadenceEta)
  }

  /** Fresh riser read over the current cells, with `buildStartBeat` bookkeeping and hysteresis:
   *  once a build is in flight (`buildStartBeat >= 0`) it stays active until the score falls under
   *  `buildExit`, not merely under `buildEnter` — a per-beat read would otherwise flicker around one
   *  threshold and reset the start (and so the drop projection) on every dip. Updates the status. */
  private readRiser(): StructureBuild {
    const enter = this.buildStartBeat >= 0 ? STRUCTURE_DSP.buildExit : STRUCTURE_DSP.buildEnter
    const build = riserScore(this.cells, this.buildStartBeat, STRUCTURE_DSP.riserWindow, enter)
    if (build.active) {
      if (this.buildStartBeat < 0) this.buildStartBeat = build.startBeat
    } else {
      this.buildStartBeat = -1
    }
    this.status.buildScore = build.score
    this.status.buildActive = build.active
    return build
  }

  private newestBeat(f: AudioFeatures): number {
    return this.cells.length ? this.cells[this.cells.length - 1].beat : f.beatIndex
  }

  /** Per-beat refresh: fresh riser read + the cached last-batch segmentation (same array
   *  references). Only called once `cached` is set. */
  private refreshBuild(f: AudioFeatures): StructureRaw {
    const t0 = performance.now()
    const build = this.readRiser()
    const costMs = performance.now() - t0
    const c = this.cached!
    return {
      atBeat: this.newestBeat(f),
      novelty: c.novelty,
      boundaries: c.boundaries,
      segments: c.segments,
      build,
      costMs,
    }
  }

  private runBatch(f: AudioFeatures): StructureRaw {
    const t0 = performance.now()
    const { novelty, boundaries, segments } = segment(this.cells)
    const build = this.readRiser()
    const costMs = performance.now() - t0

    this.lastBatchAt = f.time
    this.runs++
    // Self-throttle from measured cost, exactly like `StructureBridge` — never spend more than
    // roughly a third of the wall clock analysing. `quality.tier` scales this further in
    // `computeEtaSec()`, not here, so the two backoffs stay independently inspectable.
    this.costCadence = Math.min(CADENCE_MAX, Math.max(CADENCE_SEC, (costMs / 1000) * 3))

    let noveltyPeak = 0
    for (const v of novelty) if (v > noveltyPeak) noveltyPeak = v

    this.status.runs = this.runs
    this.status.lastCostMs = costMs
    this.status.lastBoundaries = boundaries.length
    this.status.lastNoveltyPeak = noveltyPeak

    const boundaryBeats = boundaries.map((b) => b.beat)
    this.cached = { novelty, boundaries: boundaryBeats, segments }
    return {
      atBeat: this.newestBeat(f),
      novelty,
      boundaries: boundaryBeats,
      segments,
      build,
      costMs,
    }
  }
}

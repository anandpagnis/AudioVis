import { createEmptySongSection, type AudioFeatures, type SongSection } from './types'
import type { StructureRaw, StructureSegment } from './essentia/structureProtocol'

/**
 * Synchronous fusion state machine over the async structure-analyzer output.
 *
 * The worker's O(n²) segmentation arrives every ~15 s; the per-frame signal
 * the directors depend on must stay deterministic DSP. So this class owns the
 * state: it latches the analyzer's boundaries/segments into a stable
 * `SongSectionMomentum`, overlays the fast synchronous `f.drop` / `f.buildUp`
 * flags (which the worker's cadence can't resolve), and applies hysteresis so
 * a director never cuts on a flicker.
 *
 * `update(f, raw)` takes the plain payload as an argument (not off a singleton)
 * so it unit-tests in `environment: 'node'` like `MoodEstimator` /
 * `PhraseDetector`. `raw` is almost always `null` — a real segmentation only
 * lands every ~15 s; the tracker holds and free-runs its counters in between.
 */

/** A drop stays "latched" this many beats so a director sees it past the
 * single frame `f.drop`'s rising edge would give. */
const DROP_HOLD_BEATS = 8
/** `f.buildUp` must hold this many frames before `section = 'build'` commits. */
const BUILD_CONFIRM_FRAMES = 8
/** A build with no drop is abandoned this many beats past its projected drop. */
const BUILD_FIZZLE_SLACK_BEATS = 16
/** A `raw` boundary counts as "now" if within this many beats of the grid. */
const BOUNDARY_SNAP_BEATS = 4
/** `raw` older than this (seconds) is stale — hold, decay confidence. */
const STALE_SEC = 48
/** Trailing window for the local energy baseline the breakdown test uses. */
const BREAKDOWN_BASELINE_BEATS = 16

/** Hold (beats) a candidate section must persist before it commits. */
function holdFor(next: SongSection, viaDrop: boolean): number {
  if (viaDrop) return 0
  if (next === 'build') return 2
  if (next === 'breakdown') return 4
  return 8
}

/** Min beats the committed section must dwell before a challenger can commit. */
function dwellFor(committed: SongSection): number {
  if (committed === 'build') return 4
  if (committed === 'drop') return 8
  return 8
}

/** The segment covering `beat`, or null. Exported for tests. */
export function segmentAt(segments: StructureSegment[], beat: number): StructureSegment | null {
  for (const s of segments) if (beat >= s.startBeat && beat < s.endBeat) return s
  return segments.length ? segments[segments.length - 1] : null
}

/** Energy collapsed vs a trailing baseline, sustained — a breakdown tell. */
export function classifyBreakdown(
  energyHistory: { beat: number; e: number }[],
  beat: number,
  silence: boolean,
): boolean {
  if (silence || energyHistory.length < BREAKDOWN_BASELINE_BEATS) return false
  const recent = energyHistory.filter((h) => beat - h.beat >= 0 && beat - h.beat < 4)
  const baseline = energyHistory.filter(
    (h) => beat - h.beat >= 4 && beat - h.beat < BREAKDOWN_BASELINE_BEATS,
  )
  if (recent.length < 2 || baseline.length < 6) return false
  const rE = recent.reduce((s, h) => s + h.e, 0) / recent.length
  const bE = baseline.reduce((s, h) => s + h.e, 0) / baseline.length
  return bE > 0.05 && rE < bE * 0.65
}

export class SectionTracker {
  private lastBeatIndex = -1
  private committed: SongSection = ''
  private committedAtBeat = -1
  private sectionStartBeat = 0
  private candidate: SongSection = ''
  private candidateSinceBeat = 0

  private buildFrames = 0
  private buildStartBeat = -1
  private buildBeatsTillDrop = -1
  private prevBuildActive = false
  /** The section a speculative `build`/`drop` was entered from, so a fizzle can
   * restore it silently (no `boundaryChanged` — the build didn't pay off). */
  private enteredHypeFrom: SongSection = ''

  private prevDrop = false
  private dropLatchUntilBeat = -1

  private segments: StructureSegment[] = []
  private boundaries: number[] = []
  private lastRawAt = -1
  private lastRawTime = -1
  private prevLabelAtBoundary = ''
  private everValid = false
  private energyHistory: { beat: number; e: number }[] = []

  reset(): void {
    this.lastBeatIndex = -1
    this.committed = ''
    this.committedAtBeat = -1
    this.sectionStartBeat = 0
    this.candidate = ''
    this.candidateSinceBeat = 0
    this.buildFrames = 0
    this.buildStartBeat = -1
    this.buildBeatsTillDrop = -1
    this.prevBuildActive = false
    this.enteredHypeFrom = ''
    this.prevDrop = false
    this.dropLatchUntilBeat = -1
    this.segments = []
    this.boundaries = []
    this.lastRawAt = -1
    this.lastRawTime = -1
    this.prevLabelAtBoundary = ''
    this.everValid = false
    this.energyHistory = []
  }

  update(f: AudioFeatures, raw: StructureRaw | null): void {
    const s = f.songSection
    s.boundaryChanged = false
    const beat = f.beatIndex
    const newBeat = beat !== this.lastBeatIndex
    this.lastBeatIndex = beat

    if (newBeat && !f.silence) {
      this.energyHistory.push({ beat, e: f.energy })
      while (this.energyHistory.length > 0 && beat - this.energyHistory[0].beat > 64) {
        this.energyHistory.shift()
      }
    }

    // --- Ingest a fresh analyzer result ---------------------------------
    let justBootstrapped = false
    if (raw && raw.segments.length > 0) {
      this.segments = raw.segments
      this.boundaries = raw.boundaries
      this.lastRawAt = raw.atBeat
      this.lastRawTime = f.time
      if (!this.everValid) {
        this.everValid = true
        justBootstrapped = true
      }
    }
    if (raw) {
      // The riser numbers come from the worker; the latch/release is ours.
      if (raw.build.active) {
        if (this.buildStartBeat < 0)
          this.buildStartBeat = raw.build.startBeat >= 0 ? raw.build.startBeat : beat
        this.buildBeatsTillDrop = raw.build.beatsTillDrop
        this.buildFrames = Math.max(this.buildFrames, BUILD_CONFIRM_FRAMES)
      }
      this.prevBuildActive = raw.build.active
    }

    const stale = this.lastRawTime >= 0 && f.time - this.lastRawTime > STALE_SEC
    f.structureValid = this.everValid

    // --- Fast synchronous drop / build overlay -------------------------
    const dropEdge = f.drop && !this.prevDrop
    this.prevDrop = f.drop
    let boundaryNearNow = false
    for (const b of this.boundaries)
      if (Math.abs(b - beat) <= BOUNDARY_SNAP_BEATS) boundaryNearNow = true

    if (dropEdge || (this.committed === 'build' && boundaryNearNow && f.energy > 0.5)) {
      this.dropLatchUntilBeat = beat + DROP_HOLD_BEATS
      if (this.committed !== 'build' && this.committed !== 'drop')
        this.enteredHypeFrom = this.committed
      // A drop supersedes the build outright — clear it so a stale frame count
      // can't re-trigger `build` when the latch lifts.
      this.buildFrames = 0
      this.buildStartBeat = -1
      this.buildBeatsTillDrop = -1
    }
    const inDropLatch = beat < this.dropLatchUntilBeat

    if (f.buildUp && !f.silence && !inDropLatch) {
      this.buildFrames = Math.min(this.buildFrames + 1, BUILD_CONFIRM_FRAMES * 3)
      if (this.buildStartBeat < 0) this.buildStartBeat = beat
      if (newBeat && this.buildBeatsTillDrop > 0) this.buildBeatsTillDrop--
    } else if (this.buildFrames > 0 && !inDropLatch) {
      const projected = this.buildBeatsTillDrop > 0 ? this.buildBeatsTillDrop : 0
      const overrun =
        this.buildStartBeat >= 0 &&
        beat - this.buildStartBeat > projected + BUILD_FIZZLE_SLACK_BEATS
      if (overrun || (!this.prevBuildActive && this.buildFrames < BUILD_CONFIRM_FRAMES)) {
        this.buildFrames = Math.max(0, this.buildFrames - 2)
      }
      if (this.buildFrames === 0) {
        this.buildStartBeat = -1
        this.buildBeatsTillDrop = -1
      }
    }
    const buildConfirmed = this.buildFrames >= BUILD_CONFIRM_FRAMES && !inDropLatch
    const seg = segmentAt(this.segments, beat)

    // --- Bootstrap: the first real segmentation commits its current segment
    // WITHOUT a boundary edge (nothing musical just happened). --------------
    if (justBootstrapped && seg) {
      this.committed = seg.kind
      this.candidate = seg.kind
      this.committedAtBeat = beat
      this.sectionStartBeat = beat
      this.prevLabelAtBoundary = seg.repetitionLabel
      s.previousSection = ''
      s.section = this.committed
    }

    // --- Decide the target section, priority high→low ---------------------
    const breakdownNow =
      !inDropLatch &&
      !buildConfirmed &&
      (seg?.kind === 'breakdown' || classifyBreakdown(this.energyHistory, beat, f.silence))

    let target: SongSection = this.committed
    let viaDrop = false
    let silentRelease = false
    if (inDropLatch) {
      target = 'drop'
      viaDrop = dropEdge
    } else if (buildConfirmed) {
      if (this.committed !== 'build') this.enteredHypeFrom = this.committed
      target = 'build'
    } else if (this.committed === 'build') {
      // Build with no drop and no sustained flag = fizzle. Restore what it was
      // entered from, silently — a failed build must not read as a boundary.
      target = this.enteredHypeFrom
      silentRelease = true
    } else if (breakdownNow) {
      target = 'breakdown'
    } else if (this.everValid && seg) {
      const atBoundary = boundaryNearNow
      const labelStable = seg.repetitionLabel === this.prevLabelAtBoundary || raw != null
      if (atBoundary && (labelStable || seg.repetitionLabel === '')) {
        target = seg.kind
      } else if (this.committed === 'drop') {
        target = seg.kind // post-drop settle onto the current segment label
      }
      if (raw) this.prevLabelAtBoundary = seg.repetitionLabel
    } else if (this.committed === 'drop') {
      target = 'section'
    }

    // --- Hysteresis commit ----------------------------------------------
    if (target !== this.candidate) {
      this.candidate = target
      const bypass = viaDrop || silentRelease || target === '' || inDropLatch
      this.candidateSinceBeat = bypass
        ? beat
        : Math.max(beat, this.committedAtBeat + dwellFor(this.committed))
    }
    if (
      this.candidate !== this.committed &&
      beat - this.candidateSinceBeat >= holdFor(this.candidate, viaDrop || silentRelease)
    ) {
      s.previousSection = this.committed
      this.committed = this.candidate
      this.committedAtBeat = beat
      this.sectionStartBeat = beat
      s.section = this.committed
      // A silent release (fizzled build) is not a musical boundary.
      s.boundaryChanged = !silentRelease && this.committed !== ''
      if (s.boundaryChanged) s.changeCount++
    }

    // --- Momentum fields -----------------------------------------------
    s.beatsInSection = Math.max(0, beat - this.sectionStartBeat)
    s.isDrop = inDropLatch
    s.isBuild = buildConfirmed
    s.isBreakdown = this.committed === 'breakdown'
    s.dropExpected = buildConfirmed
    s.isSustain = s.isBuild || s.dropExpected
    s.beatsTillDrop = buildConfirmed && this.buildBeatsTillDrop > 0 ? this.buildBeatsTillDrop : -1
    s.buildProgress = buildConfirmed
      ? Math.min(1, Math.max(this.buildFrames / (BUILD_CONFIRM_FRAMES * 6), s.beatsInSection / 32))
      : 0
    s.repetitionLabel = seg?.repetitionLabel ?? ''

    // Next upcoming boundary from the analyzer.
    let nextB = Infinity
    for (const b of this.boundaries) if (b > beat && b < nextB) nextB = b
    s.beatsTillBoundary = nextB === Infinity ? -1 : nextB - beat

    // Confidence: strong right after a commit, decays as `raw` goes stale.
    const age = this.lastRawTime >= 0 ? f.time - this.lastRawTime : 999
    const freshness = stale ? Math.max(0, 1 - (age - STALE_SEC) / STALE_SEC) : 1
    s.sectionConfidence = this.everValid
      ? Math.min(1, (0.45 + 0.15 * Math.min(3, s.changeCount)) * freshness)
      : 0
  }
}

export { createEmptySongSection }

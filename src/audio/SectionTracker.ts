import { createEmptySongSection, type AudioFeatures, type SongSection } from './types'
import type { StructureRaw, StructureSegment } from './essentia/structureProtocol'

/**
 * Synchronous fusion state machine over the async structure-analyzer output.
 *
 * The analyzer's O(n²) segmentation lands every ~4 s; the per-frame signal
 * the directors depend on must stay deterministic DSP. So this class owns the
 * state: it latches the analyzer's boundaries/segments into a stable
 * `SongSectionMomentum`, overlays the fast synchronous `f.drop` / `f.buildUp`
 * flags (which the analyzer's cadence can't resolve), and applies hysteresis so
 * a director never cuts on a flicker. The fast phrase-change flag
 * (`f.sectionChange`, ~1 bar latency) is fused as a LOW-confidence hint only: it can
 * shorten the hold on a section KIND the analyzer's own boundary already proposed,
 * but it never commits a kind or fires `boundaryChanged` by itself (see
 * `PHRASE_HINT_*`).
 *
 * `update(f, raw)` takes the plain payload as an argument (not off a singleton)
 * so it unit-tests in `environment: 'node'` like `MoodEstimator` /
 * `PhraseDetector`.
 *
 * TWO KINDS OF `raw` (both handled by the same call):
 *   - a FRESH segmentation (new `segments` / `boundaries` arrays) — lands every
 *     ~8 s. This is the only thing that (re)loads segments/boundaries and
 *     refreshes the staleness clock (`lastRawTime`, `justBootstrapped`);
 *   - a per-beat REFRESH (`StructureAnalyzer` after its first batch) — the SAME
 *     cached `segments`/`boundaries` array references replayed with a FRESH
 *     `build` (riser) read. Freshness is detected by array identity, so a
 *     replay is idempotent for everything except the riser numbers.
 *
 * BOUNDARY CONTRACT: every entry of `raw.boundaries` is a CONFIRMED PAST
 * boundary — "a section began at beat b, learned some beats later". The
 * analyzer's asymmetric checkerboard novelty zeroes its newest `lookahead` (4) cells
 * (a boundary needs a bar of future context), so the newest boundary it can ever
 * report is >= ~4 beats behind the live beat — plus up to a batch cadence (~4 s), and
 * a second batch for a weak boundary that has to pass persistence; nothing here may
 * wait for a boundary to be "near now". Instead a NEW boundary (not yet consumed, <=
 * `MAX_BOUNDARY_AGE_BEATS` old, not before the committed section's start)
 * means: the section covering "now" started at `b` (`beatsInSection` counts
 * from `b`), its covering segment's `kind` is adopted once the boundary has
 * aged past the hold (8 beats from `b`; ~3 with a corroborating fast
 * phrase-change), and an in-flight build is RESOLVED retroactively (see below).
 * Boundaries beyond the live beat (a provider that reports ahead) are kept and
 * consumed when the beat reaches them.
 */

/** A drop stays "latched" this many beats so a director sees it past the
 * single frame `f.drop`'s rising edge would give. */
const DROP_HOLD_BEATS = 8
/** `f.buildUp` must hold this many frames before `section = 'build'` commits. */
const BUILD_CONFIRM_FRAMES = 8
/** A build with no drop is abandoned this many beats past its projected drop. */
const BUILD_FIZZLE_SLACK_BEATS = 16
/** A boundary older than this many beats (or before the committed section's
 * start) is history, not news: never consumed as a "new section" event. Unchanged by the
 * shorter analysis lag: a boundary is now first learned ~4-14 beats after it happened
 * (4-beat lookahead + up to one ~4 s batch), ~10-25 with a persistence batch on top, so 48
 * still leaves a wide margin (and covers the quality-tier cadence backoff). */
const MAX_BOUNDARY_AGE_BEATS = 48
/** A "new" boundary within this many beats of the last consumed one is the same
 * physical boundary re-picked with a peak that shifted a few beats as the
 * analysis window slid (minSegmentBeats is 8, so real ones never sit this
 * close) — not a second event. Was 3; 4 because a peak located from only ~4
 * beats of "after" wanders a little more between batches than the old 8/32-cell
 * kernels' did (the analyzer's own persistence match is +-2 for the same reason). */
const BOUNDARY_MATCH_BEATS = 4
/** A boundary that resolves a build no more than this many beats behind the
 * live beat may still fire a visual drop event/latch; any later and a drop cue
 * is worse than none, so the build is only ended retroactively (state
 * correction, no event). The instant drop path is `f.drop`. */
const DROP_LATE_TOLERANCE_BEATS = 2
/** `f.energy` above this counts as "energy now high" for build resolution. */
const RESOLVE_ENERGY_MIN = 0.5
/** After a drop / build resolution, ignore the analyzer's riser read until it
 * reports inactive once, or this many beats pass (its window is 24 beats: the
 * pre-drop ramp keeps scoring "active" for a while after the drop, and re-arming
 * a build from that would re-trigger `build` when the drop latch lifts). */
const BUILD_REARM_BLOCK_BEATS = 24
/** `raw` older than this (seconds) is stale — hold, decay confidence. */
const STALE_SEC = 48
/** Trailing window for the local energy baseline the breakdown test uses. */
const BREAKDOWN_BASELINE_BEATS = 16
/** Median inter-boundary spacing must sit within this many beats of a multiple
 * of 4 (8 preferred) to be trusted as a musical period. */
const SPACING_SNAP_TOL_BEATS = 1
/** `beatsTillBoundary` extrapolates at most this many periods past the last
 * known boundary — beyond that the phase is too stale to claim. */
const MAX_PREDICT_PERIODS = 4

// FAST PHRASE-CHANGE HINT (`f.sectionChange` from `PhraseDetector`, ~1 bar latency). Fused as a
// low-confidence corroboration ONLY: it can shorten the hold on a section the analyzer's own boundary
// has already proposed, nothing more. Every number below is a reasoned starting point (tune live).

/** A phrase-change stays a usable hint for this many beats. */
const PHRASE_HINT_WINDOW_BEATS = 8
/** ...and only if its strength (`f.sectionChangeStrength` at the event; the detector's own trigger
 * is 0.45, its typical event ~0.6, the top tenth >= ~1.0) is at least this: a clearly-above-trigger
 * change, not one that barely scraped past. */
const PHRASE_HINT_MIN_STRENGTH = 0.6
/** ...and it must be about the same physical event as the pending analyzer boundary: within this
 * many beats of it (the detector fires 0-4 beats after a real change; the analyzer's seam sits at it). */
const PHRASE_HINT_MATCH_BEATS = 8
/** With a corroborating hint the hold of a boundary-proposed section drops to at most this many
 * beats (from 8 for a plain section / 4 for a breakdown). Not 0: the analyzer's boundary still has to
 * be at least this old, and the dwell of the committed section still applies. */
const PHRASE_HINT_HOLD_BEATS = 3

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

function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The musical period (beats) of a sorted boundary list: the median
 * inter-boundary spacing, snapped to the 8-beat grid (else the 4-beat grid)
 * when it is within `SPACING_SNAP_TOL_BEATS` of a multiple. 0 = unknown (fewer
 * than two boundaries, or a spacing that fits no grid — irregular structure is
 * not worth predicting). Exported for tests.
 */
export function boundarySpacing(sorted: readonly number[]): number {
  if (sorted.length < 2) return 0
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1])
  const med = median(gaps)
  for (const grid of [8, 4]) {
    const snapped = Math.round(med / grid) * grid
    if (snapped >= 8 && Math.abs(med - snapped) <= SPACING_SNAP_TOL_BEATS) return snapped
  }
  return 0
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
  /** Beat of the most recent qualifying fast phrase-change (-Infinity = none). */
  private phraseChangeBeat = Number.NEGATIVE_INFINITY

  private buildFrames = 0
  private buildStartBeat = -1
  /** ABSOLUTE beat the current build is projected to drop on (-1 unknown). Absolute, not a
   * "beats till" countdown: the analyzer re-projects it every beat, and the fizzle test below needs
   * "how far past the projected drop are we", which a shrinking countdown can't say. */
  private buildDropBeat = -1
  private prevBuildActive = false
  /** Riser reads are ignored until this beat (or until the analyzer reports
   * inactive) — see `BUILD_REARM_BLOCK_BEATS`. */
  private buildRearmBlockUntil = -1
  /** The section a speculative `build`/`drop` was entered from, so a fizzle can
   * restore it silently (no `boundaryChanged` — the build didn't pay off). */
  private enteredHypeFrom: SongSection = ''

  private prevDrop = false
  private dropLatchUntilBeat = -1

  private segments: StructureSegment[] = []
  /** Sorted copy of the analyzer's boundaries (confirmed past, see header). */
  private boundaries: number[] = []
  /** Snapped median inter-boundary spacing, 0 = unknown. */
  private spacing = 0
  /** The `raw` array references last ingested — a replay of the same refs is
   * not a fresh segmentation. */
  private rawSegments: StructureSegment[] | null = null
  private rawBoundaries: number[] | null = null
  /** Newest boundary already consumed (beat), -Infinity = none. */
  private lastConsumedBoundary = Number.NEGATIVE_INFINITY
  /** A consumed boundary whose covering-segment kind / section start has not
   * been applied yet (a higher-priority state — drop latch, build — was
   * in the way), -1 = none. */
  private pendingBoundary = -1
  private lastRawTime = -1
  private everValid = false
  private energyHistory: { beat: number; e: number }[] = []

  reset(): void {
    this.lastBeatIndex = -1
    this.committed = ''
    this.committedAtBeat = -1
    this.sectionStartBeat = 0
    this.candidate = ''
    this.candidateSinceBeat = 0
    this.phraseChangeBeat = Number.NEGATIVE_INFINITY
    this.buildFrames = 0
    this.buildStartBeat = -1
    this.buildDropBeat = -1
    this.prevBuildActive = false
    this.buildRearmBlockUntil = -1
    this.enteredHypeFrom = ''
    this.prevDrop = false
    this.dropLatchUntilBeat = -1
    this.segments = []
    this.boundaries = []
    this.spacing = 0
    this.rawSegments = null
    this.rawBoundaries = null
    this.lastConsumedBoundary = Number.NEGATIVE_INFINITY
    this.pendingBoundary = -1
    this.lastRawTime = -1
    this.everValid = false
    this.energyHistory = []
  }

  /**
   * Take any boundary in `this.boundaries` not consumed before and no later
   * than `beat`. Returns the newest one that is also actionable (recent enough
   * and not before the committed section's start), else -1. Every boundary seen
   * is marked consumed either way, so an old or stale one is never revisited.
   */
  private takeNewBoundary(beat: number): number {
    let actionable = -1
    let consumed = this.lastConsumedBoundary
    for (const b of this.boundaries) {
      if (b > beat || b <= this.lastConsumedBoundary + BOUNDARY_MATCH_BEATS) continue
      if (b > consumed) consumed = b
      if (beat - b <= MAX_BOUNDARY_AGE_BEATS && b >= this.sectionStartBeat && b > actionable) {
        actionable = b
      }
    }
    this.lastConsumedBoundary = consumed
    return actionable
  }

  /** True while a qualifying fast phrase-change is recent (<= PHRASE_HINT_WINDOW_BEATS old) AND is
   * about the same event as the analyzer boundary currently pending application (within
   * PHRASE_HINT_MATCH_BEATS of it). With no pending boundary there is nothing to corroborate: false. */
  private phraseHintFor(beat: number): boolean {
    const age = beat - this.phraseChangeBeat
    if (!(age >= 0 && age <= PHRASE_HINT_WINDOW_BEATS)) return false
    return this.pendingBoundary >= 0 && Math.abs(this.phraseChangeBeat - this.pendingBoundary) <= PHRASE_HINT_MATCH_BEATS
  }

  /** Beats until the next section boundary: a known future boundary if the
   * provider reported one, else `lastBoundary + period` (phase-locked, see
   * `boundarySpacing`), else -1 (unknown). */
  private beatsUntilNextBoundary(beat: number): number {
    let nextB = Infinity
    for (const b of this.boundaries) if (b > beat && b < nextB) nextB = b
    if (nextB !== Infinity) return nextB - beat
    const n = this.boundaries.length
    if (n < 2 || this.spacing <= 0) return -1
    const last = this.boundaries[n - 1]
    const k = Math.floor((beat - last) / this.spacing) + 1
    if (k > MAX_PREDICT_PERIODS) return -1
    return last + k * this.spacing - beat
  }

  update(f: AudioFeatures, raw: StructureRaw | null): void {
    const s = f.songSection
    s.boundaryChanged = false
    const beat = f.beatIndex
    const newBeat = beat !== this.lastBeatIndex
    this.lastBeatIndex = beat

    // Fast phrase-change hint: remember only the latest qualifying event. It changes nothing by
    // itself — see `phraseHintFor` for the one place it is read.
    if (f.sectionChange && !f.silence && f.sectionChangeStrength >= PHRASE_HINT_MIN_STRENGTH) {
      this.phraseChangeBeat = beat
    }

    if (newBeat && !f.silence) {
      this.energyHistory.push({ beat, e: f.energy })
      while (this.energyHistory.length > 0 && beat - this.energyHistory[0].beat > 64) {
        this.energyHistory.shift()
      }
    }

    // --- Ingest an analyzer result ---------------------------------------
    // A fresh segmentation reloads segments/boundaries and the staleness
    // clock. A per-beat refresh replays the SAME array references, so it falls
    // through to the riser block below and nothing else changes.
    let justBootstrapped = false
    if (
      raw &&
      raw.segments.length > 0 &&
      (raw.segments !== this.rawSegments || raw.boundaries !== this.rawBoundaries)
    ) {
      this.rawSegments = raw.segments
      this.rawBoundaries = raw.boundaries
      this.segments = raw.segments
      this.boundaries = [...raw.boundaries].sort((a, b) => a - b)
      this.spacing = boundarySpacing(this.boundaries)
      this.lastRawTime = f.time
      if (!this.everValid) {
        this.everValid = true
        justBootstrapped = true
      }
    }
    // The riser numbers come from the analyzer (fresh every beat); the
    // latch/release is ours.
    if (raw) {
      if (raw.build.active) {
        if (beat >= this.buildRearmBlockUntil) {
          if (this.buildStartBeat < 0)
            this.buildStartBeat = raw.build.startBeat >= 0 ? raw.build.startBeat : beat
          if (raw.build.beatsTillDrop > 0) this.buildDropBeat = beat + raw.build.beatsTillDrop
          this.buildFrames = Math.max(this.buildFrames, BUILD_CONFIRM_FRAMES)
        }
      } else {
        // The riser went quiet: whatever it reports next is a genuinely new one.
        this.buildRearmBlockUntil = -1
      }
      this.prevBuildActive = raw.build.active
    }

    const stale = this.lastRawTime >= 0 && f.time - this.lastRawTime > STALE_SEC
    f.structureValid = this.everValid
    const seg = segmentAt(this.segments, beat)

    // --- A newly learned, confirmed-past boundary ----------------------------
    // Expire an unapplied one, then look for a fresh one. A newer boundary
    // supersedes an older unapplied one (the section covering "now" started at
    // the newer).
    if (this.pendingBoundary >= 0 && beat - this.pendingBoundary > MAX_BOUNDARY_AGE_BEATS) {
      this.pendingBoundary = -1
    }
    const newBoundary = this.everValid && !justBootstrapped ? this.takeNewBoundary(beat) : -1
    if (newBoundary >= 0) this.pendingBoundary = newBoundary

    // --- Fast synchronous drop / build overlay -------------------------
    const dropEdge = f.drop && !this.prevDrop
    this.prevDrop = f.drop

    // A new boundary after the build started, with energy now high, ENDS the
    // build (the drop happened at `newBoundary`). Only a boundary at most
    // DROP_LATE_TOLERANCE_BEATS old may also fire a drop; anything older is
    // retroactive state correction with no event.
    let dropFromBoundary = false
    let buildResolvedLate = false
    if (newBoundary >= 0 && f.energy > RESOLVE_ENERGY_MIN) {
      const buildOpen = this.committed === 'build' || this.buildFrames > 0
      const buildStart =
        this.buildStartBeat >= 0
          ? this.buildStartBeat
          : this.committed === 'build'
            ? this.committedAtBeat
            : -1
      if (buildOpen && buildStart >= 0 && newBoundary > buildStart) {
        if (beat - newBoundary <= DROP_LATE_TOLERANCE_BEATS) dropFromBoundary = true
        else buildResolvedLate = true
      }
    }

    const dropEvent = dropEdge || dropFromBoundary
    if (dropEvent) {
      this.dropLatchUntilBeat = (dropEdge ? beat : newBoundary) + DROP_HOLD_BEATS
      if (this.committed !== 'build' && this.committed !== 'drop')
        this.enteredHypeFrom = this.committed
    }
    if (dropEvent || buildResolvedLate) {
      // A drop supersedes the build outright — clear it so a stale frame count
      // (or the analyzer's still-active riser window) can't re-trigger `build`
      // when the latch lifts.
      this.buildFrames = 0
      this.buildStartBeat = -1
      this.buildDropBeat = -1
      this.buildRearmBlockUntil = beat + BUILD_REARM_BLOCK_BEATS
    }
    const inDropLatch = beat < this.dropLatchUntilBeat

    if (f.buildUp && !f.silence && !inDropLatch) {
      this.buildFrames = Math.min(this.buildFrames + 1, BUILD_CONFIRM_FRAMES * 3)
      if (this.buildStartBeat < 0) this.buildStartBeat = beat
    } else if (this.buildFrames > 0 && !inDropLatch) {
      // Overrun = this many beats past the projected drop (or past the start, if none was
      // projected). The projection is re-made every beat while the riser is active, so it only
      // goes stale once the riser has gone quiet.
      const overrunFrom = this.buildDropBeat >= 0 ? this.buildDropBeat : this.buildStartBeat
      const overrun = this.buildStartBeat >= 0 && beat - overrunFrom > BUILD_FIZZLE_SLACK_BEATS
      if (overrun || (!this.prevBuildActive && this.buildFrames < BUILD_CONFIRM_FRAMES)) {
        this.buildFrames = Math.max(0, this.buildFrames - 2)
      }
      if (this.buildFrames === 0) {
        this.buildStartBeat = -1
        this.buildDropBeat = -1
      }
    }
    const buildConfirmed = this.buildFrames >= BUILD_CONFIRM_FRAMES && !inDropLatch

    // --- Bootstrap: the first real segmentation commits its current segment
    // WITHOUT a boundary edge (nothing musical just happened). The section is
    // dated from the newest past boundary (all of them count as already
    // consumed), so `beatsInSection` is honest from the first read. ----------
    if (justBootstrapped && seg) {
      this.committed = seg.kind
      this.candidate = seg.kind
      this.committedAtBeat = beat
      this.sectionStartBeat = beat
      let newestPast = -1
      for (const b of this.boundaries) if (b <= beat && b > newestPast) newestPast = b
      if (newestPast >= 0) {
        this.lastConsumedBoundary = newestPast
        if (beat - newestPast <= MAX_BOUNDARY_AGE_BEATS) this.sectionStartBeat = newestPast
      }
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
    let viaBoundary = false
    let silentRelease = false
    if (inDropLatch) {
      target = 'drop'
      viaDrop = dropEvent
    } else if (buildConfirmed) {
      if (this.committed !== 'build') this.enteredHypeFrom = this.committed
      target = 'build'
    } else if (this.committed === 'build') {
      // Build with no drop and no sustained flag = fizzle. Restore what it was
      // entered from, silently — a failed build must not read as a boundary.
      // A build the analyzer's boundary just resolved late moved on to the new
      // segment instead (also silently: the drop was too long ago to cue).
      target = buildResolvedLate && seg ? seg.kind : this.enteredHypeFrom
      silentRelease = true
    } else if (breakdownNow) {
      target = 'breakdown'
      // The analyzer's own breakdown segment, just confirmed by a boundary, is aged evidence too.
      viaBoundary = this.pendingBoundary >= 0 && seg?.kind === 'breakdown'
    } else if (this.everValid && seg) {
      if (this.pendingBoundary >= 0) {
        // A boundary began the section covering "now": adopt its kind.
        target = seg.kind
        viaBoundary = true
      } else if (this.committed === 'drop') {
        target = seg.kind // post-drop settle onto the current segment label
      }
    } else if (this.committed === 'drop') {
      target = 'section'
    }

    // --- Hysteresis commit ----------------------------------------------
    if (target !== this.candidate) {
      this.candidate = target
      const bypass = viaDrop || silentRelease || target === '' || inDropLatch
      const dwellEnd = this.committedAtBeat + dwellFor(this.committed)
      // Boundary evidence is already aged: the candidate has been true since the
      // boundary, so it only waits out the dwell, not a fresh hold.
      this.candidateSinceBeat = bypass
        ? beat
        : viaBoundary
          ? Math.max(this.pendingBoundary, dwellEnd)
          : Math.max(beat, dwellEnd)
    }
    // A recent, strong, matching phrase-change corroborates a boundary-proposed candidate: its hold
    // is cut to PHRASE_HINT_HOLD_BEATS (verse -> chorus no longer waits out the full 8 beats behind a
    // boundary the analyzer learned only ~4-6 beats after it happened). Never extends a hold, never
    // applies without an analyzer boundary behind the candidate.
    let hold = holdFor(this.candidate, viaDrop || silentRelease)
    if (viaBoundary && this.phraseHintFor(beat)) hold = Math.min(hold, PHRASE_HINT_HOLD_BEATS)
    if (this.candidate !== this.committed && beat - this.candidateSinceBeat >= hold) {
      s.previousSection = this.committed
      this.committed = this.candidate
      this.committedAtBeat = beat
      this.sectionStartBeat = beat
      s.section = this.committed
      // A silent release (fizzled build) is not a musical boundary.
      s.boundaryChanged = !silentRelease && this.committed !== ''
      if (s.boundaryChanged) s.changeCount++
    }
    // The boundary is fully applied once the committed section IS its target
    // (kind adopted, or it was already current): the section then dates from `b`
    // (the commit above stamped `beat`; the true start is the aged boundary).
    if (
      this.pendingBoundary >= 0 &&
      !inDropLatch &&
      !buildConfirmed &&
      this.committed === target &&
      this.committed !== 'build' &&
      this.committed !== 'drop'
    ) {
      this.sectionStartBeat = this.pendingBoundary
      this.pendingBoundary = -1
    }

    // --- Momentum fields -----------------------------------------------
    s.beatsInSection = Math.max(0, beat - this.sectionStartBeat)
    s.isDrop = inDropLatch
    s.isBuild = buildConfirmed
    s.isBreakdown = this.committed === 'breakdown'
    s.dropExpected = buildConfirmed
    s.isSustain = s.isBuild || s.dropExpected
    s.beatsTillDrop = buildConfirmed && this.buildDropBeat > beat ? this.buildDropBeat - beat : -1
    s.buildProgress = buildConfirmed
      ? Math.min(1, Math.max(this.buildFrames / (BUILD_CONFIRM_FRAMES * 6), s.beatsInSection / 32))
      : 0
    s.repetitionLabel = seg?.repetitionLabel ?? ''

    s.beatsTillBoundary = this.beatsUntilNextBoundary(beat)

    // Confidence: strong right after a commit, decays as `raw` goes stale.
    const age = this.lastRawTime >= 0 ? f.time - this.lastRawTime : 999
    const freshness = stale ? Math.max(0, 1 - (age - STALE_SEC) / STALE_SEC) : 1
    s.sectionConfidence = this.everValid
      ? Math.min(1, (0.45 + 0.15 * Math.min(3, s.changeCount)) * freshness)
      : 0
  }
}

export { createEmptySongSection }

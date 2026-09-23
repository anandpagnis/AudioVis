/**
 * Fast, transient-confirmed drop trigger: breakdown -> dip -> snap-back.
 *
 * WHY THIS EXISTS ALONGSIDE AudioEngine's BROADBAND detectStructure() HEURISTIC
 * That heuristic compares a ~0.35s "recent" window against a ~2.2s "before"
 * window every frame (`recent > before * 1.573 && ... && f.bass > 0.507`)
 * with no memory of what came before the "before" window itself. It is a
 * real, useful signal — a sudden jump in broadband energy with heavy bass —
 * but it structurally cannot represent the single most consistently cited
 * real-world drop cue across both the research and DJ-tool practice:
 * sub-bass reappearing after a genuinely hollowed-out breakdown. A loud,
 * sustained verse stepping up into a loud chorus can trip the same
 * instantaneous ratio test a real drop does; a breakdown that actually went
 * quiet first cannot be told apart from one that didn't, because the
 * heuristic never looks back far enough to know there WAS a breakdown.
 *
 * This class fixes that by requiring the breakdown to happen FIRST, as an
 * explicit state, before a snap-back is even eligible to fire:
 *
 *   normal  --(sub+bass falls under `dipRatio * baseline` and STAYS there
 *              for >= dipMinSec)-->  armed
 *   armed   --(sub+bass reaches the baseline again AND a qualifying
 *              transient both land within snapWindowSec of the last sample
 *              that was still "deep")-->  FIRES (one frame), -> normal
 *   armed   --(no qualifying snap-back within armTimeoutSec)--> normal
 *              (stale arm released, not latched forever)
 *
 * It is a second, independent way for AudioEngine to set the same
 * `dropUntil` pulse-latch `f.drop` already reads — not a replacement for the
 * broadband path, which stays exactly as it was.
 *
 * INPUTS. Feed `subBass = f.sub + f.bass` (each 0..1, adaptively normalized
 * per-band by BandNormalizer upstream, so a fixed baseline-RATIO threshold
 * stays meaningful across tracks and input gain — the same property the
 * broadband heuristic's own re-derived constants already lean on; the sum
 * can reach ~2, which is fine since every comparison here is baseline-
 * relative, not against an absolute ceiling). Feed `transient = f.flux`: the
 * raw, spiky onset-flux read, NOT `f.transient` — that field is an
 * exponentially-smoothed envelope of the same flux (fast attack, slow decay)
 * built for visuals that want a trailing glow, which is the opposite of what
 * a sub-0.5s "did a hit land THIS instant" concurrency check needs.
 *
 * BASELINE. A slow trailing EMA of `subBass`, entirely independent of
 * AudioEngine's `energyLog` (a broadband 6s ring buffer feeding the OTHER
 * detector) — this keeps its own single-number EMA over just the low end.
 * It FREEZES (stops updating) whenever `subBass` is below
 * `dipRatio * baseline`: without that freeze, an extended breakdown would
 * drag the baseline down with it, so by the time the real snap-back arrived
 * "reaching baseline" would mean almost nothing. Freezing keeps the
 * comparison point anchored to what the track's low end sounded like BEFORE
 * the breakdown, which is the actual "snap back to normal" a listener hears.
 *
 * THRESHOLDS (reasoned starting points, not tuned against real music yet —
 * see the plan's own "every threshold here is a reasoned starting point, not
 * a tuned one" risk note):
 *
 *   dipRatio = 0.4        Sub+bass must fall under 40% of baseline. 35% would
 *                         only catch near-total breakdowns and miss real but
 *                         less extreme ones; 45% starts catching an ordinary
 *                         quieter verse (too loose = fires on any quiet
 *                         passage). 40% sits in the middle of the plan's
 *                         35-45% band; `dipMinSec` below is what actually
 *                         guards against a merely-quiet moment arming.
 *   dipMinSec = 1.5       Below ~1s risks arming on a single quiet beat or
 *                         bar-fill (too strict a floor here = misses real,
 *                         short breakdowns; too loose = a quiet beat arms
 *                         it); above ~2s risks missing a short 2-bar hush
 *                         before a drop. 1.5s is the middle of the plan's
 *                         1-2s band.
 *   snapWindowSec = 0.5   Fixed by the plan's explicit requirement ("fast,
 *                         transient-based ... confirming in under half a
 *                         second"). Measured from the last sample that was
 *                         still "deep" (below `dipRatio * baseline`) AND,
 *                         separately, the last sample with a qualifying
 *                         transient, to the frame that finally reaches
 *                         `subBass >= baseline` — both must be recent. This
 *                         is what distinguishes an actual SNAP from an
 *                         ordinary slow climb out of a breakdown: a gradual
 *                         rise spends much longer than 0.5s crossing from
 *                         the deep zone up to baseline, so by the time it
 *                         arrives the "since deep" clock has long blown the
 *                         window and it can never fire, matching the plan's
 *                         explicit "not a slower trend" requirement.
 *   armTimeoutSec = 25    Long enough to cover an extended half-time/ambient
 *                         breakdown section that legitimately takes many
 *                         bars to resolve; short enough that a track which
 *                         just fades into a quiet outro (not staging a drop
 *                         at all) eventually releases the arm instead of
 *                         staying primed for the rest of playback, where an
 *                         unrelated later transient could fire a "drop" that
 *                         has nothing to do with that quiet section anymore.
 *                         Sits in the plan's own suggested 20-30s band.
 *   transientThreshold = 0.5   `f.flux` is already adaptively normalized
 *                         0..1 (BandNormalizer), so a fixed mid-scale bar
 *                         stays meaningful across tracks/gain the same way
 *                         the broadband heuristic's own re-derived constants
 *                         do. 0.5 asks for a clearly above-typical onset,
 *                         not just ordinary beat-to-beat flux noise.
 *   baselineTauSec = 8    Slow enough that a `dipMinSec`-scale breakdown
 *                         barely moves it even before the freeze kicks in
 *                         (freezing while deep does the rest of that work);
 *                         fast enough that "baseline" still means
 *                         "recently", not "the whole track so far".
 *
 * Deterministic, allocation-free after construction, NaN/negative-dt-safe
 * (mirrors this codebase's `if (!(dt > 0)) return` idiom — see
 * `emotionDimensions.ts` / `onsetDensity.ts`). Zero AudioEngine dependency
 * (pure scalar inputs): usable and testable standalone.
 */

export interface DropStateMachineOptions {
  /** Trailing sub+bass baseline EMA time constant (s). Default 8. */
  baselineTauSec?: number
  /** Sub+bass must fall below this fraction of the baseline to count as "deep". Default 0.4. */
  dipRatio?: number
  /** Minimum continuous time (s) sub+bass must stay deep before arming. Default 1.5. */
  dipMinSec?: number
  /** Window (s) for the snap-back + transient confirmation once armed. Default 0.5. */
  snapWindowSec?: number
  /** Stale-arm release timeout (s) — armed with no snap-back this long releases to normal. Default 25. */
  armTimeoutSec?: number
  /** Transient input must reach this value to count as a concurrent hit. Default 0.5. */
  transientThreshold?: number
}

const DEFAULT_BASELINE_TAU_SEC = 8
const DEFAULT_DIP_RATIO = 0.4
const DEFAULT_DIP_MIN_SEC = 1.5
const DEFAULT_SNAP_WINDOW_SEC = 0.5
const DEFAULT_ARM_TIMEOUT_SEC = 25
const DEFAULT_TRANSIENT_THRESHOLD = 0.5

/** Frame dt is capped at this before use, same guard `HarmonicTensionEstimator` uses for its own
 * pending-time accumulator — a backgrounded-tab gap should not be read as one giant instantaneous sample. */
const MAX_DT_SEC = 0.5

type DropState = 'normal' | 'dipping' | 'armed'

export class DropStateMachine {
  private readonly baselineTau: number
  private readonly dipRatio: number
  private readonly dipMinSec: number
  private readonly snapWindowSec: number
  private readonly armTimeoutSec: number
  private readonly transientThreshold: number

  private baseline = 0
  private seeded = false
  private state: DropState = 'normal'
  private dipElapsed = 0
  private armElapsed = 0
  /** Internal wall clock, advanced by (capped) `dt` each call — `update()` never receives an absolute
   * timestamp, so the snap-back window is measured against this instead. */
  private clock = 0
  private lastDeepClock = -Infinity
  private lastTransientClock = -Infinity

  constructor(opts: DropStateMachineOptions = {}) {
    this.baselineTau = Math.max(0.5, opts.baselineTauSec ?? DEFAULT_BASELINE_TAU_SEC)
    this.dipRatio = Math.min(0.95, Math.max(0.01, opts.dipRatio ?? DEFAULT_DIP_RATIO))
    this.dipMinSec = Math.max(0, opts.dipMinSec ?? DEFAULT_DIP_MIN_SEC)
    this.snapWindowSec = Math.max(0, opts.snapWindowSec ?? DEFAULT_SNAP_WINDOW_SEC)
    this.armTimeoutSec = Math.max(0, opts.armTimeoutSec ?? DEFAULT_ARM_TIMEOUT_SEC)
    this.transientThreshold = opts.transientThreshold ?? DEFAULT_TRANSIENT_THRESHOLD
  }

  reset(): void {
    this.baseline = 0
    this.seeded = false
    this.state = 'normal'
    this.dipElapsed = 0
    this.armElapsed = 0
    this.clock = 0
    this.lastDeepClock = -Infinity
    this.lastTransientClock = -Infinity
  }

  /**
   * Feed one frame. `subBass` and `transient` are raw scalar reads (see the file header for which
   * `AudioFeatures` fields to pass); `dt` is seconds since the previous call. Returns true on the exact
   * frame a drop fires (a one-frame rising edge, like every other trigger in this codebase) — the caller
   * (AudioEngine) turns that into its own `dropUntil` pulse-latch the same way the broadband path already
   * does. A NaN/non-finite input or a non-positive `dt` is ignored entirely (holds state, returns false).
   */
  update(subBass: number, transient: number, dt: number): boolean {
    if (!(dt > 0) || !Number.isFinite(subBass) || !Number.isFinite(transient)) return false
    const h = Math.min(dt, MAX_DT_SEC)
    this.clock += h

    // Deep/not-deep is judged against the baseline as it stood BEFORE this frame's update below, so a
    // frame can never move the goalposts it is itself being compared against.
    const deepThreshold = this.baseline * this.dipRatio
    const isDeep = this.seeded && subBass < deepThreshold
    // Freeze the baseline while deep (see header) — otherwise a long breakdown drags its own comparison
    // point down with it, and "reaches baseline" would mean almost nothing by the time it snapped back.
    if (!isDeep) {
      const k = this.seeded ? 1 - Math.exp(-h / this.baselineTau) : 1
      this.baseline += (subBass - this.baseline) * k
      this.seeded = true
    }
    if (isDeep) this.lastDeepClock = this.clock
    if (transient >= this.transientThreshold) this.lastTransientClock = this.clock

    let fired = false
    switch (this.state) {
      case 'normal':
        if (isDeep) {
          this.state = 'dipping'
          this.dipElapsed = 0
        }
        break
      case 'dipping':
        if (isDeep) {
          this.dipElapsed += h
          if (this.dipElapsed >= this.dipMinSec) {
            this.state = 'armed'
            this.armElapsed = 0
          }
        } else {
          // Recovered before the dip was sustained long enough to count as a genuine breakdown — a
          // single quiet beat, not a structural one. Deliberately resets rather than decaying: the
          // simplest rule that is still easy to reason about and test; a leakier accumulator is a
          // plausible future refinement once this is tuned against real material, not before.
          this.state = 'normal'
        }
        break
      case 'armed':
        this.armElapsed += h
        if (subBass >= this.baseline) {
          // A genuine SNAP requires BOTH "recently deep" and "a concurrent transient" inside the same
          // tight window — that combination is what a slow climb out of a breakdown can never produce
          // (see header). Either way, reaching the baseline spends this arm cycle: there is no more
          // "dip" left to snap out of, fired or not.
          if (
            this.clock - this.lastDeepClock <= this.snapWindowSec &&
            this.clock - this.lastTransientClock <= this.snapWindowSec
          ) {
            fired = true
          }
          this.state = 'normal'
        } else if (this.armElapsed >= this.armTimeoutSec) {
          // Stale: the breakdown never resolved into a drop. Release rather than latching armed for the
          // rest of playback — the very next continuously-deep stretch is free to arm again from scratch.
          this.state = 'normal'
        }
        break
    }
    return fired
  }
}

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
 *   normal  --(sub+bass falls under `dipRatio * baseline` and accumulates
 *              >= dipMinSec of "deep" time — LEAKY: a short flicker back above
 *              the threshold drains the timer at `dipLeak`x real time instead of
 *              zeroing it)-->  armed
 *   armed   --(sub+bass reaches the baseline again within snapWindowSec of the
 *              last sample that was still "deep", AND EITHER a qualifying
 *              transient lands in that same window OR the dip was a long one
 *              (>= lowSnapMinDipSec of deep time: the low-band-only snap-back,
 *              for when the flux input is small))-->  FIRES (one frame), -> normal
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
 *   dipMinSec = 0.7       Was 1.5. That floor missed the short 1-bar hush/gap
 *                         producers leave right before a drop (typically 1-2
 *                         beats, 0.5-1 s). 0.7 s (~1.4 beats at 120 BPM) sits
 *                         in the 0.5-0.8 s band: above the deep time a single
 *                         missing kick leaves in a four-on-the-floor loop
 *                         (sub+bass decays under 40% of its average ~0.4 s after
 *                         a kick, so one skipped kick is deep for ~0.6 s; an
 *                         ordinary between-kick interval for ~0.1 s), below a
 *                         real 1-beat-plus pre-drop gap. The flicker/leak rule
 *                         below and the snap-back requirement carry the rest of
 *                         the false-positive load.
 *   dipLeak = 2           A frame back above the deep threshold drains the dip
 *                         timer at 2x real time (was: reset to zero). A single
 *                         50 ms flicker inside a genuine breakdown (a stray hit,
 *                         an LFO peak) costs 100 ms of accumulated dip instead
 *                         of all of it; a genuinely non-deep stretch (>= half as
 *                         long as the dip so far) still drains it to nothing,
 *                         and a beat-by-beat kick loop (0.1-0.15 s deep, 0.35 s
 *                         not) never accumulates.
 *   lowSnapMinDipSec = 1.0  The low-band-only trigger: sub+bass returning to
 *                         baseline within snapWindowSec of the last deep sample
 *                         fires WITHOUT a concurrent flux spike — but only after
 *                         at least this much deep time, i.e. a clearly hollowed-
 *                         out breakdown, since without the transient the dip
 *                         length is the only evidence left. Shorter dips still
 *                         need the transient.
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
 * REFRACTORY AND REPEAT GUARD (added with the tap logs: a pumping / sidechained passage fired 14 drops in 28 s, spacing 1.3-2.6 s,
 * in a song whose real drops were 20 s apart). A drop is a rare, section-level event, so two mechanisms stop a machine that
 * fires over and over from doing so:
 *   refractorySec = 4     after a fire, no dip is even considered for this long (about two bars at 120 BPM: a second
 *                         "drop" that close is the same event or a bass-line rest pattern, never a new section).
 *   repeat guard          every fire inside the last `repeatWindowSec` (20 s) makes the next dip need one more
 *                         `dipMinSec` of deep time (and `lowSnapMinDipSec`): a genuine breakdown-then-drop lasts as long
 *                         however recently a drop fired, a rest pattern does not. One fire in the window doubles the bar, two
 *                         triple it. Both are inert on music that drops every 15-20 s or less often.
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
  /** Minimum accumulated "deep" time (s) before arming (leaky, see `dipLeak`). Default 0.7. */
  dipMinSec?: number
  /** While dipping, a frame back above the deep threshold drains the accumulated dip time at this
   * multiple of real time (0 = never drains, huge = the old reset-to-zero). Default 2. */
  dipLeak?: number
  /** Dip length (s of deep time) from which a snap-back needs no concurrent transient — the
   * low-band-only trigger. Default 1.0 (>= `dipMinSec`; set very large to require the transient always). */
  lowSnapMinDipSec?: number
  /** Window (s) for the snap-back + transient confirmation once armed. Default 0.5. */
  snapWindowSec?: number
  /** Stale-arm release timeout (s) — armed with no snap-back this long releases to normal. Default 25. */
  armTimeoutSec?: number
  /** Transient input must reach this value to count as a concurrent hit. Default 0.5. */
  transientThreshold?: number
  /** After a fire, dips are ignored for this long (s). 0 = off. Default 4. */
  refractorySec?: number
  /** Each fire within this many seconds raises the deep time the next dip needs by one `dipMinSec` (and `lowSnapMinDipSec`). 0 = off. Default 20. */
  repeatWindowSec?: number
}

const DEFAULT_BASELINE_TAU_SEC = 8
const DEFAULT_DIP_RATIO = 0.4
const DEFAULT_DIP_MIN_SEC = 0.7
const DEFAULT_DIP_LEAK = 2
const DEFAULT_LOW_SNAP_MIN_DIP_SEC = 1.0
const DEFAULT_SNAP_WINDOW_SEC = 0.5
const DEFAULT_ARM_TIMEOUT_SEC = 25
const DEFAULT_TRANSIENT_THRESHOLD = 0.5
const DEFAULT_REFRACTORY_SEC = 4
const DEFAULT_REPEAT_WINDOW_SEC = 20
/** Fire stamps kept for the repeat guard (older ones are past any sensible window anyway). */
const FIRE_RING = 6

/** Frame dt is capped at this before use, same guard `HarmonicTensionEstimator` uses for its own
 * pending-time accumulator — a backgrounded-tab gap should not be read as one giant instantaneous sample. */
const MAX_DT_SEC = 0.5

type DropState = 'normal' | 'dipping' | 'armed'

export class DropStateMachine {
  private readonly baselineTau: number
  private readonly dipRatio: number
  private readonly dipMinSec: number
  private readonly dipLeak: number
  private readonly lowSnapMinDipSec: number
  private readonly snapWindowSec: number
  private readonly armTimeoutSec: number
  private readonly transientThreshold: number
  private readonly refractorySec: number
  private readonly repeatWindowSec: number

  private baseline = 0
  private seeded = false
  private state: DropState = 'normal'
  /** Leaky accumulated deep time while dipping (s). */
  private dipElapsed = 0
  /** Total deep time of the current dip, carried through `armed` (keeps growing while still deep). */
  private deepSec = 0
  private armElapsed = 0
  /** Internal wall clock, advanced by (capped) `dt` each call — `update()` never receives an absolute
   * timestamp, so the snap-back window is measured against this instead. */
  private clock = 0
  private lastDeepClock = -Infinity
  private lastTransientClock = -Infinity
  private readonly fireClocks = new Float64Array(FIRE_RING).fill(-Infinity)
  private firePos = 0

  constructor(opts: DropStateMachineOptions = {}) {
    this.baselineTau = Math.max(0.5, opts.baselineTauSec ?? DEFAULT_BASELINE_TAU_SEC)
    this.dipRatio = Math.min(0.95, Math.max(0.01, opts.dipRatio ?? DEFAULT_DIP_RATIO))
    this.dipMinSec = Math.max(0, opts.dipMinSec ?? DEFAULT_DIP_MIN_SEC)
    this.dipLeak = Math.max(0, opts.dipLeak ?? DEFAULT_DIP_LEAK)
    this.lowSnapMinDipSec = Math.max(0, opts.lowSnapMinDipSec ?? DEFAULT_LOW_SNAP_MIN_DIP_SEC)
    this.snapWindowSec = Math.max(0, opts.snapWindowSec ?? DEFAULT_SNAP_WINDOW_SEC)
    this.armTimeoutSec = Math.max(0, opts.armTimeoutSec ?? DEFAULT_ARM_TIMEOUT_SEC)
    this.transientThreshold = opts.transientThreshold ?? DEFAULT_TRANSIENT_THRESHOLD
    this.refractorySec = Math.max(0, opts.refractorySec ?? DEFAULT_REFRACTORY_SEC)
    this.repeatWindowSec = Math.max(0, opts.repeatWindowSec ?? DEFAULT_REPEAT_WINDOW_SEC)
  }

  reset(): void {
    this.baseline = 0
    this.seeded = false
    this.state = 'normal'
    this.dipElapsed = 0
    this.deepSec = 0
    this.armElapsed = 0
    this.clock = 0
    this.lastDeepClock = -Infinity
    this.lastTransientClock = -Infinity
    this.fireClocks.fill(-Infinity)
    this.firePos = 0
  }

  /** Fires inside the repeat window, as a multiplier on the deep time a dip needs (1 = none recently). */
  private repeatScale(): number {
    if (this.repeatWindowSec <= 0) return 1
    let n = 0
    for (let i = 0; i < FIRE_RING; i++) if (this.clock - this.fireClocks[i] <= this.repeatWindowSec) n++
    return 1 + n
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
        if (isDeep && this.clock - this.fireClocks[(this.firePos + FIRE_RING - 1) % FIRE_RING] >= this.refractorySec) {
          this.state = 'dipping'
          // The frame that crosses under the threshold is deep time too (so N deep frames = N * dt).
          this.dipElapsed = h
        }
        break
      case 'dipping':
        if (isDeep) {
          this.dipElapsed += h
          if (this.dipElapsed >= this.dipMinSec * this.repeatScale()) {
            this.state = 'armed'
            this.armElapsed = 0
            this.deepSec = this.dipElapsed
          }
        } else {
          // LEAKY: a frame back above the deep threshold drains the timer (dipLeak x real time) rather
          // than zeroing it, so one stray flicker inside a genuine breakdown doesn't throw away the dip so
          // far — while a stretch that is not deep for long enough (a beat-by-beat kick loop, a single
          // quiet beat) still drains it to nothing and drops back to normal.
          this.dipElapsed -= h * this.dipLeak
          if (this.dipElapsed <= 0) {
            this.dipElapsed = 0
            this.state = 'normal'
          }
        }
        break
      case 'armed':
        this.armElapsed += h
        if (isDeep) this.deepSec += h
        if (subBass >= this.baseline) {
          // A genuine SNAP requires "recently deep" — reaching the baseline within snapWindowSec of the
          // last deep sample is what a slow climb out of a breakdown can never do (see header) — PLUS
          // one of two confirmations: a concurrent transient in that same window, OR (low-band-only) a
          // dip long enough (lowSnapMinDipSec of deep time) that the returning low end is evidence by
          // itself, for when the flux input is small. Either way, reaching the baseline spends this arm
          // cycle: there is no more "dip" left to snap out of, fired or not.
          const recentlyDeep = this.clock - this.lastDeepClock <= this.snapWindowSec
          const transientNow = this.clock - this.lastTransientClock <= this.snapWindowSec
          if (recentlyDeep && (transientNow || this.deepSec >= this.lowSnapMinDipSec * this.repeatScale())) {
            fired = true
            this.fireClocks[this.firePos] = this.clock
            this.firePos = (this.firePos + 1) % FIRE_RING
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

/**
 * Rolling onset-RATE tracker (events/sec, normalised 0..1).
 *
 * Pure — takes boolean trigger pulses and a frame delta, nothing else. No
 * import of `AudioEngine`/`PercussionDetector`: a caller elsewhere feeds it
 * `f.percussion.hihat.trigger || f.percussion.snare.trigger` per frame. This
 * file only owns the rate estimate.
 *
 * WHY AN EXPONENTIAL LEAKY INTEGRATOR, NOT A SLIDING WINDOW OF TIMESTAMPS
 * A true "count events in the last N seconds" window needs a queue of
 * timestamps that grows and gets pruned every call — an allocation (or at
 * least a mutable array) per update. Instead this keeps a single scalar
 * `countEma` that decays by `exp(-dt / windowSec)` every call and gets +1 on
 * a trigger. For a steady pulse train at rate R (periodic or Poisson), the
 * steady-state expectation of that decaying sum is `R * windowSec` (each
 * impulse's exponential tail integrates to `windowSec`, and by Campbell's
 * theorem the sum over a rate-R process converges to `R * windowSec`) — so
 * `countEma / windowSec` is a genuine, allocation-free estimator of the
 * rolling rate, not just a vague proxy. `windowSec` doubles as both the decay
 * time-constant and the implicit averaging window.
 *
 * WINDOW: 3s. The plan calls for "~2-4s"; 3s sits in the middle — long enough
 * to smooth over a single dropped/extra hit (a missed snare in a roll
 * shouldn't visibly dent the read), short enough that an onset-density read
 * still tracks a build's acceleration within a handful of bars, not across
 * an entire section.
 *
 * NORMALISATION CEILING: 16th notes at 160 BPM. 160 BPM = 160/60 beats/sec =
 * 2.667 beats/sec; four 16th notes per beat -> 2.667 * 4 = 10.667 events/sec.
 * That's a genuinely fast, musically-real ceiling (a snare roll accelerating
 * into 16th or 32nd notes is exactly the "build" cue this feeds), well above
 * typical verse/chorus hat patterns (8th notes at 120 BPM = 4 Hz), so normal
 * grooves read well under 1.0 and only a real roll/flourish approaches it.
 *
 * HOLD-THROUGH-GAP CONVENTION: this codebase's idiom for "don't let a bad
 * frame delta snap a slow-moving read to zero" is `EmotionDimensionEstimator
 * .update()` (`src/audio/emotionDimensions.ts`): `if (silence || !(dt > 0))
 * return`. This tracker has no `silence` flag (silence *should* naturally
 * decay the rate towards 0, which the leaky integrator already does on its
 * own as real time passes with no triggers — that's correct behaviour, not a
 * bug to guard against) — but it copies the `!(dt > 0)` half exactly: a NaN,
 * zero or negative `dt` (a paused clock, a bad timestamp) is a frame to
 * ignore, not a real gap in the music, so the read is held unchanged.
 */

/** Rolling window / decay time-constant, seconds. See file header. */
export const ONSET_DENSITY_WINDOW_SEC = 3

/** Normalisation ceiling, events/sec: 16th notes at 160 BPM. See file header. */
export const ONSET_DENSITY_MAX_RATE_HZ = (160 / 60) * 4

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export class OnsetDensityTracker {
  private countEma = 0
  private normalized = 0

  constructor(
    private readonly windowSec: number = ONSET_DENSITY_WINDOW_SEC,
    private readonly maxRateHz: number = ONSET_DENSITY_MAX_RATE_HZ,
  ) {}

  /**
   * Advance one frame. `trigger` is a one-frame pulse (e.g. a hi-hat OR snare
   * onset this frame); `dt` is the frame delta in seconds. Allocation-free:
   * only scalar field writes, no arrays/objects created. A NaN/zero/negative
   * `dt` is ignored entirely (holds the last read) — see file header.
   */
  update(trigger: boolean, dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return
    const decay = Math.exp(-dt / this.windowSec)
    this.countEma = this.countEma * decay + (trigger ? 1 : 0)
    const rateHz = this.countEma / this.windowSec
    this.normalized = clamp01(rateHz / this.maxRateHz)
  }

  /** Current normalised onset density, 0..1. Same value returned until the next `update()`. */
  read(): number {
    return this.normalized
  }

  /** Raw estimated rate in events/sec — exposed for tests/debug overlays, not required for normal use. */
  rate(): number {
    return this.countEma / this.windowSec
  }

  reset(): void {
    this.countEma = 0
    this.normalized = 0
  }
}

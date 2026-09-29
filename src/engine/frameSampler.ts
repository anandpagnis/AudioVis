import { RollingWindow } from './RollingWindow'

/**
 * Frame-time sampling policy: what the quality governor is allowed to see.
 *
 * ## The failure this exists to prevent
 *
 * The governor steps the quality tier down when the frame-time p95 is bad. But
 * stepping down used to be expensive in itself: it changed the device pixel
 * ratio, which resized the renderer, which reallocated the post chain's whole
 * mip pyramid — a multi-hundred-millisecond stall. (Since F272 stage 5 it is
 * not: the render scale is a sub-rect of buffers allocated once, a step costs
 * nothing, and nothing suspends the sampler for one — which also matters,
 * because a step can now land every frame and suspending on each would blind
 * the governor for good. The failure below is still what a compile or a commit
 * would do without rule 1.)
 *
 * With one shared 10 s window that stall was fed straight back into the metric
 * that caused it. The governor's `SETTLE_SEC` is 2 s, so it re-checked five
 * times inside its own pollution, saw the same elevated p95 each time, and
 * stepped down again — each step firing another resize, another stall, more
 * pollution. A single legitimate spike drove the tier from 0 to 4 in about ten
 * seconds and pinned it there.
 *
 * That is a control-loop error, not a tuning problem: a slow-decaying metric
 * (a 10 s percentile) was driving a fast-acting controller (a 2 s interval)
 * whose own actuation cost landed inside the measurement. Two rules fix it, and
 * both are enforced here rather than in the component so they can be tested:
 *
 * 1. **The governor never measures a known one-off.** {@link FrameSampler.suspend}
 *    drops frames caused by an actuation or a transition — a scene commit's
 *    shader compile and crossfade, a context restore, the post chain's first
 *    build. Those frames are
 *    real and the display still reports them; they are simply not evidence about
 *    *steady-state* load, which is the only thing the tier should respond to.
 *
 * 2. **The governor's window is no longer than its reaction interval.** At
 *    `GOVERNOR_WINDOW_SEC` ≤ `SETTLE_SEC` a spike can influence at most one
 *    decision before it ages out, so the loop cannot compound even if something
 *    slips past rule 1.
 *
 * The display window keeps everything, unfiltered. A scene change really does
 * drop frames and the fps meter should say so — hiding that would be lying to
 * the person holding the instrument. The two consumers want genuinely different
 * things: the meter wants the truth, the controller wants a signal it can act
 * on without chasing its own tail.
 *
 * ## F198: rule 1 covered the percentile window and nothing else
 *
 * The governor does not read `governorP95()` alone — `quality.tick()` also
 * takes a smoothed mean, computed as a 0.05-alpha EMA over raw per-frame `ms`.
 * That EMA lived entirely in `PerfMonitor.tsx`, outside this class, computed
 * unconditionally from every frame with no knowledge of `suspend()` at all —
 * so rule 1 above was true for the p95 axis and silently false for the mean
 * axis: the exact known-one-off frames this file exists to hide from the
 * governor were still moving it, just through the other argument.
 *
 * A live session confirmed it: a 158.4 ms warm-mount compile stall (a
 * candidate scene that compiled and was then withdrawn — `SceneManager.tsx`'s
 * warm-mount path never calls `suspend()` at all, unlike a real commit) moved
 * a 0.05-alpha EMA from 16.7 to 23.8 ms in one frame, past `STEP_DOWN_MEAN_RATIO`'s
 * 18.3 ms gate, and demoted the tier one `SETTLE_SEC` later — on a machine
 * whose GPU measured 9% of frame time that session.
 *
 * {@link FrameSampler.stepGovernorEma} closes this the same way `push()`
 * already closes it for the percentile: both read the identical `suspended`
 * state, so a frame excused from one is excused from the other. The display
 * EMA (`PerfMonitor.tsx`'s own `ema` ref, feeding `perf.ms`/`perf.fps`) is
 * deliberately untouched — that one's job is to tell the person holding the
 * instrument the truth about a real stall, same reasoning as the display
 * window above.
 */

/** Unfiltered window for the meter and analytics panel. Shows reality. */
const DISPLAY_WINDOW_SEC = 10

/**
 * The governor's window. **Must stay ≤ `SETTLE_SEC` in quality.ts** — that
 * inequality is the whole of rule 2 above, and `frameSampler.test.ts` pins it.
 */
export const GOVERNOR_WINDOW_SEC = 2

/**
 * Frames dropped from the governor's view after a transition.
 *
 * ~0.5 s at 60 fps. Long enough to cover a shader compile and the frames
 * around it; short enough that a scene which is genuinely too heavy is still
 * caught within one `SETTLE_SEC` of settling down.
 */
export const DEFAULT_SUSPEND_FRAMES = 30

export class FrameSampler {
  /** Everything, unfiltered — what the fps meter and analytics panel read. */
  readonly display = new RollingWindow(DISPLAY_WINDOW_SEC)
  /** Steady-state frames only — what the quality governor reads. */
  private readonly governor = new RollingWindow(GOVERNOR_WINDOW_SEC)
  private skip = 0

  /**
   * Exclude the next `frames` frames from the governor's view.
   *
   * Takes the LONGER of any overlapping requests rather than resetting, so a
   * scene commit landing inside a longer suspension (a context restore's)
   * cannot accidentally shorten it.
   */
  suspend(frames = DEFAULT_SUSPEND_FRAMES): void {
    this.skip = Math.max(this.skip, frames)
  }

  /** True while the governor is being kept blind. Exposed for the debug panel. */
  get suspended(): boolean {
    return this.skip > 0
  }

  push(t: number, ms: number): void {
    this.display.push(t, ms)
    if (this.skip > 0) {
      this.skip--
      return
    }
    this.governor.push(t, ms)
  }

  /**
   * Advance the governor's OWN mean-axis EMA by one frame — see the F198
   * section of this file's header doc for why a second EMA exists at all.
   *
   * Reads the same `suspended` state `push()` already gates the percentile
   * window on: a frame excused from the p95 window is excused here too,
   * with no separate call for a caller to remember to make. Held while
   * suspended rather than reset, matching `governor`'s own window (a
   * suspension means "no evidence", not "evidence of zero load").
   */
  stepGovernorEma(prevEma: number, ms: number, alpha = 0.05): number {
    return this.suspended ? prevEma : prevEma + (ms - prevEma) * alpha
  }

  /**
   * p95 of steady-state frames, or 0 when there is not enough evidence.
   *
   * Returning 0 rather than a percentile over a handful of samples is
   * deliberate: `quality.tick` treats 0 as "no variance signal" and falls back
   * to the mean axis alone. Just after a suspension the governor should be
   * agnostic, not confident — a p95 computed from three frames is noise, and
   * acting on it is how the runaway started.
   */
  governorP95(): number {
    if (this.governor.count() < MIN_GOVERNOR_SAMPLES) return 0
    return this.governor.percentile(0.95)
  }

  /** Drop all history — used on context loss, where nothing before is comparable. */
  reset(): void {
    this.display.clear()
    this.governor.clear()
    this.skip = 0
  }
}

/**
 * Minimum steady-state frames before the p95 is trusted. A quarter-second at
 * 60 fps — enough that the 95th percentile is picking a real tail sample rather
 * than whichever frame happened to be worst out of four.
 */
export const MIN_GOVERNOR_SAMPLES = 15

export const frameSampler = new FrameSampler()

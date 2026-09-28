/**
 * Beat-locked motion: position that is a pure function of where the beat grid is, not of wall-clock time.
 *
 * ## Why this exists
 * A scene that advances `phase += dt * rate` and then bolts a kick-triggered pulse on top has two clocks that are
 * never the same clock: the drift runs at its own speed and the pulses land where the detector says. That reads as
 * a video looping in the background with events pasted over it, "an mp4 trying to be on beat". Motion that is
 * INSIDE the beat (each beat advances a parameter by one eased step) is on the beat by construction, even on a
 * beat the kick detector missed, and it stays continuous: nothing here ever jumps or reverses.
 *
 * ## The shape of a step
 * Within a beat the parameter moves along {@link snapGlide}: most of the travel happens right after the beat line
 * (the "hit") and the rest is a glide that settles just as the next beat lands. The per-beat WEIGHT sets how far
 * that beat travels, so a bar can have an accent pattern (downbeat biggest) and a phrase can have a bigger step.
 *
 * Pure: no React, store or three imports, so it is testable without a render loop.
 */

/** Ease-out cubic: fast right after the beat line, settling to 1 at the next. `snapGlide(0) = 0`, `snapGlide(1) = 1`. */
export function snapGlide(p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p
  const y = 1 - x
  return 1 - y * y * y
}

/** How much of the current beat's step is still to come, 1 at the beat line falling to 0: a "swell that relaxes". */
export function beatRelax(p: number): number {
  return 1 - snapGlide(p)
}

/**
 * A per-beat swell 0..1: a ~10% attack (smooth, so a hit is three frames of ramp and never a one-frame pop in a
 * chaotic fractal parameter) then a quadratic relax that is back to 0 at the next beat line. Peaks at ~1.
 */
export function beatSwell(p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p
  const t = Math.min(1, x / 0.1)
  const attack = t * t * (3 - 2 * t)
  const d = 1 - x
  return Math.min(1, attack * d * d * 1.23)
}

export interface BeatMotion {
  /** Beat index last seen, -1 before the first frame. */
  lastBeat: number
  /** Total weight of every beat that has fully elapsed. */
  acc: number
  /** Weight the beat now in progress will travel (kept so the crossing adds exactly what was being eased). */
  curWeight: number
  /** Eased, weighted position: `acc + curWeight * snapGlide(progress)`. Monotone. */
  eased: number
  /** Whole beats plus raw progress. Monotone, no easing: for parameters that must move without a lurch. */
  linear: number
  /** Whole beats elapsed (counts crossings, never the raw `beatIndex`). */
  whole: number
  /** Seconds since the last crossing, for the free-run fallback when no beat grid is being delivered. */
  quiet: number
}

export function beatMotion(): BeatMotion {
  return { lastBeat: -1, acc: 0, curWeight: 1, eased: 0, linear: 0, whole: 0, quiet: 0 }
}

/**
 * Advance the motion one frame.
 *
 * `weight` is what the beat now in progress should travel (any positive number; 1 = a unit step). `bpm` is used
 * only for the free-run fallback: with no beat crossing for two beat periods (no grid, silence, a paused song) the
 * position keeps advancing at `bpm` (or 100) so the scene never freezes, and it re-syncs on the next real crossing.
 *
 * Guarantees, whatever the grid does: `eased` and `linear` never decrease, and a crossing adds exactly the weight
 * of the beat that just ended (so the eased position is continuous across the beat line). A jump in `beatIndex`
 * (a seek, a re-lock) counts as at most two crossings, never a burst of them.
 */
export function stepBeatMotion(
  m: BeatMotion,
  beatIndex: number,
  beatProgress: number,
  weight: number,
  dt: number,
  bpm = 100,
): void {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1
  const p = Number.isFinite(beatProgress) ? Math.min(1, Math.max(0, beatProgress)) : 0
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0

  if (m.lastBeat < 0) {
    m.lastBeat = beatIndex
    m.curWeight = w
  } else if (beatIndex !== m.lastBeat) {
    const crossed = Number.isFinite(beatIndex) ? Math.min(2, Math.max(1, Math.abs(beatIndex - m.lastBeat))) : 1
    m.acc += m.curWeight * crossed
    m.whole += crossed
    m.lastBeat = beatIndex
    m.quiet = 0
  }
  m.curWeight = w

  m.quiet += step
  const period = 60 / Math.max(40, Math.min(240, Number.isFinite(bpm) && bpm > 0 ? bpm : 100))
  if (m.quiet > 2 * period) {
    // No grid: free-run at the tempo so the scene keeps moving. `linear` and `eased` advance together.
    const inc = step / period
    m.acc += inc * m.curWeight
    m.whole += inc
    m.eased = Math.max(m.eased, m.acc)
    m.linear = Math.max(m.linear, m.whole)
    return
  }

  m.eased = Math.max(m.eased, m.acc + m.curWeight * snapGlide(p))
  m.linear = Math.max(m.linear, m.whole + p)
}

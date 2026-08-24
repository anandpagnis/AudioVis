/**
 * Pure policy for the feedback pass: maps ONE external dial —
 * `performanceState.trails`, 0..1 — onto the shader knobs `FeedbackPass`
 * actually drives. Split out from `FeedbackPass.ts` so the mapping is testable
 * without a WebGL context, matching this codebase's split between engine logic
 * (tested directly) and the WebGL-touching executor that applies it (not
 * unit-tested — see `quality.ts` / `PerfMonitor.tsx` for the same split).
 *
 * ## Why one dial, not five
 *
 * `EffectsDirector` is a pure executor by contract (see its header): it reads
 * `performanceState` and applies it, and reads no audio itself. A director
 * upstream is free to set `trails` from mood, tension, or a human dial — but
 * whatever sets it hands over ONE number, not `persist`/`zoom`/`rotate`/`swirl`/
 * `wobble` individually. This module is where that one number becomes five,
 * so the shape of the trail (the fixed ratios below) is an engine-owned
 * aesthetic decision, not something five different callers could each get
 * slightly wrong.
 *
 * Ported from lilim's per-frame feedback tuning (`main.js`, `fb.uZoom` /
 * `uRotate` / `uSwirl` / `uWobble`), with the audio coupling removed — those
 * terms read `s.kick` / `s.mids` / `s.sub` directly, which is exactly the
 * "everything creative happened upstream" boundary `EffectsDirector` does not
 * cross. The autonomous motion here is what is left once the audio terms are
 * gone: a fixed, gentle drift whose AMPLITUDE still scales with `trails`, so
 * the pass looks alive even at a trails value nothing has changed in seconds.
 */

/** Shader knobs {@link FeedbackPass} drives, per frame. */
export interface FeedbackKnobs {
  /**
   * History weight, 0..1. What the shader calls `uPersist`: how much of the
   * warped previous frame survives into this one before the current frame is
   * maxed over it.
   */
  persist: number
  /**
   * Per-second LOG zoom rate. `FeedbackPass` compounds this each frame as
   * `Math.exp(rate * dt)`, so it composes correctly across an uneven frame
   * rate — the same real-elapsed-time compounding trick `quality.ts` and
   * `renderScale.ts` use elsewhere in this engine, just in log space instead
   * of linear. Always >= 0: a positive rate pulls the sample inward (the
   * tunnel read); this mapping never asks for an outward zoom, since that
   * just smears without ever compounding into depth.
   */
  zoomRatePerSec: number
  /** Per-second rotation rate, in radians. */
  rotateRatePerSec: number
  /** Swirl amount: extra rotation that varies with distance from centre. */
  swirl: number
  /** Wobble amount: a small per-axis positional warp. */
  wobble: number
}

/** `trails` at or below this reads as fully off — no accumulation, no drift. */
const OFF_THRESHOLD = 0.02

/**
 * `persist` never reaches 1. A feedback loop with a persist of exactly 1 never
 * decays, so a single bright frame accumulates forever and the picture washes
 * to white — the class of bug lilim's own comments flag by name. 0.94 is
 * short enough to always fully decay (well under a second at 60fps) while
 * still reading as a long, deliberate trail at the top of the range.
 */
const MAX_PERSIST = 0.94

/** Zoom/rotate/swirl/wobble amplitudes at `trails = 1`. Tuned by eye, not
 *  measured — the honest starting point every other magic-number scene
 *  constant in this codebase is, pending a look at real footage. */
const MAX_ZOOM_RATE = 0.16 // per second, log scale: e^0.16 ≈ 1.17x zoom/sec
const MAX_ROTATE_RATE = 0.05 // rad/sec
const MAX_SWIRL = 0.35
const MAX_WOBBLE = 0.4

/**
 * Resolve the shader knobs for the current `trails` value.
 *
 * Every knob is a plain multiple of `trails` (clamped 0..1 first), so the
 * whole pass scales smoothly from "no trace of a loop" at 0 to "full tunnel"
 * at 1 with no discontinuity anywhere in between — a director easing `trails`
 * over a phrase gets a continuous transition for free.
 */
export function resolveFeedbackKnobs(trails: number): FeedbackKnobs {
  const t = Number.isNaN(trails) ? 0 : trails < 0 ? 0 : trails > 1 ? 1 : trails
  if (t <= OFF_THRESHOLD) {
    return { persist: 0, zoomRatePerSec: 0, rotateRatePerSec: 0, swirl: 0, wobble: 0 }
  }
  return {
    persist: Math.min(MAX_PERSIST, t * MAX_PERSIST),
    zoomRatePerSec: t * MAX_ZOOM_RATE,
    rotateRatePerSec: t * MAX_ROTATE_RATE,
    swirl: t * MAX_SWIRL,
    wobble: t * MAX_WOBBLE,
  }
}

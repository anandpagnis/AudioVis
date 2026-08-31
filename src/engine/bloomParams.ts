/**
 * Pure policy for the bloom threshold: where `PerformanceStateBridge` used to
 * inline this arithmetic directly in its per-frame body. Split out for the
 * same reason `feedbackParams.ts` was — testable without a WebGL context or a
 * mounted React tree, matching this codebase's split between engine logic
 * (tested directly) and the executor that applies it (`PostFXChain`, not
 * unit-tested).
 *
 * ## What this fixes (audit c10)
 *
 * Bloom runs mid-chain, on the composited frame BEFORE `GradePass`'s exposure
 * multiply — its threshold is a judgement about PRE-gain luminance. The
 * exposure servo (`exposure.ts`) measures the FINAL, POST-gain, actually-
 * displayed frame (`ExposureSampler` reads back the canvas after the whole
 * composer, including `GradePass`, has run). A FIXED pre-gain threshold and a
 * MOVING post-gain correction are answering different questions about
 * different images — and this codebase's own diagnosis is that the scenes
 * render hot, so `exposure.gain` spends most of its life below 1 (see
 * `GAIN_MIN`'s own doc: "the correction that matters is downward"). Every
 * time the servo pulls gain down to fix a hot frame, an unmoving absolute
 * threshold covers a shrinking share of what the viewer is actually seeing
 * get corrected — bloom's footprint in the final image drifts as a side
 * effect of a completely different mechanism doing its job.
 *
 * {@link bloomThreshold} divides the resting threshold by the servo's live
 * gain, converting "the top ~N% of the DISPLAYED frame" into the equivalent
 * pre-gain number bloom actually needs — so a servo correction changes
 * overall brightness without silently changing how much of the picture
 * blooms. At gain 1 (the servo at rest) this returns exactly `base`,
 * unchanged from the constant this replaced.
 */

/** Resting bloom threshold at gain 1 — the value the pass was hardcoded to
 *  before this was directed. */
export const BLOOM_THRESHOLD_BASE = 0.18

/** Absolute floor — below this everything blooms and the picture turns to
 *  soup, whatever pressure or gain says. */
export const BLOOM_THRESHOLD_FLOOR = 0.05

export interface BloomThresholdInputs {
  /** `exposure.gain` — the servo's live correction, 1 at rest. */
  gain: number
  /** `exposure.sampled` — false before the first readback lands (e.g. at
   *  boot); the gain-relative conversion is meaningless with no reading yet. */
  sampled: boolean
  /** Floor on the divisor — pass `GAIN_MIN` so a near-floor gain cannot spike
   *  the threshold. */
  gainFloor: number
  /** `performanceState.visualTension`, 0..1. */
  tension: number
  /** Whether a drop is active this frame. */
  drop: boolean
  /** Beat-synced pulse, 0..1-ish. */
  pulse: number
}

/**
 * The bloom threshold for this frame.
 *
 * Pure and total: every finite-or-not input produces a finite result at or
 * above {@link BLOOM_THRESHOLD_FLOOR}, because a NaN reaching the shader
 * uniform would either bloom nothing or bloom everything depending on the
 * driver, and neither is a frame this function should ever produce.
 */
export function bloomThreshold(i: BloomThresholdInputs): number {
  const gain = Number.isFinite(i.gain) ? i.gain : 1
  const gainFloor = Number.isFinite(i.gainFloor) && i.gainFloor > 0 ? i.gainFloor : 0.01
  const baseline = i.sampled ? BLOOM_THRESHOLD_BASE / Math.max(gainFloor, gain) : BLOOM_THRESHOLD_BASE

  const tension = Number.isFinite(i.tension) ? i.tension : 0
  const pulse = Number.isFinite(i.pulse) ? i.pulse : 0
  const dropTerm = i.drop ? 0.07 : 0

  const value = baseline - tension * 0.06 - dropTerm - pulse * 0.02
  return Number.isFinite(value) ? Math.max(BLOOM_THRESHOLD_FLOOR, value) : BLOOM_THRESHOLD_FLOOR
}

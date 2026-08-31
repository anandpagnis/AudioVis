/**
 * The effect slot's shared exit envelope, over `slotProgress` 0..1.
 *
 * Every scene claiming the `effect` role needs the same shape and the same
 * hard guarantee: `SceneManager` retires an effect entry the instant
 * `slotProgress` reaches 1 and does NOT fade it out — a scene still bright
 * there simply vanishes. Originally written inline in `OrbitGlowScene.tsx`
 * for the first scene to claim the role (F20); pulled out here once a
 * second and third effect scene needed the exact same contract, so the
 * "must reach zero at 1" guarantee is proven once rather than re-derived
 * (and possibly gotten wrong) per scene.
 *
 * Punctuation, not a fade: a fast rise so it lands ON the transient that
 * fired it, a brief hold, then a long decay that is genuinely zero at 1. The
 * decay dominates the lifetime because that is what makes a hit read as an
 * impact followed by a room rather than as a shape that came and went.
 * `smoothstep`-like clamping on both ends so neither edge is a hard step —
 * an effect that snaps off at 1 looks like a dropped frame, which is exactly
 * the impression this slot exists to avoid.
 *
 * Expressed entirely in `slotProgress` (0..1), not seconds, so the same
 * envelope shape covers a 4-second ring and a 0.3-second spark without any
 * per-effect tuning — only `durationSec` (in the scene's `effect` metadata)
 * changes how fast real time moves through it.
 */
export function effectEnvelope(slotProgress: number): number {
  const t = Number.isFinite(slotProgress) ? Math.min(1, Math.max(0, slotProgress)) : 0
  const rise = t < 0.05 ? t / 0.05 : 1
  const fall = 1 - (t - 0.18) / 0.82
  return rise * Math.max(0, Math.min(1, fall)) ** 1.6
}

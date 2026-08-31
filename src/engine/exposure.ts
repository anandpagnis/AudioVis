/**
 * Adaptive exposure: a slow closed loop on the FINAL frame's luminance.
 *
 * ## What it is for
 *
 * Additive scenes plus a feedback pass plus bloom drift. Not per-frame — over
 * tens of seconds a composition creeps hot and washes out, or a dark palette
 * under a sparse scene leaves the frame muddy. Neither is a bug in any one
 * scene; both are emergent, so no scene can fix them and no fixed constant can
 * either.
 *
 * It is also the only defence that works on content nobody reviewed. **You
 * cannot art-direct what you did not author.** A marketplace scene that renders
 * three times too hot blows out a venue projector, and the complaint arrives
 * here rather than at its author. A servo on the real output is what makes
 * admitting an unreviewed scene survivable — the same argument as the pixel
 * budget in renderScale.ts, one layer further down the pipe.
 *
 * ## Why it is slow, and why that is the point
 *
 * The time constant is ~2.3 s, far slower than any musical event. Dynamics —
 * a kick, a drop, a build — are faster than the loop and pass through
 * untouched; only sustained drift is corrected. A fast exposure loop would
 * flatten exactly the dynamics the show exists to express, which is the
 * failure mode of every auto-exposure that gets reached for as a brightness
 * fix.
 *
 * ## Three regimes, and the gate that separates dark from broken
 *
 *  - **washout** — too many near-white pixels. Pull down hard; this is the one
 *    that protects a projector.
 *  - **hot** — mean well above target. Ease down.
 *  - **muddy** — mean low AND highlights low AND *the music is loud*. Ease up,
 *    gently.
 *
 * That last conjunct is load-bearing. A dim screen over quiet audio is the
 * product working — it is what "the frame goes dark in the breakdown" means.
 * Without the energy gate the servo reads a deliberate silence as a fault and
 * lifts the whole frame, destroying the dynamic range it was added to protect.
 *
 * ## A guard, not a level-enforcer
 *
 * The dead zone between {@link MUDDY_MEAN} and {@link HOT_MEAN} is very wide,
 * and for ordinary content the servo does nothing whatsoever. That is the
 * design: it exists to catch faults — a wash that would hurt a projector, a
 * genuine collapse into mud — not to hold the picture at a preferred level.
 *
 * Both halves of that were got wrong first time and are worth stating so they
 * are not reintroduced. Aiming at the documented art-direction budget made the
 * servo correct working content permanently, and a dead zone with no restoring
 * force made every correction one-way. A servo needs a fault threshold and a
 * path home; either alone is a dimmer.
 *
 * ## The targets are AudioVis's, not lilim's
 *
 * The mechanism is ported from lilim; the numbers deliberately are not, and
 * neither is lilim's habit of servoing toward a preferred mean.
 *
 * The thresholds here come from measurement of this project's own output: over
 * 89 samples the composited frame runs at mean 0.07-0.46 (median 0.19) with
 * 0-13.8% of pixels blown, and docs/09_Rendering_Engine.md records a real
 * washout at mean 0.65 with 39% blown. The fault thresholds are placed in the
 * gap between those, which is why ordinary content falls in the dead zone.
 *
 * **Still only partly calibrated.** Those measurements were taken under a
 * software renderer, on a couple of scenes, on one track.
 * docs/09_Rendering_Engine.md is explicit that exposure calibration is only
 * valid against a real playing track — an idle frame is not representative,
 * because scene brightness is driven by bass and energy which are zero at idle.
 * See F69.
 */

/** What one downsampled frame tells us. All 0..1. */
export interface LumaSample {
  /** Mean relative luminance across the sampled pixels. */
  mean: number
  /**
   * Median relative luminance — the "typical pixel", robust to the handful of
   * blown highlights that swing {@link mean} on sparse content. Not consumed
   * by {@link exposureError} today (the hot/muddy thresholds below are
   * calibrated against `mean`/`p99`/`blownShare` from 89 real samples, and
   * swapping the statistic a threshold reads without new measured data would
   * repeat this file's own documented mistake of calibrating against numbers
   * nobody re-measured — see HOT_MEAN's history). Carried on the sample and
   * on {@link exposure} for the debug panel, and as the input the NEXT
   * calibration pass — against a real playing track, per F69 — should reach
   * for first: a percentile is the textbook answer to "mean is skewed by a
   * few bright pixels on a mostly-black frame", and this is that percentile,
   * shipped and visible before it is trusted with a threshold.
   */
  p50: number
  /** 85th percentile — the highlight shoulder, not the peak. */
  p85: number
  /** 99th percentile — the subject's own brightness on sparse content. */
  p99: number
  /** Share of pixels above {@link BLOWN_LEVEL}. */
  blownShare: number
}

/**
 * Mean luminance above which the frame is genuinely too hot.
 *
 * ## This is a FAULT threshold, not the art-direction target
 *
 * It was the art-direction target, and that was the bug behind "it applied a
 * permanent darkness effect". The servo aimed at this project's documented
 * budget — mean luma < 20 of 255, i.e. 0.078 — and treated anything above
 * 1.4x of it as hot. But the composited frame **measures 0.09 to 0.19 in normal
 * operation**, which is above that threshold nearly all the time. So the servo
 * spent its life correcting content that was working, and pulled the whole show
 * down by roughly half, permanently.
 *
 * A budget is a goal for scene authors. A servo threshold has to describe a
 * FAULT, and the two are not the same number — an auto-exposure that enforces an
 * aspiration is just a dimmer.
 *
 * ## Calibrated twice, and the first set was measured through a broken pipeline
 *
 * The first numbers here (0.30) came from frames measured while `GradePass` was
 * omitting the linear-to-sRGB output conversion, so every sample was about five
 * times darker than what a viewer actually saw. Correcting that moved normal
 * operation from an apparent 0.09-0.19 to a real **0.07-0.46 across 89 samples,
 * median 0.19** — and 0.30 was suddenly *inside* the normal range rather than
 * above it, which would have repeated the original mistake in a subtler form.
 *
 * The lesson is not "measure": it is that a measurement is only as good as the
 * pipeline it was taken through, and a constant derived from instrumentation has
 * to be re-derived whenever that pipeline changes.
 *
 * 0.55 sits above every normal frame observed (max 0.459) and below a real
 * washout: docs/09_Rendering_Engine.md records the actual failure at "39% of the
 * frame clipped to pure white while the mean sat at 167", which is 0.65. The
 * dead zone between {@link MUDDY_MEAN} and this is wide on purpose — for
 * ordinary content the servo should do **nothing at all**.
 */
export const HOT_MEAN = 0.55

/**
 * Mean luminance below which the frame may be muddy — with the other two
 * conditions (dim highlights, loud music) still required.
 *
 * Far below normal operation for the same reason as {@link HOT_MEAN}: this
 * describes a fault, not a preference. The lowest normal frame measured was
 * 0.07, so this has a factor of three of clearance.
 */
export const MUDDY_MEAN = 0.02

/**
 * Highlight level the subject is expected to reach, measured at the 99th
 * percentile.
 *
 * ## Why p99 and not p85, which is what lilim uses
 *
 * This was p85 at 0.5, reasoning from the documented "<=15% lit" budget: if at
 * most 15% of the frame is lit then the 85th percentile sits exactly on the lit
 * boundary. That reasoning is sound and the constant was still wrong, because
 * this roster is far sparser than 15% — it is thin bright line-art on true
 * black. **Measured on real frames, p85 ranged 0.006 to 0.67 depending only on
 * how sparse the scene happened to be**, so the guard it fed was meaningless:
 * on a wireframe it read 0.01, the servo concluded "no highlights, must be
 * muddy", and lifted to the gain ceiling on a picture that was working exactly
 * as authored.
 *
 * p99 measured 0.80 to 0.94 across the same frames — steady, because it tracks
 * the SUBJECT rather than the ratio of subject to background. That is the
 * question the muddy regime is actually asking: not "how much of the frame is
 * lit" but "is anything reaching full brightness". 0.7 sits below every observed
 * value with margin, so a frame only reads as muddy when the subject itself has
 * genuinely gone dim.
 *
 * Found by running the servo against a real track and reading its own telemetry,
 * which is the calibration docs/09_Rendering_Engine.md says is the only valid
 * kind. `p85` is still sampled and shown in the debug panel, because watching
 * the two diverge is what makes scene sparsity legible.
 */
export const TARGET_HIGHLIGHT = 0.7

/** A pixel at or above this counts as blown. */
export const BLOWN_LEVEL = 0.85

/**
 * Blown share the servo tolerates before pulling down hard.
 *
 * This was 0.02, reasoned from the documented "0% blown" budget and a guess that
 * 2% was a generous allowance for a deliberate hot core. **Measured, the median
 * normal frame is already 0.026 blown and the 90th percentile is 0.089** — so
 * the harshest regime in the servo, the one with the steepest correction, would
 * have fired on more than half of all healthy frames.
 *
 * Like {@link HOT_MEAN}, the budget describes what a scene author should aim
 * for; this has to describe a fault. Normal operation peaks at 0.138 blown and
 * the recorded washout failure was 0.39, so 0.20 sits between them with margin
 * on both sides. That lands close to lilim's 0.30 in the end — its looser figure
 * was closer to right than the budget-derived one, for the same reason its mean
 * target was: both were measured rather than aspired to.
 */
export const BLOWN_TOLERANCE = 0.2

/**
 * Gain limits.
 *
 * Deliberately asymmetric, and wider downward than lilim's 0.6..1.35. This
 * codebase's own diagnosis is that "the scenes render additively and very hot —
 * most of the frame sits at or above 1.0", so the correction that matters is
 * downward and it needs roughly 3x of room. Upward is kept tight because
 * lifting a dark frame amplifies noise and undoes the exposure discipline the
 * scenes were authored to.
 */
export const GAIN_MIN = 0.35
export const GAIN_MAX = 1.25

/**
 * Seconds between samples — WALL CLOCK, not frames.
 *
 * 180 ms is what 11 frames came to at 60fps, which is lilim's batching, so the
 * tuning below is unchanged on a healthy machine. The unit is what changed, and
 * it matters: a frame-counted interval makes the loop's time constant scale
 * with frame rate, so the documented ~2.3 s became ~23 s on a machine running
 * at 6fps. Benign in direction — a struggling machine got a more sluggish servo,
 * not a twitchier one — but it meant the constant did not describe the system.
 *
 * Batching is not only about readback cost: it sets the loop's speed together
 * with {@link STEP}, and those two ARE the time constant. Changing either
 * without the other retunes the servo.
 */
export const SAMPLE_INTERVAL_SEC = 0.18

/**
 * Log-space step per sample for a DARKENING correction (hot or blown — `err <
 * 0`). With the interval above this gives tau ~2.3 s at any frame rate, which
 * is the "slower than any musical event" property the header depends on.
 *
 * This is the direction the servo's own calibration history is about — every
 * threshold in this file (`HOT_MEAN`, `BLOWN_TOLERANCE`) was measured and
 * re-measured against real output specifically to get darkening right, so
 * this constant is unchanged from the single `STEP` this file used before the
 * up/down split below: the validated dynamics stay validated.
 */
export const STEP_DOWN = 0.08

/**
 * Log-space step per sample for a BRIGHTENING correction (muddy — `err > 0`).
 *
 * ## Why brightening is slower than darkening
 *
 * Real adaptive-exposure systems are not symmetric, and the asymmetry runs
 * the same direction here as it does in a camera or an eye: going from bright
 * to dim adapts quickly (a pupil constricting is a protective reflex, and a
 * genuinely blown or washed-out frame is this servo's own "protect the
 * projector" case — see `BLOWN_TOLERANCE`'s doc), while adapting from dim to
 * bright is unhurried, because there is no fault to protect against, only a
 * preference to restore. This file's OWN stated bias points the same way
 * without yet having acted on it: "the correction that matters is downward",
 * from {@link GAIN_MIN}/{@link GAIN_MAX}'s doc — this constant is where that
 * stated priority actually reaches the loop's timing, not just its range.
 *
 * Half of {@link STEP_DOWN}, so a muddy correction takes roughly twice as
 * long to reach the same log-space distance as a hot one. Deliberately not
 * more aggressive than that: the muddy branch already takes the SMALLER of
 * two corrections (mean-target and highlight-target — see
 * {@link exposureError}) specifically to avoid overshooting a sparse frame,
 * and slowing it further than 2x would make it too sluggish to ever clear a
 * genuine mid-set mud before the section that caused it has already passed.
 */
export const STEP_UP = STEP_DOWN / 2

/**
 * Log-space step per sample used to return toward unity when nothing is
 * wrong.
 *
 * ## Without this the servo is a ratchet, not a loop
 *
 * The second half of the "permanent darkness" bug. Inside the dead zone the
 * error is zero, and zero error meant the gain simply STAYED wherever it had
 * been left. So every hot passage dragged it down and nothing ever brought it
 * back: a single bright moment permanently darkened the rest of the session,
 * and the effect accumulated across a set.
 *
 * A correction with no restoring force is not a servo. Unity is the resting
 * position and the loop has to be pulled back to it whenever the frame is fine.
 *
 * A quarter of {@link STEP_DOWN}, so recovery is decisively slower than a
 * darkening correction: a sustained genuine fault still wins and holds the
 * gain down, while a brief one is forgiven over the following few seconds
 * instead of forever.
 *
 * Deliberately NOT split into an up/down pair the way {@link STEP_DOWN} and
 * {@link STEP_UP} are — {@link recoverExposure} is symmetric around unity
 * whichever side the gain is drifting back from, unchanged by the up/down
 * split above. Recovery is a return to a neutral resting position, not a
 * fault correction, and giving it the same directional bias as the
 * correction path is untested behaviour this file's calibration history
 * (see {@link HOT_MEAN}) argues strongly against introducing without
 * measuring it first.
 */
export const RECOVERY_STEP = STEP_DOWN / 4

/**
 * Below this the frame is intentionally dark and the servo must not touch it.
 *
 * Separate from the energy gate: this catches a frame that is dark because
 * nothing is drawn (a scene mid-warm, a silent intro), where boosting would
 * amplify nothing but noise.
 */
export const DARK_FLOOR_MEAN = 0.015
/** Measured on p99, for the same reason as {@link TARGET_HIGHLIGHT}: a frame
 *  with nothing drawn has no bright pixels anywhere, and p99 says so
 *  regardless of how much of the frame the subject would have covered. */
export const DARK_FLOOR_HIGHLIGHT = 0.05

/** Loudness below which the muddy regime refuses to lift. See the header. */
export const MUDDY_ENERGY_GATE = 0.4

/**
 * Reduce raw RGBA bytes to the three statistics the servo runs on.
 *
 * Takes bytes rather than a canvas so it is testable without a DOM, and so the
 * readback strategy (see ExposureSampler) can change without touching the maths.
 *
 * `into` lets the per-sample caller reuse one object instead of allocating.
 */
export function analyseLuma(pixels: Uint8ClampedArray, into?: LumaSample): LumaSample {
  const out = into ?? { mean: 0, p50: 0, p85: 0, p99: 0, blownShare: 0 }
  const n = (pixels.length / 4) | 0
  if (n <= 0) {
    out.mean = 0
    out.p50 = 0
    out.p85 = 0
    out.p99 = 0
    out.blownShare = 0
    return out
  }
  // Reused across calls: this runs several times a second for the life of the
  // session, and a fresh array each time is pure garbage.
  if (lumaScratch.length !== n) lumaScratch = new Float32Array(n)
  let total = 0
  let blown = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    // Rec. 709 relative luminance, matching the coefficients used for the
    // palette darkness checks so "luminance" means one thing in this codebase.
    const l = (pixels[o] * 0.2126 + pixels[o + 1] * 0.7152 + pixels[o + 2] * 0.0722) / 255
    lumaScratch[i] = l
    total += l
    if (l > BLOWN_LEVEL) blown++
  }
  lumaScratch.sort()
  out.mean = total / n
  out.blownShare = blown / n
  out.p50 = lumaScratch[Math.min(n - 1, Math.floor(n * 0.5))]
  out.p85 = lumaScratch[Math.min(n - 1, Math.floor(n * 0.85))]
  out.p99 = lumaScratch[Math.min(n - 1, Math.floor(n * 0.99))]
  return out
}

let lumaScratch = new Float32Array(0)

/**
 * Signed error in log space: negative wants less gain, positive wants more.
 *
 * Zero means "leave it alone", and the wide dead zone between the hot and muddy
 * thresholds is deliberate — a servo with no dead zone hunts, and hunting
 * exposure is far more visible than being slightly off target. Sparse-but-punchy
 * content (low mean, healthy highlights) falls in that gap and is left alone,
 * which is exactly what most of this roster looks like — see
 * {@link TARGET_HIGHLIGHT} for the measurement that made that case work.
 */
export function exposureError(sample: LumaSample, energy: number): number {
  const { mean, p99, blownShare } = sample
  if (!isFinite(mean) || !isFinite(p99)) return 0
  // Intentional darkness: never boost noise.
  if (mean < DARK_FLOOR_MEAN && p99 < DARK_FLOOR_HIGHLIGHT) return 0

  let err = 0
  if (blownShare > BLOWN_TOLERANCE) {
    // Proportional to how far past tolerance, and steep: this is the projector
    // guard, and it is the one regime that should react decisively.
    err = -(blownShare - BLOWN_TOLERANCE) * 2.2
  } else if (mean > HOT_MEAN) {
    err = Math.log(HOT_MEAN / mean)
  } else if (mean < MUDDY_MEAN && p99 < TARGET_HIGHLIGHT && energy > MUDDY_ENERGY_GATE) {
    // Take the SMALLER of the two corrections. Lifting until the mean is happy
    // could blow the highlights; lifting until the highlights are happy could
    // barely move a genuinely dark frame. The min respects whichever limit is
    // nearer.
    err = Math.min(
      Math.log(MUDDY_MEAN / Math.max(mean, 1e-4)),
      Math.log(TARGET_HIGHLIGHT / Math.max(p99, 1e-3)),
    )
  }
  return Math.max(-1, Math.min(1, err))
}

/** Apply one step of correction to the current gain, clamped to the limits. */
export function stepExposure(gain: number, err: number): number {
  if (!isFinite(gain)) return 1
  if (!isFinite(err) || err === 0) return gain
  // Sign of err IS the direction: negative wants less gain (darkening,
  // STEP_DOWN), positive wants more (brightening, STEP_UP). See both
  // constants' docs for why they are not the same number.
  const step = err < 0 ? STEP_DOWN : STEP_UP
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, gain * Math.exp(err * step)))
}

/**
 * Live exposure state. A mutable singleton in the same shape as
 * `performanceState` and `frameLoad`: one writer, many readers.
 *
 * `gain` is what the grade pass multiplies the frame by. The three statistics
 * are kept for the debug readout — an exposure servo you cannot see the inputs
 * of is impossible to calibrate, and calibration is explicitly still outstanding.
 */
export const exposure = {
  gain: 1,
  mean: 0,
  p50: 0,
  p85: 0,
  p99: 0,
  blownShare: 0,
  /** False until the first sample lands, so the readout can say so. */
  sampled: false,
}

/**
 * Feed one analysed frame into the loop.
 *
 * A zero error is not "do nothing" — it is "nothing is wrong", which is exactly
 * when the gain should be drifting back to unity. See {@link RECOVERY_STEP}.
 */
export function applyExposureSample(sample: LumaSample, energy: number): void {
  exposure.mean = sample.mean
  exposure.p50 = sample.p50
  exposure.p85 = sample.p85
  exposure.p99 = sample.p99
  exposure.blownShare = sample.blownShare
  exposure.sampled = true

  const err = exposureError(sample, energy)
  if (err !== 0) {
    exposure.gain = stepExposure(exposure.gain, err)
    return
  }
  // Dead zone: ease home. Snapping to 1 here would undo a correction the moment
  // the fault left the sampled window, which for a flickering source would read
  // as the exposure itself flickering.
  exposure.gain = recoverExposure(exposure.gain)
}

/**
 * One step of the return toward unity. Exported for the tests, which is the
 * only way to pin a behaviour whose whole point is that it takes many seconds.
 */
export function recoverExposure(gain: number): number {
  if (!isFinite(gain)) return 1
  const drift = Math.log(1 / gain)
  const step = Math.max(-RECOVERY_STEP, Math.min(RECOVERY_STEP, drift))
  const next = Math.max(GAIN_MIN, Math.min(GAIN_MAX, gain * Math.exp(step)))
  // Settle EXACTLY on unity rather than approaching it asymptotically. An
  // exponential return never actually arrives, so without this the gain would
  // sit at 0.9999999 forever — visually identical, but it means "is the servo
  // resting?" has no clean answer for a readout or a test to give.
  return Math.abs(next - 1) < 1e-6 ? 1 : next
}

/** Reset to unity — for a context loss, or a test. */
export function resetExposure(): void {
  exposure.gain = 1
  exposure.mean = 0
  exposure.p50 = 0
  exposure.p85 = 0
  exposure.p99 = 0
  exposure.blownShare = 0
  exposure.sampled = false
}

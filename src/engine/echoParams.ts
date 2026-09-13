/**
 * Pure policy for the echo pass: `EchoPass` takes two things from the
 * outside — how strong the current echo is, and how far apart to space its
 * taps — and this module is where both are resolved, testable with no WebGL
 * context, matching `feedbackParams.ts`'s split between engine logic and the
 * WebGL-touching executor that applies it.
 *
 * ## A different instrument from `feedbackParams.ts`, on purpose
 *
 * `FeedbackPass` is a single history buffer, continuously re-warped and
 * re-blended — it never has a "moment," only "now, faded." This pass governs
 * the opposite shape: {@link ECHO_TAP_COUNT} FIXED snapshots taken at
 * specific instants in the recent past, each held rigid and composited as
 * its own ghost at falling opacity, the way Resolume's stock RGB-delay/echo
 * effects or a strobe-multiplied photograph read. The instrument is
 * repetition-with-a-beat, not persistence-with-decay.
 *
 * ## Beat-locked spacing, and a beat-pulse strength (F232 rewrite)
 *
 * v1 of this pass (F231) drove BOTH the tap spacing and the echo's strength
 * off a single mood-scaled dial: spacing ramped with the dial's own value on
 * a wall clock, and strength eased continuously through most of a
 * groove/building/peak/aggressive passage. Shipped, tried live, and reported
 * back as simply not good — see the F232 entry in `docs/ISSUES.md` for the
 * full diagnosis. The two problems, and their fixes:
 *
 *  - Nothing about the wall-clock spacing was actually locked to the music,
 *    so the ghosts drifted in and out of phase with the beat instead of
 *    landing on it. Fixed by {@link resolveEchoTapSpacingSec}: spacing is
 *    now a real subdivision of the current tempo (an eighth-note by
 *    default), so the taps land ON the rhythm rather than at an arbitrary
 *    interval that happens to be roughly beat-length.
 *  - A continuously-present echo is not an echo, it is a wash — see
 *    `opticalDirector.ts#echoTarget`'s own header for the fuller argument.
 *    That function now derives its output directly from `beatPulse()`, so
 *    the STRENGTH this module receives already arrives as a sharp per-beat
 *    spike; this module no longer needs (and no longer has) any role in
 *    shaping that envelope, only in translating the current beat-pulse
 *    strength into `decay`.
 */

/** Shader knobs {@link EchoPass} drives from the strength dial, per frame. */
export interface EchoKnobs {
  /** Opacity falloff applied per tap: tap i contributes at decay^i. */
  decay: number
}

/**
 * How many discrete taps the echo holds. F234 (explicit request, "more ghost
 * images... last a bit longer"): raised from 3. `EchoPass` has no dynamic
 * sampler-array indexing (this codebase never uses one — GLSL ES 1.00's
 * support for it is unreliable enough across drivers that every other
 * per-slot uniform set in this engine, e.g. `LensPass`'s `RIP_SLOTS` plume
 * ring, sticks to fixed-size arrays of plain values instead), so this is a
 * compile-time constant, not a runtime dial — changing it means editing
 * `EchoPass.ts`'s explicitly-unrolled `tTap0..tTapN`/`w0..wN` uniforms and
 * `render()`'s per-tap assignments to match, the same manual-unroll shape
 * `RIP_SLOTS` already lives with.
 *
 * Five, not a smaller bump, because the total span the echo covers is
 * `ECHO_TAP_COUNT * tapSpacingSec` — more taps is *also* how this request's
 * "last a bit longer" half is met, independent of `DECAY`. See `DECAY`'s own
 * doc for why it was raised alongside this rather than left at 3 taps' value.
 */
export const ECHO_TAP_COUNT = 5

/** `echo` at or below this reads as fully off — no taps recorded, no blend
 *  draw doing anything. Same value and reasoning as `feedbackParams.ts`'s
 *  `OFF_THRESHOLD`: a director easing this dial up from rest should see
 *  nothing happen until it clears a small dead zone, not a value that is
 *  technically nonzero the instant it leaves 0. Also, now that `echo` is a
 *  per-beat pulse rather than a slow mood target, this is what keeps the
 *  quiet tail of EVERY beat's decay from being treated as "still echoing." */
const OFF_THRESHOLD = 0.02

/**
 * Per-tap opacity falloff. Fixed rather than scaled with `echo` — a named
 * field anyway, matching `FeedbackKnobs.swirl`/`wobble`, which are also
 * simple constants rather than each earning an independent external dial, so
 * a future decision to vary decay by mood or section has somewhere to write
 * without reshaping this interface.
 *
 * Raised from 0.6 to 0.72 alongside {@link ECHO_TAP_COUNT}'s bump to 5
 * (F234, explicit request). Left at 0.6, five taps deep would have put the
 * oldest at 0.6^5 ≈ 0.078 of the newest — invisible, all cost and no ghost,
 * exactly the "declared but inert" shape this codebase's own
 * `performanceState.ts` rule warns against, just inside a shader instead of
 * a field. At 0.72, the oldest (5th) tap survives at 0.72^5 ≈ 0.19: still
 * clearly the dimmest of the five, but a real, separately-visible ghost
 * rather than a rounding error. The middle taps land at 0.72/0.52/0.37/0.27
 * — a shallower, more even staircase than 0.6's 0.6/0.36/0.22 was, which is
 * also most of what actually delivers "lasts a bit longer": the train reads
 * as legible for its FULL span now instead of visually vanishing by the
 * third tap regardless of how many more are technically still being drawn.
 */
const DECAY = 0.72

/**
 * Bpm outside a sane range (silence before a source starts, a stalled
 * estimator, a corrupt value) falls back to this rather than producing a
 * nonsensical or divide-by-zero spacing. Same fallback value and reasoning
 * `DjCamDirector.ts`'s `bpmEff` already uses for an identical guard.
 */
const BPM_FALLBACK = 120

/** Beat subdivision the taps lock to: 2 is an eighth-note spacing relative to
 *  a quarter-note beat — tight enough to read as a slapback, loose enough
 *  that three of them are still individually legible rather than smearing
 *  into one softened copy (see `resolveEchoTapSpacingSec`'s own clamp for the
 *  backstop against a tempo extreme enough to make even this too tight or
 *  too loose). */
const DEFAULT_SUBDIVISION = 2

/** Hard floor/ceiling on the resolved spacing, independent of tempo — a
 *  240 bpm eighth-note (~62ms) and a 60 bpm eighth-note (~250ms) are both
 *  already inside this range, so in practice these are a backstop against a
 *  garbage bpm reaching {@link BPM_FALLBACK}'s guard and a future caller
 *  passing an unusually coarse subdivision, not a range real tempos hit. */
const MIN_TAP_SPACING_SEC = 0.05
const MAX_TAP_SPACING_SEC = 0.5

/**
 * Is the echo pass doing anything at this `echo` value? Shared shape with
 * `isFeedbackActive`: whatever sets `EchoPass.enabled` and whatever reserves
 * frame budget for it must agree, or the two silently disagree the way
 * `isFeedbackActive`'s own doc comment describes happening once already
 * (F85) for the feedback pass.
 */
export function isEchoActive(echo: number): boolean {
  const t = Number.isFinite(echo) ? echo : 0
  return t > OFF_THRESHOLD
}

/**
 * Resolve the shader knobs for the echo pass. Takes no argument — unlike
 * `resolveFeedbackKnobs`, every field here is currently a fixed constant (see
 * `decay`'s own doc on why it is named rather than inlined), so there is
 * nothing yet for an input to modulate. Still a function, not a bare
 * constant import, so `EchoPass` has one call for its whole knob set and a
 * future decision to vary `decay` by mood or section changes this file only.
 */
export function resolveEchoKnobs(): EchoKnobs {
  return { decay: DECAY }
}

/**
 * Seconds between each discrete tap, locked to the current tempo instead of
 * scaling with the echo strength (see this module's header for why v1's
 * wall-clock ramp was the wrong instrument). `subdivision` is beats per tap
 * interval, inverted — 2 means "half a beat," i.e. an eighth-note against a
 * quarter-note `bpm`. Clamped at both ends so neither a stalled/zero bpm
 * estimate nor a future caller's unusual subdivision can produce a spacing
 * so tight it is indistinguishable from a single blurred frame, or so wide
 * the taps stop reading as one repeating figure.
 */
export function resolveEchoTapSpacingSec(bpm: number, subdivision = DEFAULT_SUBDIVISION): number {
  const bpmEff = bpm > 0 && Number.isFinite(bpm) ? bpm : BPM_FALLBACK
  const sub = subdivision > 0 && Number.isFinite(subdivision) ? subdivision : DEFAULT_SUBDIVISION
  const sec = 60 / bpmEff / sub
  return Math.min(MAX_TAP_SPACING_SEC, Math.max(MIN_TAP_SPACING_SEC, sec))
}

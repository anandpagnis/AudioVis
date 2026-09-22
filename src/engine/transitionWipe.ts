import { clamp01, smoothstep, usesRack, type TransitionStyle } from './transitions'

/**
 * The wipe-tier transition vocabulary: `inkDissolve`, `irisWipe`, `datamosh`.
 *
 * ## Why this is a separate module from `transitions.ts`
 *
 * `smear`/`melt`/`collapse`/`mosaic`/`sortSlice` (the "ramp" category) are a
 * plain crossfade plus an existing post-FX rack turned up — cheap, no new
 * render targets, always available. The three styles here are a genuinely
 * different mechanism: each primary is captured to its OWN offscreen texture
 * (`TransitionCapture`) and composited by mask (`WipeCompositorPass`) instead
 * of just being alpha-blended in place. That extra render pass is real cost,
 * so it is gated (quality tier, frame budget) at a different point in the
 * pipeline than the ramp styles are, and the two categories are kept in
 * separate modules so the cheap path never has to import anything related to
 * the expensive one.
 *
 * ## Pure and WebGL-free, on purpose
 *
 * Every function below is plain math: no `THREE`, no GL context, nothing
 * time- or frame-dependent that isn't passed in as an explicit argument. That
 * is what makes it unit-testable without a browser, and it also encodes the
 * plan's "no per-frame reseed" safety rule structurally rather than by
 * convention — {@link datamoshBlockOffset} has no clock parameter to reseed
 * FROM, so a caller physically cannot wire one in by accident.
 *
 * `WipeCompositorPass.ts`'s GLSL mirrors this file's formulas exactly (same
 * shape, same constants where a shader equivalent exists) so the two are kept
 * honest against each other — each side's doc comments point at the other.
 * "Mirrors" means the same ALGORITHM, not bit-identical output: a `sin`-based
 * hash evaluated in 64-bit JS and in a GPU's 32-bit shader ALU will not agree
 * to the last bit, the same way `hash01` in `response.ts` and `hash1` in
 * `MirrorPass.ts`'s GLSL already don't. That's expected and harmless here —
 * nothing downstream compares a JS value against a GPU value, each side only
 * has to be internally deterministic, which both are.
 *
 * ## Verified one-way import (no cycle)
 *
 * `transitions.ts` imports only from `./look/lookRow`, so `transitionWipe.ts
 * -> transitions.ts` cannot cycle back — confirmed by reading transitions.ts's
 * own import list before adding this dependency.
 */

/**
 * `THREE.Layers` bits reserved for wipe-style capture. Grepped the whole
 * `src` tree for `.layers.set(`, `.layers.enable(`, `THREE.Layers` and
 * `camera.layers` before picking these — there are zero matches anywhere in
 * the codebase today, so nothing currently touches ANY layer bit (every
 * object and the main camera sit at Three's default mask, layer 0 only).
 * 30/31 are picked far from 0 deliberately, matching the plan's own reasoning
 * ("picked deliberately far from anything a scene author would casually
 * use").
 */
export const WIPE_LAYER_OUT = 30
export const WIPE_LAYER_IN = 31

/**
 * Richest-tier ceiling for offering a wipe style, from `quality.ts`'s own
 * tier ladder (`TIERS`, richest = 0, survival = 4 — confirmed by reading the
 * file: `tier` starts at 1, `FIXED_TIER.high = 0`, and the doc comment on
 * `TIERS` states "richest (0) -> survival (4)" explicitly).
 *
 * A wipe transition is TWO extra full-scene renders on top of the crossfade
 * that is already paying for both primaries at once (`fundsOverlap` already
 * has to be true before a wipe style is even considered — see
 * `SceneManager.tsx`'s commit block). That is real cost stacked on top of
 * real cost, so it is restricted to the four richest rungs (0-3) rather than
 * "any tier that can afford the plain overlap" — tier 4 ("survival") exists
 * specifically because the machine cannot comfortably carry full-cost scene
 * work at all, and a wipe asks for MORE of exactly that, not less.
 *
 * History: originally 1 (the two richest rungs), then 2 (2026-09-23) after
 * `?lookdebug` showed `auto` quality settling above 1 on ordinary hardware —
 * `quality`'s `auto` mode starts every session at tier 1 and only climbs on
 * MEASURED overbudget frames, so a session that settles at 2 is common, not
 * a rare edge case. Raised again to 3 the same day, at the user's explicit
 * request, after their own machine (described as "quite strong") measured
 * tier 3-4 in THIS session specifically — alongside repeated background-
 * process low-memory kills all session and the fact this was measured under
 * `vite`'s unminified dev server, not a production build, so the reading
 * may reflect session/dev-mode load rather than the hardware's real ceiling.
 * Accepted as an explicit tradeoff (a real chance of a dropped frame or two
 * during a transition on a session already this constrained), not a claim
 * that tier 3 is actually free. `TransitionCapture`'s `WIPE_CAPTURE_SCALE`
 * was lowered again in the same change to keep the marginal cost down as
 * this reaches further into the ladder. Tier 4 remains excluded: the base
 * show is already visibly reduced there and cannot spare the two extra
 * captures at any resolution.
 */
export const WIPE_MAX_TIER = 3

/** The three wipe-tier style names, as a standalone type — used where a
 *  signature wants to say "one of the wipe styles specifically" rather than
 *  the full 9-member `TransitionStyle` union (e.g. `WipeCompositorPass.setWipe`,
 *  which is meaningless for any other style). */
export type WipeStyle = 'inkDissolve' | 'irisWipe' | 'datamosh'

/**
 * Does this style need the two-texture capture/composite path at all? A type
 * guard (not just a `boolean`) so a caller that has already checked this —
 * `PostFXChain.tsx`'s `useFrame`, most notably — gets `tx.style` narrowed
 * from the full 9-member `TransitionStyle` union down to {@link WipeStyle}
 * for free, rather than needing a second cast to call
 * `WipeCompositorPass.setWipe`.
 */
export function usesWipe(style: TransitionStyle): style is WipeStyle {
  return style === 'inkDissolve' || style === 'irisWipe' || style === 'datamosh'
}

/**
 * Which of the three transition families a style belongs to. `usesWipe`
 * takes precedence (checked first) so a style can never be double-counted —
 * today no style is both, and this ordering keeps it that way even if the
 * rack ever grows.
 */
export function transitionCategory(style: TransitionStyle): 'ramp' | 'wipe' | 'mix' {
  if (usesWipe(style)) return 'wipe'
  if (usesRack(style)) return 'ramp'
  return 'mix'
}

/**
 * Should the capture step run this frame? `tx` is the shape of
 * `performanceState.transition` (only the two fields this needs). Reused
 * directly — not reimplemented — by `PostFXChain.tsx`'s `useFrame` (gates
 * `TransitionCapture.ensureTargets`/`.render` and `WipeCompositorPass.enabled`)
 * and by `TransitionCapture.test.ts`/`transitionWipe.test.ts`'s cost-gating
 * pins. See `PostFXChain.tsx` for the call site.
 */
export function shouldCapture(tx: { active: boolean; style: TransitionStyle }): boolean {
  return tx.active && usesWipe(tx.style)
}

/**
 * Maps a wipe style name to the integer `uStyle` uniform `WipeCompositorPass`'s
 * shader switches on. Exported so the pass and its tests share one source of
 * truth for the mapping instead of two copies that could drift.
 */
export const WIPE_STYLE_INDEX: Record<WipeStyle, number> = {
  inkDissolve: 0,
  irisWipe: 1,
  datamosh: 2,
}

/** `LookRow.transitionSharpness`'s documented range — see lookRow.ts. Clamped
 *  to here before computing a feather so an out-of-range or invalid value
 *  cannot push the edge outside the sane feather range below. */
const SHARPNESS_MIN = 1
const SHARPNESS_MAX = 8
/** Neutral fallback for a non-finite sharpness — matches `createNeutralRow()`'s
 *  own `transitionSharpness: 3` and `transitions.ts`'s "invalid folds to the
 *  neutral value" convention (see `applyTransitionDurationBias`). */
const SHARPNESS_NEUTRAL = 3

/**
 * Widest feather (softest edge), at the CALMEST sharpness (`k=1`).
 * Narrowest feather (crispest edge), at the HARSHEST sharpness (`k=8`).
 *
 * ## Chosen range: 0.02..0.22 of the 0..1 mask-value domain
 *
 * `inkMaskValue`/`irisMaskValue`'s threshold field (`noise01`/
 * `radiusFromCenter01`) and `progress` both live in 0..1, so a feather of
 * `f` blurs the reveal edge across a band of that width centred on the
 * threshold. 0.02 is the narrowest edge this system uses anywhere — a band
 * about 2% of the full transition's progress, crisp enough to read as a hard
 * spatial edge without literally being a one-pixel step (which would alias
 * badly at the render resolution `TransitionCapture` captures at). 0.22 is
 * wide enough that the reveal is visibly soft and organic across most of the
 * fade's length without ever fully dissolving into a flat crossfade (which
 * would happen somewhere past ~0.5, where the feathered band would span the
 * whole 0..1 domain and the threshold shape would stop mattering at all).
 * Both bounds are a design choice, not a derived constant — tune by eye with
 * `?lookforce=<mood>` once this ships live, per the plan's own verification
 * step.
 */
export const WIPE_FEATHER_MIN = 0.02
export const WIPE_FEATHER_MAX = 0.22

/**
 * Edge feather for the ink/iris wipe styles' threshold reveal, from the
 * committed transition's `sharpness` (`LookRow.transitionSharpness`,
 * `performanceState.transition.sharpness`). Lower sharpness (calmer moods)
 * gets a WIDER feather — a softer, more organic edge — and higher sharpness
 * (harsher moods) gets a NARROWER one, matching the same "sharpness reads as
 * harshness" convention `symmetricCurve`'s `k` already establishes for the
 * ramp styles' own mix curve.
 *
 * `sharpness` is clamped to {@link SHARPNESS_MIN}..{@link SHARPNESS_MAX}
 * first; non-finite folds to {@link SHARPNESS_NEUTRAL} (the neutral row's own
 * default), same "safe default" convention `applyTransitionDurationBias` uses
 * for a bad `bias` value.
 */
export function featherFor(sharpness: number): number {
  const s = Number.isFinite(sharpness)
    ? Math.min(SHARPNESS_MAX, Math.max(SHARPNESS_MIN, sharpness))
    : SHARPNESS_NEUTRAL
  const t = (s - SHARPNESS_MIN) / (SHARPNESS_MAX - SHARPNESS_MIN) // 0 at k=1, 1 at k=8
  return WIPE_FEATHER_MAX + (WIPE_FEATHER_MIN - WIPE_FEATHER_MAX) * t
}

/**
 * GLSL-style two-edge smoothstep: 0 below `edge0`, 1 above `edge1`, eased
 * between. `edge1 <= edge0` (a degenerate, near-zero feather beyond float
 * precision) falls back to a hard step at `edge0` rather than dividing by
 * zero — matches `symmetricCurve`'s own "never produce NaN" discipline in
 * `transitions.ts`.
 */
function thresholdReveal(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * `inkDissolve`'s per-pixel reveal weight (the incoming scene's mask value;
 * the outgoing scene's is `1 - this` — see `WipeCompositorPass`'s header for
 * why that construction keeps `maskOut + maskIn === 1` everywhere, same
 * energy-invariant spirit as `transitions.ts`'s `mixEnergy`).
 *
 * `noise01` is a STATIC per-pixel value (a noise field sampled once per
 * pixel, not animated over time — see `datamoshBlockOffset`'s header on why
 * nothing wipe-related re-seeds per frame). As `progress` sweeps 0..1, a
 * pixel reveals exactly when `progress` crosses that pixel's own noise value,
 * feathered by `feather` (see {@link featherFor}) so the crossing is a soft
 * band rather than a hard, aliased edge.
 *
 * Monotonic non-decreasing in `progress` for any fixed `noise01`/`feather`.
 * Endpoints are exact — `inkMaskValue(n, 0, f) === 0` and
 * `inkMaskValue(n, 1, f) === 1` — whenever `[n - f, n + f]` stays inside
 * `[0, 1]`; for `noise01` within `feather` of 0 or 1 the feathered edge
 * itself extends past the domain, so the endpoint value is not exactly 0/1
 * (the same, expected softening a real feathered threshold has at the very
 * extremes of its noise field). `featherFor`'s widest value (0.22) means
 * this only affects `noise01` within the outer ~22% of the range at each
 * end.
 */
export function inkMaskValue(noise01: number, progress: number, feather: number): number {
  const n = clamp01(noise01)
  const f = Math.max(1e-6, feather)
  return thresholdReveal(n - f, n + f, clamp01(progress))
}

/**
 * `irisWipe`'s per-pixel reveal weight. Same feathered-threshold shape as
 * {@link inkMaskValue} — literally the same underlying function — with the
 * roles read as: `radiusFromCenter01` is this pixel's distance from frame
 * centre, ALREADY normalised so the growing circle exactly reaches every
 * pixel (`radiusFromCenter01 === 1`, the frame corner-ish extreme depending
 * on how the caller normalises) exactly when `progress === 1`. A pixel near
 * the centre (`radiusFromCenter01` near 0) reveals almost immediately; a
 * pixel at the normalised edge reveals last. Same endpoint/monotonicity
 * characterisation as {@link inkMaskValue}, with `radiusFromCenter01` in the
 * role `noise01` played there.
 */
export function irisMaskValue(radiusFromCenter01: number, progress: number, feather: number): number {
  return inkMaskValue(radiusFromCenter01, progress, feather)
}

/** Deterministic 0..1 hash of two numbers. Same `sin`/`fract` idiom as
 *  `response.ts`'s `hash01` (one input) and `MirrorPass.ts`'s GLSL `hash1`/
 *  `LensPass.ts`'s GLSL `hash2` (this is the 2-argument shape of the same
 *  house pattern: `fract(sin(dot(...)) * 43758.5453)`), reused here rather
 *  than imported across module boundaries that don't otherwise relate. */
function hash01(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Max UV-space displacement magnitude a settling `datamosh` block ever
 * reaches (at `progress = 0`, before any settling has happened). 0.05 — a
 * twentieth of the frame — reads as a clearly-offset block without ever
 * sampling so far outside the block's own neighbourhood that the source
 * pixel data stops being locally related (which would look like noise
 * rather than a displaced block).
 */
export const DATAMOSH_MAX_DISPLACEMENT = 0.05

/**
 * `datamosh`'s per-block offset and reveal state.
 *
 * A deterministic hash of `(seed, blockIndex)` gives each block a PERSISTENT
 * random 2D direction (`dx`/`dy`, unit-ish, scaled by `DATAMOSH_MAX_DISPLACEMENT`)
 * and an independent reveal threshold. `dx`/`dy` scale by `(1 - progress)`,
 * so every block visibly settles into alignment as `progress -> 1`; `reveal`
 * is a HARD threshold (`hashReveal < progress`) — each block is either fully
 * showing the incoming scene or fully showing the outgoing one, never a
 * blend, which is what gives datamosh its blocky, non-uniform reveal instead
 * of a soft crossfade with an offset on top.
 *
 * `reveal` is complementary by construction with its own negation: exactly
 * one of "block shows incoming" / "block shows outgoing" is true for every
 * block at every progress, so `WipeCompositorPass`'s masks stay
 * `maskOut + maskIn === 1` everywhere even though the mechanism (a hard
 * per-block flip) is nothing like `inkMaskValue`'s soft threshold — see that
 * pass's header for why this still satisfies the system's energy invariant.
 *
 * ## No time/frame parameter — structural, not conventional
 *
 * This function's signature has no clock, no frame count, nothing that isn't
 * `progress` itself. That is deliberate and is the whole enforcement
 * mechanism for the plan's "no per-frame reseed" safety rule: there is
 * nothing here a caller COULD wire a per-frame value into even by accident,
 * because the function has no parameter that would accept one. Same
 * `(seed, blockIndex, progress)` always produces the same `{dx, dy, reveal}`,
 * forever, in any order, called any number of times.
 *
 * `WipeCompositorPass.ts`'s GLSL block-offset math ports this formula
 * (labelled with a comment pointing back here); keep the two in the same
 * shape if either changes.
 */
export function datamoshBlockOffset(
  seed: number,
  blockIndex: number,
  progress: number,
): { dx: number; dy: number; reveal: boolean } {
  const t = clamp01(progress)
  const settle = 1 - t
  const hx = hash01(seed * 12.9898 + blockIndex * 78.233, 3.71)
  const hy = hash01(seed * 4.898 + blockIndex * 37.719, 91.3)
  const hr = hash01(seed * 7.31 + blockIndex * 269.5, 43.7)
  return {
    dx: (hx * 2 - 1) * DATAMOSH_MAX_DISPLACEMENT * settle,
    dy: (hy * 2 - 1) * DATAMOSH_MAX_DISPLACEMENT * settle,
    reveal: hr < t,
  }
}

/**
 * Max magnitude of `datamosh`'s boundary-local chromatic offset, in
 * PROGRESS-space (the same 0..1 domain `datamoshBlockOffset`'s own `reveal`
 * threshold compares against) — see {@link datamoshChannelOffset}.
 *
 * 0.02 is chosen so the offset can only flip a block's `reveal` decision for
 * blocks whose own hidden threshold sits within a 0.04-wide band around the
 * CURRENT global `progress` (the R and B channels effectively test
 * `hashReveal < progress ± 0.02` while G tests the real `progress`) — out of
 * the full 0..1 threshold range, that is at most ~4% of all blocks on any
 * given frame, and even those get one extra frame's worth of threshold
 * difference between channels, not a persisted or growing one. That is what
 * makes this BOUNDARY-LOCAL rather than frame-wide by construction: a block
 * whose threshold is not near `progress` gets `hashReveal < progress - 0.02`
 * and `hashReveal < progress + 0.02` agreeing with the true decision on every
 * channel, so the three channels sample identically and no colour splits at
 * all. The plan's own risk section names this exact mechanism as the one
 * most likely to drift toward flicker if the magnitude crept up — 0.02 is
 * deliberately small enough that even the fastest, sharpest aggressive-mood
 * transition (short duration, narrow feather) cannot make this read as
 * anything but a thin colour seam at a hard block edge.
 */
export const DATAMOSH_CHANNEL_OFFSET_MAX = 0.02

/**
 * Small, bounded per-block chromatic offset for `datamosh`'s R/B channel
 * sampling (`WipeCompositorPass` samples R and B at `progress ±` this value,
 * G at the real `progress` — see {@link DATAMOSH_CHANNEL_OFFSET_MAX}'s doc for
 * why that construction is boundary-local rather than frame-wide by itself).
 *
 * The magnitude follows the SAME triangular arc `transitionRack`'s ramps use
 * in `transitions.ts` (zero at `progress` 0 and 1, peak at the midpoint) —
 * reused here rather than re-derived, and for the same reason: the fringe
 * should only be present while the wipe is actually in motion, never held at
 * a static offset right at the start or end of the transition, which is
 * exactly when a viewer's eye has settled and would most easily read a
 * colour split as a mistake rather than as part of the effect. `reveal`
 * flips the offset's sign, so a just-revealed and a not-yet-revealed block
 * fringe in opposite directions — a directional "smear" read at the seam
 * between them rather than a uniform tint.
 */
export function datamoshChannelOffset(reveal: boolean, progress: number): number {
  const t = clamp01(progress)
  const arc = smoothstep(1 - Math.abs(t * 2 - 1))
  return (reveal ? 1 : -1) * DATAMOSH_CHANNEL_OFFSET_MAX * arc
}

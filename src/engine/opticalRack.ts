/**
 * Pure policy for the two optical racks — the MIRROR rack (symmetry, tiling,
 * twist, slice) and the LENS rack (seven interchangeable optical materials).
 *
 * Split from the passes themselves so the vocabulary and the enable rules are
 * testable without a WebGL context, exactly as `feedbackParams.ts` is split
 * from `FeedbackPass.ts`.
 *
 * ## The structural rule these racks exist under
 *
 * `PostFXChain`'s header states it: **the effect list is structurally
 * fixed.** Adding or removing an entry rebuilds the composer's merged shader —
 * a multi-hundred-millisecond stall that has lost the WebGL context outright
 * when repeated. So neither rack is ever mounted or unmounted in response to a
 * look change. Both passes are constructed once, live in the chain for the
 * whole session, and the *only* branch is the pass-level `enabled` flag, which
 * `EffectComposer` honours by skipping the pass before its buffer swap.
 *
 * That is also why every amount here defaults to zero: a rack at zero is not
 * "off by configuration", it is a pass the composer never visits, costing
 * nothing while keeping the chain's shape constant.
 *
 * ## Why a rack instead of more scenes
 *
 * Sixteen scenes through a fixed four-effect chain is sixteen looks. The same
 * sixteen through a mirror rack and a seven-material lens rack is a combination
 * space, and it grows multiplicatively with the roster rather than additively.
 * It is also the effect vocabulary a VJ arriving from Resolume or Magic already
 * expects to find, which matters when the product's claim is that it replaces
 * one of those.
 */

/**
 * The lens materials, in the order the shader's `uStyle` branches expect.
 *
 * Index IS the uniform value — `uStyle` is compared against 0.5/1.5/2.5/… in
 * the fragment shader, so reordering this array silently repoints every stored
 * preset at a different material. Append only.
 */
export const LENS_STYLES = [
  /** Vertical reeded glass; kicks click the flute phase. */
  'glass ribs',
  /** The same flutes, radiating from bottom centre. */
  'glass fan',
  /** Cinema glass: horizontal squeeze that breathes, plus streak flares. */
  'anamorphic',
  /** The pane liquefies; kicks spawn rising heat plumes. */
  'melt',
  /** Horizontal slice tears, re-rolled on every kick. */
  'glitch',
  /** LED-wall mosaic: coarse cells, hard gaps, posterised colour. */
  'pixels',
  /** Hex lattice of convex lenslets, each refracting its neighbourhood. */
  'fly eye',
] as const

export type LensStyle = (typeof LENS_STYLES)[number]

/** Number of concurrent heat-plume slots the `melt` material tracks. */
export const RIP_SLOTS = 6

/**
 * Below this, a rack contributes nothing a viewer could see, and the pass is
 * skipped outright rather than asked to render an identity transform.
 *
 * Same reasoning as `feedbackParams.ts`'s off-threshold: an effect that is
 * mathematically a no-op still costs a fullscreen draw to prove it, and these
 * default to zero, so without a floor *every* session would pay for two
 * fullscreen passes that change nothing.
 */
export const RACK_OFF_THRESHOLD = 0.01

/** Everything the mirror rack can be told. All zero = inert. */
export interface MirrorRackState {
  /**
   * 0 off · 1 mirror-x · 2 quad · >=3 n-fold kaleidoscope.
   *
   * Deliberately not a 0..1 normalised dial: the values are structurally
   * different pictures, not points on a continuum, and 3-fold vs 4-fold is a
   * count rather than an intensity.
   */
  segments: number
  /** >=2 gives an n×n mirror-repeat wallpaper. Below that, off. */
  tiles: number
  /** Radial vortex, in radians at the centre. Signed; 0 is off. */
  twist: number
  /** Alternating shear slabs, 0..1. */
  slice: number
  /** Rotation rate of the kaleidoscope itself, in turns-ish per second. */
  spin: number
  /**
   * 0..1 blend between the untouched frame and the mirrored one — see
   * `MirrorPass`'s `uMix` uniform. `segments`/`tiles` are counts (4-fold and
   * 6-fold are different pictures, not points on a scale) so they still snap
   * to their target rather than easing; `mix` is what actually fades the
   * effect's VISIBILITY in and out, which is what `segments` snapping to 0
   * the instant a re-decision picked `MIRROR_OFF` used to do instead — the
   * fold vanished in the frame it was decided, with nothing eased at all.
   *
   * Optional, and undefined means fully visible (1) — see
   * {@link MIRROR_MIX_DEFAULT}. `PostFXChain`'s transition-rack path
   * (`txMirror`, a brief `collapse`-style burst timed by transition progress,
   * not by this fade) never sets it and never needs to: that burst was always
   * instant before this field existed, so "no opinion" defaulting to "fully
   * on" leaves it unchanged. `PerformanceStateBridge` — the autonomous rack —
   * always sets it explicitly, easing it toward 1 on engagement and back to 0
   * on disengagement.
   */
  mix?: number
}

/**
 * What {@link MirrorRackState.mix} means when a caller has no opinion — see
 * that field's doc. Exported so `MirrorPass` and `isMirrorActive` apply the
 * exact same default rather than two copies of the same magic number.
 */
export const MIRROR_MIX_DEFAULT = 1

/** Everything the lens rack can be told. `amount` 0 = inert. */
export interface LensRackState {
  /** 0..1. Drives every material's strength; 0 skips the pass entirely. */
  amount: number
  /** Index into {@link LENS_STYLES}. */
  style: number
}

export function clampUnit(v: number): number {
  if (!isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Does the mirror rack have anything to do?
 *
 * `spin` is deliberately NOT part of this test. Spin only rotates a
 * kaleidoscope that is already folding; with `segments` at 0 there is nothing
 * to turn, so a non-zero spin alone must not switch the pass on and start
 * charging a fullscreen draw for an identity transform.
 *
 * `mix` gates it too, now: a fold fully faded out (`mix` decayed to 0 at the
 * end of the ~2-3s disengage fade — see that field's doc) has nothing left
 * for a viewer to see even though `segments`/`twist`/etc. may still be
 * sitting at their last engaged value, so there is no reason to keep charging
 * the fullscreen draw for an identity blend. Missing `mix` defaults to fully
 * visible, so every existing caller that never heard of this field — the
 * transition-rack burst included — is unaffected.
 */
export function isMirrorActive(m: MirrorRackState): boolean {
  const mix = m.mix ?? MIRROR_MIX_DEFAULT
  return (
    mix > RACK_OFF_THRESHOLD &&
    (m.segments >= 0.5 ||
      m.tiles >= 1.5 ||
      Math.abs(m.twist) > RACK_OFF_THRESHOLD ||
      m.slice > RACK_OFF_THRESHOLD)
  )
}

/** Does the lens rack have anything to do? */
export function isLensActive(l: LensRackState): boolean {
  return clampUnit(l.amount) > RACK_OFF_THRESHOLD
}

/**
 * Coerce a stored/streamed style index onto a real material.
 *
 * Rounds rather than truncates so a slider sitting at 2.9 reads as the material
 * it is visually on, and clamps rather than wrapping so a preset written
 * against a longer future list degrades to the last material instead of
 * silently landing on an unrelated one.
 */
export function resolveLensStyle(raw: number): number {
  if (!isFinite(raw)) return 0
  const i = Math.round(raw)
  return i < 0 ? 0 : i >= LENS_STYLES.length ? LENS_STYLES.length - 1 : i
}

/** The material's own name, for a UI caption or an external listing. */
export function lensStyleName(raw: number): LensStyle {
  return LENS_STYLES[resolveLensStyle(raw)]
}

/**
 * Which materials re-seat their structure on a beat, and how.
 *
 * Three different mechanisms, so the per-frame driver has to know which one a
 * given style wants rather than pushing the same number at all seven:
 *
 *  - `drift` — one slowly-advancing phase that a kick nudges. Serves the two
 *    flute materials (re-seat the pattern), `anamorphic` (rack the squeeze a
 *    quarter-phase) and `fly eye` (rotate the lattice a notch).
 *  - `seed` — an integer re-rolled per kick, so `glitch` tears land somewhere
 *    new rather than shimmering in place.
 *  - `plume` — a kick spawns a rising heat plume in a ring of slots, which is
 *    the whole point of `melt`.
 *  - `none` — `pixels` deliberately holds its grid still. Sizing the LED cells
 *    off the kick moved every cell boundary on every hit and the wall read as
 *    jitter; kicks light the panel instead.
 */
export type LensBeatMode = 'drift' | 'seed' | 'plume' | 'none'

export function lensBeatMode(styleIndex: number): LensBeatMode {
  switch (resolveLensStyle(styleIndex)) {
    case 4:
      return 'seed'
    case 3:
      return 'plume'
    case 5:
      return 'none'
    default:
      // ribs, fan, anamorphic, fly eye
      return 'drift'
  }
}

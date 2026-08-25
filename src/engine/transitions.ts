/**
 * The transition vocabulary: how one scene becomes another.
 *
 * ## Why this is a vocabulary and not a constant
 *
 * There used to be exactly one transition — a linear crossfade — plus a hard
 * cut taken when the frame budget could not fund two primaries. One transition
 * is a house style, and a house style applied to every change in a set is what
 * makes a long show feel flat: the same dissolve on a breakdown, on a drop, and
 * on a key change tells the viewer those three things are the same event.
 *
 * VJs arriving from Resolume or Magic expect a rack of these and reach for a
 * different one per musical moment. This is that rack.
 *
 * ## Two outputs, deliberately separate
 *
 * A transition decides two independent things, and conflating them is what
 * makes a transition system hard to extend:
 *
 *  - {@link transitionMix} — how visible each scene is. Pure geometry of the
 *    fade, and the only part that touches scene opacity.
 *  - {@link transitionRack} — what the post-chain racks should be doing while
 *    it runs. This is where the interesting styles live, and it is nearly free
 *    because the passes already exist: `smear` is the feedback pass, `melt` and
 *    `glitch` are lens materials, `collapse` is the mirror rack.
 *
 * A style can use either, both, or neither. `dissolve` is mix-only; `smear` is
 * a plain dissolve plus a rack ramp.
 *
 * ## The energy invariant
 *
 * 17 of 18 scenes blend additively, so what a viewer sees mid-fade is the SUM
 * of the two scenes' contributions. Every mix curve here therefore has to
 * satisfy `out(t) + in(t) === 1` at every point, or the frame visibly brightens
 * or dims through the transition — which reads as a flash, not as a fade.
 * `dipToBlack` is the one deliberate exception: dimming through the middle IS
 * the effect. {@link mixEnergy} exists so the tests can assert this rather than
 * trusting each curve's algebra by eye.
 */

/** Everything the director can choose between. Append-only: stored in cues. */
export const TRANSITION_STYLES = [
  /** Instant. Still the right answer on a drop — see SceneManager. */
  'cut',
  /** Eased crossfade. The default, and what every other style builds on. */
  'dissolve',
  /** Out to black, hold a beat, in from black. Reads as a scene change rather
   *  than a blend — useful when two scenes would ghost badly over each other. */
  'dipToBlack',
  /** Dissolve under a feedback smear: the outgoing scene leaves a trail that
   *  the incoming one emerges from. */
  'smear',
  /** Dissolve while the lens rack liquefies the frame. */
  'melt',
  /** Dissolve while the mirror rack twists and multiplies, so the outgoing
   *  scene collapses into a kaleidoscope and the incoming one unfolds out. */
  'collapse',
] as const

export type TransitionStyle = (typeof TRANSITION_STYLES)[number]

/** How visible each scene is at a point in the transition. */
export interface TransitionMix {
  /** Multiplier for the scene being replaced. */
  out: number
  /** Multiplier for the scene arriving. */
  in: number
}

/** What the post-chain racks should do while a transition runs. All additive
 *  over whatever the director already set; all zero when nothing is running. */
export interface TransitionRack {
  /** Added to `performanceState.trails`. */
  trails: number
  /** Added to `performanceState.lens.amount`. */
  lensAmount: number
  /** Taken as the lens material when `lensAmount` is non-zero. */
  lensStyle: number
  /** Added to `performanceState.mirror.twist`. */
  mirrorTwist: number
  /** Taken as `performanceState.mirror.tiles` when above 1.5. */
  mirrorTiles: number
}

const NO_RACK: TransitionRack = {
  trails: 0,
  lensAmount: 0,
  lensStyle: 0,
  mirrorTwist: 0,
  mirrorTiles: 0,
}

/** Lens material indices, from engine/opticalRack.ts's `LENS_STYLES`. */
const LENS_MELT = 3

export function clamp01(t: number): number {
  if (!isFinite(t)) return 0
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** Zero slope at both ends, and symmetric: `S(1-t) === 1 - S(t)`. */
export function smoothstep(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/**
 * A curve that reaches zero before the midpoint and stays there, for the
 * outgoing half of a dip. `hold` is the share of the transition spent fully
 * dark, centred on the midpoint.
 */
function dipOut(t: number, hold: number): number {
  const edge = (1 - hold) / 2
  return t >= edge ? 0 : smoothstep(1 - t / edge)
}

/** Share of a `dipToBlack` spent at full black. */
const DIP_HOLD = 0.25

/**
 * Scene visibilities at raw linear progress `t` (0 = transition just started,
 * 1 = complete).
 *
 * `t` is the LINEAR clock, not an eased value — every curve here does its own
 * easing, so handing it a pre-eased input would apply the curve twice.
 */
export function transitionMix(style: TransitionStyle, t: number): TransitionMix {
  const x = clamp01(t)
  switch (style) {
    case 'cut':
      // No in-between state at all: the incoming scene is the frame from the
      // first sample. Present as a style so a director can choose it, rather
      // than it only happening as a budget failure.
      return { out: 0, in: 1 }
    case 'dipToBlack': {
      const edge = (1 - DIP_HOLD) / 2
      return {
        out: dipOut(x, DIP_HOLD),
        // Mirror of the outgoing curve about the midpoint.
        in: x <= 1 - edge ? 0 : smoothstep((x - (1 - edge)) / edge),
      }
    }
    // Everything else is an eased crossfade; the style's character comes from
    // the rack ramp, not from a different mix. Keeping the mix identical is
    // what makes them composable and what keeps the energy invariant holding
    // for all of them at once.
    default:
      return { out: 1 - smoothstep(x), in: smoothstep(x) }
  }
}

/**
 * Total additive contribution at `t`. 1 means the frame carries the same light
 * it would with either scene alone — see the energy invariant in the header.
 */
export function mixEnergy(style: TransitionStyle, t: number): number {
  const m = transitionMix(style, t)
  return m.out + m.in
}

/**
 * Rack settings for a transition in flight.
 *
 * Every style ramps its rack up and back down across the transition — peaking
 * mid-fade, zero at both ends — so the rack cannot be left switched on if a
 * transition is interrupted, and so a style's effect reads as belonging to the
 * change rather than to either scene.
 */
export function transitionRack(style: TransitionStyle, t: number): TransitionRack {
  const x = clamp01(t)
  // Triangular ramp, eased. Zero at t=0 and t=1 by construction.
  const arc = smoothstep(1 - Math.abs(x * 2 - 1))
  switch (style) {
    case 'smear':
      return { ...NO_RACK, trails: arc * 0.75 }
    case 'melt':
      return { ...NO_RACK, lensAmount: arc * 0.7, lensStyle: LENS_MELT }
    case 'collapse':
      // Twist and tiling together: the frame folds inward and multiplies, then
      // unfolds onto the new scene. Tiles only engage past the shader's own
      // `>= 1.5` gate, so the ramp is offset to cross it rather than sitting
      // just under it for most of the transition doing nothing.
      return { ...NO_RACK, mirrorTwist: arc * 2.2, mirrorTiles: arc > 0.35 ? 2 : 0 }
    default:
      return NO_RACK
  }
}

/** Does this style need the racks at all? Lets callers skip the work entirely. */
export function usesRack(style: TransitionStyle): boolean {
  return style === 'smear' || style === 'melt' || style === 'collapse'
}

/**
 * A stored/streamed style name coerced onto a real one.
 *
 * Unknown falls back to `dissolve` rather than `cut`: a cue written against a
 * future style should degrade to the gentlest transition, not the harshest.
 */
export function resolveTransitionStyle(raw: unknown): TransitionStyle {
  return typeof raw === 'string' && (TRANSITION_STYLES as readonly string[]).includes(raw)
    ? (raw as TransitionStyle)
    : 'dissolve'
}

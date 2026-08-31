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

/**
 * Styles that exist but may not currently be CHOSEN.
 *
 * `cut` is disabled: it reads as jarring against the rest of the vocabulary, and
 * an instantaneous change is exactly the thing the eased curves were added to
 * stop happening by accident.
 *
 * **This disables it as a choice, not as a fallback.** `SceneManager` still
 * forces a cut when the frame budget cannot fund two primaries at once, and on a
 * drop, where an overlap is either unaffordable or editorially wrong. Those are
 * safety and editorial mechanisms rather than styles, they bypass this list
 * deliberately, and they remain by far the most common source of a hard cut in
 * practice — see F64. Removing `cut` from the picker will therefore not, on its
 * own, stop you seeing cuts.
 *
 * Kept in the vocabulary rather than deleted: the value is stored in cues and
 * recorded in transition telemetry, so removing the name would orphan saved
 * shows and make old records unreadable. A disabled style still has to resolve.
 */
export const DISABLED_STYLES: readonly TransitionStyle[] = ['cut']

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

/** May a director or a human pick this style? See {@link DISABLED_STYLES}. */
export function isStyleSelectable(style: TransitionStyle): boolean {
  return !DISABLED_STYLES.includes(style)
}

/** The styles a picker should offer. */
export function selectableStyles(): TransitionStyle[] {
  return TRANSITION_STYLES.filter(isStyleSelectable)
}

/**
 * Fade length used when the frame budget cannot fund two primaries at once.
 *
 * ## Why a short fade rather than no fade
 *
 * This path used to be an instantaneous cut, and that was a performance
 * mechanism producing an editorial result: on a machine that was already
 * struggling, EVERY scene change became a hard cut. Measured under load, the
 * primary count never exceeded 1 and `transition.active` was never once true —
 * the crossfade simply never ran, which is both the jarring look and the reason
 * no styled transition could ever be seen or measured.
 *
 * The budget's real concern is **how long** the frame carries two subjects, not
 * whether it ever does. A cut takes that window to zero; this takes it to about
 * a fifth of a second. At 60fps that is ~12 frames of elevated cost instead of
 * ~60, and those frames are additionally covered by the two-tier complexity
 * discount that already runs during any overlap (TRANSITION_DISCOUNT_TIERS in
 * quality.ts). So the guard keeps its intent — bound the exposure — while the
 * picture stops teleporting.
 *
 * This is a deliberate trade and worth stating plainly: it accepts a brief,
 * bounded overcommit in exchange for never snapping. It is not free, and on a
 * machine deep into the survival tier those twelve frames will still be the
 * most expensive of the transition.
 *
 * A drop is not covered by this. That stays a true cut — see SceneManager.
 */
export const CONSTRAINED_FADE_SEC = 0.2

/**
 * How long this transition's fade should last.
 *
 * `musical` is the tempo-derived length (~two beats). When the budget cannot
 * fund the overlap the fade is shortened rather than removed, and never
 * lengthened — if the musical duration is already shorter than the constrained
 * one, the shorter wins, because the constraint is a ceiling on exposure rather
 * than a target.
 */
export function fadeDurationFor(musical: number, constrained: boolean): number {
  const base = isFinite(musical) && musical > 0 ? musical : CONSTRAINED_FADE_SEC
  return constrained ? Math.min(base, CONSTRAINED_FADE_SEC) : base
}

/**
 * Transition styles each mood prefers, best first.
 *
 * Lists rather than a single style per mood, for the same reason the scene and
 * palette tables are lists: a fixed mapping means every breakdown gets the same
 * transition, which is the flatness the vocabulary was built to remove. The
 * pick below rotates within the list and refuses to repeat.
 *
 * The assignments are editorial, and the reasoning is worth keeping:
 *  - `smear` leaves a trail, so it reads as dreamy or unresolved — the quiet
 *    moods, where the picture should feel like it is drifting rather than
 *    being replaced.
 *  - `collapse` folds the frame into a kaleidoscope and back out. Geometric and
 *    energetic; it suits a build, where a transition should feel like pressure.
 *  - `melt` liquefies. Woozy rather than energetic, which fits the top end where
 *    everything is already moving and a fold would be noise on noise.
 *  - `dissolve` is the neutral one, and the only thing `silence` should ever do.
 *
 * `cut` appears nowhere: it is disabled as a choice (see {@link DISABLED_STYLES})
 * and a drop already forces one structurally, so a director choosing it would
 * only ever duplicate something the engine does anyway.
 */
const MOOD_STYLES: Record<string, TransitionStyle[]> = {
  silence: ['dissolve'],
  ambient: ['dissolve', 'smear'],
  mellow: ['smear', 'dissolve'],
  groove: ['dissolve', 'smear', 'melt'],
  building: ['collapse', 'smear'],
  peak: ['collapse', 'melt'],
  aggressive: ['melt', 'collapse'],
}

/**
 * How long after a section boundary a transition still counts as marking it.
 *
 * A section change is a single-frame edge, but the scene change it should
 * punctuate commits on the next downbeat — up to a bar later. Without a window
 * the two never coincide; with an unbounded latch the opposite happens, and
 * every subsequent transition inherits the dip long after the boundary has
 * passed. Measured that second failure directly: five consecutive changes all
 * ran `dipToBlack` because the flag had been set once and never cleared.
 *
 * ~2 s is about a bar at 120bpm, so a commit that is genuinely punctuating the
 * boundary lands inside it and a later one does not.
 */
export const SECTION_DIP_WINDOW_SEC = 2

/**
 * What kind of structural boundary a section change actually is, when the
 * off-thread structure analyser has an opinion — `'generic'` otherwise (any
 * real section edge that is neither of the other two, e.g. verse→chorus, or
 * the degraded case with no structure read at all).
 *
 * Deliberately a plain string union with no import from `audio/types` — this
 * module stays audio-agnostic, matching how `mood` below is already a plain
 * string rather than `MoodState`. The caller (`PerformanceStateBridge`, which
 * already has `f.songSection` in scope) does the classifying; this only
 * consumes the verdict.
 */
export type TransitionBoundaryType = 'drop' | 'breakdown' | 'generic'

/**
 * Style forced for a DROP boundary, overriding {@link MOOD_STYLES} the same
 * way the plain section-change case already does. Unchanged from the
 * pre-existing section-change behaviour on purpose: a blackout timed to the
 * beat, then a hard return to full brightness ON the drop, is the working
 * VJ technique for a landing and the classic case for `dipToBlack` — the
 * boundary-type split below exists to give the OTHER two boundary kinds
 * their own treatment, not to second-guess this one.
 */
const DROP_STYLE: TransitionStyle = 'dipToBlack'

/**
 * Style forced for a BREAKDOWN boundary.
 *
 * A breakdown is energy draining away, not landing — a hard cut to black
 * fights that deflation by asking the viewer to notice a boundary at exactly
 * the moment the music is asking them to stop noticing one. `smear` (a
 * feedback trail the incoming scene emerges from — see `TRANSITION_STYLES`)
 * reads as a fade or a dissolve into afterglow, which is what a breakdown
 * entry actually looks like.
 */
const BREAKDOWN_STYLE: TransitionStyle = 'smear'

/**
 * Choose the style for the next scene change.
 *
 * Boundary type outranks mood, which outranks nothing — mood only gets a say
 * once neither a drop nor a breakdown claimed the boundary. `boundaryType`
 * absent or `'generic'` (unclassified structure, or a real edge that is
 * neither of the other two — verse→chorus and similar) falls through to the
 * ORIGINAL behaviour: any section change at all forces `dipToBlack`. This
 * is the audit's own case for the split — "a drop is not a verse change and
 * should not get the same curve" — narrowed to the two boundary kinds this
 * engine can actually tell apart today, `songSection.isDrop` and
 * `.isBreakdown`, rather than guessed for edges the analyser has no opinion
 * on.
 *
 * Otherwise the mood picks, rotating through its list and never repeating
 * `last` when an alternative exists. Deterministic from `rotation` so a recorded
 * set replays identically, matching `pickPalette` and `pickVariedMode`.
 *
 * Anything disabled is filtered out, so disabling a style removes it from the
 * autonomy as well as from the picker rather than only from the UI.
 */
export function pickTransitionStyle(
  mood: string,
  sectionChange: boolean,
  rotation: number,
  last: TransitionStyle | undefined,
  boundaryType?: TransitionBoundaryType | null,
): TransitionStyle {
  if (sectionChange) {
    if (boundaryType === 'drop' && isStyleSelectable(DROP_STYLE)) return DROP_STYLE
    if (boundaryType === 'breakdown' && isStyleSelectable(BREAKDOWN_STYLE)) return BREAKDOWN_STYLE
    if (isStyleSelectable('dipToBlack')) return 'dipToBlack'
  }
  const preferred = (MOOD_STYLES[mood] ?? MOOD_STYLES.groove).filter(isStyleSelectable)
  if (preferred.length === 0) return 'dissolve'
  const fresh = preferred.filter((st) => st !== last)
  const pool = fresh.length > 0 ? fresh : preferred
  return pool[Math.abs(rotation) % pool.length]
}

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
      // Twist and tiling together: the frame folds inward and multiplies into
      // a 2x2 mirror-repeat (four corners), then unfolds back onto the new
      // scene as the ramp comes down. Tiles only engage past the shader's own
      // `>= 1.5` gate, so `2` sits comfortably past it rather than riding the
      // edge.
      //
      // This rode along with the twist until F108 dropped it, in step with
      // retiring the STANDING wallpaper mode everywhere else (mirrorForSection's
      // pools, the debug panel, the persisted store) — tiles was one dead
      // control among several. Restored here alone (F130): this is the
      // transition's own signature look, not the standing mode F108 actually
      // targeted, and PostFXChain reads `rack.mirrorTiles` directly into a
      // scratch mirror state rather than through `performanceState.mirror`, so
      // it is untouched by F108's `p.mirror.tiles = 0` gate — restoring it here
      // does not reopen the standing mode.
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
  if (typeof raw !== 'string' || !(TRANSITION_STYLES as readonly string[]).includes(raw)) {
    return 'dissolve'
  }
  const style = raw as TransitionStyle
  // A disabled style resolves to the default rather than being honoured. This is
  // what makes the disable real for a cue or a preset saved while it was still
  // available, instead of only hiding it from the picker.
  return isStyleSelectable(style) ? style : 'dissolve'
}

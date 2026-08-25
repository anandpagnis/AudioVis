import type { MoodState } from '../audio/types'
import type { LensRackState, MirrorRackState } from './opticalRack'
import type { TransitionStyle } from './transitions'
import type { SceneParams } from '../scenes/contract'

/** One live firing of an effect scene. Owned by EffectDirector. */
export interface ActiveEffect {
  /** Scene id. */
  id: string
  /** Engine time (`features.time`) the firing began. */
  startedAt: number
  /** Lifetime, copied from the scene's `effect.durationSec` at fire time. */
  durationSec: number
  /** Distinguishes successive firings of the SAME scene, so a re-fire remounts. */
  key: number
}

/**
 * The single description of what the visuals SHOULD be doing right now.
 *
 * This is the seam the whole architecture pivots on. Above it, creative systems
 * (AutoPilot, PerformanceDirector, CueTimeline — and later any ML-driven
 * director) decide what the show wants. Below it, execution systems
 * (SceneDirector, CameraDirector, AnimationDirector, EffectsDirector) do what
 * it says. Nothing below reads audio to make a *decision*; nothing above
 * touches a Three.js object.
 *
 * The practical payoff: a new decision-maker is additive — it writes here and
 * every downstream system picks it up with no renderer changes. Likewise a new
 * renderer (TouchDesigner, Notch) only has to consume this object.
 *
 * ## Every field here must have a reader
 *
 * This object went a whole refactor carrying four fields — `complexity`,
 * `distortion`, `particleDensity` and `visualTension` — that were written every
 * frame and read by nothing, while the scenes that should have consumed them
 * reached around the seam to the quality governor instead. A declared-but-inert
 * field is worse than a missing one: it reads as wired, it gets documented as
 * working, and it costs frame time. **If nothing downstream consumes a field,
 * delete the field rather than keeping it "for later".**
 *
 * ## Single-writer, mutable-by-design
 *
 * Conceptually this is one immutable value per frame. It is implemented as a
 * mutable singleton because the render loop runs at 60fps and this codebase's
 * hot path allocates nothing — the same reason `audioEngine.features` and
 * `perf` work this way. The immutability that matters is enforced by
 * convention, not by the type: **only the performance-director layer writes;
 * everyone else reads.** Downstream systems interpolate toward these values
 * rather than snapping, so a director can set a target and let the executor
 * ease into it.
 */
export interface PerformanceState {
  // ---- What is on screen -------------------------------------------------
  /** Scene id the show WANTS. SceneDirector owns when it actually commits. */
  scene: string
  /**
   * Scene id currently committed and on screen. Differs from `scene` between a
   * request and its downbeat commit. Executors that must match what the viewer
   * can actually see — the camera above all — follow this one, so a queued
   * scene change never swings the lens before its scene is visible.
   */
  activeScene: string
  /**
   * The composition around the primary.
   *
   * `background`/`accent`/`overlay` are tenancies — a scene id or null. Effects
   * are a lifecycle: each entry is one firing with its own clock, and
   * SceneManager retires it when `startedAt + durationSec` passes. Effects live
   * here rather than in the store because they are engine state driven by
   * musical events, not a user setting.
   */
  layers: {
    background: string | null
    accent: string | null
    overlay: string | null
    effects: ActiveEffect[]
  }
  /** Palette id. */
  palette: string
  /** The mood this state was composed for — context for downstream easing. */
  mood: MoodState

  // ---- How it should behave ---------------------------------------------
  /** Camera behaviour the CameraDirector should be running. */
  cameraMode: CameraMode
  /** 0..2 — global multiplier on animation amplitude. */
  animationIntensity: number
  /** 0..1 — fraction of available particles/detail to draw. */
  particleDensity: number
  /**
   * 0..1 — dramatic pressure. Rises through a build, peaks on a drop. Distinct
   * from energy: tension is about *anticipation*, so it can be high while the
   * music is quiet (the bar before a drop).
   */
  visualTension: number
  /**
   * 0..1 — how much the show should be listening to the voice right now.
   *
   * Derived from the classifier's `vocalPresence`, which is a SECTION-scale
   * fact (12 s cadence), not a waveform. That distinction is the whole point:
   * driving motion directly from `vocalPresence` would step visibly every 12 s.
   * Instead this is the slow half of a two-timescale pair — it grants
   * *permission*, and the fast per-frame `voice` band supplies the movement.
   * An instrumental section drives this to ~0, so the fast term vanishes
   * rather than firing on hats and distortion leaking into the vocal range.
   *
   * Readers: the bridge's own bloom term and CameraDirector's mode bias. It
   * earns a field rather than a local because those two are different
   * consumers on different sides of the seam; scenes can also reach it through
   * `ctx.state`, though none currently do — Flow Ribbons deliberately still
   * tracks the raw `b.voice` band, since tracing an instrumental synth line is
   * the feature there, not a bug to gate away.
   */
  voiceFocus: number

  // ---- Post / effects ----------------------------------------------------
  /** 0..2 — bloom strength multiplier. */
  bloom: number
  /**
   * Luminance above which a pixel blooms. LOWER means more of the frame blooms,
   * so this falls on a drop rather than rising.
   *
   * The most expressive single float in the post chain: `bloom` scales what is
   * already blooming, while this changes *how much of the image* is eligible at
   * all — a whole-frame event from one uniform, with no change to the pass list.
   */
  bloomThreshold: number
  /** 0..1 — chromatic aberration / lens-break amount. */
  glitch: number
  /**
   * Direction of the chromatic-aberration smear, in radians.
   *
   * The offset was a fixed x/y ratio, so aberration always broke the image the
   * same way. Rotating it lets the glitch have a direction that tracks the
   * music instead of reading as a static lens defect.
   */
  caAngle: number
  /** 0..1 — vignette darkness. Rises through a build to tighten the frame. */
  vignette: number
  /** 0..1 — atmospheric depth. */
  fog: number
  /**
   * 0..1 — image feedback: history persistence, and with it the zoom/rotate/
   * swirl/wobble drift of the accumulated trail. 0 is a clean frame with no
   * loop at all; 1 is a full recursive tunnel. See engine/FeedbackPass.ts and
   * engine/feedbackParams.ts for what this one number expands into.
   *
   * Defaults to 0 (off) because nothing upstream drives it creatively yet —
   * the pass and the seam exist; deciding when a mood or a phrase should raise
   * this is future work, same as every other performanceState field's history
   * (bloom/vignette/fog all shipped as executors before a director opinion
   * about *when* to move them existed).
   */
  trails: number

  /**
   * The MIRROR rack: kaleidoscopic symmetry, mirror-repeat tiling, radial
   * twist, shear slicing, and the spin that turns the fold. See
   * engine/opticalRack.ts and engine/MirrorPass.ts.
   *
   * `segments` is a count, not a normalised dial (0 off · 1 mirror-x · 2 quad ·
   * >=3 n-fold), because 3-fold and 4-fold are different pictures rather than
   * points on an intensity scale.
   *
   * All zero by default: the pass is skipped entirely and the frame is
   * untouched. Nothing autonomous drives these yet — same posture as `trails`.
   */
  mirror: MirrorRackState

  /**
   * The LENS rack: `amount` 0..1 across one of seven optical materials
   * (`style` indexes engine/opticalRack.ts's `LENS_STYLES`).
   *
   * Zero by default, which skips the pass. Also undriven so far.
   */
  lens: LensRackState

  /**
   * Raw-ish audio the optical racks need, published here rather than read
   * directly by the executor.
   *
   * `EffectsDirector` is a pure executor by contract — it reads
   * `performanceState` and applies it, and reads no audio. But the lens
   * materials genuinely need beat information: kicks re-seat a material's
   * structure (a new flute phase, a re-rolled tear, a fresh heat plume), which
   * is the whole difference between glass and a filter. So the bridge, which
   * already reads audio, publishes the four signals the racks consume.
   *
   * `onKick` is a rising EDGE (0 on any frame that is not a beat), not a level.
   * The re-seat mechanisms are events; driving them from a continuous envelope
   * is what turns a structural re-seat into a flicker.
   */
  rackAudio: {
    kick: number
    highs: number
    mids: number
    onKick: number
  }

  /**
   * How the NEXT primary scene change should be performed. See
   * engine/transitions.ts.
   *
   * Read by SceneManager at commit time and captured into `transition` below,
   * so changing it mid-fade retunes the next change rather than mutating the one
   * already running — a transition that changed character halfway through would
   * read as a glitch, not as a choice.
   */
  transitionStyle: TransitionStyle

  /**
   * The transition actually in flight, published by SceneManager for the
   * executors that have to follow it.
   *
   * `progress` is the RAW linear clock, not an eased value: every curve in
   * transitions.ts does its own easing, so handing them a pre-eased number would
   * apply the curve twice. `active` is false between transitions, when
   * `progress` is meaningless rather than zero.
   */
  transition: {
    style: TransitionStyle
    progress: number
    active: boolean
  }

  /**
   * Scene Contract dial positions the director wants, in the shared vocabulary.
   *
   * The director's continuous hand on the picture, as opposed to `scene`, which
   * is its choice of picture. Sparse on purpose: a key is present only where the
   * director has an opinion, so `useSceneFrame` can tell "no opinion" from "an
   * opinion that happens to be 0.5" — and `shape` and `tilt` are never present
   * at all (see engine/sceneSteer.ts for why those two are declined).
   *
   * Reader: `useSceneFrame`, which layers it under the user's own dials. A user
   * dial always wins, so this steers only what nobody has taken.
   */
  sceneParams: SceneParams
}

/** Camera behaviours the CameraDirector can run. Scenes only supply anchors. */
export type CameraMode =
  'orbit' | 'hover' | 'push' | 'pull' | 'spiral' | 'handheld' | 'locked' | 'topdown' | 'cinematic'

export const CAMERA_MODES: CameraMode[] = [
  'orbit',
  'hover',
  'push',
  'pull',
  'spiral',
  'handheld',
  'locked',
  'topdown',
  'cinematic',
]

/**
 * The live performance state. Written by the director layer once per frame,
 * read by every executor. See the single-writer note above.
 */
export const performanceState: PerformanceState = {
  scene: 'wireframe',
  activeScene: 'wireframe',
  layers: { background: null, accent: null, overlay: null, effects: [] },
  palette: 'aurora',
  mood: 'silence',

  cameraMode: 'hover',
  animationIntensity: 1,
  particleDensity: 1,
  visualTension: 0,
  voiceFocus: 0,

  bloom: 1,
  bloomThreshold: 0.18,
  glitch: 0,
  caAngle: 0,
  vignette: 0.85,
  fog: 0,
  trails: 0,
  mirror: { segments: 0, tiles: 0, twist: 0, slice: 0, spin: 0 },
  lens: { amount: 0, style: 0 },
  rackAudio: { kick: 0, highs: 0, mids: 0, onKick: 0 },
  transitionStyle: 'dissolve',
  transition: { style: 'dissolve', progress: 1, active: false },

  // Empty, not neutral: at boot the director has formed no opinion yet, and
  // every scene's own authored defaults are the right thing to show until it
  // does. `advanceSteer` seeds each key on the first frame it runs.
  sceneParams: {},
}

/**
 * Frame-rate-independent easing toward a target.
 *
 * Downstream systems use this so a director can hard-set a value and still get
 * a smooth visual result — the "directors decide, executors interpolate" half
 * of the contract. `rate` is roughly "how much of the gap to close per second".
 *
 * ## Why the exponential, and not `delta * rate`
 *
 * This used to be `current + (target - current) * Math.min(1, delta * rate)` —
 * the first-order approximation — while its doc comment already claimed to be
 * frame-rate independent. It was not, in two ways that both showed up as
 * transitions feeling jerky:
 *
 *  - **It snapped.** Once `delta * rate >= 1` the `min` clamps and the value
 *    jumps straight to the target. With `rate` 7 (the transition discount) that
 *    is any frame under 7fps; with 2.5 (palette blending) under 2.5fps; with 3
 *    (camera distance) under 3fps. So on a struggling machine the easing that
 *    exists to hide a change stopped easing at exactly the moment it was most
 *    needed, and the camera teleported.
 *  - **It changed shape with frame rate.** The same `rate` closes a different
 *    fraction of the gap per second at 30fps than at 144fps, so a move tuned on
 *    one machine is a different move on another.
 *
 * `1 - exp(-delta * rate)` is the exact solution to the decay this was
 * approximating: identical for small `delta * rate` (so every existing rate
 * stays tuned), asymptotic rather than clamped (so it can never snap), and
 * genuinely independent of how the elapsed time is chopped into frames.
 *
 * This is the same correction TrailLineScene's header already describes for its
 * own decay — that lesson simply never reached the shared helper, which is used
 * in seventeen places including the whole camera system.
 */
export function approach(current: number, target: number, rate: number, delta: number): number {
  // A non-finite delta (a resumed background tab, a context restore) must not
  // poison the value; holding still for one frame is the safe answer.
  if (!isFinite(delta) || delta <= 0) return current
  return current + (target - current) * (1 - Math.exp(-delta * rate))
}

import type { MoodState } from '../audio/types'

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
  /** Accent layer scene id, or null. */
  accent: string | null
  /** Overlay layer scene id, or null. */
  overlay: string | null
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

  // ---- Post / effects ----------------------------------------------------
  /** 0..2 — bloom strength multiplier. */
  bloom: number
  /** 0..1 — chromatic aberration / lens-break amount. */
  glitch: number
  /** 0..1 — atmospheric depth. */
  fog: number
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
  accent: null,
  overlay: null,
  palette: 'aurora',
  mood: 'silence',

  cameraMode: 'hover',
  animationIntensity: 1,
  particleDensity: 1,
  visualTension: 0,

  bloom: 1,
  glitch: 0,
  fog: 0,
}

/**
 * Frame-rate-independent easing toward a target.
 *
 * Downstream systems use this so a director can hard-set a value and still get
 * a smooth visual result — the "directors decide, executors interpolate" half
 * of the contract. `rate` is roughly "how much of the gap to close per second".
 */
export function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * Math.min(1, delta * rate)
}

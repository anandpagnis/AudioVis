import type * as THREE from 'three'
import { audioEngine } from '../audio/AudioEngine'
import { getAudioResponse } from './audioResponse'
import { performanceState } from './performanceState'

/**
 * Reusable animation primitives, decoupled from any particular scene.
 *
 * The problem this solves: animation logic used to live inside each scene, so
 * "pulse on the beat" was reimplemented per scene and could not be swapped,
 * reused, or directed from outside. Here each primitive is a named, normalized
 * 0..1 signal computed once per frame from the music, and scenes *consume*
 * signals rather than deriving their own.
 *
 * ## Why signals rather than "apply Pulse to that sphere"
 *
 * A director that reaches in and mutates `mesh.scale` only works for scenes
 * built from Object3Ds. Three of this project's scenes do their animation
 * inside GLSL vertex shaders — you cannot lift a pulse out of
 * `pos *= 1.0 + uPulse * 0.06` and apply it from JavaScript. So the director
 * publishes VALUES, and targets consume them in whichever way suits them:
 *
 *   - mesh scenes    → {@link applyToObject} maps signals onto transforms
 *   - shader scenes  → {@link applyToUniforms} copies signals into standard
 *                      `uAnim*` uniforms the scene's GLSL already reads
 *
 * Both routes are driven by the same numbers, so a primitive genuinely behaves
 * the same across scene types — which is the reuse the refactor is after.
 */

/**
 * The primitive set. Each is a normalized 0..1 (or -1..1 for signed) signal.
 *
 * Every primitive here is something a scene cannot get from `SceneFrame.b`.
 * That boundary is deliberate and was learned the hard way: this set originally
 * also carried `pulse`, `flash` and per-drum `kick`/`snare`/`hihat`, all of
 * which restated `b.pulse`, `b.transient` and `b.kick`/`b.snare`/`b.hihat` at a
 * different scale factor. Two sources of truth for "the beat hit" is a bug
 * waiting to happen, so the duplicates are gone — reach for `b.*` for
 * instantaneous band energy, and for these when you want STATE that has to
 * accumulate across frames or a signal derived from the director's own
 * decisions.
 */
export interface AnimationSignals {
  /** Sustained low-frequency swell driven by bass mass (bass + sub together). */
  inflate: number
  /** Signed rotational shear, accumulating — drifts with mid content. */
  twist: number
  /** Travelling wave phase, advances with tempo — for radial/linear ripples. */
  ripple: number
  /**
   * 0..1 scatter amount; rises with tension, slams on a drop.
   *
   * With `dissolve`, this is the only route by which the director's
   * `visualTension` reaches the screen — the anticipation in the bar before a
   * drop is not in any band envelope, because the music there is often quiet.
   */
  explode: number
  /** 0..1 how far a form should be broken apart into particles. */
  dissolve: number
  /** Free-running oscillator, tempo-locked — generic sway/wobble. */
  oscillate: number
}

/** Live signals. Written once per frame by {@link updateAnimationSignals}. */
export const animationSignals: AnimationSignals = {
  inflate: 0,
  twist: 0,
  ripple: 0,
  explode: 0,
  dissolve: 0,
  oscillate: 0,
}

/** Continuous phases that must survive across frames. */
const phase = { ripple: 0, oscillate: 0, twist: 0 }

/**
 * Recompute every primitive for this frame.
 *
 * Called once, centrally (by SceneManager's tick), so N scenes reading the
 * signals cost the same as one — versus the old model where each scene
 * recomputed its own envelopes.
 */
export function updateAnimationSignals(): void {
  const f = audioEngine.features
  const r = getAudioResponse(f)
  const a = animationSignals
  const dt = f.delta
  // Global amplitude comes from the performance state, so a director can dial
  // the whole show's animation up or down without touching a scene.
  const amp = performanceState.animationIntensity

  phase.ripple += dt * (0.5 + (f.bpm / 120) * 0.8 + f.energy * 0.5)
  phase.oscillate += dt * (0.3 + (f.bpm / 120) * 0.4)
  phase.twist += dt * (r.mid - 0.5) * 0.6

  a.inflate = Math.min(2, (r.bass * 0.8 + r.sub * 0.4) * amp)
  a.twist = Math.max(-1, Math.min(1, Math.sin(phase.twist) * (0.4 + r.mid * 0.6)))
  a.ripple = phase.ripple % 1
  a.oscillate = Math.sin(phase.oscillate * Math.PI * 2)

  // Tension drives anticipation (things pull apart before the drop); the drop
  // itself is the release, so it slams rather than ramps.
  a.explode = Math.min(1, performanceState.visualTension * 0.7 + r.dropPulse)
  a.dissolve = Math.min(1, performanceState.visualTension * 0.5 + r.build * 0.5)
}

/** Standard uniform names a shader scene can declare to receive signals. */
export interface AnimationUniforms {
  uAnimInflate?: THREE.IUniform<number>
  uAnimTwist?: THREE.IUniform<number>
  uAnimRipple?: THREE.IUniform<number>
  uAnimExplode?: THREE.IUniform<number>
  uAnimDissolve?: THREE.IUniform<number>
  uAnimOscillate?: THREE.IUniform<number>
}

/**
 * Copy the signals into a shader material's uniforms. Only writes uniforms the
 * material actually declares, so a scene opts in per-primitive just by naming
 * the ones it wants — no base-shader changes, no unused-uniform warnings.
 *
 * Mesh scenes have no equivalent helper on purpose. An `applyToObject()` used
 * to live here, writing absolute scale and position from a captured rest pose;
 * no scene could call it, because every mesh scene already sets its own scale
 * and rotation each frame and the two would have fought for the transform.
 * Mesh scenes read `ctx.anim.*` and fold the values into their own expressions
 * instead, which also keeps the band-to-job routing per-scene where it belongs.
 */
export function applyToUniforms(u: AnimationUniforms): void {
  const a = animationSignals
  if (u.uAnimInflate) u.uAnimInflate.value = a.inflate
  if (u.uAnimTwist) u.uAnimTwist.value = a.twist
  if (u.uAnimRipple) u.uAnimRipple.value = a.ripple
  if (u.uAnimExplode) u.uAnimExplode.value = a.explode
  if (u.uAnimDissolve) u.uAnimDissolve.value = a.dissolve
  if (u.uAnimOscillate) u.uAnimOscillate.value = a.oscillate
}

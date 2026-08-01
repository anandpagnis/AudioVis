import type * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
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

/** The primitive set. Each is a normalized 0..1 (or -1..1 for signed) signal. */
export interface AnimationSignals {
  /** Sharp attack on each beat, fast decay — the classic hit. */
  pulse: number
  /** Slow sinusoidal swell, unrelated to beats — life during quiet passages. */
  breathe: number
  /** Sustained low-frequency swell driven by bass mass. */
  inflate: number
  /** Signed rotational shear, drifts with mid content. */
  twist: number
  /** Travelling wave phase, advances with tempo — for radial/linear ripples. */
  ripple: number
  /** 0..1 scatter amount; rises with tension, slams on a drop. */
  explode: number
  /** 0..1 how far a form should be broken apart into particles. */
  dissolve: number
  /** Free-running oscillator, tempo-locked — generic sway/wobble. */
  oscillate: number
  /** Instantaneous flash from any transient (all-kit). */
  flash: number

  // Per-instrument channels — these are what let separate layers move
  // separately instead of everything keying off one broadband envelope.
  kick: number
  snare: number
  hihat: number
}

/** Live signals. Written once per frame by {@link updateAnimationSignals}. */
export const animationSignals: AnimationSignals = {
  pulse: 0,
  breathe: 0,
  inflate: 0,
  twist: 0,
  ripple: 0,
  explode: 0,
  dissolve: 0,
  oscillate: 0,
  flash: 0,
  kick: 0,
  snare: 0,
  hihat: 0,
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

  const beat = beatPulse(f)

  phase.ripple += dt * (0.5 + (f.bpm / 120) * 0.8 + f.energy * 0.5)
  phase.oscillate += dt * (0.3 + (f.bpm / 120) * 0.4)
  phase.twist += dt * (r.mid - 0.5) * 0.6

  a.pulse = Math.min(2, beat * amp)
  a.breathe = (0.5 + Math.sin(f.time * 0.35) * 0.5) * amp
  a.inflate = Math.min(2, (r.bass * 0.8 + r.sub * 0.4) * amp)
  a.twist = Math.max(-1, Math.min(1, Math.sin(phase.twist) * (0.4 + r.mid * 0.6)))
  a.ripple = phase.ripple % 1
  a.oscillate = Math.sin(phase.oscillate * Math.PI * 2)
  a.flash = Math.min(1, r.transient * amp)

  // Tension drives anticipation (things pull apart before the drop); the drop
  // itself is the release, so it slams rather than ramps.
  a.explode = Math.min(1, performanceState.visualTension * 0.7 + r.dropPulse)
  a.dissolve = Math.min(1, performanceState.visualTension * 0.5 + r.build * 0.5)

  a.kick = r.kick * amp
  a.snare = r.snare * amp
  a.hihat = r.hihat * amp
}

/** Standard uniform names a shader scene can declare to receive signals. */
export interface AnimationUniforms {
  uAnimPulse?: THREE.IUniform<number>
  uAnimBreathe?: THREE.IUniform<number>
  uAnimInflate?: THREE.IUniform<number>
  uAnimTwist?: THREE.IUniform<number>
  uAnimRipple?: THREE.IUniform<number>
  uAnimExplode?: THREE.IUniform<number>
  uAnimDissolve?: THREE.IUniform<number>
  uAnimOscillate?: THREE.IUniform<number>
  uAnimFlash?: THREE.IUniform<number>
  uAnimKick?: THREE.IUniform<number>
  uAnimSnare?: THREE.IUniform<number>
  uAnimHihat?: THREE.IUniform<number>
}

/**
 * Copy the signals into a shader material's uniforms. Only writes uniforms the
 * material actually declares, so a scene opts in per-primitive just by naming
 * the ones it wants — no base-shader changes, no unused-uniform warnings.
 */
export function applyToUniforms(u: AnimationUniforms): void {
  const a = animationSignals
  if (u.uAnimPulse) u.uAnimPulse.value = a.pulse
  if (u.uAnimBreathe) u.uAnimBreathe.value = a.breathe
  if (u.uAnimInflate) u.uAnimInflate.value = a.inflate
  if (u.uAnimTwist) u.uAnimTwist.value = a.twist
  if (u.uAnimRipple) u.uAnimRipple.value = a.ripple
  if (u.uAnimExplode) u.uAnimExplode.value = a.explode
  if (u.uAnimDissolve) u.uAnimDissolve.value = a.dissolve
  if (u.uAnimOscillate) u.uAnimOscillate.value = a.oscillate
  if (u.uAnimFlash) u.uAnimFlash.value = a.flash
  if (u.uAnimKick) u.uAnimKick.value = a.kick
  if (u.uAnimSnare) u.uAnimSnare.value = a.snare
  if (u.uAnimHihat) u.uAnimHihat.value = a.hihat
}

/** Which primitives an Object3D target should respond to, and how strongly. */
export interface ObjectAnimation {
  /** Uniform scale from `pulse`. */
  pulse?: number
  /** Uniform scale from `inflate`. */
  inflate?: number
  /** Y-axis spin rate, scaled by `twist`. */
  twist?: number
  /** Vertical bob from `oscillate`. */
  bob?: number
  /** Outward displacement along the object's own position from `explode`. */
  explode?: number
}

const baseScale = new WeakMap<THREE.Object3D, number>()
const basePos = new WeakMap<THREE.Object3D, THREE.Vector3>()

/**
 * Drive a plain Object3D from the signals — the mesh-scene counterpart to
 * {@link applyToUniforms}.
 *
 * The object's scale and position at first call are captured as the rest
 * pose, so repeated application is absolute rather than cumulative (animating
 * relative to the live transform would compound every frame and drift).
 */
export function applyToObject(obj: THREE.Object3D, spec: ObjectAnimation, delta: number): void {
  const a = animationSignals
  if (!baseScale.has(obj)) baseScale.set(obj, obj.scale.x)
  if (!basePos.has(obj)) basePos.set(obj, obj.position.clone())
  const s0 = baseScale.get(obj) as number
  const p0 = basePos.get(obj) as THREE.Vector3

  const scale = s0 * (1 + (spec.pulse ?? 0) * a.pulse * 0.1 + (spec.inflate ?? 0) * a.inflate * 0.12)
  obj.scale.setScalar(scale)

  if (spec.twist) obj.rotation.y += a.twist * spec.twist * delta
  obj.position.set(
    p0.x + p0.x * (spec.explode ?? 0) * a.explode * 0.5,
    p0.y + (spec.bob ?? 0) * a.oscillate * 0.3 + p0.y * (spec.explode ?? 0) * a.explode * 0.5,
    p0.z + p0.z * (spec.explode ?? 0) * a.explode * 0.5,
  )
}

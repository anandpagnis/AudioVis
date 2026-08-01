import { useContext, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'
import { animationSignals, type AnimationSignals } from './AnimationDirector'
import { getEffectiveParams } from './moodParams'
import { performanceState, type PerformanceState } from './performanceState'
import { PaletteBlender, getPalette } from './palettes'
import { SceneFade } from './SceneManager'
import type { VisualParams } from '../store'
import { useStore } from '../store'

/**
 * Everything a scene needs, prepared once per frame.
 *
 * Before this existed, every scene opened its `useFrame` with the same six
 * lines: resolve effective params, pull reactivity out, blend the palette,
 * compute a beat pulse, scale each band by reactivity, and derive a fade
 * amount. Five scenes, five copies, five chances to drift apart — and a new
 * scene had to know all of it before it could draw anything.
 *
 * What deliberately does NOT move in here is the band→job ROUTING: which band
 * drives mass vs. hue vs. stroke weight. That mapping is the art direction (see
 * docs/05_Scene_Architecture.md) and it is per-scene by design. The context
 * hands over prepared values; the scene decides what each one means.
 */
export interface SceneFrame {
  /** Raw features, for anything the prepared values don't cover. */
  f: AudioFeatures
  /** Seconds since the previous frame. */
  dt: number

  /**
   * Reusable animation primitives, already scaled by the performance state's
   * animation intensity. Prefer these over hand-rolling an envelope.
   */
  anim: AnimationSignals

  /**
   * Band envelopes pre-multiplied by reactivity — the scaling every scene used
   * to apply by hand at each use site.
   */
  b: {
    sub: number
    bass: number
    mid: number
    presence: number
    high: number
    /** Raw 250 Hz–5 kHz energy. For a lead line prefer `voice`. */
    vocal: number
    /**
     * Sustained tonal content in the vocal range (vocal × tonality) — tracks a
     * held/sung line rather than any mid-range noise. See AudioResponse.voice.
     */
    voice: number
    air: number
    energy: number
    transient: number
    /** Subdivision-aware beat pulse, reactivity-weighted. */
    pulse: number
    /** Independent drum envelopes — use these for per-kit-piece response. */
    kick: number
    snare: number
    hihat: number
  }

  /** Smoothly blended palette. Mutated in place — never retain across frames. */
  col: { a: THREE.Color; b: THREE.Color; c: THREE.Color }

  /**
   * Crossfade weight × mood intensity, floored and clamped.
   *
   * The floor is load-bearing: a line-art subject must stay readable through a
   * quiet passage. An earlier roster gated everything on energy and scenes
   * vanished during breakdowns.
   */
  vis: number

  /** User sliders × mood multipliers × band routing. */
  params: VisualParams

  /**
   * The shared camera, **read-only** for scenes — CameraDirector owns its
   * transform. Fullscreen-quad raymarch scenes need it to build their own rays;
   * without it they would ignore the director entirely and be the one scene
   * type the camera modes could not drive.
   */
  camera: THREE.Camera

  /**
   * The live performance state, **read-only** for scenes.
   *
   * A scene may consult it to honour a director decision — `particleDensity`,
   * `visualTension`, `animationIntensity` — but must never write to it.
   * Writing is the decide band's job; a scene that writes here has inverted the
   * architecture.
   */
  state: Readonly<PerformanceState>
}

export interface SceneFrameOptions {
  /** Upper clamp on `vis`. Above 1 lets additive scenes overdrive. */
  visCeiling?: number
  /** Share of `vis` that ignores mood intensity — the readability floor. */
  visFloor?: number
}

/**
 * Drive a scene from a prepared {@link SceneFrame}.
 *
 * Replaces a scene's own `useFrame`. Runs at the default priority, so the
 * audio tick (−100), the creative directors, and the camera (−80) have all
 * already run for this frame.
 */
export function useSceneFrame(
  callback: (ctx: SceneFrame) => void,
  opts: SceneFrameOptions = {},
): void {
  const { visCeiling = 1, visFloor = 0.5 } = opts
  const fade = useContext(SceneFade)
  const camera = useThree((s) => s.camera)
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  // One context object reused every frame — the render loop allocates nothing.
  const ctx = useRef<SceneFrame>({
    f: audioEngine.features,
    dt: 0,
    anim: animationSignals,
    b: {
      sub: 0,
      bass: 0,
      mid: 0,
      presence: 0,
      high: 0,
      vocal: 0,
      voice: 0,
      air: 0,
      energy: 0,
      transient: 0,
      pulse: 0,
      kick: 0,
      snare: 0,
      hihat: 0,
    },
    col: blender,
    vis: 0,
    params: { intensity: 1, speed: 1, reactivity: 1 },
    camera,
    state: performanceState,
  })

  useFrame(() => {
    const f = audioEngine.features
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(useStore.getState().paletteId), f.delta)

    const c = ctx.current
    c.f = f
    c.dt = f.delta
    c.params = params
    c.camera = camera
    c.col = blender
    c.vis = Math.min(visCeiling, fade.value * (visFloor + (1 - visFloor) * params.intensity))

    const b = c.b
    b.sub = f.sub * R
    b.bass = f.bass * R
    b.mid = f.mid * R
    b.presence = f.presence * R
    b.high = f.high * R
    b.vocal = f.vocal * R
    // Tonality-gated: suppresses the noisy half of the vocal range so this
    // tracks a pitched lead instead of any mid-range energy.
    b.voice = Math.max(0, Math.min(1, f.vocal * (1 - Math.min(1, f.spectralFlatness)))) * R
    b.air = f.air * R
    b.energy = f.energy * R
    b.transient = f.transient * R
    b.pulse = beatPulse(f) * R
    b.kick = f.percussion.kick.env * R
    b.snare = f.percussion.snare.env * R
    b.hihat = f.percussion.hihat.env * R

    callback(c)
  })
}

/**
 * Accumulating rotation angle, the pattern every rotating scene shares.
 *
 * Returns a getter rather than a value because it must advance inside the
 * frame callback, not on React's render. `rate` is revolutions-ish per second
 * before `params.speed` is applied.
 */
export function useSpin(): (dt: number, rate: number, speed: number) => number {
  const angle = useRef(0)
  return (dt, rate, speed) => {
    angle.current += dt * rate * speed
    return angle.current
  }
}

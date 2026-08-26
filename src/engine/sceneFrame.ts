import { useContext, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'
import { animationSignals, type AnimationSignals } from './AnimationDirector'
import { getEffectiveParams } from './moodParams'
import { performanceState, type PerformanceState } from './performanceState'
import { PaletteBlender, getPalette } from './palettes'
import { SceneFade, type SlotName } from './SceneManager'
import { getSceneContract, resolveSceneMode } from '../scenes'
import {
  NEUTRAL,
  SCENE_PARAM_KEYS,
  isParamLive,
  resolveMode,
  resolveSteeredParams,
  steps,
  type ResolvedSceneParams,
  type SceneParamKey,
} from '../scenes/contract'
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
   * This scene's own Scene Contract dials — all seven, always present, 0..1.
   *
   * The scene's authored defaults with the user's (or the director's) stored
   * positions applied. Expand them with `drastic()` for a magnitude, `bipolar()`
   * for a signed offset, `steps()` for a discrete count; 0.5 is neutral for all
   * three, so a parameter the scene never declared reads as "no change".
   *
   * Not to be confused with {@link params}: that is the GLOBAL response layer
   * (multipliers around 1, same for every scene), this is per-scene art
   * direction (normalised 0..1). Both apply. See scenes/contract.ts.
   *
   * Mutated in place each frame — read it, do not retain it.
   */
  p: ResolvedSceneParams

  /**
   * This scene's active mode, or undefined if it declares none.
   *
   * A mode is a genuinely different picture inside one scene, and it may change
   * what the parameters mean — which is why a scene that has modes must branch
   * on this rather than treating `p` as mode-independent.
   */
  mode: string | undefined

  /**
   * The shared camera, **read-only** for scenes — CameraDirector owns its
   * transform. Fullscreen-quad raymarch scenes need it to build their own rays;
   * without it they would ignore the director entirely and be the one scene
   * type the camera modes could not drive.
   */
  camera: THREE.Camera

  /**
   * Which composition slot this instance is rendering in.
   *
   * A scene that wants to behave differently as a background than as the
   * subject branches on this — fewer particles, lower iteration counts, simpler
   * geometry. Declaring `roleScalable: true` in metadata tells the composition
   * budget that the scene actually does so; see slotBudget.ts.
   */
  role: SlotName

  /**
   * This slot's gain alone (0..1.5), WITHOUT the crossfade folded in.
   *
   * `vis` already includes it, so this is not for scaling output — it is how a
   * scene distinguishes "I am dim because I am mid-transition" from "I am dim
   * because I am the background". Only the second is a reason to change what it
   * draws rather than how brightly.
   */
  roleGain: number

  /**
   * 0→1 across an effect's lifetime; always 0 in every other slot.
   *
   * An effect scene **must reach visual zero by 1** — SceneManager retires it
   * there and does not fade it out for you.
   */
  slotProgress: number

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
    p: neutralParams(),
    mode: undefined,
    role: fade.role,
    roleGain: fade.gain,
    slotProgress: fade.progress,
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
    // Slot identity is mutated on the same object each frame, so an instance
    // that changes slot (or an effect advancing through its lifetime) is seen
    // without re-running the scene's React render.
    c.role = fade.role
    c.roleGain = fade.gain
    c.slotProgress = fade.progress

    // Scene Contract dials, resolved per frame against THIS instance's scene.
    //
    // Per frame rather than on React render because a dial move — a panel drag,
    // a MIDI CC, the director's steer — must reach the shader without
    // remounting the scene, exactly like the slot view above.
    // `resolveSteeredParams` writes into the existing object, so this allocates
    // nothing.
    //
    // Three layers, lowest first: the scene's authored default, the director's
    // steer, the user's own dial. The user wins any key they have touched; see
    // resolveSteeredParams.
    //
    // The user layer is read off the store rather than passed down as a prop, so
    // an instance in the accent slot and the same scene in the primary slot
    // share one set of dials — which is what makes a preset describe "this
    // scene's look" rather than "this slot's look".
    const contract = fade.sceneId ? getSceneContract(fade.sceneId) : undefined
    if (contract) {
      const store = useStore.getState()
      c.mode = resolveSceneMode(fade.sceneId, store.sceneModes[fade.sceneId])
      resolveSteeredParams(
        contract,
        c.mode,
        performanceState.sceneParams,
        store.sceneParams[fade.sceneId],
        c.p,
      )
    } else if (c.mode !== undefined) {
      // A scene with no contract reads neutral for all seven. Only reset when
      // it is not already neutral — the common case is a no-op.
      c.mode = undefined
      for (const k of SCENE_PARAM_KEYS) c.p[k] = NEUTRAL
    }

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

    if (!sceneCpu.on) {
      callback(c)
      return
    }
    const t0 = performance.now()
    callback(c)
    sceneCpu.ms += performance.now() - t0
  })
}

/**
 * How long the mounted scenes spent in their own per-frame callbacks.
 *
 * ## Why this exists
 *
 * `/bench`'s CPU column is `delta * 1000` — the whole frame's wall clock,
 * including the vsync wait and any back-pressure from a GPU that has not
 * finished the previous frame. It cannot tell "this scene's JavaScript is slow"
 * from "this frame is slow for reasons that have nothing to do with JavaScript",
 * and reading it as the former produced a confidently wrong diagnosis: F87
 * concluded `ribbons` burns 68 ms of JS per frame, when `ribbons` builds its
 * geometry once (3,960 vertices) and its per-frame loop is about 1,300
 * iterations. Whatever costs 68 ms there, it is not this.
 *
 * Accumulated across every mounted scene rather than per scene, because that is
 * what the frame actually pays and the bench measures one scene at a time
 * anyway. Read and reset once per frame by the caller.
 *
 * **Off by default.** Two `performance.now()` calls per scene per frame is
 * nothing measurable, but a profiler that is always running is a profiler
 * nobody trusts — and this must never be the reason a frame is slow.
 */
export const sceneCpu = {
  on: false,
  ms: 0,
}

/** Read the accumulated scene time and start the next frame's tally at zero. */
export function takeSceneCpu(): number {
  const ms = sceneCpu.ms
  sceneCpu.ms = 0
  return ms
}

/**
 * One Scene Contract dial, read REACTIVELY — the scene re-renders when it moves.
 *
 * `ctx.p` is the right way to read a dial that feeds a uniform: it costs nothing
 * and updates every frame. It is the wrong way to read one that decides
 * STRUCTURE — a geometry's subdivision level, a buffer's length, how many
 * meshes exist — because those are built in `useMemo` during render, which
 * `ctx.p` never triggers.
 *
 * Prefer {@link useSceneParamSteps} for exactly that case: a continuous value
 * here re-renders on every pixel of a slider drag, and rebuilding a geometry
 * 60 times a second is how a dial becomes a stutter.
 */
export function useSceneParam(key: SceneParamKey): number {
  const sceneId = useContext(SceneFade).sceneId
  return useStore((s) => {
    const contract = sceneId ? getSceneContract(sceneId) : undefined
    if (!contract) return NEUTRAL
    const declared = contract.params[key]
    if (declared === undefined) return NEUTRAL
    const mode = resolveMode(contract, s.sceneModes[sceneId])
    if (!isParamLive(contract, mode, key)) return NEUTRAL
    const o = s.sceneParams[sceneId]?.[key]
    return typeof o === 'number' && isFinite(o) ? o : declared
  })
}

/**
 * One Scene Contract dial as an integer in `min..max`, read reactively.
 *
 * The structural counterpart to {@link useSceneParam}: the value changes only
 * when the dial crosses a bucket boundary, so a full slider sweep across a
 * 3-step range rebuilds the geometry twice rather than a few hundred times.
 * Zustand compares the selector's result, so the intervening renders never
 * happen at all.
 */
export function useSceneParamSteps(key: SceneParamKey, min: number, max: number): number {
  const raw = useSceneParam(key)
  return steps(raw, min, max)
}

/**
 * This scene's active mode, read reactively.
 *
 * Modes almost always decide structure — a different mode is a different
 * picture, not a different number — so this is the reactive read rather than
 * `ctx.mode`. Returns undefined for a scene that declares no modes.
 */
export function useSceneMode(): string | undefined {
  const sceneId = useContext(SceneFade).sceneId
  return useStore((s) => resolveSceneMode(sceneId, s.sceneModes[sceneId]))
}

function neutralParams(): ResolvedSceneParams {
  const out = {} as ResolvedSceneParams
  for (const k of SCENE_PARAM_KEYS) out[k] = NEUTRAL
  return out
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

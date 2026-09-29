import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { bandClocks } from './bandClocks'
import { beatOscillators } from './beatOscillators'
import { FRAME_RECT_CUBIC_GLSL, FRAME_RECT_GLSL, blitCubicFor } from './frameRect'
import { FULLSCREEN_VERT } from './glsl'
import { createLilimState, updateLilimState, type LilimAudioState } from './lilimState'
import { getNoiseLUT, NOISE_LUT_SIZE } from './noiseLUT'
import type { PaletteBlender } from './palettes'
import { quality } from './quality'
import { renderScale } from './renderScale'
import { useSceneFrame, type SceneFrame } from './sceneFrame'
import { resolveFactoryDials, useSceneParams, type ResolvedSceneParams } from './sceneParams'
import { resourceCache } from './streaming/resourceCache'
import { prewarmShaders } from './streaming/shaderPrewarm'
import { useViewportResolution, writeResolution } from './viewportResolution'

/**
 * GLSL the factory injects ahead of every scene's fragment source.
 *
 * **Do not redeclare any of these in a scene's shader** — GLSL rejects a
 * duplicate declaration, so a scene that copies its own `uniform float uFade;`
 * across from lilim will fail to compile. Deleting those lines is the one edit
 * every ported shader needs.
 *
 * `uMid`/`uAccent`/`uGlow`/`uShadow`/`uBg` are bound to the live palette
 * colours, so a scene reads them and is recoloured globally without touching
 * anything.
 */
export const SHADER_SCENE_PRELUDE = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  /** Render-buffer resolution in pixels — NOT the canvas, when a pixelBudget is set. */
  uniform vec2 uRes;
  /** Width / height of the render buffer. */
  uniform float uAspect;
  /** Output multiplier: crossfade x slot gain x mood intensity. Scenes MUST honour it. */
  uniform float uFade;
  /** Seconds since this scene mounted, unscaled by the speed parameter. */
  uniform float uTime;
  /** Index into the scene's declared \`modes\` list. */
  uniform int uMode;

  /** The five palette slots, darkest to lightest. */
  uniform vec3 uBg;
  uniform vec3 uShadow;
  uniform vec3 uMid;
  uniform vec3 uAccent;
  uniform vec3 uGlow;

  /**
   * Decaying 0..1 envelope per drum (audit c14) — see
   * audio/PercussionDetector.ts. A shader reads these directly rather than a
   * scene having to wire its own copy of \`ctx.f.percussion.kick.env\` into a
   * custom uniform every time it wants a hit to reach the GPU.
   */
  uniform float uKick;
  uniform float uSnare;
  uniform float uHihat;

  /**
   * Per-band clocks, in seconds (audit c14) — advance while that band is
   * loud, hold still while it is not. See engine/bandClocks.ts for why this
   * is the cheapest substitution available for "make an animation read as
   * audio-reactive": swap \`uTime\` for one of these in an existing rotation
   * or drift term and it inherits the music's own rhythm of motion and
   * stillness for free, at the SAME speed \`uTime\` already ran whenever that
   * band is at full level.
   */
  uniform float uBassClock;
  uniform float uMidClock;
  uniform float uHighClock;

  /**
   * Tempo-locked sine oscillators, -1..1 (audit c14) — see
   * engine/beatOscillators.ts. \`uBeatSin\` completes one cycle per beat,
   * \`uBeatSin2\` per two beats, \`uBeatSin4\` per bar. A scene can be IN TIME
   * with the music without running its own beat detection.
   */
  uniform float uBeatSin;
  uniform float uBeatSin2;
  uniform float uBeatSin4;

  /**
   * Shared hash-lookup texture (see engine/noiseLUT.ts) — a precomputed,
   * well-distributed random value per cell, available to every scene with no
   * per-scene setup. Call \`hashLUT(vec3)\` / \`hashLUT2(vec2)\` instead of
   * writing another inline \`fract\`/\`dot\`/\`fract\` hash chain: one texture
   * fetch against a small, cache-resident table is cheaper than the same ALU
   * work repeated per pixel, per iteration, in a raymarcher's shading loop.
   * NOT a bit-identical replacement for any scene's previous hash formula —
   * see noiseLUT.ts's own header for why that trade is the right one here.
   */
  uniform sampler2D uNoiseLUT;
  const float NOISE_LUT_TEXELS = ${NOISE_LUT_SIZE.toFixed(1)};

  float hashLUT2(vec2 p) {
    vec2 ip = floor(p);
    vec2 uv = (mod(ip, NOISE_LUT_TEXELS) + 0.5) / NOISE_LUT_TEXELS;
    return texture2D(uNoiseLUT, uv).r;
  }
  float hashLUT(vec3 p) {
    vec3 ip = floor(p);
    return hashLUT2(ip.xy + ip.z * vec2(37.0, 71.0));
  }
`

/** What a shader scene's per-frame callback receives. */
export interface ShaderSceneContext<S = void> {
  /** The material's uniforms, for writing scene-specific values. */
  u: Record<string, THREE.IUniform>
  /** Audio in the lilim vocabulary — `s.mids`, `s.onKick`, and the rest. */
  s: LilimAudioState
  /**
   * This scene's resolved parameters. Apply `drastic()` to `P.speed` yourself.
   *
   * `P.speed` ALREADY includes the global speed — the user's Speed dial x the mood's speed x the song's tempo
   * rate (`getEffectiveParams().speed`), folded in as an exact multiplier on `drastic(P.speed)` — so a scene
   * must NOT multiply `params.speed` or the tempo in again. The other dials (`complexity`, `density`, `fill`,
   * `contrast`) carry the director's mood steer, with the user's own dial winning where set. This is a
   * per-instance copy: writing to it is safe but pointless (it is rebuilt every frame).
   */
  P: Readonly<ResolvedSceneParams>
  /** The live five-slot palette, already bound to the standard uniforms. */
  pal: PaletteBlender
  /** Seconds since the previous frame. */
  dt: number
  /** Seconds since mount, unscaled. */
  t: number
  /**
   * This instance's own mutable state, from {@link ShaderSceneSpec.state}.
   *
   * Accumulators — a drifting phase, a decaying shockwave — belong here, not in
   * a module-level `let`. A scene can be mounted more than once at the same
   * time (as a layer while it is also the outgoing half of a crossfade, or in
   * two slots at once), and module state would have both instances advancing
   * one shared phase at double rate.
   */
  st: S
  /** The full engine context, for anything the above does not cover. */
  ctx: SceneFrame
  /**
   * The renderer, for a scene that runs its own offscreen passes before the
   * factory draws its fragment shader — a multi-pass simulation (`inkfluid`'s
   * fluid solver) that {@link ShaderSceneSpec.sim}'s single ping-pong buffer
   * cannot express. Restore the previous render target when done.
   */
  gl: THREE.WebGLRenderer
}

export interface ShaderSceneSpec<S = void> {
  /**
   * The scene's registry id. Used to resolve its parameters, so it **must**
   * match the `id` in `SCENES` or the scene silently runs on defaults.
   */
  id: string
  /** Fragment shader body. {@link SHADER_SCENE_PRELUDE} is prepended. */
  frag: string
  /** GLSL inserted between the prelude and `frag` — noise libraries and helpers. */
  include?: string
  /**
   * Scene-specific uniforms, created once. Must not collide with the prelude's.
   * A factory so each mounted instance gets its own objects — two instances
   * sharing a `Vector2` would fight over it across slots.
   */
  uniforms?: () => Record<string, THREE.IUniform>
  /**
   * Per-instance mutable state — phase accumulators and decay envelopes.
   * Created once per mounted instance and handed back as `st`.
   */
  state?: () => S
  /** Write uniforms from audio, parameters and palette. Called once per frame. */
  update: (c: ShaderSceneContext<S>) => void
  /**
   * True for a scene whose motion is already locked to the beat grid (it advances by `bpm`/beats-per-second
   * itself). The factory folds the global speed (user dial x mood x TEMPO, see {@link ShaderSceneContext.P}) into
   * every other scene's `P.speed`; a tempo-locked one gets NO fold, because any extra multiplier on beat-locked
   * motion pulls it off the beat.
   */
  tempoLocked?: boolean
  /**
   * How the scene composites.
   *
   * Narrower in effect than it looks, and worth knowing why: `SceneManager`
   * wraps every mounted scene in a `BlendedLayer`, which traverses the subtree
   * for 30 frames after mount and **overwrites** every material's blending with
   * the slot's user-facing blend mode (`layerFx[role].blend`, or a forced `add`
   * for the primary and effect slots). So for the on-screen material this is
   * only the value used before that pass runs.
   *
   * Where it genuinely decides something is the **offscreen** material on the
   * budgeted path: that one lives inside a private scene graph that
   * `BlendedLayer` never reaches, so it keeps whatever is declared here.
   */
  blending?: THREE.Blending
  /**
   * Target internal resolution in **megapixels**, rendered offscreen and
   * upscaled.
   *
   * This is lilim's engine-owned quality dial, and it is deliberately not a
   * knob the scene reads. A scene that politely consults `quality.knobs` can
   * ignore it — four in this roster do — but it cannot ignore a resolution it
   * never chose. Declare the budget; the engine solves the scale.
   *
   * Omit for a scene cheap enough to run at full display resolution: the
   * offscreen path costs an extra fullscreen blit every frame, which is not
   * worth paying to render at scale 1.0.
   *
   * A function is read every frame instead of once, for a scene whose own
   * cost is too tier-sensitive for one fixed number — see `MazeFlightScene`,
   * which trades resolution for nesting depth at low tiers rather than
   * flattening its fractal structure outright (F128). The render target only
   * actually reallocates when the solved size changes, so a function that
   * returns the same value every frame costs nothing extra over a plain
   * number.
   */
  pixelBudget?: number | (() => number)
  /**
   * An optional ping-ponged simulation pass, run once per frame BEFORE the
   * scene's own {@link update} — a history buffer the scene can read back
   * next frame (`tPrev`, auto-bound) to build something that evolves rather
   * than being recomputed fresh from scratch every frame (a flow field, an
   * advected image, a reaction-diffusion pattern).
   *
   * Fully self-contained GLSL, unlike {@link frag}: no
   * {@link SHADER_SCENE_PRELUDE} is prepended (the sim pass has no fade,
   * mode, or palette — it is plumbing the main shader consumes, not
   * something drawn on its own), so `frag` here must declare every uniform
   * it uses, including `tPrev` itself.
   *
   * The freshly-rendered result is written into `tSim` on the scene's MAIN
   * material — declare `tSim: { value: null }` alongside the scene's own
   * uniforms (same shape `tSrc` already has) to read it in {@link frag}.
   *
   * Costs nothing for the far more common scene that never sets this: every
   * cache/allocation below is created lazily, only reached when `sim` is
   * present.
   */
  sim?: {
    /** Sim fragment shader. Self-contained — see this field's own doc. */
    frag: string
    /** Sim-specific uniforms beyond the auto-injected `tPrev`. */
    uniforms?: () => Record<string, THREE.IUniform>
    /**
     * Write the sim material's uniforms. Same shape as the main
     * {@link update}, but `u` is the SIM material's uniforms, not the main
     * one's — `mainU` is the main one, for a scene whose sim shader needs
     * to read something the main `update()` already derived (an aspect
     * ratio, a source texture) without recomputing it twice.
     *
     * Return `false` to skip this frame's render entirely — cheaper than
     * always paying for a pass nothing is currently sampling `tSim` to see
     * (a scene with several modes and only some of them sim-driven). `tSim`
     * simply keeps whatever it last held; uniforms are still written either
     * way, so a mode switch back in doesn't reappear on stale settings.
     */
    update: (c: ShaderSceneContext<S> & { mainU: Record<string, THREE.IUniform> }) => void | boolean
  }
}

/**
 * Lower bound on the solved render scale.
 *
 * Below about 0.4 the upscale stops reading as "soft" and starts reading as
 * "broken", so a scene with an unreachably small budget renders blurry rather
 * than unrecognisable.
 */
const MIN_RENDER_SCALE = 0.4

/**
 * Frames a scene renders unconditionally after mounting, before the
 * contributes-nothing guard applies.
 *
 * Matches `WARM_FRAMES` in SceneManager, which is what the warm gate counts
 * before declaring a scene ready. One more than that, so the guard can never
 * engage on the frame the gate is still waiting for.
 */
const WARM_RENDERS = 5

/** Solve lilim's `scale = sqrt(budget / fullMP)`, clamped, for a frame of `width x height` pixels. */
export function solveScale(pixelBudget: number, width: number, height: number): number {
  const fullMP = (width * height) / 1e6
  if (!(fullMP > 0)) return 1
  return Math.min(1, Math.max(MIN_RENDER_SCALE, Math.sqrt(pixelBudget / fullMP)))
}

/**
 * One side of a budgeted scene's offscreen capacity: the active rect its budget
 * solves to on the frame at scale 1 (`full` pixels, `scaleAtFull` =
 * `solveScale(budget, fullW, fullH)`), plus slack, never past the frame.
 *
 * The largest rect a budget can ask for on a display is the one at scale 1:
 * below the budget's own clamp the rect is `sqrt(budget * aspect)` whatever the
 * frame (the frame's size cancels), and where it is clamped the rect is the
 * frame, which only shrinks with the scale. The slack covers the one thing
 * that does not cancel exactly — each scaled frame is floored to integers, so
 * its aspect, and with it the rect, wobbles by a pixel or two — so a scale
 * step never lands one pixel past the allocation and reallocates for it.
 */
export function budgetedCapacity(full: number, scaleAtFull: number): number {
  return Math.min(full, Math.ceil(full * scaleAtFull * 1.02) + 2)
}

/** A scene's compiled material + its (trivial, shared-shape) geometry. */
interface CachedSceneMaterial {
  material: THREE.ShaderMaterial
  geometry: THREE.PlaneGeometry
}

/**
 * One compiled `ShaderMaterial` (+ geometry) per (renderer, scene id), reused
 * across every mount rather than rebuilt and disposed each time (F144).
 *
 * `useDispose` used to call `material.dispose()` on every unmount — correct
 * per its own doc comment (avoid leaking GPU resources), but disposal fires
 * three's `onMaterialDispose` listener, which calls
 * `WebGLPrograms.releaseProgram()`. That decrements the compiled program's
 * refcount, and since a scene's material is normally the program's only
 * user, the count hits zero and three calls `program.destroy()` — actually
 * deleting the compiled `WebGLProgram`. The NEXT mount builds a new
 * `ShaderMaterial` with byte-identical shader source, but there is nothing
 * left in the cache for `acquireProgram` to match, so it compiles from
 * scratch: a genuine `compileShader`/`linkProgram` pair, every single time a
 * scene is switched away from and back to, regardless of anything the
 * warm-mount system does — that system can only front-load a compile that's
 * about to happen anyway, it can't stop a live one from being deleted and
 * repeated on every switch.
 *
 * For a cheap shader this was invisible (a few ms, easily lost in the warm
 * window). For maze's raymarching shader it is the ~2s stall F137 first
 * measured and F144 traced past every render-target/resolution theory back
 * to this: `git log` shows the shader's own source unchanged since F137's
 * partial mitigation, yet the full-magnitude stall kept recurring — because
 * nothing was ever caching the compiled PROGRAM itself, only (post-F138) the
 * render target it draws into.
 *
 * Same trade F138 already made for render targets applies here: one
 * resident material per scene type for the renderer's lifetime, invalidated
 * naturally by a context-loss remount (new `WebGLRenderer`, new `WeakMap`
 * entry) rather than disposed by hand. Reusing uniform VALUES across mounts
 * is safe — every one here is either overwritten every frame in `update()`
 * or explicitly re-bound on mount via `bound` below, which is a per-mount
 * `useRef` and stays correct regardless of whether the material itself is
 * fresh or cached.
 */
const sceneMaterialCache = new WeakMap<THREE.WebGLRenderer, Map<string, CachedSceneMaterial>>()

function getSceneMaterial<S>(gl: THREE.WebGLRenderer, spec: ShaderSceneSpec<S>): CachedSceneMaterial {
  let byId = sceneMaterialCache.get(gl)
  if (!byId) {
    byId = new Map()
    sceneMaterialCache.set(gl, byId)
  }
  const existing = byId.get(spec.id)
  if (existing) return existing

  const material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: SHADER_SCENE_PRELUDE + (spec.include ?? '') + spec.frag,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: spec.blending ?? THREE.AdditiveBlending,
    uniforms: {
      uRes: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: 1 },
      uFade: { value: 0 },
      uTime: { value: 0 },
      uMode: { value: 0 },
      // Left null until the first frame, where they are pointed at the
      // blender's live Colors. They cannot be bound here: the blender is
      // owned by useSceneFrame and only reachable through its context.
      uBg: { value: new THREE.Color() },
      uShadow: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uKick: { value: 0 },
      uSnare: { value: 0 },
      uHihat: { value: 0 },
      uBassClock: { value: 0 },
      uMidClock: { value: 0 },
      uHighClock: { value: 0 },
      uBeatSin: { value: 0 },
      uBeatSin2: { value: 0 },
      uBeatSin4: { value: 0 },
      // Static for the renderer's lifetime (see noiseLUT.ts) — bound once
      // here, unlike the per-frame values above, since nothing about it
      // changes frame to frame.
      uNoiseLUT: { value: getNoiseLUT(gl) },
      ...spec.uniforms?.(),
    },
  })
  const geometry = new THREE.PlaneGeometry(2, 2)
  const created: CachedSceneMaterial = { material, geometry }
  byId.set(spec.id, created)
  return created
}

/** Shared setup: material, geometry, audio state, parameters, frame driver. */
function useShaderCore<S>(spec: ShaderSceneSpec<S>) {
  const gl = useThree((s) => s.gl)
  const Pdials = useSceneParams(spec.id)
  // This instance's own copy of the dials, rebuilt every frame with the global speed folded into `speed`.
  // `useSceneParams` returns ONE object per scene id, shared by every instance of it (and rewritten by a store
  // subscription), so the fold must never be written into it.
  const P = useMemo(() => ({ ...Pdials }) as ResolvedSceneParams, [Pdials])

  // Cached across mounts (see getSceneMaterial) — no useDispose for these two;
  // they outlive any one mount by design.
  const { material, geometry } = useMemo(() => getSceneMaterial(gl, spec), [gl, spec])

  const audio = useMemo(() => createLilimState(), [])
  // `as S` covers the `S = void` default, where a scene declares no state and
  // never reads `st`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sceneState = useMemo(() => (spec.state ? spec.state() : (undefined as S)), [])
  const elapsed = useRef(0)
  const bound = useRef(false)
  const rendered = useRef(0)

  /**
   * Run the scene's own update. Returns false when this instance contributes
   * nothing, so the caller can skip an offscreen render — `node.visible = false`
   * does not stop a manual `gl.render()`, and a fading-out scene would otherwise
   * pay full price while drawing nothing.
   *
   * The first {@link WARM_RENDERS} frames are exempt, and that exemption is
   * load-bearing on the budgeted path. A warming entry sits at `vis === 0` by
   * construction (`dir === 0`, so its fade never advances), so a plain
   * vis-guard would skip the offscreen pass for the entire warm window — and
   * the offscreen pass is where the expensive shader lives. The scene would
   * reach its downbeat commit with that program still uncompiled and the stall
   * would land on the beat, which is the exact failure the warm gate exists to
   * prevent. Rendering a couple of black frames instead is cheap insurance.
   */
  const runFrame = (ctx: SceneFrame): boolean => {
    const u = material.uniforms
    if (!bound.current) {
      // Point the colour uniforms at the blender's own Colors. They are mutated
      // in place from here on, so the palette morph reaches the shader with no
      // per-frame copying — lilim's trick, and the reason its palette can
      // recolour a scene mid-morph.
      u.uBg.value = ctx.col.bg
      u.uShadow.value = ctx.col.shadow
      u.uMid.value = ctx.col.mid
      u.uAccent.value = ctx.col.accent
      u.uGlow.value = ctx.col.glow
      bound.current = true
    }

    u.uFade.value = ctx.vis
    // Refresh the private copy of the dials. Takes them from `ctx.p` (declared default -> the director's mood
    // steer -> the user's own dial), NOT from `useSceneParams`, which has no steering layer; then folds the global
    // speed into `speed` as an exact multiplier on `drastic()` (tempoSpeed.ts), so every scene that already does
    // `phase += dt * ... * drastic(P.speed)` picks up the user's Speed dial, the mood's speed and the song's tempo
    // with no per-scene edit. A tempo-locked scene gets everything but the tempo (it already follows the beat grid).
    resolveFactoryDials(P, Pdials, ctx.p, ctx.params.speed, spec.tempoLocked === true)
    u.uMode.value = P.modeIndex

    if (rendered.current < WARM_RENDERS) rendered.current++
    else if (ctx.vis <= 0.001) return false

    elapsed.current += ctx.dt
    u.uTime.value = elapsed.current

    // Audio-reactive prelude uniforms (audit c14) — see SHADER_SCENE_PRELUDE's
    // own doc on each. Read directly off ctx.f / the band-clock singleton
    // rather than through the lilim adapter below: these are meant to be
    // reachable by any scene's shader with no per-scene JS wiring, which is
    // exactly the gap updateLilimState's JS-side `s.kick`/`s.onKick` etc.
    // does not close (a scene still has to manually copy those into its own
    // custom uniform to get them onto the GPU).
    u.uKick.value = ctx.f.percussion.kick.env
    u.uSnare.value = ctx.f.percussion.snare.env
    u.uHihat.value = ctx.f.percussion.hihat.env
    u.uBassClock.value = bandClocks.bass
    u.uMidClock.value = bandClocks.mid
    u.uHighClock.value = bandClocks.high
    const beats = beatOscillators(ctx.f.beatIndex, ctx.f.beatProgress)
    u.uBeatSin.value = beats.sin1
    u.uBeatSin2.value = beats.sin2
    u.uBeatSin4.value = beats.sin4

    updateLilimState(audio, ctx)

    // Sim step, before the scene's own update: so tSim already holds THIS
    // frame's fresh result by the time the caller renders the main shader
    // that samples it. Sized off lilim's own choice for the same job
    // (`getDrawingBufferSize().multiplyScalar(0.6)`) — a simulation buffer
    // does not need to match display resolution 1:1, and this scene's own
    // main offscreen budget (if any) is a separate, later-solved number
    // `runFrame` has no access to here.
    //
    // Taken of the frame at scale 1 (`renderScale.fullW/H`), not the scaled
    // one: the sim renders its whole target and keeps its state in it, so a
    // size that followed the scale would grow on every new session-high step
    // (F272 stage 5 made those instant), and a grow disposes both ping-pong
    // targets — a reallocation stall mid-show, and the simulation restarting
    // from black. The grow-only buffer reached this size at the first frame
    // drawn at scale 1 anyway; only a display change moves it now.
    if (spec.sim) {
      const simW = Math.max(1, Math.floor(renderScale.fullW * 0.6))
      const simH = Math.max(1, Math.floor(renderScale.fullH * 0.6))
      const rt = getSimRT(gl, spec, spec.sim, simW, simH)
      const prev = rt.flip ? rt.a : rt.b
      const next = rt.flip ? rt.b : rt.a
      rt.material.uniforms.tPrev.value = prev.texture
      const shouldRender = spec.sim.update({
        u: rt.material.uniforms,
        mainU: u,
        s: audio,
        P,
        pal: ctx.col,
        dt: ctx.dt,
        t: elapsed.current,
        st: sceneState,
        ctx,
        gl,
      })
      if (shouldRender !== false) {
        const prevTarget = gl.getRenderTarget()
        gl.setRenderTarget(next)
        gl.render(rt.scene, rt.camera)
        gl.setRenderTarget(prevTarget)
        rt.flip = !rt.flip
        if (u.tSim) u.tSim.value = next.texture
      }
    }

    spec.update({
      u,
      s: audio,
      P,
      pal: ctx.col,
      dt: ctx.dt,
      t: elapsed.current,
      st: sceneState,
      ctx,
      gl,
    })
    return true
  }

  return { material, geometry, runFrame }
}

/** Full-resolution path: one fullscreen quad straight into the shared graph. */
/**
 * One frame of a direct-path scene: the main frame's size onto the uniforms,
 * THEN the scene's update.
 *
 * The per-draw write (viewportResolution.ts) leaves the LAST draw's size
 * behind, which after a wipe capture is the capture's. `update()` reads these
 * on the JS side (`inkfluid` sizes its tank from `uAspect` and would reseed it
 * on a capture's aspect), so it must see the main frame's every frame. The
 * order is the whole point, which is why this is a function the tests call.
 */
export function runDirectSceneFrame<C>(
  material: THREE.ShaderMaterial,
  runFrame: (ctx: C) => unknown,
  ctx: C,
): void {
  writeResolution(material, renderScale.internalW, renderScale.internalH)
  runFrame(ctx)
}

function createDirectScene<S>(spec: ShaderSceneSpec<S>): ComponentType {
  function ShaderScene() {
    const { material, geometry, runFrame } = useShaderCore(spec)
    // No useDispose(material, geometry) — cached across mounts, see getSceneMaterial.

    // `uRes`/`uAspect` are the size of the target each draw lands in, written
    // per draw (viewportResolution.ts): the composer's buffer, or a wipe's
    // capture target, which a canvas-sized `uRes` used to crop.
    const mesh = useRef<THREE.Mesh>(null)
    useViewportResolution(mesh, material)

    useSceneFrame((ctx) => {
      runDirectSceneFrame(material, runFrame, ctx)
    })

    return (
      <mesh ref={mesh} frustumCulled={false}>
        <primitive object={geometry} attach="geometry" />
        <primitive object={material} attach="material" />
      </mesh>
    )
  }
  ShaderScene.displayName = `ShaderScene(${spec.id})`
  return ShaderScene
}

/**
 * Blit the offscreen buffer, honouring the scene's blending choice.
 *
 * The source texture is allocated at the FULL canvas size (see `BudgetedRT`
 * below) but only the bottom-left `uSrcSize` texels hold this frame's actual
 * render — the rest is stale/uninitialised from whatever the target held
 * before. Every tap is clamped to texel centres inside that rect
 * (frameRect.ts's `rectTexel`, the same clamp every post pass uses since F272
 * stage 5), so filtering can never pull the stale region in.
 *
 * ## Alignment (F272)
 *
 * Sampling happens in texel space, `vUv * uSrcSize`, so at 1:1 each output
 * pixel lands exactly on a texel centre and the blit is an exact copy. The
 * previous mapping, `vUv * (w/fullW - 0.5/fullW)`, drifted by up to half a
 * texel across the frame, so every budgeted scene drawn at 1:1 was a 50/50
 * blend of two texels — soft — across its upper-right half.
 *
 * ## Upscale filter (F272)
 *
 * `uCubic` 0 is bilinear. Above 0 it is the cubic-convolution kernel with that
 * tension (0.5 = Catmull-Rom) in its 5-tap form (`rectCubic`, shared with
 * GradePass's upscale): bilinear taps placed so the
 * hardware does most of the weighting, corners dropped and renormalised. The
 * result is clamped to the taps' own range, so a bright line on black cannot
 * ring into a dark halo or go negative — this roster is bright lines on black,
 * and 16 of the 17 budgeted displays write straight into the frame. Linear in
 * the input, so it stays exact under `uFade`. Used only while the scene is
 * actually upscaled and the machine is on a top tier: measured on the M1 at
 * 2560x1600, a bilinear blit costs ~0.6 ms and this ~1.3 ms.
 */
export const DISPLAY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform vec2 uSrcSize;
  uniform vec2 uTexel;
  uniform float uCubic;
${FRAME_RECT_GLSL}${FRAME_RECT_CUBIC_GLSL}
  void main() {
    vec4 rect = vec4(uSrcSize, uTexel);
    vec2 pos = vUv * uSrcSize;
    if (uCubic <= 0.0) {
      gl_FragColor = texture2D(uScene, rectTexel(pos, rect));
      return;
    }
    gl_FragColor = rectCubic(uScene, pos, rect, uCubic);
  }
`

// The upscale policy and its constants live with the shared rect sampling
// (frameRect.ts) since GradePass uses them too; re-exported for the callers
// and tests that have always found them here.
export { BLIT_CUBIC_MAX_TIER, BLIT_CUBIC_TENSION, blitCubicFor } from './frameRect'

/** The GPU-side pieces a budgeted scene needs: real allocations, not just JS state. */
interface BudgetedRT {
  target: THREE.WebGLRenderTarget
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
  /** Lives in `scene`; its geometry/material get repointed on every mount. */
  mesh: THREE.Mesh
  displayMaterial: THREE.ShaderMaterial
}

/**
 * One `WebGLRenderTarget` (+ its offscreen scene/camera/blit material) per
 * (renderer, scene id), reused across every mount rather than rebuilt inside
 * a component-scoped `useMemo` (F138).
 *
 * A render target is a real GPU texture + framebuffer allocation, and unlike
 * a compiled shader program three has no cache for it — a second, identical
 * one costs the same as the first. A live session log showed exactly that: a
 * scene's SECOND mount in the same session froze the app for as long as its
 * first (259.8ms, then 264.7ms), which a mount-scoped `useMemo` explains and
 * a shader-compile-cache theory alone does not.
 *
 * Keyed by `gl` in a `WeakMap` rather than invalidated by hand: a WebGL
 * context loss remounts `SceneManager` under a brand new `WebGLRenderer`, so
 * the old renderer — and everything cached under it here — simply becomes
 * unreachable and is garbage collected. Skipping an explicit `.dispose()` on
 * that path costs nothing real: the lost context already invalidated the
 * underlying GPU resources before JS ever sees the loss event.
 *
 * Never explicitly evicted on the live path either: the budgeted scenes are a
 * fixed, small set (the roster's raymarch-heavy handful), so one resident
 * render target per scene type for the renderer's lifetime is the same
 * "pay once, keep it" trade `SceneManager` already makes for pinned effect
 * scenes.
 *
 * ## Sized once for the display, not for the current rect (F139/F143)
 *
 * `target.setSize()` is only ever called here for a real display change (or a
 * function budget first reaching a higher level this session) — rare events.
 * The quality governor's own resolution changes (a tier demote, a render-scale
 * step — dozens of times a minute) do NOT resize this target at all; they move
 * `target.viewport`/`target.scissor` instead, which
 * `WebGLRenderer.setRenderTarget()` reads directly with no texture/framebuffer
 * work. The capacity is the rect the budget solves to at scale 1, which bounds
 * the rect at every scale (`budgetedCapacity`, F272 stage 5).
 *
 * This replaces the previous behaviour, which called `setSize()` on
 * whatever budget the quality governor produced that frame. That used to be
 * safe because F138 didn't exist yet: every mount got a BRAND NEW target
 * already allocated at the right size, so nothing already resident on the
 * GPU ever actually changed dimensions. F138 (caching the target across
 * mounts, to stop a second mount from paying a fresh allocation) turned that
 * same call into a resize of an existing, previously-rendered-into target —
 * and a live-resized render target is a well-known GPU stall hazard
 * (texture/framebuffer teardown-and-recreate, with an implicit sync point on
 * some drivers/backends), confirmed here by two session logs showing a
 * single isolated frame over a SECOND long landing exactly on a maze
 * tier-demote, with instant recovery the very next frame — the signature of
 * a one-shot blocking call, not a sustained per-pixel cost. See F139/F143 in
 * `docs/ISSUES.md` for the full trace.
 */
const budgetedRTCache = new WeakMap<THREE.WebGLRenderer, Map<string, BudgetedRT>>()

function getBudgetedRT(gl: THREE.WebGLRenderer, id: string, blending: THREE.Blending): BudgetedRT {
  let byId = budgetedRTCache.get(gl)
  if (!byId) {
    byId = new Map()
    budgetedRTCache.set(gl, byId)
  }
  const existing = byId.get(id)
  if (existing) return existing

  const target = new THREE.WebGLRenderTarget(1, 1, {
    // Half-float, not 8-bit: these scenes composite additively and several
    // run values above 1.0 before the fade, which an 8-bit buffer clips.
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  // Linear filtering is what makes the upscale read as soft rather than
  // blocky — the whole premise of rendering below display resolution.
  target.texture.minFilter = THREE.LinearFilter
  target.texture.magFilter = THREE.LinearFilter
  const scene = new THREE.Scene()
  const mesh = new THREE.Mesh()
  scene.add(mesh)
  const displayMaterial = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: DISPLAY_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending,
    uniforms: {
      uScene: { value: null },
      uSrcSize: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uCubic: { value: 0 },
    },
  })
  const created: BudgetedRT = {
    target,
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    mesh,
    displayMaterial,
  }
  byId.set(id, created)
  return created
}

/** One scene's ping-pong simulation buffers, plus the tiny scene/camera that renders its sim shader. */
interface SimRT {
  a: THREE.WebGLRenderTarget
  b: THREE.WebGLRenderTarget
  /** true: `a` holds the last rendered frame (so it is `tPrev`, and `b` renders next). Flips every step. */
  flip: boolean
  material: THREE.ShaderMaterial
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
}

/**
 * Per (renderer, scene id), same caching shape as {@link getBudgetedRT} and
 * for the same reason — a `WebGLRenderTarget` is a real GPU allocation, and
 * a mount-scoped one would pay for it again on every scene switch.
 */
const simRTCache = new WeakMap<THREE.WebGLRenderer, Map<string, SimRT>>()

/**
 * Half-float, linear-filtered, no mipmaps/depth/stencil — the exact format
 * `FeedbackPass.ts`'s own history buffer already uses for the same job (a
 * texture resampled and rewritten every frame under repeated blending,
 * where an 8-bit target would band/clip).
 */
function makeSimTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.name = `sim:${width}x${height}`
  return target
}

function getSimRT<S>(
  gl: THREE.WebGLRenderer,
  spec: ShaderSceneSpec<S>,
  sim: NonNullable<ShaderSceneSpec<S>['sim']>,
  width: number,
  height: number,
): SimRT {
  let byId = simRTCache.get(gl)
  if (!byId) {
    byId = new Map()
    simRTCache.set(gl, byId)
  }
  const existing = byId.get(spec.id)
  if (existing) {
    // Grow only — same F147 trade `getBudgetedRT`'s own target already makes
    // and for the same reason: a live-resized render target is a real GPU
    // stall hazard. The size asked for follows the display, not the render
    // scale (see the caller), so this fires only when the display grows.
    if (width > existing.a.width || height > existing.a.height) {
      const w = Math.max(width, existing.a.width)
      const h = Math.max(height, existing.a.height)
      existing.a.dispose()
      existing.b.dispose()
      existing.a = makeSimTarget(w, h)
      existing.b = makeSimTarget(w, h)
      existing.flip = false
    }
    return existing
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: sim.frag,
    depthWrite: false,
    depthTest: false,
    uniforms: { tPrev: { value: null }, ...sim.uniforms?.() },
  })
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material))
  const created: SimRT = {
    a: makeSimTarget(width, height),
    b: makeSimTarget(width, height),
    flip: false,
    material,
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
  }
  byId.set(spec.id, created)
  return created
}

/** Budgeted path: render offscreen at the solved scale, then upscale. */
function createBudgetedScene<S>(
  spec: ShaderSceneSpec<S>,
  pixelBudget: number | (() => number),
): ComponentType {
  function ShaderScene() {
    const gl = useThree((s) => s.gl)
    const { material, geometry, runFrame } = useShaderCore(spec)

    const rt = useMemo(
      () => getBudgetedRT(gl, spec.id, spec.blending ?? THREE.AdditiveBlending),
      [gl],
    )
    const displayMaterial = rt.displayMaterial

    // `material`/`geometry` are cached per scene id too now (see
    // getSceneMaterial, F144), same as `rt` — this just keeps the offscreen
    // mesh pointed at the current pair; idempotent after the first mount of
    // a given scene id, since both sides are the same cached objects from
    // then on.
    useEffect(() => {
      rt.mesh.geometry = geometry
      rt.mesh.material = material
    }, [rt, geometry, material])

    // Nothing left for this component to dispose: `rt.*` (getBudgetedRT) and
    // `material`/`geometry` (getSceneMaterial) are both session-cached.

    // Tracks the last ACTIVE (budgeted) resolution this mount wrote, so the
    // uniform writes below — cheap individually, but there's no reason to
    // repeat them every frame — only happen when the solved size actually
    // changes. This is intentionally separate from `rt.target`'s own size:
    // the target is sized once for the display (see `getBudgetedRT`'s F139/
    // F143 doc comment) and essentially never changes, while this tracks the
    // viewport sub-rect the quality governor moves dozens of times a minute.
    // Tracks BOTH sizes the blit samples with — the active rect (`uSrcSize`)
    // and the allocation (`uTexel`) — not just the active one.
    //
    // Guarding on the active size alone was a real, visible bug: black bars
    // along the top and right with the picture squashed into the bottom-left.
    // The blit's mapping then was `uUvMax = active / full` (replaced by
    // `uSrcSize`/`uTexel` in F272, same dependency), and in the normal (unclamped) regime the
    // ACTIVE size is invariant under DPR — `solveScale` divides by the frame's
    // pixel count and the `w = floor(frameW * scale)` below multiplies it
    // straight back out, so `w` reduces to `floor(sqrt(budget * 1e6 * W/H))`,
    // a function of aspect and budget only. The grow check against
    // `frameW/H` does NOT cancel the DPR. So every time the governor climbed
    // the render scale, the target grew, `full` changed, `w`/`h` did not, this guard
    // stayed false, and `uUvMax` kept a ratio computed against the OLD,
    // smaller target — leaving the blit sampling past the rendered rect into
    // never-written texels. Permanent, too, for the fixed-budget scenes
    // (`malachite`/`nebula`/`dustfield`): their `w` only moves on a window
    // ASPECT change, so nothing ever corrected it. The function-budget
    // scenes (`maze`/`beats`/`travelling`/`web`) self-healed on their next
    // tier threshold crossing, which is why this looked intermittent.
    //
    // F147's grow-only rule is what made the two sizes able to diverge at
    // all — before it, `setSize` ran on every change and `full` tracked
    // `needed`, so this window barely existed. Keeping the ratio's own
    // inputs in the guard is the fix, not reverting that.
    const activeSize = useRef({ w: 0, h: 0, fullW: 0, fullH: 0 })

    // Solved every frame rather than in a resize-only effect, so a function
    // budget can react to the quality tier changing mid-scene — cheap, since
    // it's pure arithmetic with no GPU work unless the active size changed.
    useSceneFrame((ctx) => {
      const budget = typeof pixelBudget === 'function' ? pixelBudget() : pixelBudget
      // The frame this scene's display pass draws into (F272 stage 3): the
      // rendered sub-rect of the full-size composer buffers (stage 5).
      const frameW = renderScale.internalW
      const frameH = renderScale.internalH
      const scale = solveScale(budget, frameW, frameH)
      const w = Math.max(1, Math.floor(frameW * scale))
      const h = Math.max(1, Math.floor(frameH * scale))

      // Capacity follows the frame at SCALE 1, not the scaled frame (F272
      // stage 5). Sized from `frameW/H`, a target first mounted at a low scale
      // grew — a full reallocation, the stall described below — on the first
      // later climb, and stage 5 made climbs instant and frequent. The rect
      // the budget solves to on the full frame bounds every rect any scale
      // produces (see `budgetedCapacity`), so a scale step never grows it;
      // only a display change or a function budget first rising to its
      // higher level this session does. Not the whole frame: most budgets are
      // a fraction of it, and every budgeted scene keeps its target for the
      // session, so that would hold several frames' worth of RGBA16F for
      // pixels no scene draws.
      const fullW = renderScale.fullW
      const fullH = renderScale.fullH
      const scaleAtFull = solveScale(budget, fullW, fullH)
      const needW = Math.max(w, budgetedCapacity(fullW, scaleAtFull))
      const needH = Math.max(h, budgetedCapacity(fullH, scaleAtFull))

      // Real display change, or a higher budget than this target has held —
      // NOT a scale step. `setSize()` resets `target.viewport`/`.scissor` to
      // the full new size, which is why the active-viewport block below runs
      // unconditionally after this rather than being folded into the same
      // guard.
      //
      // GROWS only, never shrinks (F147). `RenderTarget.setSize()` — verified
      // directly in three's source — calls `.dispose()` whenever the size
      // actually changes, which is a real GPU framebuffer/texture teardown
      // and reallocation: the exact stall F139/F143 already measured at "a
      // single isolated frame over a second long." Before F146, a scene under
      // load got relief from the governor's free complexity-knob tier first,
      // and only paid this cost on a genuine, comparatively rare canvas/DPR
      // change. F146 removed that relief for maze specifically — DPR/
      // pixelBudget is now its only lever — so this reallocation started
      // firing on nearly every governor step instead, which is what the
      // window-resize-shaped symptom the user hit today actually was: not a
      // resize bug, this path reallocating every time DPR eased back down.
      // The target only ever needs to be big enough to hold the active
      // rect — that is already exactly what viewport/scissor/`uSrcSize` render
      // into and sample below — so once it has grown to a given size this
      // session there is no reason to ever shrink it back down again; doing
      // so only re-pays the stall the next time DPR climbs back up. Same
      // "pay once, keep it" trade F138/F144 already made for the cache these
      // targets and materials live in.
      if (needW > rt.target.width || needH > rt.target.height) {
        rt.target.setSize(Math.max(needW, rt.target.width), Math.max(needH, rt.target.height))
        // F16: this target deliberately never goes through resourceCache's
        // acquire/release lifecycle (see that method's own doc comment) —
        // but budgetLedger.ts exists specifically for targets like this one,
        // and it can't see a size nobody reports. HalfFloat RGBA, no mipmaps,
        // no depth/stencil buffer (see the type below) — 4 channels x 2
        // bytes each is the whole allocation. Only reported on an actual
        // grow, matching how rarely this now actually changes post-F147.
        resourceCache.reportExternalByteSize(
          `rt:${spec.id}`,
          rt.target.width * rt.target.height * 8,
        )
      }
      const allocW = rt.target.width
      const allocH = rt.target.height

      if (
        w !== activeSize.current.w ||
        h !== activeSize.current.h ||
        allocW !== activeSize.current.fullW ||
        allocH !== activeSize.current.fullH
      ) {
        activeSize.current.w = w
        activeSize.current.h = h
        activeSize.current.fullW = allocW
        activeSize.current.fullH = allocH
        // The shader's idea of resolution is the ACTIVE viewport's, not the
        // allocated target's — it drives ray setup and pixel-space maths, so
        // passing the full target size here would draw a differently-shaped
        // frame than the one actually being written into.
        material.uniforms.uRes.value.set(w, h)
        material.uniforms.uAspect.value = w / h
        // The blit samples in texel space inside the active rect and clamps
        // every tap to it — see DISPLAY_FRAG's alignment note (F272).
        displayMaterial.uniforms.uSrcSize.value.set(w, h)
        displayMaterial.uniforms.uTexel.value.set(1 / allocW, 1 / allocH)
      }
      // Bicubic only while the rect is genuinely upscaled and the live
      // resolution tier is a top one (F272). A uniform write, so read every
      // frame to follow the tier without its own change-guard.
      displayMaterial.uniforms.uCubic.value = blitCubicFor(w, frameW, quality.resolutionTier)
      // Cheap Vector4 writes, not a GPU resize — `setRenderTarget()` below
      // reads these directly (three's own dynamic-resolution mechanism).
      rt.target.viewport.set(0, 0, w, h)
      rt.target.scissor.set(0, 0, w, h)
      rt.target.scissorTest = true

      displayMaterial.uniforms.uScene.value = rt.target.texture
      if (!runFrame(ctx)) return
      const prev = gl.getRenderTarget()
      gl.setRenderTarget(rt.target)
      gl.render(rt.scene, rt.camera)
      gl.setRenderTarget(prev)
    })

    return (
      <mesh frustumCulled={false}>
        <primitive object={geometry} attach="geometry" />
        <primitive object={displayMaterial} attach="material" />
      </mesh>
    )
  }
  ShaderScene.displayName = `ShaderScene(${spec.id})`
  return ShaderScene
}

/**
 * Build a fullscreen-shader scene from a declaration.
 *
 * This is the lilim scene shape expressed inside this engine: a scene is a
 * fragment shader plus an `update` that maps audio, parameters and palette onto
 * uniforms — no React, no resource lifecycle, no resize plumbing, no fade
 * arithmetic. What a scene author writes is the art direction and nothing else.
 *
 * ```ts
 * export const InkScene = createShaderScene({
 *   id: 'ink',
 *   frag: FRAG,
 *   include: SNOISE_GLSL,
 *   uniforms: () => ({ uPhase: { value: 0 }, uWarp: { value: 1 } }),
 *   blending: THREE.NoBlending,
 *   pixelBudget: 1.5,
 *   update({ u, s, P, dt }) {
 *     phase += dt * 0.011 * (1 + s.mids * 0.5) * drastic(P.speed)
 *     u.uPhase.value = phase
 *     u.uWarp.value = 0.3 + 1.5 * P.complexity
 *   },
 * })
 * ```
 *
 * The two paths differ only in whether a `pixelBudget` is declared, and the
 * choice is made here rather than inside a component so each variant has a
 * fixed hook order.
 */
export function createShaderScene<S = void>(spec: ShaderSceneSpec<S>): PrewarmableScene {
  const Component = (
    spec.pixelBudget !== undefined
      ? createBudgetedScene(spec, spec.pixelBudget)
      : createDirectScene(spec)
  ) as PrewarmableScene
  Component.prewarm = (gl) => {
    const { material, geometry } = getSceneMaterial(gl, spec)
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(geometry, material))
    // Gives the driver's own parallel-compile thread a head start on
    // compileShader/linkProgram, off the main thread where the extension
    // is actually honoured (shaderPrewarm.ts). Fire-and-forget: the render
    // below does not depend on this having resolved, it just means less
    // work is left for that render to do synchronously if it has.
    void prewarmShaders(gl, scene, PREWARM_CAMERA)
    // F145 correction (2026-08-29): compileShader/linkProgram alone was not
    // enough — a live session log showed maze's boot-prewarmed material
    // still stalling ~1.8s on its first real mount, completely unchanged
    // from before this file had a prewarm path at all. Read three's own
    // `compile()` source to confirm why: it calls `prepareMaterial()` for
    // every material and never calls `render()` — no draw call is ever
    // issued. F139 already suspected the actual mechanism: on this
    // session's backend (ANGLE/D3D11 — see env.gpu in a session log),
    // linking a program is not the same as the driver having really
    // compiled it — some ANGLE/D3D11 configurations defer the real
    // HLSL-compile-and-link step to the first draw call that exercises the
    // program with a concrete vertex layout, which compileShader/
    // linkProgram alone never provides. A real render forces that too —
    // into a throwaway 1x1 target so the actual fill cost is negligible,
    // using the exact geometry/material pair the real mount will use, so
    // whatever the driver was waiting for is already settled by the time
    // anything needs this scene live.
    const warmTarget = new THREE.WebGLRenderTarget(1, 1)
    const prevTarget = gl.getRenderTarget()
    gl.setRenderTarget(warmTarget)
    gl.render(scene, PREWARM_CAMERA)
    gl.setRenderTarget(prevTarget)
    warmTarget.dispose()
  }
  return Component
}

/** A shader-scene component that can also force its own compile ahead of any mount. */
export type PrewarmableScene = ComponentType & {
  /**
   * Forces this scene's material to exist (creating and caching it via
   * `getSceneMaterial` if this is the first call for this renderer), issues
   * a real `compileShader`/`linkProgram` for it through the same
   * `compileAsync` path `EntryGroup`'s warm-mount uses, AND renders it once
   * into a throwaway 1x1 target — off the critical path, before any mount
   * ever asks for this scene.
   *
   * The render is not decoration: `compileAsync`/`compile()` never issue an
   * actual draw call (verified directly in three's source), and on at least
   * one backend observed live (ANGLE/D3D11) that alone was not enough — see
   * the F145 update in ISSUES.md for the live log that caught it. Whatever
   * that backend was deferring past link, a real draw with the exact
   * geometry/material pair the real mount will use forces it too.
   *
   * For a scene heavy enough that its first-ever compile this session runs
   * into whole seconds (see F144 in ISSUES.md), this is what lets that cost
   * land at boot instead of on whatever moment the director first picks it
   * mid-show. Cheap and safe to call more than once: `getSceneMaterial`
   * hands back the same cached object every time, so a second call compiles
   * and draws against an already-warm program, which is fast.
   */
  prewarm: (gl: THREE.WebGLRenderer) => void
}

/**
 * Shared throwaway camera for `.prewarm()` calls — `compileAsync` needs
 * *some* camera to traverse against, but does not read its parameters, so
 * one instance serves every scene's prewarm call for the life of the page.
 */
const PREWARM_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

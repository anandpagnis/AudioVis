import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from './glsl'
import { createLilimState, updateLilimState, type LilimAudioState } from './lilimState'
import type { PaletteBlender } from './palettes'
import { useSceneFrame, type SceneFrame } from './sceneFrame'
import { useSceneParams, type ResolvedSceneParams } from './sceneParams'
import { useDispose } from './useDispose'

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
`

/** What a shader scene's per-frame callback receives. */
export interface ShaderSceneContext<S = void> {
  /** The material's uniforms, for writing scene-specific values. */
  u: Record<string, THREE.IUniform>
  /** Audio in the lilim vocabulary — `s.mids`, `s.onKick`, and the rest. */
  s: LilimAudioState
  /** This scene's resolved parameters. Apply `drastic()` to `P.speed` yourself. */
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

/** Solve lilim's `scale = sqrt(budget / fullMP)`, clamped. */
function solveScale(pixelBudget: number, width: number, height: number, dpr: number): number {
  const fullMP = (width * dpr * height * dpr) / 1e6
  if (!(fullMP > 0)) return 1
  return Math.min(1, Math.max(MIN_RENDER_SCALE, Math.sqrt(pixelBudget / fullMP)))
}

/** Shared setup: material, geometry, audio state, parameters, frame driver. */
function useShaderCore<S>(spec: ShaderSceneSpec<S>) {
  const P = useSceneParams(spec.id)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
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
          ...spec.uniforms?.(),
        },
      }),
    // Every field read here is fixed for the life of the module — a spec is a
    // static declaration, not state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
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
    u.uMode.value = P.modeIndex

    if (rendered.current < WARM_RENDERS) rendered.current++
    else if (ctx.vis <= 0.001) return false

    elapsed.current += ctx.dt
    u.uTime.value = elapsed.current
    updateLilimState(audio, ctx)
    spec.update({
      u,
      s: audio,
      P,
      pal: ctx.col,
      dt: ctx.dt,
      t: elapsed.current,
      st: sceneState,
      ctx,
    })
    return true
  }

  return { material, geometry, runFrame }
}

/** Full-resolution path: one fullscreen quad straight into the shared graph. */
function createDirectScene<S>(spec: ShaderSceneSpec<S>): ComponentType {
  function ShaderScene() {
    const size = useThree((s) => s.size)
    const dpr = useThree((s) => s.viewport.dpr)
    const { material, geometry, runFrame } = useShaderCore(spec)

    useDispose(material, geometry)

    useEffect(() => {
      const w = Math.max(1, Math.floor(size.width * dpr))
      const h = Math.max(1, Math.floor(size.height * dpr))
      material.uniforms.uRes.value.set(w, h)
      material.uniforms.uAspect.value = w / h
    }, [material, size, dpr])

    useSceneFrame(runFrame)

    return (
      <mesh frustumCulled={false}>
        <primitive object={geometry} attach="geometry" />
        <primitive object={material} attach="material" />
      </mesh>
    )
  }
  ShaderScene.displayName = `ShaderScene(${spec.id})`
  return ShaderScene
}

/** Blit the offscreen buffer, honouring the scene's blending choice. */
const DISPLAY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uScene;
  void main() { gl_FragColor = texture2D(uScene, vUv); }
`

/** Budgeted path: render offscreen at the solved scale, then upscale. */
function createBudgetedScene<S>(
  spec: ShaderSceneSpec<S>,
  pixelBudget: number | (() => number),
): ComponentType {
  function ShaderScene() {
    const gl = useThree((s) => s.gl)
    const size = useThree((s) => s.size)
    const dpr = useThree((s) => s.viewport.dpr)
    const { material, geometry, runFrame } = useShaderCore(spec)

    const displayMaterial = useMemo(
      () =>
        new THREE.ShaderMaterial({
          vertexShader: FULLSCREEN_VERT,
          fragmentShader: DISPLAY_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: spec.blending ?? THREE.AdditiveBlending,
          uniforms: { uScene: { value: null } },
        }),
      [],
    )

    const rt = useMemo(() => {
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
      scene.add(new THREE.Mesh(geometry, material))
      return { target, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) }
    }, [geometry, material])

    useDispose(material, displayMaterial, geometry, rt.target)

    // Solved every frame rather than in a resize-only effect, so a function
    // budget can react to the quality tier changing mid-scene. Cheap either
    // way — `setSize` on a target already at the target dimensions is a
    // guarded no-op inside three, but the uniform writes below it are not, so
    // this still gates on the size actually changing.
    useSceneFrame((ctx) => {
      const budget = typeof pixelBudget === 'function' ? pixelBudget() : pixelBudget
      const scale = solveScale(budget, size.width, size.height, dpr)
      const w = Math.max(1, Math.floor(size.width * dpr * scale))
      const h = Math.max(1, Math.floor(size.height * dpr * scale))
      if (w !== rt.target.width || h !== rt.target.height) {
        rt.target.setSize(w, h)
        // The shader's idea of resolution is the BUFFER's, not the canvas's —
        // it drives ray setup and pixel-space maths, so passing the canvas
        // size here would draw a differently-shaped frame than the one being
        // written into.
        material.uniforms.uRes.value.set(w, h)
        material.uniforms.uAspect.value = w / h
      }

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
export function createShaderScene<S = void>(spec: ShaderSceneSpec<S>): ComponentType {
  return spec.pixelBudget !== undefined
    ? createBudgetedScene(spec, spec.pixelBudget)
    : createDirectScene(spec)
}

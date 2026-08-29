import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from './glsl'
import { createLilimState, updateLilimState, type LilimAudioState } from './lilimState'
import type { PaletteBlender } from './palettes'
import { useSceneFrame, type SceneFrame } from './sceneFrame'
import { useSceneParams, type ResolvedSceneParams } from './sceneParams'
import { prewarmShaders } from './streaming/shaderPrewarm'

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
  const P = useSceneParams(spec.id)

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
    // No useDispose(material, geometry) — cached across mounts, see getSceneMaterial.

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

/**
 * Blit the offscreen buffer, honouring the scene's blending choice.
 *
 * The source texture is allocated at the FULL canvas size (see `BudgetedRT`
 * below) but only the bottom-left `uUvMax` fraction of it holds this frame's
 * actual render — the rest is stale/uninitialised from whatever the target
 * held before. `uUvMax` is already inset half a texel short of the true
 * boundary so linear filtering can't sample across into that stale region.
 */
const DISPLAY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uScene;
  uniform vec2 uUvMax;
  void main() { gl_FragColor = texture2D(uScene, vUv * uUvMax); }
`

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
 * ## Fixed to the full canvas size, not the budgeted one (F139/F143)
 *
 * `target.setSize()` is only ever called here for a real canvas/DPR change —
 * a rare, user-driven event. The quality governor's own resolution changes
 * (a tier demote, a render-scale step — dozens of times a minute) do NOT
 * resize this target at all; they move `target.viewport`/`target.scissor`
 * instead, which `WebGLRenderer.setRenderTarget()` reads directly with no
 * texture/framebuffer work.
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
    uniforms: { uScene: { value: null }, uUvMax: { value: new THREE.Vector2(1, 1) } },
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
    // the target is fixed to the full canvas (see `getBudgetedRT`'s F139/
    // F143 doc comment) and essentially never changes, while this tracks the
    // viewport sub-rect the quality governor moves dozens of times a minute.
    const activeSize = useRef({ w: 0, h: 0 })

    // Solved every frame rather than in a resize-only effect, so a function
    // budget can react to the quality tier changing mid-scene — cheap, since
    // it's pure arithmetic with no GPU work unless the active size changed.
    useSceneFrame((ctx) => {
      const budget = typeof pixelBudget === 'function' ? pixelBudget() : pixelBudget
      const scale = solveScale(budget, size.width, size.height, dpr)
      const w = Math.max(1, Math.floor(size.width * dpr * scale))
      const h = Math.max(1, Math.floor(size.height * dpr * scale))

      // Real canvas/DPR change only — NOT a budget/tier change. `setSize()`
      // resets `target.viewport`/`.scissor` to the full new size, which is
      // why the active-viewport block below runs unconditionally after this
      // rather than being folded into the same guard.
      const fullW = Math.max(1, Math.round(size.width * dpr))
      const fullH = Math.max(1, Math.round(size.height * dpr))
      if (fullW !== rt.target.width || fullH !== rt.target.height) {
        rt.target.setSize(fullW, fullH)
      }

      if (w !== activeSize.current.w || h !== activeSize.current.h) {
        activeSize.current.w = w
        activeSize.current.h = h
        // The shader's idea of resolution is the ACTIVE viewport's, not the
        // allocated target's — it drives ray setup and pixel-space maths, so
        // passing the full target size here would draw a differently-shaped
        // frame than the one actually being written into.
        material.uniforms.uRes.value.set(w, h)
        material.uniforms.uAspect.value = w / h
        // Half-texel inset so the blit's bilinear filtering can't sample
        // across into the stale region outside this frame's active rect.
        displayMaterial.uniforms.uUvMax.value.set(w / fullW - 0.5 / fullW, h / fullH - 0.5 / fullH)
      }
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
    void prewarmShaders(gl, scene, PREWARM_CAMERA)
  }
  return Component
}

/** A shader-scene component that can also force its own compile ahead of any mount. */
export type PrewarmableScene = ComponentType & {
  /**
   * Forces this scene's material to exist (creating and caching it via
   * `getSceneMaterial` if this is the first call for this renderer) and
   * issues a real `compileShader`/`linkProgram` for it through the same
   * `compileAsync` path `EntryGroup`'s warm-mount uses — off the critical
   * path, before any mount ever asks for this scene.
   *
   * For a scene heavy enough that its first-ever compile this session runs
   * into whole seconds (see F144 in ISSUES.md), this is what lets that cost
   * land at boot instead of on whatever moment the director first picks it
   * mid-show. Cheap and safe to call more than once: `getSceneMaterial`
   * hands back the same cached object every time, so a second call issues a
   * `compileAsync` against an already-compiled program, which resolves
   * immediately.
   */
  prewarm: (gl: THREE.WebGLRenderer) => void
}

/**
 * Shared throwaway camera for `.prewarm()` calls — `compileAsync` needs
 * *some* camera to traverse against, but does not read its parameters, so
 * one instance serves every scene's prewarm call for the life of the page.
 */
const PREWARM_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

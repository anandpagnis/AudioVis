import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import { parseISF } from './isf/parseISF'
import {
  ISF_FILTER_MIX_UNIFORM,
  ISF_FILTER_PRELUDE,
  isfUniformSeed,
  transpileISF,
  type TranspiledISF,
} from './isf/transpileISF'
import { prewarmShaders } from './streaming/shaderPrewarm'

/**
 * One permanently-mounted post-chain pass that runs a transpiled ISF FILTER —
 * and swaps which one by changing the material it draws, never by changing the
 * chain.
 *
 * ## Why it is one pass and not one pass per filter
 *
 * `PostFXChain`'s own header states the constraint this whole design answers:
 * *"The effect list is structurally FIXED. Adding or removing an effect rebuilds
 * the composer's merged shader — a multi-hundred-millisecond stall that,
 * repeated, has lost the WebGL context outright."* The obvious design — mount
 * the selected filter, unmount it when the user picks another — is exactly the
 * thing that has already taken the context down once. So the chain gets one
 * slot, forever, and picking a filter is a material assignment on a `Mesh`.
 *
 * The null case is {@link Pass.enabled}, and that is safe for a specific,
 * checked reason rather than by assumption: `EffectComposer.render()` in
 * `postprocessing` 6.39.2 does `for (const pass of this.passes) { if
 * (!pass.enabled) continue; … }`. It is a per-frame skip in the render loop.
 * Nothing about it touches `addPass`/`removePass`, which are the calls that
 * rebuild anything. A disabled pass also never swaps buffers, so the frame flows
 * past it untouched.
 *
 * ## The material cache is never disposed
 *
 * Keyed by renderer, exactly as `createShaderScene.tsx`'s `getSceneMaterial`
 * is, and for the reason spelled out in F144 there: `material.dispose()` fires
 * three's `onMaterialDispose`, which releases the compiled `WebGLProgram`, and
 * the next selection then pays a real `compileShader`/`linkProgram` — measured
 * at ~2s for a heavy shader. A filter is picked, compared against another, and
 * picked back; that is the access pattern disposal punishes hardest. One
 * resident material per (renderer, filter) for the renderer's lifetime is the
 * same trade, invalidated naturally when a context loss produces a new
 * `WebGLRenderer` and therefore a new `WeakMap` entry.
 *
 * ## No colour-space conversion
 *
 * Deliberate, and F81 is the note that explains it: every custom pass in this
 * chain renders into an intermediate LINEAR buffer and `GradePass`, being last,
 * does the one real `colorspace_fragment` conversion for everybody. This pass
 * sits in the same position — mid-chain, writing to a composer buffer — so
 * adding the include here would convert twice and present a washed-out frame
 * with no compile error to catch it.
 *
 * ## What it does NOT do
 *
 * Choose a filter. Nothing in the app selects one yet, and that is not an
 * oversight — see the NOTICE in `src/assets/isf/filters/` and F178 in
 * docs/ISSUES.md. The corpus is MIT and MIT requires the attribution travel
 * with the work; the product has nowhere to show a third-party credit. The
 * machinery is built and tested, and {@link IsfFilterPass.setFilter} is the one
 * seam a picker will call.
 */

/** A filter compiled from an ISF source file, ready for {@link IsfFilterPass}. */
export interface IsfFilter {
  /**
   * Stable identity, and the material cache's key.
   *
   * Two different sources must never share one — the cache would hand the
   * second the first's compiled program, which is a filter silently rendering
   * as a different filter.
   */
  id: string
  /** The shader's own `CREDIT`, which is the attribution MIT requires. */
  credit?: string
  /** ISF `DESCRIPTION`, when the author wrote one. */
  description?: string
  transpiled: TranspiledISF
}

/**
 * Parse and transpile one `.fs` source into a runnable filter.
 *
 * Throws `IsfImportError` for anything out of scope — `PASSES`, `IMPORTED`, an
 * audio input, an image input under any name but `inputImage` — with the same
 * distinction the scene path relies on: a batch importer can tell "skip this
 * file" from "the adapter is broken".
 *
 * Pure apart from its imports; nothing here touches a renderer, so a test can
 * prove every vendored filter transpiles without a GL context.
 */
export function compileIsfFilter(id: string, source: string): IsfFilter {
  const parsed = parseISF(source, { origin: id, kind: 'filter' })
  const transpiled = transpileISF(parsed, { origin: id, kind: 'filter' })
  return {
    id,
    ...(parsed.header.credit ? { credit: parsed.header.credit } : {}),
    ...(parsed.header.description ? { description: parsed.header.description } : {}),
    transpiled,
  }
}

/** A compiled filter's material and the geometry it was warmed against. */
export interface CachedFilterMaterial {
  material: THREE.ShaderMaterial
  geometry: THREE.PlaneGeometry
}

/**
 * One compiled `ShaderMaterial` (+ geometry) per (renderer, filter id), reused
 * for the renderer's lifetime and never disposed — see the class header for
 * why, and F144 in docs/ISSUES.md for the measurement behind it.
 *
 * The geometry is cached alongside rather than shared across filters even
 * though every filter uses the identical 2x2 quad. That is not redundancy: F145
 * found that some ANGLE/D3D11 configurations defer the real HLSL compile to the
 * first draw that exercises a program *with a concrete vertex layout*, so
 * {@link IsfFilterPass.prewarm} has to draw the exact geometry/material PAIR the
 * live render will use. Keeping them together makes that impossible to get
 * wrong by accident.
 */
const filterMaterialCache = new WeakMap<THREE.WebGLRenderer, Map<string, CachedFilterMaterial>>()

/**
 * The cached material for one filter on one renderer, compiled on first ask.
 *
 * Exported for the unit tests, which build materials against a stub renderer to
 * assert the cache identity and the emitted uniforms without a GL context. The
 * pass itself is the only production caller.
 */
export function getIsfFilterMaterial(
  gl: THREE.WebGLRenderer,
  filter: IsfFilter,
): CachedFilterMaterial {
  let byId = filterMaterialCache.get(gl)
  if (!byId) {
    byId = new Map()
    filterMaterialCache.set(gl, byId)
  }
  const existing = byId.get(filter.id)
  if (existing) return existing

  const material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: ISF_FILTER_PRELUDE + filter.transpiled.frag,
    // Opaque and depth-free, matching every other pass in this chain. With
    // `transparent: false` three disables blending outright, so the wrapper's
    // wet/dry mix is WRITTEN rather than composited — which is what makes mix=0
    // an exact pass-through of the input pixel rather than an approximation of
    // one. See ISF_FILTER_WRAPPER on why the alpha channel rides along.
    depthWrite: false,
    depthTest: false,
    uniforms: {
      tDiffuse: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      [ISF_FILTER_MIX_UNIFORM]: { value: 1 },
      // Every `uIsf*` the transpile generated, seeded from the ISF DEFAULTs, so
      // a filter with no UI attached still renders what its author tuned.
      ...isfUniformSeed(filter.transpiled),
    },
  })
  const geometry = new THREE.PlaneGeometry(2, 2)
  const created: CachedFilterMaterial = { material, geometry }
  byId.set(filter.id, created)
  return created
}

/** Longest frame delta the ISF clock will advance by, in seconds. */
const MAX_DELTA = 0.1

export class IsfFilterPass extends Pass {
  private readonly fsScene: THREE.Scene
  private readonly orthoCamera: THREE.OrthographicCamera
  /** Created with the first filter — there is nothing to draw before one. */
  private mesh: THREE.Mesh | null = null
  private filter: IsfFilter | null = null
  /** Resolved material, and the renderer it belongs to (a context loss changes it). */
  private cached: CachedFilterMaterial | null = null
  private cachedFor: THREE.WebGLRenderer | null = null
  private mix = 1
  /** ISF `TIME`, in seconds. Runs continuously so a swap does not jump. */
  private elapsed = 0
  /** ISF `FRAMEINDEX`. */
  private frames = 0

  constructor() {
    super('IsfFilterPass')
    this.needsSwap = true
    // The null case. Nothing selects a filter yet, so this pass costs one
    // `if (!pass.enabled) continue` per frame until something does.
    this.enabled = false
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.fsScene = new THREE.Scene()
  }

  /**
   * Select a filter, or `null` to switch the pass off.
   *
   * Cheap and safe to call every frame with the same value. The material is not
   * built here — that needs a renderer, which only `render` has — so a
   * selection landing on a filter that has never been compiled on this renderer
   * pays its compile on the next frame. {@link prewarm} is how that cost is
   * moved off the moment of selection.
   */
  setFilter(filter: IsfFilter | null): void {
    if (filter?.id === this.filter?.id) return
    this.filter = filter
    this.enabled = filter !== null
    this.cached = null
    this.cachedFor = null
  }

  /** The selected filter, or null. */
  get selected(): IsfFilter | null {
    return this.filter
  }

  /**
   * Wet/dry, clamped to 0..1. 0 passes the frame through untouched.
   *
   * A dial rather than a switch because a post-effect at full strength is
   * usually too much — and because it is what lets a director ramp a filter in
   * over a build instead of popping it on. `enabled` remains the off switch:
   * mix 0 still pays a fullscreen pass, `enabled = false` pays nothing.
   */
  setMix(amount: number): void {
    this.mix = isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0
  }

  /**
   * Compile and DRAW one filter ahead of any selection, off the critical path.
   *
   * The draw is not belt-and-braces. F145 recorded a live session where a
   * boot-prewarmed material still stalled ~1.8s on its first real mount, and
   * reading three's `compile()` explains it: it calls `prepareMaterial()` for
   * every material and never issues a draw call. On ANGLE/D3D11 — the backend
   * this project's own session logs report — linking is not the same as the
   * driver having compiled anything; some configurations defer the real
   * HLSL-compile-and-link to the first draw that exercises the program with a
   * concrete vertex layout. `compileAsync` cannot provide one. A real render
   * into a throwaway 1x1 target does, for a fill cost of one pixel.
   *
   * `compileAsync` is still fired first, because it genuinely hands the
   * driver's own compile thread a head start (see streaming/shaderPrewarm.ts)
   * and costs nothing that was not already being paid.
   */
  prewarm(gl: THREE.WebGLRenderer, filter: IsfFilter): void {
    const { material, geometry } = getIsfFilterMaterial(gl, filter)
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    scene.add(mesh)
    void prewarmShaders(gl, scene, this.orthoCamera)
    const warmTarget = new THREE.WebGLRenderTarget(1, 1)
    const prevTarget = gl.getRenderTarget()
    gl.setRenderTarget(warmTarget)
    gl.render(scene, this.orthoCamera)
    gl.setRenderTarget(prevTarget)
    warmTarget.dispose()
  }

  render(
    gl: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
    deltaTime?: number,
  ): void {
    const filter = this.filter
    if (!filter || !inputBuffer) return

    if (!this.cached || this.cachedFor !== gl) {
      // First frame after a selection (or after a context loss). Compiles here
      // if `prewarm` was never called for this filter — see its note.
      this.cached = getIsfFilterMaterial(gl, filter)
      this.cachedFor = gl
      if (!this.mesh) {
        this.mesh = new THREE.Mesh(this.cached.geometry, this.cached.material)
        this.mesh.frustumCulled = false
        this.fsScene.add(this.mesh)
      } else {
        this.mesh.geometry = this.cached.geometry
        this.mesh.material = this.cached.material
      }
    }

    // Clamped so a tab returning from the background does not advance an
    // animated filter by however many seconds it was hidden for — which reads
    // as the effect jumping rather than running.
    const dt =
      typeof deltaTime === 'number' && isFinite(deltaTime)
        ? Math.min(Math.max(0, deltaTime), MAX_DELTA)
        : 0
    this.elapsed += dt
    this.frames++

    const u = this.cached.material.uniforms
    u.tDiffuse.value = inputBuffer.texture
    // The buffer's own size, not the canvas's: the render-scale governor moves
    // this every time it changes tier, and `RENDERSIZE`, `IMG_SIZE` and every
    // `gl_FragCoord` comparison in the filter body are all measured against it.
    ;(u.uRes.value as THREE.Vector2).set(inputBuffer.width, inputBuffer.height)
    u.uTime.value = this.elapsed
    u[ISF_FILTER_MIX_UNIFORM].value = this.mix
    // Only present when the body actually referenced them — see
    // TranspiledISF.builtinsUsed. `uIsfDate` is deliberately left at zero: F175
    // records that nothing in this engine supplies a wall-clock date, and a
    // fabricated one would be worse than an obviously-unset one.
    if (u.uIsfTimeDelta) u.uIsfTimeDelta.value = dt
    if (u.uIsfFrameIndex) u.uIsfFrameIndex.value = this.frames

    gl.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    gl.render(this.fsScene, this.orthoCamera)
  }

  /**
   * Frees nothing, on purpose.
   *
   * `Pass.dispose()` performs a shallow search for disposable properties and
   * disposes them, and `useDispose` calls this on unmount. Both are correct for
   * a pass that owns its material; this one does not. Every material and
   * geometry it draws belongs to {@link filterMaterialCache}, which is resident
   * for the renderer's lifetime by design (F144) and reachable from the next
   * mount. Disposing them here would delete the compiled programs and hand the
   * ~2s recompile back to whoever selects a filter next.
   *
   * `super.dispose()` is deliberately NOT called. It would be harmless today —
   * nothing on this instance is a bare `Material` — but it is one refactor away
   * from being the bug this comment exists to prevent.
   */
  dispose(): void {
    /* nothing to free; see above */
  }
}

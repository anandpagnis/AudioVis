import * as THREE from 'three'
import { WIPE_LAYER_IN, WIPE_LAYER_OUT } from './transitionWipe'

/**
 * Lazily-allocated capture targets for the two primaries during a wipe-style
 * transition. Modelled directly on `FeedbackPass.ts`'s `makeHistoryTarget`:
 * half-float, linear filtering, no depth/stencil buffer — the same target
 * shape, for the same reason (accumulated/composited colour that must not
 * band or clip the way an 8-bit target would).
 *
 * ## Not a `Pass`
 *
 * `FeedbackPass`/`MirrorPass`/`LensPass` are all `postprocessing` `Pass`
 * subclasses that sit IN the composer's chain and are driven by its own
 * render loop. This class is not — it never appears in
 * `<EffectComposer>`'s children. It is a plain helper `PostFXChain.tsx` calls
 * into directly, from the SAME `useFrame` callback that drives the passes
 * above (priority 0, before the composer's own render at priority 1 — see
 * that file), because capturing the two primaries has to happen with two
 * manual `gl.render()` calls BEFORE the composer's chain (and specifically
 * `WipeCompositorPass`, mounted first in it) runs this frame and reads the
 * results back as textures.
 *
 * ## Why the composer's `RenderPass` doesn't already do this
 *
 * While a wipe is active, `SceneManager.tsx` moves the outgoing primary onto
 * `WIPE_LAYER_OUT` and the incoming primary onto `WIPE_LAYER_IN`, off the
 * main camera's default layer (0). So the composer's own auto-inserted
 * `RenderPass` (camera masked to layer 0, untouched by this feature) already
 * renders a frame with BOTH primaries excluded — that's the "merged frame
 * (now containing only background/accent/overlay/effects)" `WipeCompositorPass`
 * reads as `tDiffuse`. This class's job is the two EXTRA renders that put
 * each primary — and only that one primary — into its own texture, which
 * nothing else in the pipeline does.
 *
 * ## Cost discipline
 *
 * Zero cost at rest: `ensureTargets`/`render` are only ever called from
 * `PostFXChain.tsx` behind `shouldCapture(tx)` (see `transitionWipe.ts`) —
 * cross-referenced there and here so the gate can be verified by reading two
 * places rather than running the app. `ensureTargets` is safe to call every
 * frame once sized correctly: it reallocates only when there is no target yet
 * or the requested size actually differs from the current one.
 */

/**
 * Linear scale of the renderer's current size the two capture targets are allocated at (so the AREA cost is
 * this squared). A wipe reads and downstream-blurs/blooms/composites a small texture over sub-2-second
 * transitions, so full resolution buys nothing visible; keeping this low is the direct lever on the capture's
 * actual cost, alongside `WIPE_MAX_TIER`'s gate on which sessions attempt it at all. This does NOT touch the
 * fixed per-pass overhead of a second full scene traversal (state changes, draw calls, shader binds) — on the
 * weakest admitted tier that overhead, not pixel count, is most of the real cost, so shrinking this further has
 * diminishing returns past a point. History: 0.75 originally, then 0.5 (2026-09-23) alongside `WIPE_MAX_TIER`
 * 1->2, then 0.35 (same day) alongside 2->3 — see that constant's doc for the full reasoning; both move
 * together deliberately.
 */
export const WIPE_CAPTURE_SCALE = 0.35

function makeCaptureTarget(width: number, height: number, name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.name = name
  return target
}

export class TransitionCapture {
  /**
   * The outgoing primary's captured frame (`WIPE_LAYER_OUT`), or `null`
   * before first use. Named `outTarget`/`inTarget` rather than the plan's
   * bare `out`/`in` — `in` is a reserved word in JS/TS and cannot be used as
   * a class field name (confirmed: `in` alone here fails the build with
   * `Unexpected ":"`), so `outTarget.texture`/`inTarget.texture` is the
   * "or equivalent" the prompt allows.
   */
  outTarget: THREE.WebGLRenderTarget | null = null
  /** The incoming primary's captured frame (`WIPE_LAYER_IN`), or `null` before first use. */
  inTarget: THREE.WebGLRenderTarget | null = null

  private width = 0
  private height = 0

  /**
   * Allocate (or reallocate, on a real size change) both capture targets at
   * `WIPE_CAPTURE_SCALE` of `width`/`height` (the renderer's current size, in
   * CSS pixels — `gl.getSize()`, the same numbers `PostFXChain.tsx` reads for
   * the composer's own resize path, so this piggybacks on that existing poll
   * rather than adding a second resize mechanism). Relative to the drawn frame
   * that is 0.35 / (baseDpr * applied) — 17.5% on a 2x display at native.
   *
   * Safe to call every frame: a call that requests the same size the targets
   * are already at does nothing beyond two integer comparisons. Rounds down
   * to at least 1x1 so a not-yet-laid-out canvas (width/height 0) cannot
   * construct a degenerate target.
   */
  ensureTargets(width: number, height: number): void {
    const w = Math.max(1, Math.round(width * WIPE_CAPTURE_SCALE))
    const h = Math.max(1, Math.round(height * WIPE_CAPTURE_SCALE))
    if (this.outTarget && this.inTarget && this.width === w && this.height === h) return
    this.outTarget?.dispose()
    this.inTarget?.dispose()
    this.outTarget = makeCaptureTarget(w, h, 'TransitionCapture.out')
    this.inTarget = makeCaptureTarget(w, h, 'TransitionCapture.in')
    this.width = w
    this.height = h
  }

  /**
   * Render the outgoing primary (layer {@link WIPE_LAYER_OUT}) into
   * `outTarget` and the incoming primary (layer {@link WIPE_LAYER_IN}) into
   * `inTarget`, then restore the camera's layer mask and clear the render
   * target.
   *
   * Call only while {@link ensureTargets} has already been called this frame
   * (or a previous one) with a matching size — a no-op if either target is
   * not yet allocated, so an out-of-order call costs nothing rather than
   * throwing.
   *
   * Leaves `gl`'s render target `null` afterward rather than restoring
   * whatever it was before this call: every pass further down the chain
   * (including the composer's own `RenderPass` this same frame) explicitly
   * sets its own target before rendering — confirmed by reading
   * `FeedbackPass.ts`/`MirrorPass.ts`, neither of which assumes an incoming
   * target either — so leaving it `null` is safe and matches that
   * convention rather than adding a third one.
   */
  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.outTarget || !this.inTarget) return
    const savedMask = camera.layers.mask
    camera.layers.set(WIPE_LAYER_OUT)
    gl.setRenderTarget(this.outTarget)
    gl.render(scene, camera)
    // `WebGLRenderer.render` walks the WHOLE scene graph updating world matrices on every call (unless
    // `matrixWorldAutoUpdate` is off). The first capture above has just done that for this frame and nothing
    // moves between the two captures, so the second one skips it: one full-graph traversal saved per wipe frame
    // (the composer's own RenderPass, after this, still does its own). Restored in `finally` so an exception in
    // the render can never leave the scene stuck unable to update its matrices.
    const savedAutoUpdate = scene.matrixWorldAutoUpdate
    scene.matrixWorldAutoUpdate = false
    try {
      camera.layers.set(WIPE_LAYER_IN)
      gl.setRenderTarget(this.inTarget)
      gl.render(scene, camera)
    } finally {
      scene.matrixWorldAutoUpdate = savedAutoUpdate
      camera.layers.mask = savedMask
    }
    gl.setRenderTarget(null)
  }

  /** Frees both targets, following `FeedbackPass`/`MirrorPass`'s own
   *  `dispose()` contract (see `useDispose.ts`, which calls this the same way
   *  it calls theirs from `PostFXChain.tsx`'s unmount). Safe to call more than
   *  once, and safe to call before anything has ever been allocated. */
  dispose(): void {
    this.outTarget?.dispose()
    this.inTarget?.dispose()
    this.outTarget = null
    this.inTarget = null
    this.width = 0
    this.height = 0
  }
}

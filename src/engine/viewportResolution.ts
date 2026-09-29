import { useEffect, type RefObject } from 'react'
import { Vector4, type Object3D, type ShaderMaterial, type Vector2 } from 'three'

/**
 * Pixel-space uniforms that follow the target a draw actually lands in (F272
 * stage 3).
 *
 * ## Why not `size * viewport.dpr`
 *
 * That is the canvas, and the canvas is only one of the places a scene is
 * drawn. `TransitionCapture` draws both primaries of a wipe into targets of
 * `round(css * WIPE_CAPTURE_SCALE)` — 0.35 of the CSS size, so
 * 0.35 / (baseDpr * applied) of the drawn frame (17.5% on a 2x display at
 * native) — and a shader that builds its coordinates from `gl_FragCoord`
 * against a frame-sized `uRes` drew only that bottom-left fraction of its
 * picture there, blown up to fill the capture: the wipe cropped it. From F272
 * stage 5 the whole frame is drawn into a sub-rect of full-size buffers, and
 * the canvas will not describe that either.
 *
 * `WebGLRenderer.getCurrentViewport` does: it is the GL viewport in use right
 * now, in physical pixels — a render target's own `.viewport`, or for the
 * canvas `_viewport * pixelRatio` (rounded by `setViewport`, floored by
 * `setRenderTarget(null)`; three 0.178).
 *
 * ## Why per draw, and why the value reaches the GPU
 *
 * Materials are drawn into several targets a frame (the composer's buffer and
 * both wipe captures), and the factory's are shared across mounts, so nothing
 * written once per frame can be right for every draw. Verified in three
 * 0.178's `WebGLRenderer.js`: `renderObject` calls `object.onBeforeRender`
 * before `renderBufferDirect` → `setProgram`, and `setProgram` uploads the
 * material's uniforms whenever the material is not the one it last bound —
 * `_currentMaterialId` is reset to -1 by every `setRenderTarget` and at the end
 * of every `render()` — or when `material.uniformsNeedUpdate` is set. So a
 * value written here is the value this draw uses. The flag covers the one case
 * the reset does not: the same material drawn again inside one `render()` call,
 * where `setProgram` would otherwise keep the first draw's values.
 */

/** Scratch for every binding. Read synchronously inside one draw's hook, so one is enough. */
const viewport = new Vector4()

/**
 * Call `apply` with the physical pixel size of the target each draw of
 * `object` lands in, from `object.onBeforeRender`. Returns the unbind.
 *
 * Replaces the object's own `onBeforeRender` rather than chaining it: meant for
 * the plain meshes scenes draw, whose hook is three's no-op. Allocates nothing
 * per draw.
 */
export function bindViewportResolution(
  object: Object3D,
  apply: (width: number, height: number) => void,
): () => void {
  const previous = object.onBeforeRender
  const hook: Object3D['onBeforeRender'] = (renderer) => {
    renderer.getCurrentViewport(viewport)
    apply(Math.max(1, viewport.z), Math.max(1, viewport.w))
  }
  object.onBeforeRender = hook
  return () => {
    if (object.onBeforeRender === hook) object.onBeforeRender = previous
  }
}

/**
 * Write `uRes` (a `Vector2`) and `uAspect`, whichever the material declares,
 * and flag `uniformsNeedUpdate` only when one of them actually changed. Returns
 * whether anything changed.
 */
export function writeResolution(material: ShaderMaterial, width: number, height: number): boolean {
  const u = material.uniforms
  let changed = false
  const res = u.uRes?.value as Vector2 | undefined
  if (res && (res.x !== width || res.y !== height)) {
    res.set(width, height)
    changed = true
  }
  const aspect = u.uAspect
  if (aspect) {
    const next = width / height
    if (aspect.value !== next) {
      aspect.value = next
      changed = true
    }
  }
  if (changed) material.uniformsNeedUpdate = true
  return changed
}

/**
 * Keep `material`'s `uRes`/`uAspect` on the target the object in `ref` is
 * drawn into, for as long as the component is mounted. The object must be
 * attached by the time effects run — a `ref` on a JSX element always is.
 */
export function useViewportResolution(ref: RefObject<Object3D | null>, material: ShaderMaterial): void {
  useEffect(() => {
    const object = ref.current
    if (!object) return
    return bindViewportResolution(object, (w, h) => {
      writeResolution(material, w, h)
    })
  }, [ref, material])
}

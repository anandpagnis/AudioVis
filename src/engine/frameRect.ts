import type { Vector4 } from 'three'
import { renderScale } from './renderScale'

/**
 * The frame's sub-rect (F272 stage 5): one GLSL chunk and a few JS helpers so every pass in the post chain
 * samples a buffer drawn into a corner of a larger allocation the same way.
 *
 * ## Why the frame is a rect and not a buffer size
 *
 * A render-scale change used to resize the canvas and every buffer in the chain — the composer's pair, the
 * bloom pyramid, the trail and echo history — and that reallocation was the 20-200 ms hitch in F272. Measured
 * on the M1: drawing into a scissored sub-rect of a full-size RGBA16F target costs the same as drawing into an
 * exact-size one, and moving the rect costs nothing. So every buffer is allocated once at full size (grow
 * only), the frame is drawn into its bottom-left `renderScale.internalW x internalH`, and `GradePass` upscales
 * that rect to the canvas. A resolution step is a `Vector4` write.
 *
 * ## The one rule: never sample outside the rect
 *
 * Outside the rect a full-size buffer holds whatever an earlier, larger frame left there. A bilinear tap that
 * reaches past the rect's last texel centre mixes that stale texel in, and it shows as a coloured seam along
 * the top and right edges that changes with the music. So every read goes through {@link FRAME_RECT_GLSL}:
 * a coordinate is mapped into the rect and clamped to its outermost texel CENTRES — the same thing
 * `CLAMP_TO_EDGE` does for an exact-size texture, so at full scale nothing changes.
 *
 * A rect is carried to the shader as one `vec4`: `(w, h)` its size in texels and `(1 / allocW, 1 / allocH)`
 * the allocation's texel size. Each render target records the rect it was last drawn into in its own
 * `viewport` (which `setRenderTarget` also uses to aim the draw), so {@link rectOf} is the only thing a pass
 * needs to read a buffer correctly, including history written at an earlier scale.
 */

/**
 * `rectTexel(pos, rect)`: a position in the rect's texel space (0..w, 0..h) to a texture coordinate, clamped
 * to the rect's texel centres. `rectUv(uv, rect)`: the same for a coordinate normalised to the rect (0..1).
 */
export const FRAME_RECT_GLSL = /* glsl */ `
  vec2 rectTexel(vec2 pos, vec4 rect) {
    return clamp(pos, vec2(0.5), rect.xy - 0.5) * rect.zw;
  }
  vec2 rectUv(vec2 uv, vec4 rect) {
    return rectTexel(uv * rect.xy, rect);
  }
`

/**
 * `rectCubic(tex, pos, rect, C)`: a 5-tap de-ringed Catmull-Rom sample at `pos` (rect texel space), every tap
 * clamped to the rect. The four corner taps of the 9-tap separable form are dropped (their weight is
 * `w0 * w0`-sized, a few percent) and the result is clamped to the taps' own min/max, so a bright line on
 * black cannot ring past its neighbours or go negative. Shared by the budgeted-scene blit
 * (`createShaderScene`'s `DISPLAY_FRAG`) and `GradePass`'s upscale. Needs {@link FRAME_RECT_GLSL} first.
 */
export const FRAME_RECT_CUBIC_GLSL = /* glsl */ `
  vec4 rectCubic(sampler2D tex, vec2 pos, vec4 rect, float C) {
    vec2 tc1 = floor(pos - 0.5) + 0.5;
    vec2 f = pos - tc1;
    vec2 w0 = -C * f * (1.0 - f) * (1.0 - f);
    vec2 w3 = -C * f * f * (1.0 - f);
    vec2 w1 = 1.0 + f * f * ((C - 3.0) + (2.0 - C) * f);
    vec2 w2 = 1.0 - w0 - w1 - w3;
    vec2 w12 = w1 + w2;
    vec2 t0 = rectTexel(tc1 - 1.0, rect);
    vec2 t3 = rectTexel(tc1 + 2.0, rect);
    vec2 t12 = rectTexel(tc1 + w2 / w12, rect);
    vec4 cC = texture2D(tex, t12);
    vec4 cL = texture2D(tex, vec2(t0.x, t12.y));
    vec4 cR = texture2D(tex, vec2(t3.x, t12.y));
    vec4 cB = texture2D(tex, vec2(t12.x, t0.y));
    vec4 cT = texture2D(tex, vec2(t12.x, t3.y));
    float wC = w12.x * w12.y;
    float wL = w0.x * w12.y;
    float wR = w3.x * w12.y;
    float wB = w12.x * w0.y;
    float wT = w12.x * w3.y;
    vec4 c = (cC * wC + cL * wL + cR * wR + cB * wB + cT * wT) / (wC + wL + wR + wB + wT);
    vec4 mn = min(cC, min(min(cL, cR), min(cB, cT)));
    vec4 mx = max(cC, max(max(cL, cR), max(cB, cT)));
    return max(clamp(c, mn, mx), 0.0);
  }
`

/**
 * A 1:1 copy of one buffer's rect into another's (the feedback history and the echo taps). `vUv` spans the
 * destination's rect, so a destination rect half the source's is a 2x2 box downsample.
 */
export const RECT_COPY_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec4 uRect;
  varying vec2 vUv;
${FRAME_RECT_GLSL}
  void main() {
    gl_FragColor = texture2D(tDiffuse, rectUv(vUv, uRect));
  }
`

/** Catmull-Rom tension for the upscales ({@link FRAME_RECT_CUBIC_GLSL}). */
export const BLIT_CUBIC_TENSION = 0.5

/**
 * The cheapest quality tier that still gets the bicubic upscale (tiers run 0 richest -> 4 survival). The
 * user's call (F272): bicubic only while the machine is running comfortably — the top two tiers — and plain
 * bilinear once the ladder has stepped down, so a struggling M1 never pays for it.
 */
export const BLIT_CUBIC_MAX_TIER = 1

/**
 * `C` for an upscale: the Catmull-Rom tension when the rect is genuinely smaller than what it is drawn over
 * AND the live resolution tier is a top one, else 0 (bilinear — which at 1:1 is an exact copy). Total against
 * non-finite input. Pure, so the policy is testable without a GPU. Used by the budgeted-scene blit and by
 * `GradePass`.
 */
export function blitCubicFor(srcW: number, destW: number, resolutionTier: number): number {
  if (!Number.isFinite(srcW) || !Number.isFinite(destW) || !Number.isFinite(resolutionTier)) return 0
  if (srcW >= destW - 0.5) return 0
  return resolutionTier <= BLIT_CUBIC_MAX_TIER ? BLIT_CUBIC_TENSION : 0
}

/** What the helpers below read from a render target. `WebGLRenderTarget` satisfies it. */
export interface RectTarget {
  width: number
  height: number
  viewport: Vector4
  scissor: Vector4
  scissorTest: boolean
}

/**
 * Write `target`'s rect into `out` as the shaders take it: (w, h, 1 / allocW, 1 / allocH). The rect is the
 * target's `viewport`, i.e. wherever it was last aimed — for history, the scale that frame was written at.
 * Returns `out`. Allocation-free.
 */
export function rectOf(target: RectTarget, out: Vector4): Vector4 {
  return out.set(
    Math.max(1, target.viewport.z),
    Math.max(1, target.viewport.w),
    1 / Math.max(1, target.width),
    1 / Math.max(1, target.height),
  )
}

/**
 * Aim `target` at its bottom-left `w x h` (clamped to the allocation): viewport and scissor both, scissor
 * test on, so a clear touches only the rect. `setRenderTarget` applies all three.
 */
export function setRect(target: RectTarget, w: number, h: number): void {
  const rw = Math.max(1, Math.min(target.width, Math.floor(w)))
  const rh = Math.max(1, Math.min(target.height, Math.floor(h)))
  target.viewport.set(0, 0, rw, rh)
  target.scissor.set(0, 0, rw, rh)
  target.scissorTest = true
}

/** Aim `target` at its whole allocation, scissor off (a full clear). */
export function setFullRect(target: RectTarget): void {
  target.viewport.set(0, 0, target.width, target.height)
  target.scissor.set(0, 0, target.width, target.height)
  target.scissorTest = false
}

/**
 * Aim `target` at the frame's rect: `renderScale.internalW x internalH`, never larger than the allocation (a
 * window resize can land in the frame before `PerfMonitor` re-reads the display, and a rect past the buffer
 * would scale the frame by the difference).
 */
export function setFrameRect(target: RectTarget): void {
  setRect(target, renderScale.internalW, renderScale.internalH)
}

/**
 * Half a size, as the echo taps are stored (F272: echo history at half resolution, trails at full). Rounded
 * like the bloom pyramid, at least 1, and monotonic, so the half of a rect never exceeds the half of the
 * allocation it lives in.
 */
export function halfSize(n: number): number {
  return Math.max(1, Math.round(n * 0.5))
}

/**
 * {@link FRAME_RECT_GLSL}'s `rectTexel` in TypeScript, one axis: the texture coordinate a rect-texel-space
 * position samples at. For the tests.
 */
export function rectTexelCoord(pos: number, rectSize: number, allocSize: number): number {
  return Math.min(rectSize - 0.5, Math.max(0.5, pos)) / allocSize
}

/** {@link FRAME_RECT_GLSL}'s `rectUv` in TypeScript, one axis. For the tests. */
export function rectUvCoord(uv: number, rectSize: number, allocSize: number): number {
  return rectTexelCoord(uv * rectSize, rectSize, allocSize)
}

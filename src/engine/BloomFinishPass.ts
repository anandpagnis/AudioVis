import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FRAME_RECT_GLSL, rectOf, setRect } from './frameRect'
import { FULLSCREEN_VERT } from './glsl'

/**
 * Bloom, chromatic aberration and vignette as ONE in-repo raw pass (F272 stage 4).
 *
 * ## What it replaces, and why it exists
 *
 * Until F272 stage 4 the chain mounted the library's `<Bloom intensity={0.8} luminanceThreshold={0.18} mipmapBlur
 * radius={0.75}/>`, `<ChromaticAberration/>` and `<Vignette eskil={false} offset={0.18} darkness={0.85}/>`
 * (`postprocessing` 6.39.2 via `@react-three/postprocessing` 3.1.1). F272 stage 5 renders the whole chain
 * into a sub-rect of full-size buffers so a resolution step reallocates nothing, and the library passes
 * cannot do that: their mip pyramid sizes itself from the buffer, samples the whole texture and clamps to
 * the texture's own border. This pass reproduces them with code this repo owns, so stage 5 has somewhere
 * to put a rect.
 *
 * ## The frame's sub-rect (F272 stage 5)
 *
 * The composer's buffers are full size and the frame is drawn into their bottom-left rect (frameRect.ts). The
 * pyramid follows it: its fifteen targets are allocated once from the FULL size (and only grow), and each
 * frame level `i` is drawn into the bottom-left `round(rect * 0.5^(i+1))` of its target, rounded through the
 * same `Math.round` chain as the allocation ({@link bloomLevelSizes}), so every level's rect fits its
 * target. Every texture fetch goes through the shader's `read*` helper, which maps into the source's rect and
 * clamps to its texel centres; the downsample's border test runs in the source rect's own texel space, from
 * `gl_FragCoord`, so it is exact (see the downsample shader). At full scale every rect is its whole target and
 * the result is what it was.
 *
 * ## What it reproduces (read against `node_modules/postprocessing/build/index.js`)
 *
 * `@react-three/postprocessing`'s `buildPasses` merged the three consecutive Effects into one `EffectPass`,
 * and `EffectPass.setEffects` sorts by attributes, CONVOLUTION first. So the library composited
 * **aberration, then bloom, then vignette**, each as `color0 = blend(color0, mainImage(color0), 1.0)`. This
 * pass does the same in one draw:
 *
 *  1. **Threshold** (`LuminanceMaterial`, colour output on, smoothing 0.03): `texel * smoothstep(t, t +
 *     0.03, luminance(texel.rgb))` on all four channels, with three's Rec.709 luminance weights.
 *  2. **Mip blur** (`MipmapBlurPass`, 8 levels): 8 downsamples (13-tap, `clampToBorder` zeroing any tap
 *     outside [0, 1] WITHOUT renormalising) then 7 upsamples (9-tap tent, `mix(support, tent, radius)`,
 *     radius 0.75). Level sizes halve with `Math.round` from the composer's size ({@link bloomLevelSizes}).
 *     The bloom map is the largest upsample, at half the frame's size.
 *  3. **Composite**: aberration (`offset * vec2(1, aspect)`, radial modulation off), bloom with the R3F
 *     wrapper's ADD blend (`rgb + bloom * intensity`, alpha max), the DEFAULT vignette technique at offset
 *     0.18, and the EffectPass's final `alpha = clamp(alpha, 0, 1)`.
 *
 * All targets are HalfFloat, linear-filtered, clamp-to-edge, no depth/stencil, no mipmaps: what the library
 * got from `initialize(frameBufferType)` on this app's HalfFloat composer.
 *
 * ## The one deliberate difference: the threshold is folded into the first downsample
 *
 * The library ran the threshold as its own full-resolution pass into its own target, which the first
 * downsample then read. Here the first downsample reads the composer's input buffer directly and applies
 * the mask to each TAP. That removes one full-resolution read + write per frame and one full-size target:
 * 16 draws instead of 17. The user chose this ("faster, near-identical"). Measured on the M1 (ANGLE/Metal,
 * interleaved A/B against the library's own EffectPass, each synced by a readback of its output): 8.4 ->
 * 7.0 ms at 2880x1800, 3.7 -> 3.2 ms at 1920x1080 (medians; the whole bloom/CA/vignette stage).
 *
 * It is near-identical, not identical, because the mask now sees the BILINEAR average of the 2x2 texels a
 * tap lands on rather than each texel on its own. Where a whole footprint is above or below the threshold
 * the two agree exactly. Where a footprint straddles it they differ: a bright feature thinner than two
 * texels is averaged with its dark surround before it is masked, so a DIM one-pixel line can drop out of
 * the bloom where the library kept it, and a dark texel beside a bright one is let through at its own
 * level. Measured against the library on a synthetic frame (same M1 harness): large and soft highlights
 * within 0.1-2.5% of the library's bloom, a smooth gradient crossing the threshold within 1%, one-pixel
 * lines and per-pixel noise 10-50% off locally, whole-frame bloom energy within +3%/-6%. Worth watching on
 * the line-art scenes in the parity check.
 *
 * With the threshold switched off and the library's own luminance target fed in, the pyramid matches the
 * library to float rounding everywhere except taps that land EXACTLY on the frame border (every edge pixel
 * of every level, for an even-sized source). The library's `>= 0.0 && <= 1.0` test keeps those taps; whether
 * a given GPU's interpolation rounds them to just inside or just outside is an accident (the M1 drops them on
 * the left and bottom edges from level 1 down, keeps them at level 0 and on the right and top). Here the
 * test is exact (stage 5 moved it into integer texel space) and keeps them on every edge, so the bloom of
 * content touching the left or bottom edge of the frame is a little stronger than the library's on the M1.
 * The aberration and vignette composite matches the library to 2e-6.
 *
 * ## No colour-space conversion
 *
 * None of these shaders includes `colorspace_fragment`. The chain is linear throughout and `GradePass`,
 * which is always last, does the one conversion for the whole chain (F79/F81; see its header and the
 * chain-order guard in `PostFXChain.tsx`). The library's intermediate targets resolved that include to
 * identity for the same reason (three converts only when drawing to the canvas).
 *
 * ## Shape
 *
 * The house pattern (`GradePass`, `FeedbackPass`): a raw `Pass`, a private `Scene` + `OrthographicCamera` +
 * one `PlaneGeometry(2, 2)` mesh whose material is swapped per sub-pass, `needsSwap = true`, and
 * `setSize` sizing the pyramid. The composer calls `setSize` from `addPass` and from `composer.setSize`,
 * which since stage 5 happens only on a real display change; the render scale reaches the pyramid through
 * the rects, set per frame in `render`. The fifteen targets are created once and only ever grown. Nothing is
 * allocated per frame.
 */

/** Mip levels, the library's `MipmapBlurPass` default (8 downsamples, 7 upsamples). */
export const BLOOM_LEVELS = 8
/** Upsample blend toward the tent (`mix(support, tent, radius)`), the chain's old `radius={0.75}`. */
export const BLOOM_RADIUS = 0.75
/** Width of the threshold's soft knee, `LuminanceMaterial`'s smoothing default. */
export const BLOOM_THRESHOLD_SMOOTHING = 0.03
/** three r178's `luminance()` weights (Rec.709, `ColorManagement` for the linear working space). */
export const BLOOM_LUMA = [0.2126, 0.7152, 0.0722] as const
/** Downsample weights: the four diagonal taps at +-1 texel, and the centre plus eight outer taps at +-2. */
export const DOWNSAMPLE_WEIGHT_INNER = 0.125
export const DOWNSAMPLE_WEIGHT_OUTER = 0.05556
/** Upsample tent: corners, edges, centre. */
export const UPSAMPLE_WEIGHTS = { corner: 0.0625, edge: 0.125, centre: 0.25 } as const
/** Vignette offset, the chain's old `offset={0.18}` (fixed; darkness is the live dial). */
export const VIGNETTE_OFFSET = 0.18
/** Values at mount, matching the old JSX so the first frame before `useFrame` runs is the same. */
export const BLOOM_FINISH_INITIAL = { intensity: 0.8, threshold: 0.18, darkness: 0.85 } as const

/**
 * Sizes of the pyramid's levels for a frame of `width` x `height`: level 0 is half the frame, each level
 * after it half the one before, every halving `Math.round`ed exactly as `MipmapBlurPass.setSize` does
 * (so an odd size rounds UP: 1921 -> 961). Downsample `i` and upsample `i` (for i < levels - 1) share
 * size `i`. The allocation is this of the full size; each frame's level rects are this of the frame's rect
 * (computed in place in `render`, not by calling this). Rounding is monotonic, so a rect's levels never
 * exceed the allocation's. Pure; allocates, so it is for `setSize` and tests, never the frame loop.
 */
export function bloomLevelSizes(
  width: number,
  height: number,
  levels: number = BLOOM_LEVELS,
): Array<{ width: number; height: number }> {
  const sizes: Array<{ width: number; height: number }> = []
  let w = width
  let h = height
  for (let i = 0; i < levels; i++) {
    w = Math.round(w * 0.5)
    h = Math.round(h * 0.5)
    sizes.push({ width: w, height: h })
  }
  return sizes
}

/** A JS number as a GLSL float literal (always carries a '.' or an exponent, so it is never an int). */
const glf = (n: number): string => {
  const s = String(n)
  return /[.e]/i.test(s) ? s : `${s}.0`
}

const LUMA_GLSL = `vec3(${glf(BLOOM_LUMA[0])}, ${glf(BLOOM_LUMA[1])}, ${glf(BLOOM_LUMA[2])})`

/**
 * The 13-tap downsample. `threshold` builds the level-0 variant, which reads the composer's input and
 * masks every tap (the folded threshold, see the header); the other seven levels read the level above.
 * Two programs rather than a uniform branch, so neither pays for the other's path.
 *
 * Tap order and accumulation order are the library's (inner four, outer eight, centre last), so the sums
 * round the same way.
 */
function downsampleFrag(threshold: boolean): string {
  return /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  /** The SOURCE's rect: (w, h) in texels, (1 / allocW, 1 / allocH) — frameRect.ts. */
  uniform vec4 uSrcRect;
  /** Source texels per destination texel, the source rect over this level's rect (about 2). */
  uniform vec2 uSrcPerDst;
${threshold ? '  uniform float uThreshold;\n' : ''}${FRAME_RECT_GLSL}
  // Every read of the source goes through here: a position in the source rect's texel space, clamped to its
  // texel centres, so no tap reaches the stale texels outside the rect.
  vec4 readSource(vec2 pos) {
    return texture2D(tDiffuse, rectTexel(pos, uSrcRect));
  }

  vec4 tap(vec2 pos) {
    vec4 t = readSource(pos);${
      threshold
        ? `
    // The folded threshold: LuminanceMaterial's colour-output mask, applied per tap.
    t *= smoothstep(uThreshold, uThreshold + ${glf(BLOOM_THRESHOLD_SMOOTHING)}, dot(t.rgb, ${LUMA_GLSL}));`
        : ''
    }
    return t;
  }

  // The library's clampToBorder: a tap outside the source contributes nothing, and the rest are NOT
  // renormalised, so the frame's edge darkens the bloom exactly as it did. Tested against the source RECT, in
  // its texel space, where a tap on the border lands on an exact integer: gl_FragCoord is exactly a texel
  // centre and the source is twice the destination for any even size, so the library's edge-of-[0, 1]
  // rounding accident cannot happen here (see the header).
  float inBorder(vec2 pos) {
    return float(pos.x >= 0.0 && pos.x <= uSrcRect.x && pos.y >= 0.0 && pos.y <= uSrcRect.y);
  }

  const float W_INNER = ${glf(DOWNSAMPLE_WEIGHT_INNER)};
  const float W_OUTER = ${glf(DOWNSAMPLE_WEIGHT_OUTER)};

  void main() {
    // This fragment's centre in the source's texel space (the library's vUv * srcSize).
    vec2 p = gl_FragCoord.xy * uSrcPerDst;
    vec4 c = vec4(0.0);
    vec2 pos;
    pos = p + vec2(-1.0,  1.0); c += W_INNER * inBorder(pos) * tap(pos);
    pos = p + vec2( 1.0,  1.0); c += W_INNER * inBorder(pos) * tap(pos);
    pos = p + vec2(-1.0, -1.0); c += W_INNER * inBorder(pos) * tap(pos);
    pos = p + vec2( 1.0, -1.0); c += W_INNER * inBorder(pos) * tap(pos);
    pos = p + vec2(-2.0,  2.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2( 0.0,  2.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2( 2.0,  2.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2(-2.0,  0.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2( 2.0,  0.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2(-2.0, -2.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2( 0.0, -2.0); c += W_OUTER * inBorder(pos) * tap(pos);
    pos = p + vec2( 2.0, -2.0); c += W_OUTER * inBorder(pos) * tap(pos);
    c += W_OUTER * tap(p);
    gl_FragColor = c;
  }
`
}

/** Level 0: reads the composer's input and applies the folded threshold. Exported for the tests. */
export const BLOOM_DOWNSAMPLE_THRESHOLD_FRAG = downsampleFrag(true)
/** Levels 1-7. Exported for the tests. */
export const BLOOM_DOWNSAMPLE_FRAG = downsampleFrag(false)

/** The 9-tap tent upsample, blended toward the same-size downsample by `uRadius`. Exported for the tests. */
export const BLOOM_UPSAMPLE_FRAG = /* glsl */ `
  precision highp float;
  /** The smaller level coming up the pyramid. */
  uniform sampler2D tDiffuse;
  /** The downsample of this level's own size. */
  uniform sampler2D tSupport;
  /** The source (smaller) level's rect, and the support's (this level's own) — frameRect.ts. */
  uniform vec4 uSrcRect;
  uniform vec4 uSupportRect;
  /** Source texels per destination texel (about 0.5). */
  uniform vec2 uSrcPerDst;
  uniform float uRadius;
${FRAME_RECT_GLSL}
  // Every read goes through one of these two: a position in that texture's rect texel space, clamped to the
  // rect's texel centres (the library's clamp-to-edge, on the rect instead of the texture).
  vec4 readSource(vec2 pos) {
    return texture2D(tDiffuse, rectTexel(pos, uSrcRect));
  }
  vec4 readSupport(vec2 pos) {
    return texture2D(tSupport, rectTexel(pos, uSupportRect));
  }

  void main() {
    // This fragment's centre in the source's texel space (the library's vUv * srcSize).
    vec2 p = gl_FragCoord.xy * uSrcPerDst;
    vec4 c = vec4(0.0);
    c += readSource(p + vec2(-1.0,  1.0)) * ${glf(UPSAMPLE_WEIGHTS.corner)};
    c += readSource(p + vec2( 0.0,  1.0)) * ${glf(UPSAMPLE_WEIGHTS.edge)};
    c += readSource(p + vec2( 1.0,  1.0)) * ${glf(UPSAMPLE_WEIGHTS.corner)};
    c += readSource(p + vec2(-1.0,  0.0)) * ${glf(UPSAMPLE_WEIGHTS.edge)};
    c += readSource(p) * ${glf(UPSAMPLE_WEIGHTS.centre)};
    c += readSource(p + vec2( 1.0,  0.0)) * ${glf(UPSAMPLE_WEIGHTS.edge)};
    c += readSource(p + vec2(-1.0, -1.0)) * ${glf(UPSAMPLE_WEIGHTS.corner)};
    c += readSource(p + vec2( 0.0, -1.0)) * ${glf(UPSAMPLE_WEIGHTS.edge)};
    c += readSource(p + vec2( 1.0, -1.0)) * ${glf(UPSAMPLE_WEIGHTS.corner)};
    // The support is this level's own size, so its texel is exactly this fragment's.
    gl_FragColor = mix(readSupport(gl_FragCoord.xy), c, uRadius);
  }
`

/**
 * The full-resolution composite: aberration, then bloom, then vignette — the order the library's merged
 * EffectPass ran them in (CONVOLUTION effects sort first). Exported for the tests.
 */
export const BLOOM_COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  /** The frame's rect in the input buffer, and the bloom map's (pyramid level 0's) — frameRect.ts. */
  uniform vec4 uInputRect;
  uniform vec4 uBloomRect;
  uniform float uIntensity;
  /** Aberration offset in uv, before the aspect correction. */
  uniform vec2 uCaOffset;
  /** Input width / height. */
  uniform float uAspect;
  uniform float uDarkness;
  varying vec2 vUv;
${FRAME_RECT_GLSL}
  // Every read goes through one of these two: a frame coordinate (0..1) mapped into that texture's rect and
  // clamped to its texel centres, so the aberration's offset taps cannot reach outside the frame.
  vec4 readInput(vec2 uv) {
    return texture2D(tDiffuse, rectUv(uv, uInputRect));
  }
  vec4 readBloom(vec2 uv) {
    return texture2D(tBloom, rectUv(uv, uBloomRect));
  }

  void main() {
    vec4 color = readInput(vUv);

    // 1. Chromatic aberration (ChromaticAberrationEffect, radial modulation off). Red and blue are pulled
    // from either side of the pixel along the offset; green stays put. At a zero offset it is skipped, which
    // is what the library's vActive did (its output at zero offset is the input unchanged).
    vec2 shift = uCaOffset * vec2(1.0, uAspect);
    if (shift.x != 0.0 || shift.y != 0.0) {
      vec2 ra = readInput(vUv + shift).ra;
      vec2 ba = readInput(vUv - shift).ba;
      color = vec4(ra.x, color.g, ba.x, max(max(ra.y, ba.y), color.a));
    }

    // 2. Bloom, with the R3F wrapper's ADD blend: rgb adds, alpha takes the max.
    vec4 bloom = readBloom(vUv) * uIntensity;
    color = vec4(color.rgb + bloom.rgb, max(color.a, bloom.a));

    // 3. Vignette (VignetteEffect, DEFAULT technique). smoothstep with edge0 > edge1 is the library's own
    // inverted ramp, kept verbatim.
    float d = distance(vUv, vec2(0.5));
    color.rgb *= smoothstep(0.8, ${glf(VIGNETTE_OFFSET)} * 0.799, d * (uDarkness + ${glf(VIGNETTE_OFFSET)}));

    // The merged EffectPass's own last step.
    color.a = clamp(color.a, 0.0, 1.0);
    gl_FragColor = color;
  }
`

/** A pyramid level's target: what `MipmapBlurPass` got from `initialize(HalfFloatType)`. */
function makeLevelTarget(name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.name = name
  return target
}

function makeMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    blending: THREE.NoBlending,
    toneMapped: false,
    depthWrite: false,
    depthTest: false,
  })
}

/** Grow a target to at least `w x h`, never shrinking either axis. A fresh (1 x 1) target always takes the size. */
function grow(target: THREE.WebGLRenderTarget, w: number, h: number): void {
  if (target.width >= w && target.height >= h) return
  target.setSize(Math.max(target.width, w), Math.max(target.height, h))
}

export class BloomFinishPass extends Pass {
  private readonly downsampleThresholdMaterial: THREE.ShaderMaterial
  private readonly downsampleMaterial: THREE.ShaderMaterial
  private readonly upsampleMaterial: THREE.ShaderMaterial
  private readonly compositeMaterial: THREE.ShaderMaterial
  private readonly fsScene: THREE.Scene
  private readonly quad: THREE.Mesh
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera
  /** `BLOOM_LEVELS` targets, largest first. */
  private readonly downsampleTargets: THREE.WebGLRenderTarget[]
  /** `BLOOM_LEVELS - 1` targets, largest first; `upsampleTargets[0]` is the bloom map. */
  private readonly upsampleTargets: THREE.WebGLRenderTarget[]

  constructor() {
    super('BloomFinishPass')
    this.needsSwap = true
    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    this.downsampleThresholdMaterial = makeMaterial(BLOOM_DOWNSAMPLE_THRESHOLD_FRAG, {
      tDiffuse: { value: null },
      uSrcRect: { value: new THREE.Vector4(1, 1, 1, 1) },
      uSrcPerDst: { value: new THREE.Vector2(2, 2) },
      uThreshold: { value: BLOOM_FINISH_INITIAL.threshold },
    })
    this.downsampleMaterial = makeMaterial(BLOOM_DOWNSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uSrcRect: { value: new THREE.Vector4(1, 1, 1, 1) },
      uSrcPerDst: { value: new THREE.Vector2(2, 2) },
    })
    this.upsampleMaterial = makeMaterial(BLOOM_UPSAMPLE_FRAG, {
      tDiffuse: { value: null },
      tSupport: { value: null },
      uSrcRect: { value: new THREE.Vector4(1, 1, 1, 1) },
      uSupportRect: { value: new THREE.Vector4(1, 1, 1, 1) },
      uSrcPerDst: { value: new THREE.Vector2(0.5, 0.5) },
      uRadius: { value: BLOOM_RADIUS },
    })
    this.compositeMaterial = makeMaterial(BLOOM_COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      uInputRect: { value: new THREE.Vector4(1, 1, 1, 1) },
      uBloomRect: { value: new THREE.Vector4(1, 1, 1, 1) },
      uIntensity: { value: BLOOM_FINISH_INITIAL.intensity },
      uCaOffset: { value: new THREE.Vector2(0, 0) },
      uAspect: { value: 1 },
      uDarkness: { value: BLOOM_FINISH_INITIAL.darkness },
    })

    this.quad = new THREE.Mesh(this.quadGeometry, this.compositeMaterial)
    this.quad.frustumCulled = false
    this.fsScene = new THREE.Scene()
    this.fsScene.add(this.quad)

    this.downsampleTargets = []
    for (let i = 0; i < BLOOM_LEVELS; i++) this.downsampleTargets.push(makeLevelTarget(`BloomFinishPass.down${i}`))
    this.upsampleTargets = []
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) this.upsampleTargets.push(makeLevelTarget(`BloomFinishPass.up${i}`))
    this.compositeMaterial.uniforms.tBloom.value = this.upsampleTargets[0].texture
  }

  /** Bloom strength (the old `bloom.intensity`) and luminance threshold (the old `luminanceMaterial.threshold`). */
  setBloom(intensity: number, threshold: number): void {
    this.compositeMaterial.uniforms.uIntensity.value = intensity
    this.downsampleThresholdMaterial.uniforms.uThreshold.value = threshold
  }

  /** Chromatic-aberration offset in uv (the old `ChromaticAberrationEffect.offset`); (0, 0) is off. */
  setAberration(x: number, y: number): void {
    ;(this.compositeMaterial.uniforms.uCaOffset.value as THREE.Vector2).set(x, y)
  }

  /** Vignette darkness (the old `VignetteEffect.darkness`). */
  setVignette(darkness: number): void {
    this.compositeMaterial.uniforms.uDarkness.value = darkness
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    if (!inputBuffer || (!outputBuffer && !this.renderToScreen)) return
    const quad = this.quad
    const down = this.downsampleTargets
    const up = this.upsampleTargets
    const composite = this.compositeMaterial
    const inRect = rectOf(inputBuffer, composite.uniforms.uInputRect.value)

    // Aim every level at its share of the frame's rect: the library's Math.round halving chain, run on the
    // rect instead of the buffer, so the levels fit the targets `setSize` allocated from the full size.
    let w = inRect.x
    let h = inRect.y
    for (let i = 0; i < down.length; i++) {
      w = Math.max(1, Math.round(w * 0.5))
      h = Math.max(1, Math.round(h * 0.5))
      setRect(down[i], w, h)
      if (i < up.length) setRect(up[i], w, h)
    }

    // Downsample. Level 0 reads the composer's input with the threshold folded in; each later level reads
    // the one above it. Positions are in the SOURCE's texel space, as the library's uTexel was 1 / source.
    let src: THREE.WebGLRenderTarget = inputBuffer
    for (let i = 0; i < down.length; i++) {
      const material = i === 0 ? this.downsampleThresholdMaterial : this.downsampleMaterial
      const srcRect = rectOf(src, material.uniforms.uSrcRect.value)
      material.uniforms.tDiffuse.value = src.texture
      ;(material.uniforms.uSrcPerDst.value as THREE.Vector2).set(
        srcRect.x / down[i].viewport.z,
        srcRect.y / down[i].viewport.w,
      )
      quad.material = material
      renderer.setRenderTarget(down[i])
      renderer.render(this.fsScene, this.orthoCamera)
      src = down[i]
    }

    // Upsample from the smallest downsample back to level 0, each blended toward its same-size downsample.
    const upMaterial = this.upsampleMaterial
    const uu = upMaterial.uniforms
    quad.material = upMaterial
    for (let i = up.length - 1; i >= 0; i--) {
      uu.tDiffuse.value = src.texture
      uu.tSupport.value = down[i].texture
      const srcRect = rectOf(src, uu.uSrcRect.value)
      rectOf(down[i], uu.uSupportRect.value)
      ;(uu.uSrcPerDst.value as THREE.Vector2).set(srcRect.x / up[i].viewport.z, srcRect.y / up[i].viewport.w)
      renderer.setRenderTarget(up[i])
      renderer.render(this.fsScene, this.orthoCamera)
      src = up[i]
    }

    // Composite at the frame's resolution. `tBloom` is bound once in the constructor (upsample 0 never
    // changes object); its rect is level 0's.
    rectOf(up[0], composite.uniforms.uBloomRect.value)
    composite.uniforms.tDiffuse.value = inputBuffer.texture
    composite.uniforms.uAspect.value = inRect.x / inRect.y
    quad.material = composite
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.fsScene, this.orthoCamera)
  }

  /**
   * Allocates the pyramid for a frame of the composer's size (the full drawing buffer), as
   * `MipmapBlurPass.setSize` did — but only ever GROWS a target, per axis. The composer calls this from
   * `addPass` and on a real display change; the render scale never reaches it (F272 stage 5), and a
   * smaller display is served by the rects `render` sets inside the larger allocation. Resizing a target
   * only reallocates its GPU storage when the size actually changes.
   */
  setSize(width: number, height: number): void {
    const sizes = bloomLevelSizes(Math.max(1, width), Math.max(1, height))
    for (let i = 0; i < this.downsampleTargets.length; i++) {
      const { width: w, height: h } = sizes[i]
      grow(this.downsampleTargets[i], w, h)
      if (i < this.upsampleTargets.length) grow(this.upsampleTargets[i], w, h)
    }
  }

  dispose(): void {
    this.downsampleThresholdMaterial.dispose()
    this.downsampleMaterial.dispose()
    this.upsampleMaterial.dispose()
    this.compositeMaterial.dispose()
    this.quadGeometry.dispose()
    for (const target of this.downsampleTargets) target.dispose()
    for (const target of this.upsampleTargets) target.dispose()
    super.dispose()
  }
}

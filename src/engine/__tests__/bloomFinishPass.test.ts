import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { MipmapBlurPass } from 'postprocessing'
import {
  BLOOM_COMPOSITE_FRAG,
  BLOOM_DOWNSAMPLE_FRAG,
  BLOOM_DOWNSAMPLE_THRESHOLD_FRAG,
  BLOOM_FINISH_INITIAL,
  BLOOM_LEVELS,
  BLOOM_LUMA,
  BLOOM_RADIUS,
  BLOOM_THRESHOLD_SMOOTHING,
  BLOOM_UPSAMPLE_FRAG,
  BloomFinishPass,
  DOWNSAMPLE_WEIGHT_INNER,
  DOWNSAMPLE_WEIGHT_OUTER,
  UPSAMPLE_WEIGHTS,
  VIGNETTE_OFFSET,
  bloomLevelSizes,
} from '../BloomFinishPass'

/**
 * `BloomFinishPass` (F272 stage 4): the in-repo rebuild of the library Bloom + ChromaticAberration +
 * Vignette that the chain used to mount.
 *
 * No GL context exists in this suite (vitest runs in `node`), so what is checked is what carries the
 * design without one: the constants the shaders are built from, the level sizes, the composite's stage
 * order, that every declared uniform has a JS value, that every texture read goes through the per-shader
 * helper stage 5 will extend, and the draw sequence against a stub renderer. Whether the GLSL compiles and
 * whether the picture matches the library's is the on-device parity check, and is not faked here.
 */

type Private = {
  downsampleThresholdMaterial: THREE.ShaderMaterial
  downsampleMaterial: THREE.ShaderMaterial
  upsampleMaterial: THREE.ShaderMaterial
  compositeMaterial: THREE.ShaderMaterial
  downsampleTargets: THREE.WebGLRenderTarget[]
  upsampleTargets: THREE.WebGLRenderTarget[]
}
const internals = (pass: BloomFinishPass) => pass as unknown as Private

/** Declared uniform names in a shader source. */
const declaredUniforms = (src: string) => [...src.matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1])

/** A render target with just the fields the pass reads. */
function stubBuffer(width: number, height: number, id: string) {
  return { width, height, texture: { id } } as unknown as THREE.WebGLRenderTarget
}

/** A stand-in renderer that records every draw: the target, the material and a copy of its uniforms. */
function stubRenderer() {
  type Draw = {
    target: unknown
    material: THREE.ShaderMaterial
    input: unknown
    support: unknown
    texel: [number, number] | null
  }
  const draws: Draw[] = []
  let target: unknown = undefined
  const gl = {
    setRenderTarget(t: unknown) {
      target = t
    },
    render(scene: THREE.Scene) {
      const material = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
      const u = material.uniforms
      const texel = u.uTexel ? (u.uTexel.value as THREE.Vector2) : null
      draws.push({
        target,
        material,
        input: u.tDiffuse.value,
        support: u.tSupport?.value,
        texel: texel ? [texel.x, texel.y] : null,
      })
    },
  }
  return { gl: gl as unknown as THREE.WebGLRenderer, draws }
}

describe('the constants the shaders are built from', () => {
  it('downsample weights sum to 1 (four inner taps, eight outer taps and the centre)', () => {
    expect(4 * DOWNSAMPLE_WEIGHT_INNER + 9 * DOWNSAMPLE_WEIGHT_OUTER).toBeCloseTo(1, 3)
    for (const src of [BLOOM_DOWNSAMPLE_THRESHOLD_FRAG, BLOOM_DOWNSAMPLE_FRAG]) {
      expect(src.match(/c \+= W_INNER \* inBorder\(uv\) \* tap\(uv\);/g)).toHaveLength(4)
      expect(src.match(/c \+= W_OUTER \* inBorder\(uv\) \* tap\(uv\);/g)).toHaveLength(8)
      expect(src.match(/c \+= W_OUTER \* tap\(vUv\);/g)).toHaveLength(1)
      expect(src).toContain(`const float W_INNER = ${DOWNSAMPLE_WEIGHT_INNER};`)
      expect(src).toContain(`const float W_OUTER = ${DOWNSAMPLE_WEIGHT_OUTER};`)
    }
  })

  it('upsample tent weights sum to exactly 1', () => {
    const { corner, edge, centre } = UPSAMPLE_WEIGHTS
    expect(4 * corner + 4 * edge + centre).toBe(1)
    expect(BLOOM_UPSAMPLE_FRAG.match(/\) \* 0\.0625;/g)).toHaveLength(4)
    expect(BLOOM_UPSAMPLE_FRAG.match(/\) \* 0\.125;/g)).toHaveLength(4)
    expect(BLOOM_UPSAMPLE_FRAG.match(/\) \* 0\.25;/g)).toHaveLength(1)
  })

  it('the threshold knee is 0.03 wide, the library LuminanceMaterial smoothing default', () => {
    expect(BLOOM_THRESHOLD_SMOOTHING).toBe(0.03)
    expect(BLOOM_DOWNSAMPLE_THRESHOLD_FRAG).toContain('smoothstep(uThreshold, uThreshold + 0.03,')
  })

  it("luminance weights are Rec.709, the same as three's luminance() for the working colour space", () => {
    expect([...BLOOM_LUMA]).toEqual([0.2126, 0.7152, 0.0722])
    // (Typed as returning a tuple; it fills and returns the Vector3 it is given.)
    const three = new THREE.Vector3()
    THREE.ColorManagement.getLuminanceCoefficients(three)
    expect([three.x, three.y, three.z]).toEqual([...BLOOM_LUMA])
    expect(BLOOM_DOWNSAMPLE_THRESHOLD_FRAG).toContain('dot(t.rgb, vec3(0.2126, 0.7152, 0.0722))')
  })

  it('only level 0 carries the threshold (the fold), and it masks all four channels', () => {
    expect(BLOOM_DOWNSAMPLE_THRESHOLD_FRAG).toMatch(/t \*= smoothstep\(/)
    expect(BLOOM_DOWNSAMPLE_FRAG).not.toMatch(/smoothstep|uThreshold/)
  })

  it('carries the old mount values (radius 0.75, 8 levels, intensity 0.8, threshold 0.18, vignette 0.18/0.85)', () => {
    expect(BLOOM_RADIUS).toBe(0.75)
    expect(BLOOM_LEVELS).toBe(8)
    expect(BLOOM_FINISH_INITIAL).toEqual({ intensity: 0.8, threshold: 0.18, darkness: 0.85 })
    expect(VIGNETTE_OFFSET).toBe(0.18)
  })
})

/**
 * One tap of a convolution: where it samples (in source texels from the pixel), its weight, and whether it
 * goes through the clampToBorder test.
 */
type Tap = { offset: [number, number]; weight: number; clamped: boolean }

/** The library's own mip-blur materials, from a live `MipmapBlurPass` (neither is in the package's types). */
function libraryBlurMaterials() {
  const lib = new MipmapBlurPass()
  const { downsamplingMaterial: down, upsamplingMaterial: up } = lib as unknown as {
    downsamplingMaterial: THREE.ShaderMaterial
    upsamplingMaterial: THREE.ShaderMaterial
  }
  return { lib, down, up }
}

/**
 * The library's downsample, tap by tap, in accumulation order. Its vertex shader names each offset
 * (`vUv00=vUv+texelSize*vec2(-1.0,1.0)`); its fragment shader sets a weight vector over four clamp tests
 * (`w=WEIGHT_INNER*vec4(clampToBorder(vUv00),...)`), then reads `c+=w.x*texture2D(inputBuffer,vUv00)`, and
 * ends with the unclamped centre `c+=WEIGHT_OUTER*texture2D(inputBuffer,vUv)`.
 */
function libraryDownsampleTaps(vert: string, frag: string): Tap[] {
  const offsetOf = new Map<string, [number, number]>([['vUv', [0, 0]]])
  for (const m of vert.matchAll(/(vUv\d+)=vUv\+texelSize\*vec2\(([-\d.]+),([-\d.]+)\)/g))
    offsetOf.set(m[1], [Number(m[2]), Number(m[3])])
  const define = (name: string) => Number(frag.match(new RegExp(`#define ${name} ([\\d.]+)`))![1])
  const taps: Tap[] = []
  let weight = NaN
  let clampedUvs: string[] = []
  const token =
    /w=(WEIGHT_\w+)\*vec4\(clampToBorder\((vUv\d+)\),clampToBorder\((vUv\d+)\),clampToBorder\((vUv\d+)\),clampToBorder\((vUv\d+)\)\)|c\+=w\.([xyzw])\*texture2D\(inputBuffer,(vUv\d*)\)|c\+=(WEIGHT_\w+)\*texture2D\(inputBuffer,(vUv\d*)\)/g
  for (const m of frag.matchAll(token)) {
    if (m[1]) {
      weight = define(m[1])
      clampedUvs = [m[2], m[3], m[4], m[5]]
    } else if (m[6]) {
      // The clamp test a tap is weighted by must be its OWN uv's.
      expect(clampedUvs['xyzw'.indexOf(m[6])]).toBe(m[7])
      taps.push({ offset: offsetOf.get(m[7])!, weight, clamped: true })
    } else {
      taps.push({ offset: offsetOf.get(m[9])!, weight: define(m[8]), clamped: false })
    }
  }
  return taps
}

/** Ours, tap by tap: `uv = vUv + uTexel * vec2(x, y); c += W_* * inBorder(uv) * tap(uv);`, centre last. */
function ourDownsampleTaps(frag: string): Tap[] {
  const consts = new Map<string, number>()
  for (const m of frag.matchAll(/const float (W_\w+) = ([\d.]+);/g)) consts.set(m[1], Number(m[2]))
  const taps: Tap[] = []
  const token =
    /uv = vUv \+ uTexel \* vec2\(\s*([-\d.]+),\s*([-\d.]+)\); c \+= (W_\w+) \* inBorder\(uv\) \* tap\(uv\);|c \+= (W_\w+) \* tap\(vUv\);/g
  for (const m of frag.matchAll(token)) {
    if (m[3]) taps.push({ offset: [Number(m[1]), Number(m[2])], weight: consts.get(m[3])!, clamped: true })
    else taps.push({ offset: [0, 0], weight: consts.get(m[4])!, clamped: false })
  }
  return taps
}

/** The library's upsample: `vUv0=vUv+texelSize*vec2(...)` offsets, `c+=texture2D(inputBuffer,vUv0)*0.0625` reads. */
function libraryUpsampleTaps(vert: string, frag: string): Tap[] {
  const offsetOf = new Map<string, [number, number]>([['vUv', [0, 0]]])
  for (const m of vert.matchAll(/(vUv\d)=vUv\+texelSize\*vec2\(([-\d.]+),([-\d.]+)\)/g))
    offsetOf.set(m[1], [Number(m[2]), Number(m[3])])
  return [...frag.matchAll(/c\+=texture2D\(inputBuffer,(vUv\d?)\)\*([\d.]+);/g)].map((m) => ({
    offset: offsetOf.get(m[1])!,
    weight: Number(m[2]),
    clamped: false,
  }))
}

/** Ours: `c += readSource(vUv + uTexel * vec2(x, y)) * w;`, the centre as `readSource(vUv) * w`. */
function ourUpsampleTaps(frag: string): Tap[] {
  return [
    ...frag.matchAll(/c \+= readSource\(vUv(?: \+ uTexel \* vec2\(\s*([-\d.]+),\s*([-\d.]+)\))?\) \* ([\d.]+);/g),
  ].map((m) => ({
    offset: m[1] === undefined ? ([0, 0] as [number, number]) : ([Number(m[1]), Number(m[2])] as [number, number]),
    weight: Number(m[3]),
    clamped: false,
  }))
}

describe("tap for tap against the library's own mip-blur materials (postprocessing 6.39.2)", () => {
  it('downsample: the same 13 offsets, in the same order, each with the same weight and clamp test', () => {
    const { lib, down } = libraryBlurMaterials()
    const theirs = libraryDownsampleTaps(down.vertexShader, down.fragmentShader)
    // The parse itself found the whole kernel (so an empty match on both sides cannot pass).
    expect(theirs).toHaveLength(13)
    expect(theirs.filter((t) => t.weight === DOWNSAMPLE_WEIGHT_INNER)).toHaveLength(4)
    expect(theirs.filter((t) => !t.clamped)).toEqual([{ offset: [0, 0], weight: DOWNSAMPLE_WEIGHT_OUTER, clamped: false }])
    for (const [name, src] of [
      ['level 0 (threshold)', BLOOM_DOWNSAMPLE_THRESHOLD_FRAG],
      ['levels 1-7', BLOOM_DOWNSAMPLE_FRAG],
    ] as const) {
      expect(ourDownsampleTaps(src), name).toEqual(theirs)
    }
    lib.dispose()
  })

  it('upsample: the same 9 offsets, in the same order, each with the same tent weight, then the same mix', () => {
    const { lib, up } = libraryBlurMaterials()
    const theirs = libraryUpsampleTaps(up.vertexShader, up.fragmentShader)
    expect(theirs).toHaveLength(9)
    expect(ourUpsampleTaps(BLOOM_UPSAMPLE_FRAG)).toEqual(theirs)
    // Blended toward the same-size downsample at the pixel itself, by the radius.
    expect(up.fragmentShader).toContain('vec4 baseColor=texture2D(supportBuffer,vUv);gl_FragColor=mix(baseColor,c,radius);')
    expect(BLOOM_UPSAMPLE_FRAG).toContain('gl_FragColor = mix(readSupport(vUv), c, uRadius);')
    lib.dispose()
  })
})

describe('bloomLevelSizes', () => {
  it("halves with Math.round from the frame's size, level 0 at half", () => {
    expect(bloomLevelSizes(1920, 1080)).toEqual([
      { width: 960, height: 540 },
      { width: 480, height: 270 },
      { width: 240, height: 135 },
      { width: 120, height: 68 },
      { width: 60, height: 34 },
      { width: 30, height: 17 },
      { width: 15, height: 9 },
      { width: 8, height: 5 },
    ])
    // Odd sizes round UP at every halving.
    expect(bloomLevelSizes(1921, 1081)[0]).toEqual({ width: 961, height: 541 })
    // Never reaches zero from a positive size.
    expect(bloomLevelSizes(3, 1).every((s) => s.width >= 1 && s.height >= 1)).toBe(true)
  })

  it("matches the library MipmapBlurPass's own sizing for a spread of canvas sizes", () => {
    const lib = new MipmapBlurPass()
    lib.levels = BLOOM_LEVELS
    const internalsOf = lib as unknown as {
      downsamplingMipmaps: THREE.WebGLRenderTarget[]
      upsamplingMipmaps: THREE.WebGLRenderTarget[]
    }
    for (const [w, h] of [
      [1920, 1080],
      [2880, 1800],
      [3840, 2160],
      [1536, 864],
      [1151, 647],
      [1, 1],
    ]) {
      lib.setSize(w, h)
      const ours = bloomLevelSizes(w, h)
      const theirs = internalsOf.downsamplingMipmaps.map((t) => ({ width: t.width, height: t.height }))
      expect(ours, `${w}x${h}`).toEqual(theirs)
      expect(internalsOf.upsamplingMipmaps).toHaveLength(BLOOM_LEVELS - 1)
    }
    lib.dispose()
  })
})

describe('BloomFinishPass, built without a renderer', () => {
  it('gives every declared uniform in each shader a JS value (a declared-but-unset uniform is a black frame)', () => {
    const p = internals(new BloomFinishPass())
    const pairs: Array<[string, string, THREE.ShaderMaterial]> = [
      ['downsample (threshold)', BLOOM_DOWNSAMPLE_THRESHOLD_FRAG, p.downsampleThresholdMaterial],
      ['downsample', BLOOM_DOWNSAMPLE_FRAG, p.downsampleMaterial],
      ['upsample', BLOOM_UPSAMPLE_FRAG, p.upsampleMaterial],
      ['composite', BLOOM_COMPOSITE_FRAG, p.compositeMaterial],
    ]
    for (const [name, src, material] of pairs) {
      const declared = declaredUniforms(src)
      expect(declared.length, name).toBeGreaterThan(0)
      for (const u of declared) expect(Object.keys(material.uniforms), `${name}: ${u}`).toContain(u)
      expect(material.fragmentShader).toBe(src)
    }
  })

  it('sizes the pyramid from setSize: 8 downsamples, 7 upsamples sharing the first 7 sizes', () => {
    const pass = new BloomFinishPass()
    pass.setSize(2880, 1800)
    const p = internals(pass)
    const sizes = bloomLevelSizes(2880, 1800)
    expect(p.downsampleTargets).toHaveLength(BLOOM_LEVELS)
    expect(p.upsampleTargets).toHaveLength(BLOOM_LEVELS - 1)
    p.downsampleTargets.forEach((t, i) => expect([t.width, t.height]).toEqual([sizes[i].width, sizes[i].height]))
    p.upsampleTargets.forEach((t, i) => expect([t.width, t.height]).toEqual([sizes[i].width, sizes[i].height]))
    // A degenerate size is clamped rather than handed to GL.
    pass.setSize(0, 0)
    expect(p.downsampleTargets[0].width).toBe(1)
  })

  it('allocates the targets once: a resize reuses the same objects', () => {
    const pass = new BloomFinishPass()
    const p = internals(pass)
    const before = [...p.downsampleTargets, ...p.upsampleTargets]
    pass.setSize(1920, 1080)
    pass.setSize(1280, 720)
    expect([...p.downsampleTargets, ...p.upsampleTargets]).toEqual(before)
    for (const t of before) {
      expect(t.texture.type).toBe(THREE.HalfFloatType)
      expect(t.texture.minFilter).toBe(THREE.LinearFilter)
      expect(t.texture.magFilter).toBe(THREE.LinearFilter)
      expect(t.texture.generateMipmaps).toBe(false)
      expect(t.depthBuffer).toBe(false)
    }
  })

  it('writes the three setters onto the uniforms', () => {
    const pass = new BloomFinishPass()
    const p = internals(pass)
    expect(p.compositeMaterial.uniforms.uIntensity.value).toBe(0.8)
    expect(p.downsampleThresholdMaterial.uniforms.uThreshold.value).toBe(0.18)
    expect(p.compositeMaterial.uniforms.uDarkness.value).toBe(0.85)
    expect(p.upsampleMaterial.uniforms.uRadius.value).toBe(0.75)
    pass.setBloom(1.3, 0.4)
    pass.setAberration(0.002, -0.001)
    pass.setVignette(0.5)
    expect(p.compositeMaterial.uniforms.uIntensity.value).toBe(1.3)
    expect(p.downsampleThresholdMaterial.uniforms.uThreshold.value).toBe(0.4)
    const ca = p.compositeMaterial.uniforms.uCaOffset.value as THREE.Vector2
    expect([ca.x, ca.y]).toEqual([0.002, -0.001])
    expect(p.compositeMaterial.uniforms.uDarkness.value).toBe(0.5)
  })

  it('draws the pyramid in the library order: 8 down, 7 up (smallest first), then the composite', () => {
    const pass = new BloomFinishPass()
    pass.setSize(1920, 1080)
    const p = internals(pass)
    const input = stubBuffer(1920, 1080, 'input')
    const output = stubBuffer(1920, 1080, 'output')
    const { gl, draws } = stubRenderer()
    pass.render(gl, input, output)

    expect(draws).toHaveLength(BLOOM_LEVELS + (BLOOM_LEVELS - 1) + 1)
    // Downsamples: level 0 reads the composer's input with the threshold material, texel = 1/input size.
    expect(draws[0].material).toBe(p.downsampleThresholdMaterial)
    expect(draws[0].input).toBe(input.texture)
    expect(draws[0].texel).toEqual([1 / 1920, 1 / 1080])
    expect(draws[0].target).toBe(p.downsampleTargets[0])
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const src = p.downsampleTargets[i - 1]
      expect(draws[i].material).toBe(p.downsampleMaterial)
      expect(draws[i].input).toBe(src.texture)
      expect(draws[i].texel).toEqual([1 / src.width, 1 / src.height])
      expect(draws[i].target).toBe(p.downsampleTargets[i])
    }
    // Upsamples: from the smallest downsample, support = same-size downsample, texel = 1/source size.
    let src = p.downsampleTargets[BLOOM_LEVELS - 1]
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const i = BLOOM_LEVELS - 2 - k
      const d = draws[BLOOM_LEVELS + k]
      expect(d.material).toBe(p.upsampleMaterial)
      expect(d.input).toBe(src.texture)
      expect(d.support).toBe(p.downsampleTargets[i].texture)
      expect(d.texel).toEqual([1 / src.width, 1 / src.height])
      expect(d.target).toBe(p.upsampleTargets[i])
      src = p.upsampleTargets[i]
    }
    // Composite: reads the input and the largest upsample, writes the output buffer.
    const last = draws[draws.length - 1]
    expect(last.material).toBe(p.compositeMaterial)
    expect(last.input).toBe(input.texture)
    expect(last.target).toBe(output)
    expect(p.compositeMaterial.uniforms.tBloom.value).toBe(p.upsampleTargets[0].texture)
    expect(p.compositeMaterial.uniforms.uAspect.value).toBeCloseTo(1920 / 1080, 12)
  })

  it('writes to the screen when it is the last pass, and swaps buffers like every house pass', () => {
    const pass = new BloomFinishPass()
    pass.setSize(640, 360)
    expect(pass.needsSwap).toBe(true)
    pass.renderToScreen = true
    const { gl, draws } = stubRenderer()
    pass.render(gl, stubBuffer(640, 360, 'input'), stubBuffer(640, 360, 'output'))
    expect(draws[draws.length - 1].target).toBeNull()
  })
})

describe('the shader sources', () => {
  const all: Array<[string, string]> = [
    ['downsample (threshold)', BLOOM_DOWNSAMPLE_THRESHOLD_FRAG],
    ['downsample', BLOOM_DOWNSAMPLE_FRAG],
    ['upsample', BLOOM_UPSAMPLE_FRAG],
    ['composite', BLOOM_COMPOSITE_FRAG],
  ]

  it('the composite runs aberration, then bloom, then vignette, then the alpha clamp (the merged EffectPass order)', () => {
    const at = (s: string) => {
      const i = BLOOM_COMPOSITE_FRAG.indexOf(s)
      expect(i, `expected the composite to contain: ${s}`).toBeGreaterThanOrEqual(0)
      return i
    }
    const ca = at('color = vec4(ra.x, color.g, ba.x, max(max(ra.y, ba.y), color.a));')
    const bloom = at('color = vec4(color.rgb + bloom.rgb, max(color.a, bloom.a));')
    const vignette = at('color.rgb *= smoothstep(0.8, 0.18 * 0.799, d * (uDarkness + 0.18));')
    const clamp = at('color.a = clamp(color.a, 0.0, 1.0);')
    expect(ca).toBeLessThan(bloom)
    expect(bloom).toBeLessThan(vignette)
    expect(vignette).toBeLessThan(clamp)
    // The aberration's aspect correction and zero-offset skip, as in ChromaticAberrationEffect.
    at('vec2 shift = uCaOffset * vec2(1.0, uAspect);')
    at('if (shift.x != 0.0 || shift.y != 0.0)')
  })

  it('routes every texture read through a per-shader read* helper (the one place F272 stage 5 edits)', () => {
    for (const [name, src] of all) {
      const reads = src.match(/texture2D\(/g) ?? []
      const helpers = src.match(/vec4 read\w+\(vec2 uv\) \{\s*return texture2D\(\w+, uv\);\s*\}/g) ?? []
      expect(reads.length, name).toBeGreaterThan(0)
      expect(helpers.length, name).toBe(reads.length)
    }
  })

  it('does no colour-space conversion (GradePass, always last, owns the only one)', () => {
    for (const [name, src] of all) expect(src, name).not.toMatch(/colorspace_fragment|linearToOutputTexel/)
  })

  it('keeps the library clampToBorder: out-of-range taps weigh zero and are not renormalised', () => {
    for (const src of [BLOOM_DOWNSAMPLE_THRESHOLD_FRAG, BLOOM_DOWNSAMPLE_FRAG]) {
      expect(src).toContain('return float(uv.s >= 0.0 && uv.s <= 1.0 && uv.t >= 0.0 && uv.t <= 1.0);')
      expect(src).toMatch(/gl_FragColor = c;/)
    }
  })

  it('is well-formed: no leaked template holes', () => {
    for (const [name, src] of all) expect(src, name).not.toMatch(/undefined|NaN|\$\{|\[object/)
  })
})

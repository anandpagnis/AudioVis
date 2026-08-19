import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { KP_BUF_A, KP_BUF_B, KP_BUF_C, KP_BUF_D, KP_IMAGE } from './shaders/kernelPanicGlsl'

/* ==========================================================================
 * ██  NON-COMMERCIAL — DO NOT SHIP  ████████████████████████████████████████
 *
 * Port of an unlicensed Shadertoy work. Shadertoy's default licence is
 *
 *     Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported
 *     https://creativecommons.org/licenses/by-nc-sa/3.0/
 *
 * so absent an explicit grant this is NonCommercial. It MUST NOT appear in a
 * commercial release, a marketplace listing, or any public revenue-generating
 * distribution without separate written permission. ShareAlike would further
 * require any distributed derivative to carry the same licence, which would
 * encumber this codebase — so remove rather than relicense.
 *
 * Present state: PERSONAL / PRIVATE USE ONLY.
 *
 * Marked `license: 'noncommercial'`; `nonCommercialSceneIds()` derives the
 * packaging exclusion list from that field and sceneLicensing.test.ts fails if
 * it is removed. See docs/HANDOFF.md.
 * ========================================================================== */

/**
 * Kernel Panic — a corrupted terminal crash screen.
 *
 * **The GLSL is a verbatim port**, on request: the original uint hashing, the
 * three 1200-entry character tables, the 40-second scripted timeline and the
 * five-stage buffer chain are all unchanged. See `shaders/kernelPanicGlsl.ts`.
 * The only host additions are `uFade` (the engine's crossfade weight, without
 * which the scene cannot transition at all), a brightness scale for the
 * additive exposure budget, and `uGlitchBoost` added to GLITCH — which at 0
 * reproduces the original exactly.
 *
 * ## Why this is the only GLSL3 scene
 *
 * The source needs GLSL ES 3.00: `uint` with bitwise ops, `floatBitsToUint`,
 * `int[40*30] = int[](...)` array constructors, `textureSize`, `textureLod`.
 * None exist in GLSL ES 1.00, which every other scene here targets. Rather than
 * rewrite the maths, these materials set `glslVersion: THREE.GLSL3`.
 *
 * That works without touching the shared vertex shader: three.js's GLSL3
 * prelude defines `attribute`->`in`, `varying`->`out`/`in`, `texture2D`->
 * `texture`, and `gl_FragColor`->`pc_fragColor`, so `FULLSCREEN_VERT` and the
 * original fragment bodies both compile unmodified.
 *
 * ## The font atlas, decoded from the LUT macros
 *
 * The source needs a glyph atlas it does not ship. Its macros give the layout
 * away: `_A = 11*16+1`, `_P = 10*16+0`, `_0 = 16*12+0`, `_h = 13*16+3`.
 *
 * Those are ASCII cells with the ROW INDEX FLIPPED — 'A' is ASCII 65, row 4
 * col 1, and 15-4 = 11. 'P' is 80, row 5 col 0, and 15-5 = 10. '0' is 48, row 3
 * col 0, and 15-3 = 12. `_h` is row 13 col 3, which flips to row 2 col 3 =
 * ASCII 35 = '#', matching the rules and separators in the reference image.
 *
 * So the atlas is a plain 16x16 ASCII grid sampled bottom-up. Drawing ASCII
 * code c into canvas cell (c%16, c/16) with `CanvasTexture`'s default
 * `flipY = true` reproduces exactly that, and every macro resolves correctly
 * with no changes to the shader.
 *
 * ## Chain
 *
 *   A  text grid, feedback on itself       ping-pong
 *   B  vertical smear of A (2x height), feedback on itself   ping-pong
 *   C  vertical blur of B (50 px)
 *   D  A + B + horizontal blur of C (100 px)
 *   -> image: block displacement + RGB-split over D
 *
 * Six render targets. All four offscreen passes share one scene and quad,
 * swapping material between renders. `useSceneFrame` runs at `useFrame`
 * priority 0 and `EffectComposer` at 1, so the whole chain lands before the
 * composer takes the frame.
 */

const BRIGHTNESS = 0.55
const ATLAS = 16
const CELL_PX = 16

/**
 * 16x16 ASCII glyph atlas, white on black.
 *
 * `flipY` is left at its `CanvasTexture` default of true — that flip is what
 * makes the source's row-flipped macros resolve. See the header.
 */
function buildFontTexture(): THREE.CanvasTexture {
  const size = ATLAS * CELL_PX
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${CELL_PX - 2}px ui-monospace, "Cascadia Mono", Consolas, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let code = 32; code < 127; code++) {
    ctx.fillText(
      String.fromCharCode(code),
      (code % ATLAS) * CELL_PX + CELL_PX / 2,
      Math.floor(code / ATLAS) * CELL_PX + CELL_PX / 2,
    )
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** Shadertoy's uniform surface, one set per pass. */
function shadertoyUniforms(): Record<string, THREE.IUniform> {
  return {
    iResolution: { value: new THREE.Vector3(1, 1, 1) },
    iTime: { value: 0 },
    iFrame: { value: 0 },
    iMouse: { value: new THREE.Vector4(0, 0, 0, 0) },
    iChannelResolution: {
      value: [
        new THREE.Vector3(1, 1, 1),
        new THREE.Vector3(1, 1, 1),
        new THREE.Vector3(1, 1, 1),
        new THREE.Vector3(1, 1, 1),
      ],
    },
    iChannel0: { value: null },
    iChannel1: { value: null },
    iChannel2: { value: null },
    iChannel3: { value: null },
  }
}

export function KernelPanicScene() {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const clock = useRef(0)
  const frame = useRef(0)

  const font = useMemo(() => buildFontTexture(), [])

  const mats = useMemo(() => {
    const mk = (fragmentShader: string, extra: Record<string, THREE.IUniform> = {}) =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader,
        depthWrite: false,
        depthTest: false,
        uniforms: { ...shadertoyUniforms(), ...extra },
      })
    const image = mk(KP_IMAGE, {
      uFade: { value: 0 },
      uGlitchBoost: { value: 0 },
      U_BRIGHTNESS: { value: BRIGHTNESS },
    })
    image.transparent = true
    image.blending = THREE.AdditiveBlending
    return { a: mk(KP_BUF_A), b: mk(KP_BUF_B), c: mk(KP_BUF_C), d: mk(KP_BUF_D), image }
  }, [])

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  const rt = useMemo(() => {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false }
    const mk = () => new THREE.WebGLRenderTarget(1, 1, opts)
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(geometry, mats.a)
    scene.add(mesh)
    return {
      a0: mk(),
      a1: mk(),
      b0: mk(),
      b1: mk(),
      c: mk(),
      d: mk(),
      aRead: null as THREE.WebGLRenderTarget | null,
      bRead: null as THREE.WebGLRenderTarget | null,
      scene,
      mesh,
      camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    }
  }, [geometry, mats])

  useDispose(
    mats.a, mats.b, mats.c, mats.d, mats.image, geometry, font,
    rt.a0, rt.a1, rt.b0, rt.b1, rt.c, rt.d,
  )

  useEffect(() => {
    // CSS pixels, deliberately independent of DPR: the governor moves DPR as
    // tiers change, and reallocating these would wipe both feedback buffers
    // every time it did.
    const w = Math.max(1, Math.floor(size.width))
    const h = Math.max(1, Math.floor(size.height))
    for (const t of [rt.a0, rt.a1, rt.b0, rt.b1, rt.c, rt.d]) t.setSize(w, h)
    for (const m of [mats.a, mats.b, mats.c, mats.d, mats.image]) {
      m.uniforms.iResolution.value.set(w, h, 1)
      for (const cr of m.uniforms.iChannelResolution.value as THREE.Vector3[]) cr.set(w, h, 1)
    }
    // Buffer A samples the font atlas on channel 0.
    mats.a.uniforms.iChannelResolution.value[0].set(ATLAS * CELL_PX, ATLAS * CELL_PX, 1)
  }, [rt, mats, size])

  useSceneFrame(({ dt, b, vis, params }) => {
    clock.current += dt * params.speed
    frame.current += 1
    const t = clock.current
    const fr = frame.current

    for (const m of [mats.a, mats.b, mats.c, mats.d, mats.image]) {
      m.uniforms.iTime.value = t
      m.uniforms.iFrame.value = fr
    }

    const prevTarget = gl.getRenderTarget()
    const draw = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
      rt.mesh.material = mat
      gl.setRenderTarget(target)
      gl.render(rt.scene, rt.camera)
    }

    // A: text + its own previous frame.
    const aPrev = rt.aRead ?? rt.a1
    const aNext = aPrev === rt.a0 ? rt.a1 : rt.a0
    mats.a.uniforms.iChannel0.value = font
    mats.a.uniforms.iChannel1.value = aPrev.texture
    draw(mats.a, aNext)
    rt.aRead = aNext

    // B: long vertical smear of A, with its own previous frame.
    const bPrev = rt.bRead ?? rt.b1
    const bNext = bPrev === rt.b0 ? rt.b1 : rt.b0
    mats.b.uniforms.iChannel0.value = aNext.texture
    mats.b.uniforms.iChannel1.value = bPrev.texture
    draw(mats.b, bNext)
    rt.bRead = bNext

    // C: shorter vertical blur of B.
    mats.c.uniforms.iChannel0.value = bNext.texture
    draw(mats.c, rt.c)

    // D: A + B + horizontal blur of C.
    mats.d.uniforms.iChannel0.value = aNext.texture
    mats.d.uniforms.iChannel1.value = bNext.texture
    mats.d.uniforms.iChannel2.value = rt.c.texture
    draw(mats.d, rt.d)

    gl.setRenderTarget(prevTarget)

    mats.image.uniforms.iChannel3.value = rt.d.texture
    // At 0 this is exactly the original's scripted ramp; transients push it.
    mats.image.uniforms.uGlitchBoost.value = b.transient * 1.6 + b.energy * 0.4
    mats.image.uniforms.uFade.value = vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={mats.image} attach="material" />
    </mesh>
  )
}

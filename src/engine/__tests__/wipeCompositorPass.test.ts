import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import WIPE_PASS_SRC from '../WipeCompositorPass.ts?raw'
import { WipeCompositorPass } from '../WipeCompositorPass'
import { WIPE_NOISE_CELLS, WIPE_NOISE_SIZE } from '../transitionWipe'

/** The pass's private ShaderMaterial, for uniform / source inspection. No GL context is needed to build one. */
const materialOf = (pass: WipeCompositorPass) =>
  (pass as unknown as { material: THREE.ShaderMaterial }).material

describe('WipeCompositorPass: cost shape of the fragment shader (source pins; the GL result is integration-only)', () => {
  const frag = materialOf(new WipeCompositorPass()).fragmentShader

  it('no longer computes value noise per pixel: the sin-hash noise is gone, the baked field is sampled instead', () => {
    expect(frag).not.toContain('vnoise')
    expect(frag).not.toContain('hash2')
    expect(frag).toContain('uniform sampler2D uNoise;')
    expect(frag).toMatch(/texture2D\(uNoise,/)
  })

  it('ink and iris take only the taps the mask needs (exact 0 / 1 early-outs), via one shared helper', () => {
    expect(frag).toContain('vec3 pickOrMix(vec2 uv, float m)')
    expect(frag).toMatch(/if \(m <= 0\.0\) return texture2D\(uCaptureOut/)
    expect(frag).toMatch(/if \(m >= 1\.0\) return texture2D\(uCaptureIn/)
    expect(frag.match(/pickOrMix\(vUv, maskIn\)/g)?.length).toBe(2)
  })

  it('datamosh no longer samples both captures for every channel: agreeing blocks take one tap, seam blocks two', () => {
    expect(frag).not.toContain('wipeColor.r = revealR ?')
    expect(frag).toMatch(/if \(revealR && revealG && revealB\)/)
    expect(frag).toMatch(/else if \(!revealR && !revealG && !revealB\)/)
  })

  it('derives its noise sampling scale from the period of the baked field, so shader and builder cannot drift', () => {
    expect(WIPE_PASS_SRC).toContain('WIPE_NOISE_CELLS')
    expect(frag).toContain((6 / WIPE_NOISE_CELLS).toFixed(8))
    expect(frag).toContain((13 / WIPE_NOISE_CELLS).toFixed(8))
  })
})

describe('WipeCompositorPass: baked noise texture lifecycle', () => {
  it('builds nothing at construction (most sessions never run an ink wipe)', () => {
    expect(materialOf(new WipeCompositorPass()).uniforms.uNoise.value).toBeNull()
  })

  it('builds a tiling, linearly filtered, mipmap-free field on the first ink wipe, and only once', () => {
    const pass = new WipeCompositorPass()
    pass.setWipe('inkDissolve', 0.3, 0.1, 7, null, null)
    const tex = materialOf(pass).uniforms.uNoise.value as THREE.DataTexture
    expect(tex).toBeInstanceOf(THREE.DataTexture)
    expect(tex.image.width).toBe(WIPE_NOISE_SIZE)
    expect(tex.image.height).toBe(WIPE_NOISE_SIZE)
    expect(tex.wrapS).toBe(THREE.RepeatWrapping)
    expect(tex.wrapT).toBe(THREE.RepeatWrapping)
    expect(tex.minFilter).toBe(THREE.LinearFilter)
    expect(tex.generateMipmaps).toBe(false)
    pass.setWipe('inkDissolve', 0.6, 0.1, 7, null, null)
    expect(materialOf(pass).uniforms.uNoise.value).toBe(tex)
  })

  it('does not build it for iris or datamosh', () => {
    const pass = new WipeCompositorPass()
    pass.setWipe('irisWipe', 0.5, 0.1, 1, null, null)
    pass.setWipe('datamosh', 0.5, 0.1, 1, null, null)
    expect(materialOf(pass).uniforms.uNoise.value).toBeNull()
  })

  it('dispose frees the texture', () => {
    const pass = new WipeCompositorPass()
    pass.setWipe('inkDissolve', 0.3, 0.1, 7, null, null)
    const tex = materialOf(pass).uniforms.uNoise.value as THREE.DataTexture
    let disposed = false
    tex.addEventListener('dispose', () => {
      disposed = true
    })
    pass.dispose()
    expect(disposed).toBe(true)
  })
})

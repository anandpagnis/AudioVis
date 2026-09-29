import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { BLIT_CUBIC_MAX_TIER, BLIT_CUBIC_TENSION, blitCubicFor, rectUvCoord } from '../frameRect'
import { GRADE_FRAG, GradePass } from '../GradePass'
import { quality } from '../quality'

/**
 * GradePass as the upscaler (F272 stage 5): the chain renders the frame into a sub-rect of full-size
 * buffers, and this pass, last, draws it to the whole canvas. What is checked without a GPU: which filter
 * it picks and what rect it samples, against a stub renderer, and the shader's sampling structure. Whether
 * it compiles, and that the 0.6-scale output matches the 1.0 one, is the on-device harness's job.
 */

/** A composer buffer: allocated at `w x h`, the frame in its bottom-left `rw x rh`. */
function buffer(w: number, h: number, rw: number, rh: number): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h)
  t.viewport.set(0, 0, rw, rh)
  return t
}

/** Records the target and the uniforms of each draw; the canvas viewport is `canvasW x canvasH`. */
function stubRenderer(canvasW: number, canvasH: number) {
  let target: THREE.WebGLRenderTarget | null = null
  const draws: Array<{ target: THREE.WebGLRenderTarget | null; srcRect: number[]; cubic: number }> = []
  let material: THREE.ShaderMaterial | null = null
  const gl = {
    setRenderTarget(t: THREE.WebGLRenderTarget | null) {
      target = t
    },
    getCurrentViewport(v: THREE.Vector4) {
      return target ? v.copy(target.viewport) : v.set(0, 0, canvasW, canvasH)
    },
    render(scene: THREE.Scene) {
      material = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
      draws.push({
        target,
        srcRect: (material.uniforms.uSrcRect.value as THREE.Vector4).toArray(),
        cubic: material.uniforms.uCubic.value as number,
      })
    },
  }
  return { gl: gl as unknown as THREE.WebGLRenderer, draws }
}

function draw(tier: number, rectW: number, rectH: number, canvasW = 2880, canvasH = 1800) {
  quality.pinTier(tier)
  const pass = new GradePass()
  pass.renderToScreen = true
  const { gl, draws } = stubRenderer(canvasW, canvasH)
  pass.render(gl, buffer(canvasW, canvasH, rectW, rectH), buffer(canvasW, canvasH, rectW, rectH), 1 / 60)
  expect(draws).toHaveLength(1)
  return draws[0]
}

describe('GradePass upscale selection', () => {
  afterEach(() => quality.setMode('auto'))

  it('draws the whole canvas from the frame’s rect: uSrcRect is the rect over the allocation', () => {
    const d = draw(0, 1728, 1080)
    expect(d.target).toBeNull()
    expect(d.srcRect).toEqual([1728, 1080, 1 / 2880, 1 / 1800])
  })

  it('is bicubic while upscaled on a top quality tier', () => {
    for (let tier = 0; tier <= BLIT_CUBIC_MAX_TIER; tier++) {
      expect(draw(tier, 1728, 1080).cubic, `tier ${tier}`).toBe(BLIT_CUBIC_TENSION)
    }
  })

  it('is bilinear below the top tiers, so a struggling machine never pays for the cubic', () => {
    for (let tier = BLIT_CUBIC_MAX_TIER + 1; tier <= 4; tier++) {
      expect(draw(tier, 1728, 1080).cubic, `tier ${tier}`).toBe(0)
    }
  })

  it('is bilinear at 1:1 on every tier (an exact copy — there is nothing to reconstruct)', () => {
    for (let tier = 0; tier <= 4; tier++) expect(draw(tier, 2880, 1800).cubic).toBe(0)
  })

  it('judges the upscale against what the draw covers, not against the buffer', () => {
    // The same rect drawn to a smaller canvas (a window at a lower DPR) can be 1:1.
    expect(draw(0, 1440, 900, 1440, 900).cubic).toBe(0)
    expect(blitCubicFor(1440, 1440, 0)).toBe(0)
  })

  it('keys on the RESOLUTION tier, so the new-scene caution (detail only) does not flip the filter', () => {
    quality.pinTier(1)
    expect(quality.resolutionTier).toBe(1)
    expect(draw(1, 1728, 1080).cubic).toBe(BLIT_CUBIC_TENSION)
  })
})

describe('GRADE_FRAG sampling (the upscale)', () => {
  it('samples the rect in its own texel space, iris folded into the same resample', () => {
    expect(GRADE_FRAG).toContain('vec2 pos = uv * uSrcRect.xy;')
    const upscale = GRADE_FRAG.indexOf('vec2 pos = uv * uSrcRect.xy;')
    expect(GRADE_FRAG.indexOf('vec2 uv = uIris > 0.0')).toBeLessThan(upscale)
  })

  it('takes the shared cubic when uCubic is on, the clamped bilinear read otherwise', () => {
    expect(GRADE_FRAG).toContain('col = rectCubic(tDiffuse, pos, uSrcRect, uCubic).rgb;')
    expect(GRADE_FRAG).toContain('col = texture2D(tDiffuse, rectTexel(pos, uSrcRect)).rgb;')
  })

  it('every texture read is clamped to the rect, including the four sharpen taps at +-1 source texel', () => {
    const reads = [...GRADE_FRAG.matchAll(/texture2D\((\w+), ([^;]+)\)\.rgb;/g)].filter((m) => m[1] === 'tDiffuse')
    expect(reads.length).toBe(5)
    for (const m of reads) expect(m[2]).toMatch(/^rectTexel\(pos( \+ vec2\([-\d. ,]+\))?, uSrcRect\)$/)
    for (const off of ['vec2(0.0, -1.0)', 'vec2(0.0,  1.0)', 'vec2(-1.0, 0.0)', 'vec2( 1.0, 0.0)']) {
      expect(GRADE_FRAG).toContain(`rectTexel(pos + ${off}, uSrcRect)`)
    }
  })

  it('at 1:1 with no iris, each canvas pixel lands on its own texel centre (an exact copy)', () => {
    // pos = vUv * rect with rect = canvas: the pixel centre (x + 0.5) / W maps to texel x's centre.
    const W = 2880
    for (const x of [0, 1, 1439, 2879]) expect(rectUvCoord((x + 0.5) / W, W, W) * W).toBeCloseTo(x + 0.5, 9)
  })
})

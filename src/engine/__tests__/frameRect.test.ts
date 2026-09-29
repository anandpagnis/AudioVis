import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FRAME_RECT_CUBIC_GLSL,
  FRAME_RECT_GLSL,
  RECT_COPY_FRAG,
  halfSize,
  rectOf,
  rectTexelCoord,
  rectUvCoord,
  setFrameRect,
  setFullRect,
  setRect,
} from '../frameRect'
import { RectRenderPass, createRectRenderPass } from '../RectRenderPass'
import { renderScale } from '../renderScale'

/**
 * The frame's sub-rect (F272 stage 5): the shared rect maths every post pass samples through, the helpers
 * that aim a target at a rect, and the scene pass that aims the composer's buffers each frame.
 *
 * No GL context in this suite, so the GLSL is checked by its TypeScript mirror (`rectTexelCoord` /
 * `rectUvCoord`, one axis each) and by its source; whether it compiles is the on-device check.
 */

/** A bilinear read of a 1-D texture at a normalised coordinate, CLAMP_TO_EDGE, as the GPU does it. */
function bilinear(data: number[], u: number): number {
  const x = u * data.length - 0.5
  const x0 = Math.floor(x)
  const f = x - x0
  const at = (i: number) => data[Math.min(data.length - 1, Math.max(0, i))]
  return at(x0) * (1 - f) + at(x0 + 1) * f
}

describe('rectTexel / rectUv — the one mapping every pass samples through', () => {
  it('at full size it is the identity on texel centres and CLAMP_TO_EDGE outside them', () => {
    const N = 64
    for (let x = 0; x < N; x++) expect(rectUvCoord((x + 0.5) / N, N, N)).toBeCloseTo((x + 0.5) / N, 12)
    expect(rectUvCoord(0, N, N)).toBeCloseTo(0.5 / N, 12)
    expect(rectUvCoord(1, N, N)).toBeCloseTo((N - 0.5) / N, 12)
  })

  it('maps 0..1 of the FRAME onto the rect, so the picture is the same at any scale', () => {
    const alloc = 2880
    for (const rect of [2880, 2016, 1728, 1152]) {
      // The frame's centre is the rect's centre, in the rect's own texel space.
      expect(rectUvCoord(0.5, rect, alloc) * alloc).toBeCloseTo(rect / 2, 9)
      // A frame-pixel centre reads exactly its own texel.
      for (const x of [0, 1, rect >> 1, rect - 1]) {
        expect(rectUvCoord((x + 0.5) / rect, rect, alloc) * alloc).toBeCloseTo(x + 0.5, 9)
      }
    }
  })

  it('never reaches a stale texel: every coordinate, however far out, stays inside the rect’s texel centres', () => {
    const alloc = 100
    const rect = 37
    for (let u = -2; u <= 3; u += 0.013) {
      const t = rectUvCoord(u, rect, alloc) * alloc
      expect(t).toBeGreaterThanOrEqual(0.5 - 1e-9)
      expect(t).toBeLessThanOrEqual(rect - 0.5 + 1e-9)
    }
    for (let p = -50; p <= 150; p += 0.7) {
      const t = rectTexelCoord(p, rect, alloc) * alloc
      expect(t).toBeGreaterThanOrEqual(0.5 - 1e-9)
      expect(t).toBeLessThanOrEqual(rect - 0.5 + 1e-9)
    }
  })

  it('a bilinear read through it sees only the rect, even with garbage past the rect’s edge', () => {
    // 40 texels allocated, the frame in the first 25; the rest holds an older frame (poison).
    const POISON = 1e6
    const data = Array.from({ length: 40 }, (_, i) => (i < 25 ? i : POISON))
    for (let u = -0.5; u <= 1.5; u += 0.01) {
      expect(bilinear(data, rectUvCoord(u, 25, 40))).toBeLessThanOrEqual(24)
    }
  })

  it('is the GLSL, operation for operation', () => {
    expect(FRAME_RECT_GLSL).toContain('return clamp(pos, vec2(0.5), rect.xy - 0.5) * rect.zw;')
    expect(FRAME_RECT_GLSL).toContain('return rectTexel(uv * rect.xy, rect);')
  })

  it('the shared cubic clamps every one of its taps through rectTexel', () => {
    const taps = [...FRAME_RECT_CUBIC_GLSL.matchAll(/vec2 (t(?:0|3|12)) = (\w+)\(/g)]
    expect(taps.map((m) => m[1])).toEqual(['t0', 't3', 't12'])
    for (const m of taps) expect(m[2]).toBe('rectTexel')
    for (const m of FRAME_RECT_CUBIC_GLSL.matchAll(/texture2D\(tex, ([^;]+)\);/g)) {
      expect(m[1]).toMatch(/^t12$|^vec2\(t(0|3|12)\.x, t(0|3|12)\.y\)$/)
    }
  })

  it('the rect copy reads its source through the rect and nothing else', () => {
    expect(RECT_COPY_FRAG).toContain('gl_FragColor = texture2D(tDiffuse, rectUv(vUv, uRect));')
    expect(RECT_COPY_FRAG.match(/texture2D\(/g)).toHaveLength(1)
  })
})

describe('rectOf / setRect / setFullRect / halfSize', () => {
  const target = (w: number, h: number) => new THREE.WebGLRenderTarget(w, h)

  it('rectOf reads the rect a target was last aimed at, over its allocation', () => {
    const t = target(2880, 1800)
    const out = new THREE.Vector4()
    expect(rectOf(t, out).toArray()).toEqual([2880, 1800, 1 / 2880, 1 / 1800])
    setRect(t, 2016, 1260)
    expect(rectOf(t, out)).toBe(out)
    expect(out.toArray()).toEqual([2016, 1260, 1 / 2880, 1 / 1800])
  })

  it('setRect aims viewport and scissor at the bottom-left rect, scissor on, clamped to the allocation', () => {
    const t = target(100, 50)
    setRect(t, 60.9, 30.2)
    expect(t.viewport.toArray()).toEqual([0, 0, 60, 30])
    expect(t.scissor.toArray()).toEqual([0, 0, 60, 30])
    expect(t.scissorTest).toBe(true)
    setRect(t, 400, 400)
    expect(t.viewport.toArray()).toEqual([0, 0, 100, 50])
    setRect(t, 0, -3)
    expect(t.viewport.toArray()).toEqual([0, 0, 1, 1])
  })

  it('setFullRect aims at the whole allocation with the scissor off (a full clear)', () => {
    const t = target(100, 50)
    setRect(t, 10, 10)
    setFullRect(t)
    expect(t.viewport.toArray()).toEqual([0, 0, 100, 50])
    expect(t.scissorTest).toBe(false)
  })

  it('halfSize is at least 1, rounds like the bloom pyramid, and is monotonic (a half-rect fits its half-allocation)', () => {
    expect(halfSize(1)).toBe(1)
    expect(halfSize(2880)).toBe(1440)
    expect(halfSize(1081)).toBe(541)
    let prev = 0
    for (let n = 1; n <= 4000; n++) {
      const h = halfSize(n)
      expect(h).toBeGreaterThanOrEqual(prev)
      prev = h
    }
  })
})

describe('setFrameRect — the frame is renderScale.internalW x internalH', () => {
  const saved = { cssW: renderScale.cssW, cssH: renderScale.cssH, baseDpr: renderScale.baseDpr, applied: renderScale.applied }
  afterEach(() => {
    renderScale.setDisplay(saved.cssW || 1, saved.cssH || 1, saved.baseDpr || 1)
    renderScale.applied = saved.applied
  })

  it('aims a full-size buffer at exactly the solver’s rect', () => {
    renderScale.setDisplay(1440, 900, 2)
    renderScale.applied = 0.75
    const t = new THREE.WebGLRenderTarget(2880, 1800)
    setFrameRect(t)
    expect(t.viewport.toArray()).toEqual([0, 0, renderScale.internalW, renderScale.internalH])
    expect([renderScale.internalW, renderScale.internalH]).toEqual([2160, 1350])
  })

  it('at scale 1 the rect is the whole buffer', () => {
    renderScale.setDisplay(1440, 900, 2)
    renderScale.applied = 1
    const t = new THREE.WebGLRenderTarget(2880, 1800)
    setFrameRect(t)
    expect(t.viewport.toArray()).toEqual([0, 0, 2880, 1800])
  })

  it('never aims past the buffer, even for one frame of a display the buffer has not caught up with', () => {
    renderScale.setDisplay(1920, 1080, 2)
    renderScale.applied = 1
    const t = new THREE.WebGLRenderTarget(2880, 1800)
    setFrameRect(t)
    expect(t.viewport.toArray()).toEqual([0, 0, 2880, 1800])
  })
})

describe('RectRenderPass — aims both composer buffers before the first draw of the frame', () => {
  function stubRenderer() {
    const seen: Array<{ target: unknown; viewport: number[] | null; scissorTest: boolean | null }> = []
    let target: THREE.WebGLRenderTarget | null = null
    const gl = {
      shadowMap: { autoUpdate: true },
      setRenderTarget(t: THREE.WebGLRenderTarget | null) {
        target = t
      },
      render() {
        seen.push({
          target,
          viewport: target ? target.viewport.toArray() : null,
          scissorTest: target ? target.scissorTest : null,
        })
      },
    }
    return { gl: gl as unknown as THREE.WebGLRenderer, seen }
  }

  afterEach(() => {
    renderScale.setDisplay(1, 1, 1)
    renderScale.applied = 1
  })

  it('writes the frame rect onto input and output, re-applying it after a setSize reset it', () => {
    renderScale.setDisplay(1440, 900, 2)
    renderScale.applied = 0.6
    const pass = createRectRenderPass(new THREE.Scene(), new THREE.PerspectiveCamera())
    expect(pass).toBeInstanceOf(RectRenderPass)
    pass.clearPass.enabled = false
    const input = new THREE.WebGLRenderTarget(2880, 1800)
    const output = new THREE.WebGLRenderTarget(2880, 1800)
    // What EffectComposer.setSize does to the buffers just before render: viewport back to the full size.
    input.setSize(2880, 1800)
    output.setSize(2880, 1800)
    const { gl, seen } = stubRenderer()
    pass.render(gl, input, output)
    const rect = [0, 0, renderScale.internalW, renderScale.internalH]
    expect(rect).toEqual([0, 0, 1728, 1080])
    // The scene was drawn into the rect of the input buffer...
    expect(seen).toEqual([{ target: input, viewport: rect, scissorTest: true }])
    // ...and the output, which the next pass writes, is aimed at the same rect.
    expect(output.viewport.toArray()).toEqual(rect)
    expect(output.scissorTest).toBe(true)
  })
})

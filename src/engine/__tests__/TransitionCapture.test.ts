import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { TransitionCapture, WIPE_CAPTURE_SCALE } from '../TransitionCapture'
import { WIPE_LAYER_IN, WIPE_LAYER_OUT } from '../transitionWipe'

/**
 * `THREE.WebGLRenderTarget` is a plain data object (dimensions + a texture
 * descriptor) until `setRenderTarget`/`render` actually touch it — confirmed
 * directly here (the first test constructs one with no GL context at all,
 * same as `lensPass.test.ts`'s precedent of `new LensPass()` succeeding in
 * vitest's `node` environment with no real WebGL). So `ensureTargets`'
 * allocate-only-when-needed logic is tested against the REAL target class,
 * not a mock standing in for it.
 *
 * `render()`'s actual GL calls (`gl.render(scene, camera)` drawing something
 * meaningful into those targets) are integration-only, exactly like
 * `FeedbackPass.ts`/`MirrorPass.ts`/`LensPass.ts` — none of which have a test
 * file that instantiates a real `THREE.WebGLRenderer` either (`lensPass.test.ts`
 * only ever asserts `Pass.enabled`, its own header says so explicitly: "No GL
 * context is available in this suite"). What CAN be verified without one, and
 * is verified below, is the WIRING: which methods get called, in what order,
 * with what arguments, and that the camera's layer mask is saved and restored
 * around the two capture draws — using a lightweight mock standing in for the
 * renderer, and a REAL `THREE.PerspectiveCamera` (so `.layers` is the real
 * `THREE.Layers` class, not a hand-rolled stand-in).
 */

function makeGlMock() {
  return {
    setRenderTarget: vi.fn(),
    render: vi.fn(),
  }
}

describe('TransitionCapture.ensureTargets — allocate only when needed', () => {
  it('allocates nothing until first called', () => {
    const cap = new TransitionCapture()
    expect(cap.outTarget).toBeNull()
    expect(cap.inTarget).toBeNull()
  })

  it('allocates both targets, scaled by WIPE_CAPTURE_SCALE, on first call', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(1000, 800)
    expect(cap.outTarget).toBeInstanceOf(THREE.WebGLRenderTarget)
    expect(cap.inTarget).toBeInstanceOf(THREE.WebGLRenderTarget)
    expect(cap.outTarget!.width).toBe(Math.round(1000 * WIPE_CAPTURE_SCALE))
    expect(cap.outTarget!.height).toBe(Math.round(800 * WIPE_CAPTURE_SCALE))
    expect(cap.inTarget!.width).toBe(cap.outTarget!.width)
    expect(cap.inTarget!.height).toBe(cap.outTarget!.height)
  })

  it('is half-float, linearly filtered, and has no depth/stencil buffer — same shape as FeedbackPass\'s history target', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(640, 480)
    for (const t of [cap.outTarget!, cap.inTarget!]) {
      expect(t.texture.type).toBe(THREE.HalfFloatType)
      expect(t.texture.minFilter).toBe(THREE.LinearFilter)
      expect(t.texture.magFilter).toBe(THREE.LinearFilter)
      expect(t.depthBuffer).toBe(false)
      expect(t.stencilBuffer).toBe(false)
    }
  })

  it('does not reallocate when called again with the same size', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(1000, 800)
    const out1 = cap.outTarget
    const in1 = cap.inTarget
    const disposeOut = vi.spyOn(out1!, 'dispose')
    const disposeIn = vi.spyOn(in1!, 'dispose')
    cap.ensureTargets(1000, 800)
    expect(cap.outTarget).toBe(out1)
    expect(cap.inTarget).toBe(in1)
    expect(disposeOut).not.toHaveBeenCalled()
    expect(disposeIn).not.toHaveBeenCalled()
  })

  it('reallocates (and disposes the old targets) when the requested size actually changes', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(1000, 800)
    const out1 = cap.outTarget!
    const in1 = cap.inTarget!
    const disposeOut = vi.spyOn(out1, 'dispose')
    const disposeIn = vi.spyOn(in1, 'dispose')
    cap.ensureTargets(500, 400)
    expect(disposeOut).toHaveBeenCalledTimes(1)
    expect(disposeIn).toHaveBeenCalledTimes(1)
    expect(cap.outTarget).not.toBe(out1)
    expect(cap.inTarget).not.toBe(in1)
    expect(cap.outTarget!.width).toBe(Math.round(500 * WIPE_CAPTURE_SCALE))
  })

  it('rounds down to at least 1x1 rather than constructing a degenerate target', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(0, 0)
    expect(cap.outTarget!.width).toBeGreaterThanOrEqual(1)
    expect(cap.outTarget!.height).toBeGreaterThanOrEqual(1)
  })
})

describe('TransitionCapture.render — wiring (mock renderer, real camera/scene)', () => {
  it('does nothing when targets are not yet allocated', () => {
    const cap = new TransitionCapture()
    const gl = makeGlMock()
    const camera = new THREE.PerspectiveCamera()
    const scene = new THREE.Scene()
    cap.render(gl as unknown as THREE.WebGLRenderer, scene, camera)
    expect(gl.setRenderTarget).not.toHaveBeenCalled()
    expect(gl.render).not.toHaveBeenCalled()
  })

  it('renders WIPE_LAYER_OUT into `out`, WIPE_LAYER_IN into `in`, then clears the render target', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(200, 200)
    const gl = makeGlMock()
    const camera = new THREE.PerspectiveCamera()
    const scene = new THREE.Scene()
    const layerCalls: number[] = []
    const originalSet = camera.layers.set.bind(camera.layers)
    camera.layers.set = (channel: number) => {
      layerCalls.push(channel)
      return originalSet(channel)
    }

    cap.render(gl as unknown as THREE.WebGLRenderer, scene, camera)

    expect(layerCalls).toEqual([WIPE_LAYER_OUT, WIPE_LAYER_IN])
    expect(gl.setRenderTarget.mock.calls.map((c) => c[0])).toEqual([cap.outTarget, cap.inTarget, null])
    expect(gl.render).toHaveBeenCalledTimes(2)
    expect(gl.render).toHaveBeenNthCalledWith(1, scene, camera)
    expect(gl.render).toHaveBeenNthCalledWith(2, scene, camera)
  })

  it('restores the camera\'s original layer mask afterward, whatever it was', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(200, 200)
    const gl = makeGlMock()
    const camera = new THREE.PerspectiveCamera()
    camera.layers.enable(5) // an arbitrary pre-existing mask, not just the default
    const savedMask = camera.layers.mask
    const scene = new THREE.Scene()

    cap.render(gl as unknown as THREE.WebGLRenderer, scene, camera)

    expect(camera.layers.mask).toBe(savedMask)
  })

  it('leaves the render target null afterward (every later pass sets its own before rendering)', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(200, 200)
    const gl = makeGlMock()
    const camera = new THREE.PerspectiveCamera()
    const scene = new THREE.Scene()
    cap.render(gl as unknown as THREE.WebGLRenderer, scene, camera)
    expect(gl.setRenderTarget).toHaveBeenLastCalledWith(null)
  })
})

describe('TransitionCapture.dispose', () => {
  it('frees both targets and nulls them out', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(200, 200)
    const out = cap.outTarget!
    const disposeOut = vi.spyOn(out, 'dispose')
    cap.dispose()
    expect(disposeOut).toHaveBeenCalledTimes(1)
    expect(cap.outTarget).toBeNull()
    expect(cap.inTarget).toBeNull()
  })

  it('is safe before anything has ever been allocated', () => {
    const cap = new TransitionCapture()
    expect(() => cap.dispose()).not.toThrow()
  })

  it('is safe to call more than once', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(200, 200)
    cap.dispose()
    expect(() => cap.dispose()).not.toThrow()
  })

  it('allows a fresh allocation after dispose', () => {
    const cap = new TransitionCapture()
    cap.ensureTargets(200, 200)
    cap.dispose()
    cap.ensureTargets(200, 200)
    expect(cap.outTarget).not.toBeNull()
    expect(cap.inTarget).not.toBeNull()
  })
})

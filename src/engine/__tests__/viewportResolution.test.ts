import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bindViewportResolution, writeResolution } from '../viewportResolution'

/**
 * F272 stage 3: pixel-space uniforms follow the target each draw lands in.
 *
 * No GL context in this suite, so the renderer is a fake that implements the
 * one method the binding reads, `getCurrentViewport`, over a viewport the test
 * moves between "draws" — the composer buffer, then a wipe capture target.
 * The object and material are three's real classes.
 */

function fakeRenderer(w: number, h: number) {
  const current = new THREE.Vector4(0, 0, w, h)
  return {
    current,
    getCurrentViewport: (target: THREE.Vector4) => target.copy(current),
  }
}

/** What `renderObject` does first for each draw of `object`. */
function draw(object: THREE.Object3D, renderer: ReturnType<typeof fakeRenderer>) {
  object.onBeforeRender(
    renderer as unknown as THREE.WebGLRenderer,
    new THREE.Scene(),
    new THREE.Camera(),
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
    null as unknown as THREE.Group,
  )
}

function sceneMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uAspect: { value: 1 } },
  })
}

describe('bindViewportResolution', () => {
  it('reports the viewport bound at each draw, not one size per frame', () => {
    const mesh = new THREE.Mesh()
    const seen: [number, number][] = []
    bindViewportResolution(mesh, (w, h) => seen.push([w, h]))
    const gl = fakeRenderer(2102, 1314)
    draw(mesh, gl)
    gl.current.set(0, 0, 504, 315) // a wipe capture target
    draw(mesh, gl)
    expect(seen).toEqual([
      [2102, 1314],
      [504, 315],
    ])
  })

  it('never reports a zero size, so an aspect cannot go NaN', () => {
    const mesh = new THREE.Mesh()
    let got: [number, number] = [0, 0]
    bindViewportResolution(mesh, (w, h) => {
      got = [w, h]
    })
    draw(mesh, fakeRenderer(0, 0))
    expect(got).toEqual([1, 1])
  })

  it('unbinding restores the previous hook, and never removes a newer one', () => {
    const mesh = new THREE.Mesh()
    const original = mesh.onBeforeRender
    const unbind = bindViewportResolution(mesh, () => {})
    expect(mesh.onBeforeRender).not.toBe(original)
    unbind()
    expect(mesh.onBeforeRender).toBe(original)

    const unbindA = bindViewportResolution(mesh, () => {})
    const unbindB = bindViewportResolution(mesh, () => {})
    const hookB = mesh.onBeforeRender
    unbindA()
    expect(mesh.onBeforeRender).toBe(hookB)
    unbindB()
  })
})

describe('writeResolution', () => {
  it('writes uRes and uAspect and flags a re-upload when they change', () => {
    const m = sceneMaterial()
    m.uniformsNeedUpdate = false
    expect(writeResolution(m, 1920, 1080)).toBe(true)
    expect(m.uniforms.uRes.value.toArray()).toEqual([1920, 1080])
    expect(m.uniforms.uAspect.value).toBe(1920 / 1080)
    expect(m.uniformsNeedUpdate).toBe(true)
  })

  it('does not flag a re-upload when nothing changed', () => {
    const m = sceneMaterial()
    writeResolution(m, 1920, 1080)
    m.uniformsNeedUpdate = false
    expect(writeResolution(m, 1920, 1080)).toBe(false)
    expect(m.uniformsNeedUpdate).toBe(false)
  })

  it('writes only the uniforms the material declares', () => {
    const resOnly = new THREE.ShaderMaterial({ uniforms: { uRes: { value: new THREE.Vector2(1, 1) } } })
    expect(writeResolution(resOnly, 800, 600)).toBe(true)
    expect(resOnly.uniforms.uAspect).toBeUndefined()

    const neither = new THREE.ShaderMaterial({ uniforms: {} })
    neither.uniformsNeedUpdate = false
    expect(writeResolution(neither, 800, 600)).toBe(false)
    expect(neither.uniformsNeedUpdate).toBe(false)
  })
})

describe('a bound material across a wipe frame', () => {
  it('follows each target and re-flags only on the draws that move it', () => {
    const m = sceneMaterial()
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m)
    bindViewportResolution(mesh, (w, h) => writeResolution(m, w, h))
    const gl = fakeRenderer(2880, 1800)

    const flags: boolean[] = []
    const drawAt = (w: number, h: number) => {
      gl.current.set(0, 0, w, h)
      m.uniformsNeedUpdate = false
      draw(mesh, gl)
      flags.push(m.uniformsNeedUpdate)
      return m.uniforms.uRes.value.toArray()
    }

    expect(drawAt(2880, 1800)).toEqual([2880, 1800]) // main frame
    expect(drawAt(2880, 1800)).toEqual([2880, 1800]) // main frame again
    expect(drawAt(1008, 630)).toEqual([1008, 630]) // wipe capture
    expect(drawAt(2880, 1800)).toEqual([2880, 1800]) // main frame, next frame
    expect(flags).toEqual([true, false, true, true])
  })
})

describe('runDirectSceneFrame (F272)', () => {
  it("hands update() the main frame's size even when the last draw was a wipe capture", async () => {
    const { runDirectSceneFrame } = await import('../createShaderScene')
    const { renderScale } = await import('../renderScale')
    const saved = { ...renderScale }
    try {
      renderScale.setDisplay(1000, 500, 2)
      renderScale.applied = 0.5 // internal frame: 1000 x 500, aspect 2
      const material = sceneMaterial()
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
      bindViewportResolution(mesh, (w, h) => writeResolution(material, w, h))
      draw(mesh, fakeRenderer(350, 100)) // a capture draw, aspect 3.5, lands last
      expect(material.uniforms.uAspect.value).toBeCloseTo(3.5, 9)

      let seenAspect = -1
      runDirectSceneFrame(material, () => {
        seenAspect = material.uniforms.uAspect.value as number
      }, null)
      expect(seenAspect).toBeCloseTo(renderScale.internalW / renderScale.internalH, 9)
      expect(seenAspect).toBeCloseTo(2, 9)
    } finally {
      Object.assign(renderScale, saved)
    }
  }, 20_000) // imports the whole scene factory, slow under load
})

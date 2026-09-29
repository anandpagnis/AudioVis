import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { EchoPass } from '../EchoPass'
import { ECHO_TAP_COUNT } from '../echoParams'
import { FeedbackPass } from '../FeedbackPass'
import { halfSize } from '../frameRect'

/**
 * The two history passes under F272 stage 5: buffers allocated once at full size (grow only), every frame
 * drawn into a sub-rect, and each stored frame remembering the rect it was written at, so a resolution
 * step does not zoom the trail or the ghosts.
 *
 * No GL context in this suite: a stub renderer records which target each draw and clear lands in, with
 * that target's rect at the time, and a copy of the rect uniforms the material carried.
 */

type Event =
  | { kind: 'clear'; target: THREE.WebGLRenderTarget | null; viewport: number[] | null; scissorTest: boolean | null }
  | { kind: 'draw'; target: THREE.WebGLRenderTarget | null; viewport: number[] | null; uniforms: Record<string, number[]> }

function stubRenderer() {
  const events: Event[] = []
  let target: THREE.WebGLRenderTarget | null = null
  const snap = (t: THREE.WebGLRenderTarget | null) => (t ? t.viewport.toArray() : null)
  const gl = {
    setRenderTarget(t: THREE.WebGLRenderTarget | null) {
      target = t
    },
    getRenderTarget() {
      return target
    },
    clear() {
      events.push({ kind: 'clear', target, viewport: snap(target), scissorTest: target ? target.scissorTest : null })
    },
    render(scene: THREE.Scene) {
      const material = (scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
      const uniforms: Record<string, number[]> = {}
      for (const [name, u] of Object.entries(material.uniforms)) {
        if (u.value instanceof THREE.Vector4) uniforms[name] = u.value.toArray()
      }
      events.push({ kind: 'draw', target, viewport: snap(target), uniforms })
    },
  }
  return { gl: gl as unknown as THREE.WebGLRenderer, events }
}

/** A composer buffer: allocated at `w x h`, the frame in its bottom-left `rw x rh`. */
function buffer(w: number, h: number, rw: number, rh: number): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(w, h)
  t.viewport.set(0, 0, rw, rh)
  t.scissor.set(0, 0, rw, rh)
  t.scissorTest = true
  return t
}

const draws = (events: Event[]) => events.filter((e): e is Extract<Event, { kind: 'draw' }> => e.kind === 'draw')

describe('FeedbackPass — full-resolution trail history, sampled at the scale it was written', () => {
  type Internals = { history: THREE.WebGLRenderTarget | null; blendMaterial: THREE.ShaderMaterial }
  const internals = (p: FeedbackPass) => p as unknown as Internals

  function frame(pass: FeedbackPass, rw: number, rh: number) {
    const { gl, events } = stubRenderer()
    const input = buffer(2880, 1800, rw, rh)
    const output = buffer(2880, 1800, rw, rh)
    pass.render(gl, input, output, 1 / 60)
    return { events, input, output }
  }

  it('allocates the history once at the full size and only grows it', () => {
    const pass = new FeedbackPass()
    pass.setSize(2880, 1800)
    const first = internals(pass).history!
    expect([first.width, first.height]).toEqual([2880, 1800])
    pass.setSize(1280, 720)
    expect(internals(pass).history).toBe(first)
    pass.setSize(2880, 1800)
    expect(internals(pass).history).toBe(first)
    pass.setSize(3840, 2160)
    const grown = internals(pass).history!
    expect(grown).not.toBe(first)
    expect([grown.width, grown.height]).toEqual([3840, 2160])
  })

  it('clears the WHOLE history on the first frame, then records the frame’s rect over the cleared texels', () => {
    const pass = new FeedbackPass()
    pass.setSize(2880, 1800)
    pass.setTrails(0.8)
    const { events } = frame(pass, 2016, 1260)
    const clear = events.find((e) => e.kind === 'clear') as Extract<Event, { kind: 'clear' }>
    expect(clear.target).toBe(internals(pass).history)
    expect(clear.viewport).toEqual([0, 0, 2880, 1800])
    expect(clear.scissorTest).toBe(false)
    // The blend then reads the cleared history through this frame's rect.
    const blend = draws(events)[0]
    expect(blend.uniforms.uHistRect).toEqual([2016, 1260, 1 / 2880, 1 / 1800])
    expect(blend.uniforms.uInRect).toEqual([2016, 1260, 1 / 2880, 1 / 1800])
  })

  it('stores each frame at its own rect, and the next blend samples it with THAT rect across a scale step', () => {
    const pass = new FeedbackPass()
    pass.setSize(2880, 1800)
    pass.setTrails(0.8)
    const history = internals(pass).history!

    const one = frame(pass, 2016, 1260)
    const copy = draws(one.events)[1]
    expect(copy.target).toBe(history)
    expect(copy.viewport).toEqual([0, 0, 2016, 1260])
    expect(copy.uniforms.uRect).toEqual([2016, 1260, 1 / 2880, 1 / 1800])

    // The scale steps down: this frame is 1440x900, last frame's trail is still at 2016x1260.
    const two = frame(pass, 1440, 900)
    const [blend, copy2] = draws(two.events)
    expect(blend.uniforms.uInRect).toEqual([1440, 900, 1 / 2880, 1 / 1800])
    expect(blend.uniforms.uHistRect).toEqual([2016, 1260, 1 / 2880, 1 / 1800])
    expect(copy2.viewport).toEqual([0, 0, 1440, 900])
    // No clear on a scale step: the trail survives it.
    expect(two.events.some((e) => e.kind === 'clear')).toBe(false)

    // And back up: the stored frame is now the 1440x900 one.
    const three = frame(pass, 2880, 1800)
    expect(draws(three.events)[0].uniforms.uHistRect).toEqual([1440, 900, 1 / 2880, 1 / 1800])
  })

  it('reads the frame and the history through the rect clamp in the shader', () => {
    const src = internals(new FeedbackPass()).blendMaterial.fragmentShader
    expect(src).toContain('texture2D(tHistory, rectUv(huv, uHistRect))')
    expect(src).toContain('texture2D(tDiffuse, rectUv(vUv, uInRect))')
    expect(src.match(/texture2D\(/g)).toHaveLength(2)
  })
})

describe('EchoPass — half-resolution taps, each remembering the rect it was recorded at', () => {
  type Internals = { taps: THREE.WebGLRenderTarget[]; blendMaterial: THREE.ShaderMaterial }
  const internals = (p: EchoPass) => p as unknown as Internals

  function frame(pass: EchoPass, rw: number, rh: number, dt: number) {
    const { gl, events } = stubRenderer()
    pass.render(gl, buffer(2880, 1800, rw, rh), buffer(2880, 1800, rw, rh), dt)
    return events
  }

  const rectOfTap = (w: number, h: number) => [w, h, 1 / 1440, 1 / 900]

  it('allocates every tap at HALF the full size, once, growing only', () => {
    const pass = new EchoPass()
    pass.setSize(2880, 1800)
    const taps = [...internals(pass).taps]
    expect(taps).toHaveLength(ECHO_TAP_COUNT)
    for (const t of taps) expect([t.width, t.height]).toEqual([1440, 900])
    pass.setSize(1280, 720)
    expect(internals(pass).taps).toEqual(taps)
    pass.setSize(3841, 2161)
    for (const t of internals(pass).taps) expect([t.width, t.height]).toEqual([halfSize(3841), halfSize(2161)])
  })

  it('records a snapshot into half of the CURRENT rect, and the blend reads each tap through its own rect', () => {
    const pass = new EchoPass()
    pass.setSize(2880, 1800)
    pass.setEcho(0.6, 0.25, 1)
    expect(pass.enabled).toBe(true)

    // First frame: every tap cleared whole, then a snapshot of the 2016x1260 frame at 1008x630.
    const one = frame(pass, 2016, 1260, 0.3)
    const clears = one.filter((e) => e.kind === 'clear') as Array<Extract<Event, { kind: 'clear' }>>
    expect(clears).toHaveLength(ECHO_TAP_COUNT)
    for (const c of clears) {
      expect(c.viewport).toEqual([0, 0, 1440, 900])
      expect(c.scissorTest).toBe(false)
    }
    const [copy, blend] = draws(one)
    expect(copy.target).toBe(internals(pass).taps[0])
    expect(copy.viewport).toEqual([0, 0, 1008, 630])
    expect(copy.uniforms.uRect).toEqual([2016, 1260, 1 / 2880, 1 / 1800])
    expect(blend.uniforms.uInRect).toEqual([2016, 1260, 1 / 2880, 1 / 1800])
    expect(blend.uniforms.uTapRect0).toEqual(rectOfTap(1008, 630))
    // The taps not yet written read their cleared texels at this frame's half-rect.
    expect(blend.uniforms.uTapRect1).toEqual(rectOfTap(1008, 630))

    // The scale steps down; the next snapshot lands at 720x450, the previous ghost keeps 1008x630.
    const two = frame(pass, 1440, 900, 0.3)
    const [copy2, blend2] = draws(two)
    expect(copy2.viewport).toEqual([0, 0, 720, 450])
    expect(blend2.uniforms.uTapRect0).toEqual(rectOfTap(720, 450))
    expect(blend2.uniforms.uTapRect1).toEqual(rectOfTap(1008, 630))
    expect(two.some((e) => e.kind === 'clear')).toBe(false)

    // A frame with no new snapshot still reads every tap at the rect it was written at.
    const three = draws(frame(pass, 2880, 1800, 0.05))
    expect(three).toHaveLength(1)
    expect(three[0].uniforms.uInRect).toEqual([2880, 1800, 1 / 2880, 1 / 1800])
    expect(three[0].uniforms.uTapRect0).toEqual(rectOfTap(720, 450))
    expect(three[0].uniforms.uTapRect1).toEqual(rectOfTap(1008, 630))
  })

  it('the recorded rect rotates with its tap, and a snapshot never exceeds the tap’s allocation', () => {
    const pass = new EchoPass()
    pass.setSize(2880, 1800)
    pass.setEcho(0.6, 0.25, 1)
    frame(pass, 2016, 1260, 0.3) // tap A at 1008x630
    const a = internals(pass).taps[0]
    frame(pass, 2880, 1800, 0.3) // tap B at 1440x900 (the whole half-allocation)
    expect(internals(pass).taps[0].viewport.toArray()).toEqual([0, 0, 1440, 900])
    expect(internals(pass).taps[1]).toBe(a)
    expect(a.viewport.toArray()).toEqual([0, 0, 1008, 630])
  })

  it('samples every tap and the frame through the rect clamp in the shader', () => {
    const src = internals(new EchoPass()).blendMaterial.fragmentShader
    expect(src).toContain('texture2D(tDiffuse, rectUv(vUv, uInRect))')
    for (let i = 0; i < ECHO_TAP_COUNT; i++) expect(src).toContain(`texture2D(tTap${i}, rectUv(vUv, uTapRect${i}))`)
    expect(src.match(/texture2D\(/g)).toHaveLength(ECHO_TAP_COUNT + 1)
  })
})

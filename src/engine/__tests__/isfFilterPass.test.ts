import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { compileIsfFilter, getIsfFilterMaterial, IsfFilterPass } from '../IsfFilterPass'
import { ISF_FILTER_MIX_UNIFORM, ISF_FILTER_PRELUDE } from '../isf/transpileISF'
import COLOR_INVERT_FS from '../../assets/isf/filters/Color Invert.fs?raw'
import BAD_TV_FS from '../../assets/isf/filters/Bad TV.fs?raw'
import POST_FX_CHAIN_SRC from '../PostFXChain.tsx?raw'

/**
 * The runtime half of the ISF filter path.
 *
 * No GL context is available in this suite (vitest runs in `node`), and nothing
 * here pretends otherwise: what IS testable off-GPU is the part that actually
 * carries the design — the material cache's identity, the disabled-by-default
 * null case, the uniform wiring, and the refusal to dispose. Every one of those
 * is a decision with a documented failure mode (F144, F145, PostFXChain's
 * fixed-effect-list constraint), and every one of them is checkable with a stub
 * renderer, because the cache keys on the renderer as an object rather than
 * calling anything on it.
 *
 * What is NOT tested here, stated rather than faked:
 *
 *  - That the emitted GLSL compiles. That needs a real driver. The transpile
 *    tests assert the shape of the source; only a browser can assert the rest.
 *  - That `prewarm`'s draw genuinely warms an ANGLE/D3D11 program. F145 found
 *    that by reading a live session log, and a live session log is still the
 *    only instrument that can confirm it.
 *  - That the composed composer chain has the pass before `GradePass`. The
 *    composer is built by `@react-three/postprocessing` inside a live Canvas.
 *    The order assertion at the bottom reads `PostFXChain.tsx` as TEXT and
 *    checks the JSX order instead — which is what `buildPasses` walks, so it
 *    catches a reorder, but it is a source-order check and is labelled as one.
 */

/**
 * A stand-in renderer.
 *
 * `getIsfFilterMaterial` uses it only as a `WeakMap` key, and the pass only
 * calls `setRenderTarget`/`render` on it. Constructing a real `WebGLRenderer`
 * would need a canvas and a GL context; neither exists here, and neither is
 * what these assertions are about.
 */
function stubRenderer() {
  const calls: Array<{ target: unknown; scene: THREE.Object3D }> = []
  const gl = {
    setRenderTarget(target: unknown) {
      this._target = target
    },
    render(scene: THREE.Object3D) {
      calls.push({ target: (this as { _target?: unknown })._target, scene })
    },
    _target: undefined as unknown,
  }
  return { gl: gl as unknown as THREE.WebGLRenderer, calls }
}

/** A render target with just the fields the pass reads. */
function stubBuffer(width = 1920, height = 1080) {
  return {
    width,
    height,
    texture: { id: `${width}x${height}` },
  } as unknown as THREE.WebGLRenderTarget
}

const invert = () => compileIsfFilter('Color Invert', COLOR_INVERT_FS)
const badTv = () => compileIsfFilter('Bad TV', BAD_TV_FS)

describe('compileIsfFilter', () => {
  it('carries the shader’s own CREDIT through, because MIT needs it to travel', () => {
    const filter = invert()
    expect(filter.id).toBe('Color Invert')
    expect(filter.credit).toBe('by zoidberg')
    expect(filter.description).toBe('Inverts the RGB channels of the input')
    expect(filter.transpiled.kind).toBe('filter')
  })

  it('refuses a generator with the parser’s own message rather than a vague one', () => {
    expect(() => compileIsfFilter('Solid', '/*{"INPUTS":[]}*/\nvoid main(){}')).toThrow(
      /Solid: was imported as a filter but declares no image input/,
    )
  })
})

describe('the material cache', () => {
  it('hands back one material per (renderer, filter) and never rebuilds it', () => {
    // F144: rebuilding means the previous program was released, and the next
    // selection pays a real compile — measured at ~2s for a heavy shader. A
    // filter picker's access pattern is "try one, try another, go back", which
    // is the pattern that punishes hardest.
    const { gl } = stubRenderer()
    const filter = invert()
    const first = getIsfFilterMaterial(gl, filter)
    expect(getIsfFilterMaterial(gl, filter)).toBe(first)
    // A freshly compiled object with the same id is still the same filter.
    expect(getIsfFilterMaterial(gl, invert()).material).toBe(first.material)
  })

  it('keeps different filters apart', () => {
    const { gl } = stubRenderer()
    const a = getIsfFilterMaterial(gl, invert())
    const b = getIsfFilterMaterial(gl, badTv())
    expect(a.material).not.toBe(b.material)
    expect(a.geometry).not.toBe(b.geometry)
  })

  it('keys on the renderer, so a context loss gets fresh materials', () => {
    // A new WebGLRenderer means a new WeakMap entry, which is how the cache is
    // invalidated — by hand-disposal never happening rather than by it being
    // scheduled.
    const one = stubRenderer().gl
    const two = stubRenderer().gl
    expect(getIsfFilterMaterial(one, invert()).material).not.toBe(
      getIsfFilterMaterial(two, invert()).material,
    )
  })

  it('gives each filter its own geometry, because prewarm draws the exact pair', () => {
    // Sharing one quad across every filter would be smaller and would break
    // the F145 guarantee: some ANGLE/D3D11 configurations defer the real
    // compile to the first draw with a CONCRETE VERTEX LAYOUT, so the warm draw
    // has to use the same geometry/material pair the live render will.
    const { gl } = stubRenderer()
    const cached = getIsfFilterMaterial(gl, invert())
    expect(cached.geometry).toBeInstanceOf(THREE.PlaneGeometry)
  })

  it('prepends the filter prelude and nothing else', () => {
    const { gl } = stubRenderer()
    const { material } = getIsfFilterMaterial(gl, invert())
    expect(material.fragmentShader.startsWith(ISF_FILTER_PRELUDE)).toBe(true)
    expect(material.fragmentShader).toContain('uniform sampler2D tDiffuse;')
    // F81: this pass writes into an intermediate LINEAR buffer and GradePass,
    // being last, owns the one colour-space conversion for the whole chain.
    // Converting here would present the frame washed out, with no compile error.
    expect(material.fragmentShader).not.toContain('colorspace_fragment')
    // The scene prelude's vocabulary must not leak in.
    expect(material.fragmentShader).not.toContain('uFade')
  })

  it('seeds every uniform the pass and the shader need', () => {
    const { gl } = stubRenderer()
    const u = getIsfFilterMaterial(gl, badTv()).material.uniforms
    for (const name of ['tDiffuse', 'uRes', 'uTime', ISF_FILTER_MIX_UNIFORM]) {
      expect(u[name], name).toBeDefined()
    }
    // Full wet by default: a filter that had to be dialled up before it did
    // anything would read as broken on selection.
    expect(u[ISF_FILTER_MIX_UNIFORM].value).toBe(1)
    // And the ISF DEFAULTs, so a filter with no UI attached still renders what
    // its author tuned rather than a shader full of zeroes.
    expect(u.uIsfDistortion2.value).toBe(5)
    expect(u.uIsfScanLineThickness.value).toBe(25)
  })
})

describe('IsfFilterPass', () => {
  it('starts disabled, which is the whole null case', () => {
    // `Pass.enabled` is a per-frame skip in EffectComposer.render()
    // (`if (!pass.enabled) continue`) — it is not addPass/removePass, so it
    // does not rebuild the merged shader. That is what makes a permanently
    // mounted, usually-off pass the right shape here.
    const pass = new IsfFilterPass()
    expect(pass.enabled).toBe(false)
    expect(pass.selected).toBeNull()
    expect(pass.needsSwap).toBe(true)
  })

  it('enables on selection and disables again on null', () => {
    const pass = new IsfFilterPass()
    const filter = invert()
    pass.setFilter(filter)
    expect(pass.enabled).toBe(true)
    expect(pass.selected).toBe(filter)
    pass.setFilter(null)
    expect(pass.enabled).toBe(false)
    expect(pass.selected).toBeNull()
  })

  it('renders nothing at all when no filter is selected', () => {
    const { gl, calls } = stubRenderer()
    const pass = new IsfFilterPass()
    pass.render(gl, stubBuffer(), stubBuffer())
    expect(calls).toHaveLength(0)
  })

  it('binds the input buffer and its size, so the render-scale governor reaches it', () => {
    // `RENDERSIZE`, `IMG_SIZE` and every gl_FragCoord comparison in a filter
    // body measure against uRes. Taking it from the canvas rather than the
    // buffer would put every one of them a tier out of step the moment the
    // quality governor moved.
    const { gl, calls } = stubRenderer()
    const pass = new IsfFilterPass()
    pass.setFilter(invert())
    const input = stubBuffer(1280, 720)
    const output = stubBuffer()
    pass.render(gl, input, output, 1 / 60)

    const u = getIsfFilterMaterial(gl, invert()).material.uniforms
    expect(u.tDiffuse.value).toBe(input.texture)
    expect((u.uRes.value as THREE.Vector2).x).toBe(1280)
    expect((u.uRes.value as THREE.Vector2).y).toBe(720)
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe(output)
  })

  it('advances ISF TIME from the composer’s own delta, clamped', () => {
    // The composer hands every pass the frame delta, so nothing in PostFXChain
    // has to push a clock in — which matters, because that component must not
    // re-render and must not grow new per-frame plumbing.
    const { gl } = stubRenderer()
    const pass = new IsfFilterPass()
    pass.setFilter(badTv())
    const u = getIsfFilterMaterial(gl, badTv()).material.uniforms
    pass.render(gl, stubBuffer(), stubBuffer(), 0.5)
    pass.render(gl, stubBuffer(), stubBuffer(), 0.5)
    // Clamped to 0.1 each: a tab returning from the background would otherwise
    // jump an animated filter forward by however long it was hidden.
    expect(u.uTime.value).toBeCloseTo(0.2, 6)
  })

  it('applies the wet/dry mix, clamped to 0..1', () => {
    const { gl } = stubRenderer()
    const pass = new IsfFilterPass()
    pass.setFilter(invert())
    const u = getIsfFilterMaterial(gl, invert()).material.uniforms
    pass.setMix(0.25)
    pass.render(gl, stubBuffer(), stubBuffer(), 0)
    expect(u[ISF_FILTER_MIX_UNIFORM].value).toBe(0.25)
    for (const [given, want] of [
      [2, 1],
      [-1, 0],
      [NaN, 0],
    ] as const) {
      pass.setMix(given)
      pass.render(gl, stubBuffer(), stubBuffer(), 0)
      expect(u[ISF_FILTER_MIX_UNIFORM].value).toBe(want)
    }
    // Mix 0 is a pass-through, not an off switch — it still costs a full pass.
    // `enabled` is the off switch.
    expect(pass.enabled).toBe(true)
  })

  it('swaps the drawn material rather than the chain when the filter changes', () => {
    // The constraint the whole class exists for: PostFXChain's header records
    // that adding or removing an effect rebuilds the composer's merged shader,
    // "a multi-hundred-millisecond stall that, repeated, has lost the WebGL
    // context outright". A swap must therefore never touch the pass list.
    const { gl, calls } = stubRenderer()
    const pass = new IsfFilterPass()
    pass.setFilter(invert())
    pass.render(gl, stubBuffer(), stubBuffer(), 0)
    const drawn = calls[0].scene
    pass.setFilter(badTv())
    pass.render(gl, stubBuffer(), stubBuffer(), 0)
    // Same scene object, same mesh, different material.
    expect(calls[1].scene).toBe(drawn)
    const mesh = drawn.children[0] as THREE.Mesh
    expect(mesh.material).toBe(getIsfFilterMaterial(gl, badTv()).material)
    expect(drawn.children).toHaveLength(1)
  })

  it('dispose() frees nothing, so the next selection does not pay a recompile', () => {
    // `Pass.dispose()` shallow-searches for disposable properties and disposes
    // them, and `useDispose` calls it on unmount. Correct for a pass that owns
    // its material; this one draws the cache's, which is resident by design.
    const { gl } = stubRenderer()
    const pass = new IsfFilterPass()
    const filter = invert()
    pass.setFilter(filter)
    pass.render(gl, stubBuffer(), stubBuffer(), 0)
    const { material, geometry } = getIsfFilterMaterial(gl, filter)
    pass.dispose()
    expect(getIsfFilterMaterial(gl, filter).material).toBe(material)
    expect(getIsfFilterMaterial(gl, filter).geometry).toBe(geometry)
    // three sets `version`/disposal through an event; the surviving identity
    // above is the real assertion, and this is the direct one.
    expect(material.uniforms.tDiffuse).toBeDefined()
  })
})

describe('the chain position (source order — see this file’s header)', () => {
  /** Index of a JSX element in PostFXChain's returned tree. */
  function at(marker: string): number {
    const i = POST_FX_CHAIN_SRC.indexOf(marker, POST_FX_CHAIN_SRC.indexOf('<EffectComposer'))
    expect(i, `${marker} not found in the composer's children`).toBeGreaterThan(-1)
    return i
  }

  it('sits after every merged Effect, so a filter sees the lit composite', () => {
    // The placement is a product decision: a filter should see the fully-lit
    // composited image — bloom, aberration and vignette included.
    expect(at('<Bloom')).toBeLessThan(at('object={isfFilterPass}'))
    expect(at('<ChromaticAberration')).toBeLessThan(at('object={isfFilterPass}'))
    expect(at('<Vignette ref=')).toBeLessThan(at('object={isfFilterPass}'))
  })

  it('does not split the merged EffectPass — no raw Pass between the effects', () => {
    // The load-bearing half of the placement, and the reason it must not drift
    // back up the list. `@react-three/postprocessing`'s `buildPasses` merges
    // only CONSECUTIVE `Effect` children into one `EffectPass`, so a raw
    // `<primitive>` between Bloom and Vignette splits one fullscreen pass into
    // two. That split is decided at mount, so `enabled = false` does not undo
    // it: the chain would pay the extra draw every frame with no filter even
    // selected. Asserted on the SPAN rather than on isfFilterPass alone,
    // because any future pass inserted there costs exactly the same.
    const span = POST_FX_CHAIN_SRC.slice(at('<Bloom'), at('<Vignette ref='))
    expect(span).not.toMatch(/<primitive object=\{/)
  })

  it('leaves GradePass last, which the chain has a runtime assertion about', () => {
    // GradePass owns the chain's only colour-space conversion (F79/F81) and
    // PostFXChain logs a console.error if it is ever not last. Inserting a pass
    // above it must not trip that.
    expect(at('object={isfFilterPass}')).toBeLessThan(at('object={gradePass}'))
    const primitives = [...POST_FX_CHAIN_SRC.matchAll(/<primitive object=\{(\w+)\}/g)].map(
      (m) => m[1],
    )
    expect(primitives[primitives.length - 1]).toBe('gradePass')
    expect(primitives).toContain('isfFilterPass')
  })

  it('is instantiated with useMemo, like every sibling pass', () => {
    // Constraint 3 in PostFXChain's header: nothing here may re-render, and a
    // pass rebuilt on a render would be a new object in the composer's list —
    // which is the structural change constraint 1 forbids.
    expect(POST_FX_CHAIN_SRC).toContain(
      'const isfFilterPass = useMemo(() => new IsfFilterPass(), [])',
    )
    expect(POST_FX_CHAIN_SRC).toMatch(/useDispose\([^)]*isfFilterPass[^)]*\)/)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'
import { hasParallelCompile, prewarmShaders, resetParallelCompileProbe } from '../shaderPrewarm'

/** Minimal renderer stand-in — prewarmShaders only touches these two members. */
function fakeRenderer(opts: {
  extension: boolean
  compileAsync?: (() => Promise<unknown>) | undefined
}): THREE.WebGLRenderer {
  return {
    getContext: () => ({ getExtension: () => (opts.extension ? {} : null) }),
    compileAsync: opts.compileAsync,
  } as unknown as THREE.WebGLRenderer
}

const object = {} as THREE.Object3D
const camera = {} as THREE.Camera

beforeEach(resetParallelCompileProbe)

describe('hasParallelCompile', () => {
  it('reports the extension when present and caches the probe', () => {
    const getExtension = vi.fn(() => ({}))
    const gl = { getContext: () => ({ getExtension }) } as unknown as THREE.WebGLRenderer
    expect(hasParallelCompile(gl)).toBe(true)
    expect(hasParallelCompile(gl)).toBe(true)
    expect(getExtension).toHaveBeenCalledTimes(1)
  })

  it('reports false when the extension is absent', () => {
    expect(hasParallelCompile(fakeRenderer({ extension: false }))).toBe(false)
  })

  it('treats a throwing getContext as unsupported rather than exploding', () => {
    const gl = {
      getContext: () => {
        throw new Error('no context')
      },
    } as unknown as THREE.WebGLRenderer
    expect(hasParallelCompile(gl)).toBe(false)
  })
})

describe('prewarmShaders', () => {
  it('compiles and allows skipping warm frames when the extension backs it', async () => {
    const compileAsync = vi.fn(() => Promise.resolve({}))
    const gl = fakeRenderer({ extension: true, compileAsync })
    const result = await prewarmShaders(gl, object, camera)
    expect(compileAsync).toHaveBeenCalledOnce()
    expect(result).toEqual({ skippedWarmFrames: true, compiled: true })
  })

  it('still compiles without the extension, but refuses to skip warm frames', async () => {
    // This is the whole point of the design. Without KHR_parallel_shader_compile,
    // three's isReady() returns true immediately whether or not the program is
    // actually ready, so compileAsync resolving proves nothing. Skipping the
    // warm render here would move the stall onto the first post-promotion draw
    // — on the beat, the worst possible place.
    const compileAsync = vi.fn(() => Promise.resolve({}))
    const gl = fakeRenderer({ extension: false, compileAsync })
    const result = await prewarmShaders(gl, object, camera)
    expect(compileAsync).toHaveBeenCalledOnce() // head start is still worth taking
    expect(result).toEqual({ skippedWarmFrames: false, compiled: true })
  })

  it('falls back cleanly when compileAsync is missing entirely', async () => {
    const gl = fakeRenderer({ extension: true, compileAsync: undefined })
    const result = await prewarmShaders(gl, object, camera)
    expect(result).toEqual({ skippedWarmFrames: false, compiled: false })
  })

  it('reports ready for an EMPTY subtree — which is why callers must gate on content', async () => {
    // Verified against a real WebGLRenderer: compileAsync on a subtree with no
    // materials resolves successfully having compiled nothing, and reports
    // ready. A caller that fires this on frame 1 — while the scene is still
    // inside <Suspense> and its group is empty — would skip the warm frames
    // with nothing actually compiled, handing the real stall to the first draw
    // after promotion. SceneManager's EntryGroup gates on hasRenderable() for
    // exactly this reason; this test pins the underlying behavior so the
    // reason for that guard doesn't get lost.
    const compileAsync = vi.fn(() => Promise.resolve({}))
    const gl = fakeRenderer({ extension: true, compileAsync })
    const result = await prewarmShaders(gl, {} as THREE.Object3D, camera)
    expect(result.skippedWarmFrames).toBe(true)
  })

  it('falls back to warm frames when compileAsync rejects', async () => {
    const compileAsync = vi.fn(() => Promise.reject(new Error('driver said no')))
    const gl = fakeRenderer({ extension: true, compileAsync })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await prewarmShaders(gl, object, camera)
    expect(result).toEqual({ skippedWarmFrames: false, compiled: false })
    warn.mockRestore()
  })
})

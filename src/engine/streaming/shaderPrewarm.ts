import type * as THREE from 'three'

/**
 * Front-loads shader compilation so a scene's first visible frame doesn't
 * stall on it.
 *
 * ## Why this does not simply replace the WARM_FRAMES trick
 *
 * `SceneManager` already solves this by rendering an incoming scene *visibly*
 * for a few frames (forcing compile-on-first-draw) then hiding it until the
 * crossfade promotes it. That works, but costs several frames where two
 * scenes render at once — the file's own comment flags the resulting
 * frame-time spike.
 *
 * `renderer.compileAsync()` looks like a clean replacement, and for
 * `onBeforeCompile`-patched stock materials it is the ONLY option (their real
 * shader source only exists after three's internal chunk substitution, so
 * string-based approaches can't see it). But read what it actually does:
 *
 *   - It calls the synchronous `compile()` first, issuing the real
 *     `compileShader`/`linkProgram` calls. That part happens either way.
 *   - Then it polls `program.isReady()` until every material reports ready.
 *
 * And `WebGLProgram.isReady()` says, verbatim in three's own source: *"if the
 * KHR_parallel_shader_compile extension isn't supported, flag the program as
 * ready immediately. It may cause a stall when it's first used."*
 *
 * So without that extension, `compileAsync` resolves almost instantly — and
 * the resolution is a **lie**. Treating it as "shader is warm" would move
 * today's stall from a frame we control (the hidden warm render) to the first
 * real draw after promotion: on the beat, which is the single worst place for
 * it, and precisely what WARM_FRAMES was built to avoid.
 *
 * Hence: always call `compileAsync` (it genuinely gives the driver's compile
 * thread a head start, and costs nothing we weren't already paying), but only
 * report `skippedWarmFrames: true` when the extension is actually present to
 * back the claim.
 */

export interface PrewarmResult {
  /** True only when the driver can genuinely confirm readiness, meaning the
   *  caller may skip the visible warm-render frames. */
  skippedWarmFrames: boolean
  /** False if compileAsync was unavailable or threw — caller falls back. */
  compiled: boolean
}

let parallelCompile: boolean | null = null

/**
 * Whether the driver exposes `KHR_parallel_shader_compile`. Probed once and
 * cached — `getExtension` is not free, and this cannot change for the life of
 * a context. (A context loss remounts everything anyway; the answer is a
 * property of the driver, not the context instance.)
 */
export function hasParallelCompile(gl: THREE.WebGLRenderer): boolean {
  if (parallelCompile === null) {
    try {
      parallelCompile = gl.getContext().getExtension('KHR_parallel_shader_compile') !== null
    } catch {
      parallelCompile = false
    }
  }
  return parallelCompile
}

/** Test seam — lets the unit tests exercise both driver paths. */
export function resetParallelCompileProbe(): void {
  parallelCompile = null
}

/**
 * Compile every material under `object` ahead of time.
 *
 * Works uniformly for raw `ShaderMaterial` scenes and for future
 * `onBeforeCompile`-patched stock materials, because it compiles the real
 * post-substitution program off the live object graph rather than inspecting
 * shader strings.
 */
export async function prewarmShaders(
  gl: THREE.WebGLRenderer,
  object: THREE.Object3D,
  camera: THREE.Camera,
): Promise<PrewarmResult> {
  const canSkip = hasParallelCompile(gl)
  if (typeof gl.compileAsync !== 'function') {
    return { skippedWarmFrames: false, compiled: false }
  }
  try {
    await gl.compileAsync(object, camera)
    return { skippedWarmFrames: canSkip, compiled: true }
  } catch (err) {
    console.warn('[AudioVis] compileAsync failed; falling back to warm frames', err)
    return { skippedWarmFrames: false, compiled: false }
  }
}

import * as THREE from 'three'

/**
 * A shared, precomputed hash lookup texture — the infrastructure fix for the
 * roster's ~13 live scenes that each hand-roll their own inline
 * `hash()`/`hash21()`/`hash31()`/`vnoise()`/`fbm()` (a `fract`+`dot`+`fract`
 * ALU chain, run per pixel, often dozens of times per pixel in a raymarcher's
 * shading — see `MazeFlightScene`'s `carveScale`, called up to 6x per nesting
 * level per `map()` call, itself called ~110+ times per pixel between the
 * march and the shading taps).
 *
 * ## Why a texture, and why this is not a bit-identical swap
 *
 * A GPU is comparatively cheap at a texture fetch and comparatively more
 * expensive at the same ALU work repeated per pixel per iteration. Baking the
 * hash into a texture trades one texture fetch for the `fract`/`dot`/`fract`
 * chain a scene's own inline hash pays every single call.
 *
 * This is deliberately NOT an attempt to reproduce any scene's specific old
 * hash formula bit-for-bit — that would need either a true 3D texture (a
 * WebGL2-only feature this app does not otherwise require) or baking one
 * separate texture per distinct offset/seed a scene happens to add before
 * hashing, which does not scale to "every scene's own hash." Instead this is
 * ONE shared, well-distributed 2D hash table that any scene can index with a
 * 2D or 3D coordinate (`hashLUT`/`hashLUT2` in `shaderLib.ts`) and get a
 * stable, deterministic, good-looking-random value back — a DIFFERENT
 * specific sequence than a scene's previous inline hash, not a worse one nor
 * a frame-to-frame-unstable one. Nothing in this roster depends on a
 * PARTICULAR hash sequence persisting (a maze's exact corridor layout, a
 * field of stardust's exact positions) — only on it looking coherently
 * random and staying the same from one frame to the next, both of which this
 * preserves.
 *
 * ## Why 2D, and why this is safe for a 3D input like a maze cell id
 *
 * `hashLUT(vec3)` folds the third coordinate into a shift of the 2D texture
 * lookup (`shaderLib.ts`'s `NOISE_LUT_GLSL`) rather than needing a true
 * volume texture — every current caller's "3D" input is actually an
 * integer-ish CELL index (`floor(worldPos / cellSize)`), not a continuous
 * field that needs trilinear interpolation between neighbours, so a
 * `NearestFilter` 2D lookup with the z-shift already gives every distinct
 * cell its own effectively-independent value.
 */

/** Texture side length, in texels. 512 gives 262144 independent hash values
 *  before the tile repeats along either lookup axis — long enough that nothing
 *  in this roster (a flight path, a field of dust) flies far enough in one
 *  session to make the repeat visible. Kept a power of two for wrap-friendly
 *  GPU sampling, though `RepeatWrapping` plus the shader's own `mod()` means
 *  this is not load-bearing. */
export const NOISE_LUT_SIZE = 512

/**
 * Deterministic 32-bit PRNG — same algorithm this roster's own test suites
 * already use (`mulberry32` in MothWingsScene.test.ts / InkFluidScene.test.ts)
 * for the same reason: fast, seedable, well-distributed, no external
 * dependency. Reused here rather than reinvented so this project has one
 * blessed "I need a deterministic random stream" primitive, not two.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fixed seed: the texture must be byte-identical across renderers/sessions —
 *  two scenes reading the same cell coordinate on two different machines must
 *  see the same value, the same way the old per-scene GLSL hash always did. */
const LUT_SEED = 0x5eed1e5

function buildNoiseLUTData(size: number): Uint8Array {
  const rng = mulberry32(LUT_SEED)
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const v = Math.floor(rng() * 256)
    const o = i * 4
    data[o] = v
    data[o + 1] = v
    data[o + 2] = v
    data[o + 3] = 255
  }
  return data
}

/**
 * One texture per renderer, never disposed on unmount — same trade
 * `createShaderScene.tsx`'s own material cache makes (F138/F144): this is
 * cheap to hold for the renderer's lifetime and expensive to regenerate and
 * re-upload on every scene mount. A context loss produces a new renderer and
 * so a fresh entry, same as every other WeakMap-per-renderer cache in this
 * codebase.
 */
const textures = new WeakMap<THREE.WebGLRenderer, THREE.DataTexture>()

/** The shared hash-lookup texture for this renderer, creating it on first use. */
export function getNoiseLUT(gl: THREE.WebGLRenderer): THREE.DataTexture {
  let tex = textures.get(gl)
  if (tex) return tex
  tex = new THREE.DataTexture(
    buildNoiseLUTData(NOISE_LUT_SIZE),
    NOISE_LUT_SIZE,
    NOISE_LUT_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  // Nearest, not linear: this represents a discrete per-cell hash, not a
  // smooth field — interpolating between two unrelated cells' hash values
  // would produce meaningless in-between noise rather than either cell's
  // actual answer.
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  textures.set(gl, tex)
  return tex
}

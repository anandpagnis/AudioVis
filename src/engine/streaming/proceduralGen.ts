/**
 * Bespoke procedural geometry generation, extracted from the scenes that used
 * to do it synchronously inside `useMemo`.
 *
 * Two things change by moving the math here:
 *
 * 1. **It can run off the main thread.** Plasma seeds 70,000 particles through
 *    a rejection-sampling loop and Dissolve Cage builds an area-weighted CDF
 *    then binary-searches it 24,000 times. Both ran during the React commit
 *    that mounts a warming scene, blocking whatever frame that landed on —
 *    the real hitch, and one the existing WARM_FRAMES shader-compile trick
 *    never addressed, because it is CPU work, not shader compilation.
 * 2. **It is deterministic.** `Math.random()` is replaced with a seeded PRNG,
 *    so the same seed always produces the same field. That makes the output
 *    unit-testable without a browser, lets a worker be handed a seed instead
 *    of relying on its own global RNG state, and incidentally delivers the
 *    "deterministic seeds so recordings/screenshots are reproducible" item
 *    that was already on the roadmap.
 *
 * Deliberately imports nothing — not even THREE. This file is compiled into
 * BOTH the main DOM program and the WebWorker program (see tsconfig.worker.json),
 * so it must use neither DOM nor WebWorker globals. All output is plain typed
 * arrays the caller wraps in `BufferAttribute`s.
 */

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG. Chosen over any
 * dependency because it is four lines and the statistical quality needed here
 * is "looks random to the eye", not cryptographic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function random(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Plasma Filament — core-weighted radial particle field
// ---------------------------------------------------------------------------

export interface PlasmaGenParams {
  count: number
  spread: number
  seed: number
}

export interface PlasmaGenResult {
  positions: Float32Array
  rand: Float32Array
}

/**
 * Core-weighted radial seeding: a random direction at a power-law radius, so
 * density falls off outward and the centre becomes a genuine hot core.
 *
 * The direction is rejection-sampled inside the unit sphere (uniform on the
 * sphere once normalized; sampling spherical angles directly would cluster
 * particles at the poles). That rejection loop is the expensive part — it
 * discards roughly half its samples — and is exactly why this belongs on a
 * worker.
 */
export function generatePlasmaField({ count, spread, seed }: PlasmaGenParams): PlasmaGenResult {
  const random = mulberry32(seed)
  const positions = new Float32Array(count * 3)
  const rand = new Float32Array(count * 4)

  for (let i = 0; i < count; i++) {
    let x: number
    let y: number
    let z: number
    let len: number
    do {
      x = random() * 2 - 1
      y = random() * 2 - 1
      z = random() * 2 - 1
      len = Math.sqrt(x * x + y * y + z * z)
    } while (len < 1e-4 || len > 1)

    const dist = Math.pow(random(), 1.4) * spread
    positions[i * 3] = (x / len) * dist
    positions[i * 3 + 1] = (y / len) * dist * 0.85 // slightly flattened body
    positions[i * 3 + 2] = (z / len) * dist

    rand[i * 4] = random() * 6.28
    rand[i * 4 + 1] = random()
    rand[i * 4 + 2] = random()
    rand[i * 4 + 3] = random()
  }

  return { positions, rand }
}

// ---------------------------------------------------------------------------
// PCD LIDAR Scan — volumetric spherical point cloud
// ---------------------------------------------------------------------------

export interface PointCloudGenParams {
  count: number
  radius: number
  seed: number
}

export interface PointCloudGenResult {
  positions: Float32Array
  rand: Float32Array
}

/**
 * Volumetric spherical distribution, biased toward the outer shell.
 *
 * `acos(2u - 1)` for the polar angle is what makes this uniform over the
 * sphere — sampling `phi` directly would pile points at the poles. The
 * `pow(u, 0.4)` radius bias then pushes density outward so the cloud reads as
 * a scanned surface with volume behind it rather than a solid ball.
 */
export function generatePointCloudField({
  count,
  radius,
  seed,
}: PointCloudGenParams): PointCloudGenResult {
  const random = mulberry32(seed)
  const positions = new Float32Array(count * 3)
  const rand = new Float32Array(count * 4)

  for (let i = 0; i < count; i++) {
    const theta = random() * Math.PI * 2
    const phi = Math.acos(random() * 2 - 1)
    const rad = radius * Math.pow(random(), 0.4)
    const sinPhi = Math.sin(phi)

    positions[i * 3] = rad * sinPhi * Math.cos(theta)
    positions[i * 3 + 1] = rad * sinPhi * Math.sin(theta)
    positions[i * 3 + 2] = rad * Math.cos(phi)

    rand[i * 4] = random() // displacement variance
    rand[i * 4 + 1] = random() // scan response seed
    rand[i * 4 + 2] = random() // sparkle seed
    rand[i * 4 + 3] = random() // point size variance
  }

  return { positions, rand }
}

// ---------------------------------------------------------------------------
// Dissolve Cage — area-weighted surface sampling
// ---------------------------------------------------------------------------

export interface DissolveGenParams {
  /**
   * Non-indexed triangle soup, extracted on the main thread before dispatch —
   * `BufferGeometry` itself is not structured-cloneable, so the caller pulls
   * the raw arrays out of a `toNonIndexed()` clone and transfers those.
   */
  position: Float32Array
  normal: Float32Array
  count: number
  cage: number
  seed: number
}

export interface DissolveGenResult {
  formed: Float32Array
  scattered: Float32Array
  rand: Float32Array
}

/**
 * Area-weighted surface sample. Uniform-random triangle picking would
 * over-sample dense small triangles (a torus knot's are not equal-area),
 * clumping the particles; a cumulative-area CDF plus a barycentric sample
 * inside the chosen triangle distributes them evenly over the real surface.
 */
export function generateDissolveField({
  position,
  normal,
  count,
  cage,
  seed,
}: DissolveGenParams): DissolveGenResult {
  const random = mulberry32(seed)
  const triCount = position.length / 9 // 3 verts x 3 components per triangle

  // Cumulative triangle area, for area-proportional picking.
  const cdf = new Float64Array(triCount)
  let total = 0
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const abx = position[o + 3] - position[o]
    const aby = position[o + 4] - position[o + 1]
    const abz = position[o + 5] - position[o + 2]
    const acx = position[o + 6] - position[o]
    const acy = position[o + 7] - position[o + 1]
    const acz = position[o + 8] - position[o + 2]
    // |ab x ac| / 2
    const cx = aby * acz - abz * acy
    const cy = abz * acx - abx * acz
    const cz = abx * acy - aby * acx
    total += Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5
    cdf[t] = total
  }

  const formed = new Float32Array(count * 3)
  const scattered = new Float32Array(count * 3)
  const rand = new Float32Array(count * 4)
  const limit = cage * 0.5 * 0.93 // stay inside the cage walls

  for (let i = 0; i < count; i++) {
    // Binary search the CDF for an area-proportional triangle.
    const target = random() * total
    let lo = 0
    let hi = triCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < target) lo = mid + 1
      else hi = mid
    }

    // Uniform barycentric point inside triangle `lo`.
    let u = random()
    let v = random()
    if (u + v > 1) {
      u = 1 - u
      v = 1 - v
    }
    const w = 1 - u - v

    const o = lo * 9
    const fx = position[o] * w + position[o + 3] * u + position[o + 6] * v
    const fy = position[o + 1] * w + position[o + 4] * u + position[o + 7] * v
    const fz = position[o + 2] * w + position[o + 5] * u + position[o + 8] * v
    formed[i * 3] = fx
    formed[i * 3 + 1] = fy
    formed[i * 3 + 2] = fz

    // Scatter along the interpolated surface normal, so the dispersed cloud
    // keeps a ghost of the form instead of collapsing to a featureless shell.
    const nx = normal[o] * w + normal[o + 3] * u + normal[o + 6] * v
    const ny = normal[o + 1] * w + normal[o + 4] * u + normal[o + 7] * v
    const nz = normal[o + 2] * w + normal[o + 5] * u + normal[o + 8] * v
    const push = 0.7 + random() * 1.5
    let sx = fx + nx * push + (random() - 0.5) * 0.7
    let sy = fy + ny * push + (random() - 0.5) * 0.7
    let sz = fz + nz * push + (random() - 0.5) * 0.7

    // Scale back along the ray rather than clamping per-axis — a hard clamp
    // would flatten stray particles onto visible planes at the cage faces.
    const worst = Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz))
    if (worst > limit) {
      const k = limit / worst
      sx *= k
      sy *= k
      sz *= k
    }
    scattered[i * 3] = sx
    scattered[i * 3 + 1] = sy
    scattered[i * 3 + 2] = sz

    rand[i * 4] = random() * 6.28
    rand[i * 4 + 1] = random()
    rand[i * 4 + 2] = random()
    rand[i * 4 + 3] = random()
  }

  return { formed, scattered, rand }
}

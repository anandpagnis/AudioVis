import type { IUniform } from 'three'

/**
 * Central runtime quality governor — the single source of truth for how hard
 * every heavy scene is allowed to push each frame.
 *
 * The key idea: it scales COMPLEXITY, not just canvas resolution. Fixed-cost
 * GPU work — the fluid sim's Jacobi passes, the particle count, a raymarcher's
 * per-pixel step count and noise octaves — is invisible to plain DPR scaling
 * (those targets/buffers/loops don't shrink when the framebuffer does). The
 * governor exposes those knobs directly so an overloaded frame actually makes
 * the expensive scenes lighter, which is the only thing that keeps butter-smooth
 * playback once the visuals get genuinely heavy (fractals, liquids, stacks).
 *
 * A tier is a coherent bundle of knobs. `auto` walks the tiers from measured
 * frame time with hysteresis; fixed qualities pin a tier. Scenes never read the
 * store or FPS themselves — they read `quality.knobs`.
 */
export interface QualityKnobs {
  /** Multiplier applied to the base device pixel ratio. */
  renderScale: number
  /** Max raymarch iterations (uMaxSteps early-break in RAYMARCH_GLSL). */
  raymarchSteps: number
  /** fbm octaves (uOctaves early-break in NOISE3D_GLSL). */
  noiseOctaves: number
  /** Jacobi pressure iterations for the fluid solver. */
  fluidJacobi: number
  /** Fraction of the full particle budget to draw (setDrawRange). */
  particleFraction: number
  /** How many high-cost scenes may render at once (crossfade budget). */
  maxHeavyLayers: number
}

/**
 * Tier ladder, richest (0) → survival (4). Chosen so each step roughly halves
 * the marginal cost of the dominant term while staying visually close: step
 * count and octaves fall first (raymarch dominates), then fluid/particles.
 */
const TIERS: QualityKnobs[] = [
  { renderScale: 1.0, raymarchSteps: 96, noiseOctaves: 4, fluidJacobi: 20, particleFraction: 1.0, maxHeavyLayers: 2 },
  { renderScale: 0.85, raymarchSteps: 72, noiseOctaves: 4, fluidJacobi: 16, particleFraction: 0.8, maxHeavyLayers: 2 },
  { renderScale: 0.7, raymarchSteps: 54, noiseOctaves: 3, fluidJacobi: 12, particleFraction: 0.6, maxHeavyLayers: 1 },
  { renderScale: 0.58, raymarchSteps: 40, noiseOctaves: 3, fluidJacobi: 10, particleFraction: 0.45, maxHeavyLayers: 1 },
  { renderScale: 0.48, raymarchSteps: 28, noiseOctaves: 2, fluidJacobi: 8, particleFraction: 0.33, maxHeavyLayers: 1 },
]

/** Fixed store qualities map onto a pinned tier. */
const FIXED_TIER: Record<'low' | 'medium' | 'high', number> = { low: 4, medium: 2, high: 0 }

/** Frame-time thresholds (ms EMA). Drop above STEP_DOWN, climb below STEP_UP. */
const STEP_DOWN_MS = 20 // slipping under ~50 fps → shed load now
const STEP_UP_MS = 12 // comfortably over ~80 fps → room to climb
const SETTLE_SEC = 2 // min seconds between any change (avoid oscillation)
const CLIMB_HOLD_SEC = 4 // sustained headroom required before climbing back

class QualityGovernor {
  /** Current tier index; starts one rung down so we boot into headroom, not the fire. */
  tier = 1
  knobs: QualityKnobs = TIERS[1]

  private auto = true
  private lastChangeAt = 0
  private goodSince = 0

  /** Pin to a fixed store quality, or hand control back to the auto walker. */
  setMode(q: 'auto' | 'low' | 'medium' | 'high'): void {
    if (q === 'auto') {
      this.auto = true
      return
    }
    this.auto = false
    this.setTier(FIXED_TIER[q])
  }

  /** Auto tick — call once per frame with the smoothed frame time. */
  tick(emaMs: number, elapsedSec: number): void {
    if (!this.auto) return
    if (elapsedSec - this.lastChangeAt < SETTLE_SEC) {
      if (emaMs <= STEP_UP_MS) this.goodSince = Math.max(this.goodSince, this.lastChangeAt)
      return
    }
    if (emaMs > STEP_DOWN_MS && this.tier < TIERS.length - 1) {
      this.setTier(this.tier + 1)
      this.lastChangeAt = elapsedSec
      this.goodSince = elapsedSec
    } else if (emaMs < STEP_UP_MS && this.tier > 0) {
      if (elapsedSec - this.goodSince > CLIMB_HOLD_SEC) {
        this.setTier(this.tier - 1)
        this.lastChangeAt = elapsedSec
        this.goodSince = elapsedSec
      }
    } else {
      this.goodSince = elapsedSec
    }
  }

  private setTier(t: number): void {
    this.tier = Math.max(0, Math.min(TIERS.length - 1, t))
    this.knobs = TIERS[this.tier]
  }
}

export const quality = new QualityGovernor()

/**
 * Fresh uniform bundle for the raymarch/noise complexity knobs. Spread into a
 * ShaderMaterial's `uniforms` so `uMaxSteps` / `uOctaves` (declared inside
 * RAYMARCH_GLSL / NOISE3D_GLSL) resolve; then call {@link applyQualityUniforms}
 * each frame to track the governor.
 */
export function qualityUniforms(): Record<string, IUniform> {
  return {
    uMaxSteps: { value: TIERS[0].raymarchSteps },
    uOctaves: { value: TIERS[0].noiseOctaves },
  }
}

/** Push the governor's current complexity knobs into a scene's uniforms. */
export function applyQualityUniforms(u: Record<string, IUniform>): void {
  if (u.uMaxSteps) u.uMaxSteps.value = quality.knobs.raymarchSteps
  if (u.uOctaves) u.uOctaves.value = quality.knobs.noiseOctaves
}

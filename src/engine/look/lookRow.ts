import type { CharacterMood } from '../../audio/characterTypes'

/**
 * The CONTRACT of the mood-driven look system (plan: "Mood-driven look system").
 *
 * One `LookRow` is an authored look for ONE character mood (`moodRows.ts`). The live `LookProfile` is the
 * confidence-sharpened, distribution-weighted blend of those rows, plus the fast-layer modifiers (build /
 * drop afterglow / breakdown) — computed once per frame by `LookProfileTracker` (`lookProfile.ts`) and
 * published on `performanceState.look`. Every director reads that instead of keying tables on the old
 * 7-state look.
 *
 * Continuous fields blend linearly. Discrete choices (lens style, mirror mode / segments, camera mode,
 * transition style) are stored as WEIGHT VECTORS: the blended vector is the marginal probability of each
 * option, sampled by the consumer only at its existing decision edges, so nothing flips mid-hold.
 *
 * This file is types + constants + a neutral row only. No behaviour lives here.
 */

/** Lens materials, in the SAME order as `LENS_STYLES` in `opticalRack.ts` (the index is the shader uniform). */
export const LENS_STYLE_COUNT = 8
export const LENS = { ribs: 0, fan: 1, anamorphic: 2, melt: 3, glitch: 4, pixels: 5, flyEye: 6, pixelSort: 7 } as const

/** Mirror modes that are live (wallpaper / shear are retired). Weight-vector order. */
export const MIRROR_MODES = ['kaleido', 'vortex'] as const
/** Kaleidoscope segment counts. Weight-vector order. */
export const SEGMENT_CHOICES = [4, 6, 8] as const
/** Camera modes, SAME order as `CAMERA_MODES` in `performanceState.ts` (a test pins the equality; not imported to avoid a cycle). */
export const LOOK_CAMERA_MODES = ['orbit', 'hover', 'push', 'pull', 'spiral', 'handheld', 'locked', 'topdown', 'cinematic'] as const
/**
 * Transition styles a mood may weight. `cut` / `dipToBlack` stay owned by the section logic.
 *
 * The first 4 are the original "ramp" styles: a plain crossfade with a triangular arc of extra amount
 * added into an existing post-FX rack (feedback for `smear`, lens melt for `melt`, mirror tile+twist for
 * `collapse`) — cheap, no new render targets, always available.
 *
 * `mosaic` and `sortSlice` are also ramp styles (same triangular-arc mechanism, riding the `pixels` and
 * `pixel-sort` lens materials respectively) — cheap, no new render targets.
 *
 * `inkDissolve`, `irisWipe` and `datamosh` are "wipe" styles: a real two-texture cross-blend between the
 * outgoing and incoming scene, captured to their own render targets (`TransitionCapture`/
 * `WipeCompositorPass`). Only selectable at a quality tier that can afford the extra render pass; the
 * picker falls back to a ramp style otherwise. See `docs/12_Character_Layer.md`'s transitions section.
 */
export const LOOK_TRANSITIONS = [
  'dissolve',
  'smear',
  'melt',
  'collapse',
  'mosaic',
  'sortSlice',
  'inkDissolve',
  'irisWipe',
  'datamosh',
] as const

/** An authored look. Every field is finite. Ranges are the design ranges, not hard clamps except where noted. */
export interface LookRow {
  // --- bloom / chromatic aberration / vignette / fog -------------------------------------------------
  /** Resting bloom, 0.25..0.8 (the old BLOOM_BASE table spans .30-.71). */
  bloomBase: number
  /** Gain on the reactive bloom terms (bass / pulse / drop), 0.5..1.4. */
  bloomReact: number
  /** Resting chromatic aberration, 0..0.004 (old formula starts at .0006). */
  caBase: number
  /** Gain on the reactive CA terms, 0.5..2. */
  caReact: number
  /** Resting vignette, 0.7..1 (higher = darker edges). */
  vignette: number
  /** Resting fog / veil, 0..0.5. */
  fogBase: number

  // --- feedback trails / echo -----------------------------------------------------------------------
  /** Feedback persistence target, 0..1. */
  trailsBase: number
  /** Multipliers 0..2 on the feedback's zoom / rotate / swirl / wobble ratios (1 = today's fixed ratios). */
  trailsZoom: number
  trailsRotate: number
  trailsSwirl: number
  trailsWobble: number
  /** Beat-echo gate, 0..1. */
  echoGate: number

  // --- lens -----------------------------------------------------------------------------------------
  /** Probability the lens engages at a decision edge, 0..0.7. */
  lensEngage: number
  /** Engaged lens amount range, 0.15..0.42. */
  lensAmountFloor: number
  lensAmountCeil: number
  /** Weights over the 8 lens styles (order = `LENS`). `flyEye` (6) stays 0. Need not sum to 1. */
  lensWeights: number[]

  // --- mirror ---------------------------------------------------------------------------------------
  /** Probability the mirror engages at a decision edge, 0..0.9. */
  mirrorEngage: number
  /** Weights over `MIRROR_MODES`. */
  mirrorMode: number[]
  /** Weights over `SEGMENT_CHOICES`. */
  mirrorSegments: number[]
  /** Spin range, capped at 0.7 (radial patterns). */
  mirrorSpinMin: number
  mirrorSpinMax: number
  /** Vortex twist ceiling, 0..1.3. */
  mirrorTwistMax: number
  /** Mirror mix ceiling, 0..1. */
  mirrorMix: number
  /** How much the `busy` descriptor raises `mirrorEngage`, 0..1. */
  mirrorBusyGain: number

  // --- scene dial steering (0..1, 0.5 neutral) --------------------------------------------------------
  steerSpeed: number
  steerComplexity: number
  steerDensity: number
  steerFill: number
  steerContrast: number

  // --- tempo coupling ---------------------------------------------------------------------------------
  /**
   * How strongly the song's BPM sets the rate of motion, 0..1.2: the exponent in `rate = (bpm / 120) ** coupling`
   * (`tempoSpeed.ts`). 0 ignores tempo, 1 makes motion proportional to it (160 BPM = 1.33x, 80 BPM = 0.67x), above 1
   * exaggerates it slightly (1.2: 160 BPM = 1.41x, 80 BPM = 0.61x). Driving and aggressive moods lock hard to the tempo;
   * serene and dreamy ones stay slow and floaty even on a fast track.
   * Applied on top of the mood's own base speed (`steerSpeed`, `cameraSpeed`), never instead of it.
   */
  tempoCoupling: number

  // --- camera ---------------------------------------------------------------------------------------
  /** Weights over `LOOK_CAMERA_MODES`. */
  cameraWeights: number[]
  /** Multiplier on camera motion speed, 0.6..1.6. */
  cameraSpeed: number
  /** Multiplier on handheld shake / jitter, 0..1.5. */
  cameraShake: number
  /** 0..1: probability of a hard camera re-cut at a phrase boundary (`CameraDirector.shouldHardCut`). */
  cameraCutRate: number

  // --- transitions ----------------------------------------------------------------------------------
  /** Weights over `LOOK_TRANSITIONS`. */
  transitionWeights: number[]
  /** Multiplier on the tempo-derived primary crossfade duration, 0.6..1.6 (1 = unchanged). */
  transitionDurationBias: number
  /**
   * The transition curve's symmetric-family exponent `k` in `S_k(t) = t^k / (t^k + (1-t)^k)`, which
   * satisfies `S_k(1-t) = 1-S_k(t)` for any `k>0` — so the `out+in≈1` energy invariant holds for every
   * value, and sharpness is free to vary per mood without touching that pinned property. 1..8:
   * `k=1` is linear (mechanical/aggressive), `k≈3` matches the original `smoothstep` feel (the neutral
   * default), `k≈5-8` holds near both ends and snaps through the middle (sharp, but still continuous —
   * never an overshoot: most scenes are additive, so any curve exceeding 1 would read as a brightness
   * flash, which is why this family was chosen over an elastic/bounce one).
   */
  transitionSharpness: number

  // --- colour grade (multiplicative only; see GradePass) -----------------------------------------------
  /** Saturation multiplier, 0.75..1.3 (1 = unchanged). */
  gradeSat: number
  /** Cool (-1) .. warm (+1) tint. */
  gradeTemp: number
  /** Contrast about a pivot, 0.95..1.3 (1 = unchanged). */
  gradeContrast: number

  // --- scene preference (feeds `sceneBoost`) ----------------------------------------------------------
  /** Target scene traits, 0..1: how fast / angular / busy / radially-symmetric the scene should be. */
  traitTempo: number
  traitAngular: number
  traitBusy: number
  traitRadial: number
  /** 0..1 strength of the preference (0 = ignore traits). */
  traitStrength: number

  // --- effect scene propensities (multiplies the effect director's odds), 0..1.5 ----------------------
  fxShock: number
  fxFlare: number
  fxSpark: number
  fxStrobe: number
}

/** Numeric scalar keys of `LookRow`, for generic allocation-free blending. */
export const ROW_SCALAR_KEYS = [
  'bloomBase', 'bloomReact', 'caBase', 'caReact', 'vignette', 'fogBase',
  'trailsBase', 'trailsZoom', 'trailsRotate', 'trailsSwirl', 'trailsWobble', 'echoGate',
  'lensEngage', 'lensAmountFloor', 'lensAmountCeil',
  'mirrorEngage', 'mirrorSpinMin', 'mirrorSpinMax', 'mirrorTwistMax', 'mirrorMix', 'mirrorBusyGain',
  'steerSpeed', 'steerComplexity', 'steerDensity', 'steerFill', 'steerContrast',
  'tempoCoupling',
  'cameraSpeed', 'cameraShake', 'cameraCutRate',
  'transitionDurationBias', 'transitionSharpness',
  'gradeSat', 'gradeTemp', 'gradeContrast',
  'traitTempo', 'traitAngular', 'traitBusy', 'traitRadial', 'traitStrength',
  'fxShock', 'fxFlare', 'fxSpark', 'fxStrobe',
] as const satisfies readonly (keyof LookRow)[]

/** Array-valued keys of `LookRow` and their fixed lengths. */
export const ROW_ARRAY_KEYS = {
  lensWeights: LENS_STYLE_COUNT,
  mirrorMode: MIRROR_MODES.length,
  mirrorSegments: SEGMENT_CHOICES.length,
  cameraWeights: LOOK_CAMERA_MODES.length,
  transitionWeights: LOOK_TRANSITIONS.length,
} as const satisfies Partial<Record<keyof LookRow, number>>

/** Per-family switches (`?look=-grade,-post,-scene,-camera`; all false under `?scenepick=legacy`). Consumers gate on `valid && families.X`. */
export interface LookFamilies {
  grade: boolean
  post: boolean
  scene: boolean
  camera: boolean
}

/** Where the current profile came from. `legacy`: character not valid, consumers use their original code paths. */
export type LookSource = 'legacy' | 'character' | 'forced'

/**
 * The live, blended look. `LookRow` fields hold the blended (and modifier-adjusted) values. Mutated in place
 * every frame by `LookProfileTracker.update` (no allocation); read by the directors and executors.
 */
export interface LookProfile extends LookRow {
  /** False until a profile has been computed from a valid character read. Consumers fall back to legacy paths. */
  valid: boolean
  source: LookSource
  /** Which consumer families may use this profile right now. */
  families: LookFamilies
  /** Highest-weight mood of the blend (debug / overlay). */
  primary: CharacterMood | null
  /** Normalised blend weights over `CHARACTER_MOODS` order (debug / overlay). */
  weights: number[]
  /** 0..1 how far the blend was relaxed toward the NEUTRAL row (high entropy / low confidence). */
  relax: number
  /** Timbre descriptors echoed from `AudioFeatures.timbre`, 0..1 (harsh / busy / sparse). */
  harsh: number
  busy: number
  sparse: number
  /** Fast-layer modifiers, each 0..1, already applied to the row fields above. */
  buildIntent: number
  afterglow: number
  breakdown: number
  /** Multiplier on hard-effect propensity from the fast intensity layer (silence 0 .. peak 1). */
  intensityGate: number
}

/** The neutral row: a moderate, groove-like look. Used as the relax target and as the profile's initial values. */
export function createNeutralRow(): LookRow {
  return {
    bloomBase: 0.49, bloomReact: 1, caBase: 0.0012, caReact: 1, vignette: 0.85, fogBase: 0.15,
    trailsBase: 0.8, trailsZoom: 1, trailsRotate: 1, trailsSwirl: 1, trailsWobble: 1, echoGate: 0.55,
    lensEngage: 0.3, lensAmountFloor: 0.15, lensAmountCeil: 0.24, lensWeights: [0, 0, 0.5, 0, 0, 0.5, 0, 0],
    mirrorEngage: 0.35, mirrorMode: [0.6, 0.4], mirrorSegments: [0.34, 0.33, 0.33],
    mirrorSpinMin: 0.2, mirrorSpinMax: 0.4, mirrorTwistMax: 1, mirrorMix: 1, mirrorBusyGain: 0.5,
    steerSpeed: 0.52, steerComplexity: 0.52, steerDensity: 0.52, steerFill: 0.52, steerContrast: 0.55,
    tempoCoupling: 0.68,
    cameraWeights: [0.3, 0.2, 0.1, 0.05, 0.15, 0.05, 0.02, 0.05, 0.08], cameraSpeed: 1, cameraShake: 0.3, cameraCutRate: 0.5,
    // dissolve, smear, melt, collapse, mosaic, sortSlice, inkDissolve, irisWipe, datamosh (LOOK_TRANSITIONS order).
    transitionWeights: [0.28, 0.16, 0.14, 0.12, 0.1, 0.08, 0.06, 0.04, 0.02],
    transitionDurationBias: 1, transitionSharpness: 3,
    gradeSat: 1, gradeTemp: 0.1, gradeContrast: 1.05,
    traitTempo: 0.5, traitAngular: 0.4, traitBusy: 0.5, traitRadial: 0.3, traitStrength: 0.5,
    fxShock: 0.7, fxFlare: 0.6, fxSpark: 0.8, fxStrobe: 0,
  }
}

/** A fresh, invalid profile initialised to the neutral row. */
export function createLookProfile(): LookProfile {
  return {
    ...createNeutralRow(),
    valid: false,
    source: 'legacy',
    families: { grade: true, post: true, scene: true, camera: true },
    primary: null,
    weights: new Array<number>(14).fill(0),
    relax: 1,
    harsh: 0.5,
    busy: 0.5,
    sparse: 0.5,
    buildIntent: 0,
    afterglow: 0,
    breakdown: 0,
    intensityGate: 1,
  }
}

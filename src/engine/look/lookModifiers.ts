import { CHARACTER_MOODS } from '../../audio/characterTypes'
import type { MoodState } from '../../audio/types'
import { LENS, LENS_STYLE_COUNT, LOOK_CAMERA_MODES, SEGMENT_CHOICES, type LookRow } from './lookRow'

/**
 * The pure modifiers that sit on top of a blended `LookRow`. Two kinds, both applied to the profile's fields
 * IN PLACE and both allocation-free:
 *
 *  - FAST layer (music dynamics, seconds): `applyBuild`, `applyAfterglow`, `applyBreakdown`, `applyIntensityGate`.
 *    `LookProfileTracker` owns their state (build ramp, afterglow decay, breakdown ease, gate ease) and applies
 *    them AFTER its slow smoothing, on the published copy only, so they never compound frame to frame.
 *  - SLOW descriptors (timbre, ~4 s at the source): `applyDescriptors`. Every effect is a multiplicative factor
 *    bounded to +-40% (`DESCRIPTOR.bound`) around 1 at the neutral descriptor 0.5, so a descriptor sets HOW MUCH
 *    of a mood's effects show and can never turn on a family the mood does not have (0 stays 0).
 *
 * Every formula lives in a named constant below (the tuning surface: art direction, not physics). Ranges the
 * consumers rely on are capped, because a modifier may push a value past its authored design range but never
 * past something meaningless (a probability above 1, a negative dial).
 *
 * Flash safety (plan risk 3): NOTHING here raises `fxStrobe`, and the build never touches any fx propensity.
 * The intensity gate can only lower them.
 */

// ---------------------------------------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------------------------------------

/** BUILD, r = buildIntent 0..1. */
export const BUILD = {
  /** `bloomBase += bloom * r`. */
  bloom: 0.15,
  /** `trailsBase += trails * r`. */
  trails: 0.1,
  /** `trailsZoom *= 1 + trailsZoomGain * r` (the feedback pushes outward harder as the build rises). */
  trailsZoomGain: 1,
  /** `echoGate += echoGate * r`. */
  echoGate: 0.25,
  /** Hard lens styles (glitch, pixel sort) are weighted `x (1 + hardLensGain * r)`. */
  hardLensGain: 1,
  /** `mirrorEngage += mirrorEngage * r`. */
  mirrorEngage: 0.3,
  /** How far the segment weights move (at r = 1) toward the r-driven target that steps 4 -> 6 -> 8. */
  segmentMix: 0.85,
  /** `steerSpeed` and `steerComplexity += steer * r`. */
  steer: 0.15,
  /** `gradeSat += gradeSat * r`. */
  gradeSat: 0.05,
  /** Fraction of the camera-weight mass moved onto `push` at r = 1 ("camera push"). */
  cameraPush: 0.25,
} as const

/** How `buildIntent` is derived from the two build signals. */
export const BUILD_INTENT = {
  /** The everyday (legacy `building` look) build can only reach this, so only a confirmed structural build reaches 1. */
  legacyCap: 0.5,
  /** Seconds for the legacy ramp to climb 0 -> cap, and to fall cap -> 0 (linear). */
  legacyAttackSec: 2,
  legacyReleaseSec: 1.5,
  /** The structural build follows `buildProgress` up instantly and releases linearly over this (no pop when the drop ends it). */
  structuralReleaseSec: 1.5,
} as const

/** DROP afterglow: 1 on the drop's rising edge, then linear decay. */
export const AFTERGLOW = {
  /** Seconds to decay 1 -> 0 (about 8 beats at 120 bpm). */
  seconds: 4,
  /** Fraction of the segment-weight mass pushed onto the 8-segment kaleidoscope at afterglow 1. */
  segmentMix: 1,
  /** `mirrorEngage += mirrorEngage * a`, so the 8-segment mirror can actually be picked. */
  mirrorEngage: 0.2,
  /** `gradeSat += gradeSat * a`. */
  gradeSat: 0.1,
  /** `gradeContrast += gradeContrast * a`. */
  gradeContrast: 0.05,
} as const

/** BREAKDOWN, b = eased 0..1. */
export const BREAKDOWN = {
  /** `bloomBase *= 1 - (1 - bloomScale) * b`, i.e. x0.7 at b = 1. */
  bloomScale: 0.7,
  /** `trailsBase += trails * b`. */
  trails: 0.15,
  /** `steerSpeed` and `steerDensity -= steer * b`. */
  steer: 0.2,
  /** `fogBase += fog * b`. */
  fog: 0.15,
  /** Fraction of the camera-weight mass moved onto `hover` at b = 1. */
  cameraHover: 0.7,
  /** Calm-mirror moods (dreamy / serene / mysterious) keep their mirror but spin no faster than this. */
  slowSpinMax: 0.12,
  /** Seconds to ease into / out of a breakdown (linear ramp, then smoothstep). */
  attackSec: 2,
  releaseSec: 1,
} as const

/** Moods whose mirror survives a breakdown (slow spin) instead of being switched off. */
const CALM_MIRROR_MOODS = ['serene', 'dreamy', 'mysterious'] as const

/**
 * Timbre-descriptor modulation (harsh / busy / sparse, each 0..1 with 0.5 the corpus median = neutral). With
 * `u = 2 * descriptor - 1` (-1..1) every factor is `1 + k * u`, bounded to `1 +- bound`.
 */
export const DESCRIPTOR = {
  /** Hard bound on any descriptor factor (+-40%). */
  bound: 0.4,
  /** `lensEngage *= harshEngageBase + harshEngageGain * harsh` (0.6 .. 1.4). */
  harshEngageBase: 0.6,
  harshEngageGain: 0.8,
  /** Up to this fraction of soft-style lens weight moves to pixel sort / glitch at harsh = 1 (and back at harsh = 0). */
  harshLensShift: 0.4,
  /** `caBase *= 1 + harshCa * u_harsh` ("raises caBase slightly"). */
  harshCa: 0.2,
  /** `trailsBase *= 1 - harshTrails * u_harsh` (harsh lowers, sparse raises). */
  harshTrails: 0.25,
  /**
   * `mirrorEngage *= 1 + busyMirror * mirrorBusyGain * u_busy`. The plan writes (0.5 + 1.0 * busy * gain);
   * that is 0.5 .. 1.5 at gain 1 (outside the +-40% bound) and not neutral at busy 0.5 for gain < 1, so it is
   * re-centred and scaled: 0.6 .. 1.4 at gain 1, exactly 1 at busy 0.5 for ANY gain.
   */
  busyMirror: 0.4,
  /** `steerComplexity` and `steerDensity *= 1 + busySteer * u_busy`. */
  busySteer: 0.3,
  /** `fogBase *= 1 + sparseFog * u_sparse`. */
  sparseFog: 0.4,
  /** `trailsBase *= 1 + sparseTrails * u_sparse`. */
  sparseTrails: 0.2,
  /** `echoGate *= 1 - sparseEcho * u_sparse`. */
  sparseEcho: 0.3,
  /** `steerSpeed *= 1 - sparseSpeed * u_sparse`. */
  sparseSpeed: 0.2,
} as const

/**
 * Multiplier on hard-effect propensity by the FAST 7-state look (`lookOf(f.mood)`): preserves "a breakdown in an
 * epic song does not get peak effects".
 */
export const INTENSITY_GATE: Readonly<Record<MoodState, number>> = {
  silence: 0,
  ambient: 0.35,
  mellow: 0.35,
  groove: 0.7,
  building: 0.9,
  peak: 1,
  aggressive: 1,
}

/** One-pole time constant (s) the tracker eases the gate with (its only continuous consumer is `caReact`). */
export const INTENSITY_GATE_TAU_SEC = 0.5

/** Caps that keep a modified value meaningful (not design ranges: a modifier may exceed the authored range). */
const CAP = {
  bloom: 1,
  trails: 1,
  trailsMult: 2,
  echoGate: 1,
  mirrorEngage: 0.9,
  lensEngage: 0.85,
  steer: 1,
  gradeSat: 1.4,
  gradeContrast: 1.35,
  fog: 0.6,
} as const

/** Lens styles the breakdown keeps / the harsh descriptor moves weight FROM. */
export const SOFT_LENS_STYLES: readonly number[] = [LENS.ribs, LENS.fan, LENS.anamorphic, LENS.melt]
/** "Hard" (corruption family) lens styles: pixel sort and glitch. `pixels` / `flyEye` are neither hard nor soft. */
export const HARD_LENS_STYLES: readonly number[] = [LENS.glitch, LENS.pixelSort]
/** Split of moved weight between `HARD_LENS_STYLES` (glitch, pixel sort) when a mood has no hard weight to grow. */
const HARD_SPLIT: readonly number[] = [0.4, 0.6]

const IS_SOFT_LENS: readonly boolean[] = Array.from({ length: LENS_STYLE_COUNT }, (_, i) => SOFT_LENS_STYLES.includes(i))
const SEG_4 = SEGMENT_CHOICES.indexOf(4)
const SEG_6 = SEGMENT_CHOICES.indexOf(6)
const SEG_8 = SEGMENT_CHOICES.indexOf(8)
const CAM_PUSH = LOOK_CAMERA_MODES.indexOf('push')
const CAM_HOVER = LOOK_CAMERA_MODES.indexOf('hover')
const CALM_MIRROR_IDX: readonly number[] = CALM_MIRROR_MOODS.map((m) => CHARACTER_MOODS.indexOf(m))

const EPS = 1e-9

// @hot-path:begin (everything below runs per frame: no `new`, no array/object literals, no closures, no spread)

// ---------------------------------------------------------------------------------------------------------
// Small numeric helpers (also used by the tracker)
// ---------------------------------------------------------------------------------------------------------

/** Clamp to 0..1. NaN -> 0. */
export function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0
}

/** A descriptor value: clamped to 0..1, NaN -> the neutral 0.5. */
export function descriptor01(x: number): number {
  return x === x ? clamp01(x) : 0.5
}

/**
 * One-pole blend factor for a step of `dt` seconds toward a target with time constant `tau`:
 * `1 - exp(-dt / tau)`. A NaN / zero / negative / infinite `dt` returns 0 (hold: it must never poison state);
 * a huge finite `dt` returns ~1 (snap to target, never overshoot).
 */
export function easeFactor(dt: number, tau: number): number {
  if (!(dt > 0) || dt === Infinity) return 0
  if (!(tau > 0)) return 1
  return 1 - Math.exp(-dt / tau)
}

/** 0..1 smoothstep. */
export function smoothstep01(x: number): number {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/** Linear ramp toward 1 (`up`) over `attackSec` or toward 0 over `releaseSec`. dt-guarded. */
export function stepRamp(cur: number, up: boolean, dt: number, attackSec: number, releaseSec: number): number {
  if (!(dt > 0) || dt === Infinity) return cur
  const sec = up ? attackSec : releaseSec
  const step = sec > 0 ? dt / sec : 1
  return clamp01(up ? cur + step : cur - step)
}

/** Structural build: instant attack (follows `buildProgress`), linear release over `structuralReleaseSec`. */
export function stepStructuralBuild(cur: number, structural: number, dt: number): number {
  const target = clamp01(structural)
  const held = dt > 0 && dt !== Infinity ? cur - dt / BUILD_INTENT.structuralReleaseSec : cur
  return held > target ? (held < 1 ? held : 1) : target
}

/** Drop afterglow: 1 on the drop's rising edge (`edge`), else linear decay over `AFTERGLOW.seconds`. */
export function stepAfterglow(cur: number, edge: boolean, dt: number): number {
  if (edge) return 1
  if (!(dt > 0) || dt === Infinity) return cur
  const next = cur - dt / AFTERGLOW.seconds
  return next > 0 ? next : 0
}

/** The intensity gate for a fast look state (unknown -> 1). */
export function intensityGate(look: MoodState): number {
  const g = INTENSITY_GATE[look]
  return g === undefined ? 1 : g
}

/** Share (0..1) of a `CHARACTER_MOODS`-ordered weight vector that sits on dreamy / serene / mysterious. */
export function calmMirrorShare(weights: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < CALM_MIRROR_IDX.length; i++) {
    const w = weights[CALM_MIRROR_IDX[i]]
    s += w > 0 ? w : 0
  }
  return clamp01(s)
}

function sumOf(w: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < w.length; i++) s += w[i]
  return s
}

/** Moves fraction `mix` of the total mass of `w` onto index `to` (in place, total preserved). */
function moveMassTo(w: number[], to: number, mix: number): void {
  if (!(mix > 0)) return
  const m = mix < 1 ? mix : 1
  let s = sumOf(w)
  if (!(s > EPS)) s = 1
  for (let i = 0; i < w.length; i++) w[i] *= 1 - m
  w[to] += m * s
}

/** Build: pulls the segment weights (total preserved) toward a target that steps 4 -> 6 -> 8 as `r` rises. */
function stepSegments(w: number[], r: number): void {
  const mix = BUILD.segmentMix * r
  if (!(mix > 0)) return
  let s = sumOf(w)
  if (!(s > EPS)) s = 1
  const t4 = r < 0.5 ? 1 - 2 * r : 0
  const t6 = r < 0.5 ? 2 * r : 2 - 2 * r
  const t8 = r > 0.5 ? 2 * r - 1 : 0
  const keep = 1 - mix
  w[SEG_4] = w[SEG_4] * keep + mix * s * t4
  w[SEG_6] = w[SEG_6] * keep + mix * s * t6
  w[SEG_8] = w[SEG_8] * keep + mix * s * t8
}

/** Breakdown: moves the non-soft lens mass (weighted `b`) onto the soft styles, total preserved. */
function restrictLensToSoft(w: number[], b: number): void {
  let total = 0
  for (let i = 0; i < w.length; i++) total += w[i]
  let soft = 0
  for (let j = 0; j < SOFT_LENS_STYLES.length; j++) soft += w[SOFT_LENS_STYLES[j]]
  const removed = (total - soft) * b
  if (!(removed > EPS)) return
  for (let i = 0; i < w.length; i++) if (!IS_SOFT_LENS[i]) w[i] *= 1 - b
  if (soft > EPS) {
    for (let j = 0; j < SOFT_LENS_STYLES.length; j++) {
      const k = SOFT_LENS_STYLES[j]
      w[k] += (removed * w[k]) / soft
    }
  } else {
    for (let j = 0; j < SOFT_LENS_STYLES.length; j++) w[SOFT_LENS_STYLES[j]] += removed / SOFT_LENS_STYLES.length
  }
}

/**
 * Harsh descriptor on the lens weights: `u > 0` moves `harshLensShift * u` of the soft-style mass onto the hard
 * styles (proportional to their existing weights, else glitch 0.4 / pixel sort 0.6); `u < 0` moves that share of
 * the hard mass back onto the soft styles. Total preserved.
 */
function shiftLensHarsh(w: number[], u: number): void {
  if (u > 0) {
    let soft = 0
    for (let j = 0; j < SOFT_LENS_STYLES.length; j++) soft += w[SOFT_LENS_STYLES[j]]
    if (!(soft > EPS)) return
    const f = DESCRIPTOR.harshLensShift * u
    const moved = soft * f
    for (let j = 0; j < SOFT_LENS_STYLES.length; j++) w[SOFT_LENS_STYLES[j]] *= 1 - f
    let hard = 0
    for (let j = 0; j < HARD_LENS_STYLES.length; j++) hard += w[HARD_LENS_STYLES[j]]
    if (hard > EPS) {
      for (let j = 0; j < HARD_LENS_STYLES.length; j++) {
        const k = HARD_LENS_STYLES[j]
        w[k] += (moved * w[k]) / hard
      }
    } else {
      for (let j = 0; j < HARD_LENS_STYLES.length; j++) w[HARD_LENS_STYLES[j]] += moved * HARD_SPLIT[j]
    }
  } else if (u < 0) {
    let hard = 0
    for (let j = 0; j < HARD_LENS_STYLES.length; j++) hard += w[HARD_LENS_STYLES[j]]
    if (!(hard > EPS)) return
    const f = DESCRIPTOR.harshLensShift * -u
    const moved = hard * f
    for (let j = 0; j < HARD_LENS_STYLES.length; j++) w[HARD_LENS_STYLES[j]] *= 1 - f
    let soft = 0
    for (let j = 0; j < SOFT_LENS_STYLES.length; j++) soft += w[SOFT_LENS_STYLES[j]]
    if (soft > EPS) {
      for (let j = 0; j < SOFT_LENS_STYLES.length; j++) {
        const k = SOFT_LENS_STYLES[j]
        w[k] += (moved * w[k]) / soft
      }
    } else {
      for (let j = 0; j < SOFT_LENS_STYLES.length; j++) w[SOFT_LENS_STYLES[j]] += moved / SOFT_LENS_STYLES.length
    }
  }
}

/** `1 + k * u`, held within `1 +- DESCRIPTOR.bound`. */
function factor(f: number): number {
  const lo = 1 - DESCRIPTOR.bound
  const hi = 1 + DESCRIPTOR.bound
  return f < lo ? lo : f > hi ? hi : f
}

function min(a: number, b: number): number {
  return a < b ? a : b
}

// ---------------------------------------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------------------------------------

/**
 * BUILD: bloom +.15r, trails +.1r, feedback zoom x(1+r), echo gate up, hard lens weights x(1+r), mirror engaged
 * with segments stepping 4 -> 6 -> 8, steer speed / complexity +.15r, saturation +.05r, camera push. NO strobe
 * (and no other fx propensity) change. `r` = buildIntent, clamped to 0..1; NaN / 0 is a no-op.
 */
export function applyBuild(p: LookRow, r: number): void {
  const x = clamp01(r)
  if (!(x > 0)) return
  p.bloomBase = min(CAP.bloom, p.bloomBase + BUILD.bloom * x)
  p.trailsBase = min(CAP.trails, p.trailsBase + BUILD.trails * x)
  p.trailsZoom = min(CAP.trailsMult, p.trailsZoom * (1 + BUILD.trailsZoomGain * x))
  p.echoGate = min(CAP.echoGate, p.echoGate + BUILD.echoGate * x)
  const lens = p.lensWeights
  const g = 1 + BUILD.hardLensGain * x
  for (let j = 0; j < HARD_LENS_STYLES.length; j++) lens[HARD_LENS_STYLES[j]] *= g
  p.mirrorEngage = min(CAP.mirrorEngage, p.mirrorEngage + BUILD.mirrorEngage * x)
  stepSegments(p.mirrorSegments, x)
  p.steerSpeed = min(CAP.steer, p.steerSpeed + BUILD.steer * x)
  p.steerComplexity = min(CAP.steer, p.steerComplexity + BUILD.steer * x)
  p.gradeSat = min(CAP.gradeSat, p.gradeSat + BUILD.gradeSat * x)
  moveMassTo(p.cameraWeights, CAM_PUSH, BUILD.cameraPush * x)
}

/**
 * DROP afterglow (a = 1 at the drop, decaying to 0 over `AFTERGLOW.seconds`): mirror pushed to 8 segments,
 * saturation +.1a, contrast +.05a. `a` clamped to 0..1; NaN / 0 is a no-op.
 */
export function applyAfterglow(p: LookRow, a: number): void {
  const x = clamp01(a)
  if (!(x > 0)) return
  moveMassTo(p.mirrorSegments, SEG_8, AFTERGLOW.segmentMix * x)
  p.mirrorEngage = min(CAP.mirrorEngage, p.mirrorEngage + AFTERGLOW.mirrorEngage * x)
  p.gradeSat = min(CAP.gradeSat, p.gradeSat + AFTERGLOW.gradeSat * x)
  p.gradeContrast = min(CAP.gradeContrast, p.gradeContrast + AFTERGLOW.gradeContrast * x)
}

/**
 * BREAKDOWN (b = eased 0..1): bloom x.7, trails +.15, echo gate 0, lens weights restricted to the soft styles
 * (ribs / fan / anamorphic / melt), mirror off unless the mood is a calm-mirror one (then it stays, spinning
 * slowly), steer speed / density -.2, fog +.15, camera weights toward hover.
 *
 * `calmMirror` (0..1, see `calmMirrorShare`) is the weight share on dreamy / serene / mysterious. The plan says
 * "unless the primary mood is ..."; a continuous share instead of a boolean on the primary means a primary
 * flip mid-breakdown cannot pop the mirror on or off.
 */
export function applyBreakdown(p: LookRow, b: number, calmMirror: number): void {
  const x = clamp01(b)
  if (!(x > 0)) return
  p.bloomBase *= 1 - (1 - BREAKDOWN.bloomScale) * x
  p.trailsBase = min(CAP.trails, p.trailsBase + BREAKDOWN.trails * x)
  p.echoGate *= 1 - x
  restrictLensToSoft(p.lensWeights, x)
  const keep = clamp01(calmMirror)
  p.mirrorEngage *= 1 - x * (1 - keep)
  const slow = x * keep
  if (slow > 0) {
    const cap = BREAKDOWN.slowSpinMax
    const spinMax = p.mirrorSpinMax
    p.mirrorSpinMax = min(spinMax, spinMax + (cap - spinMax) * slow)
    const spinMin = p.mirrorSpinMin
    p.mirrorSpinMin = min(min(spinMin, spinMin + (cap - spinMin) * slow), p.mirrorSpinMax)
  }
  const sp = p.steerSpeed - BREAKDOWN.steer * x
  p.steerSpeed = sp > 0 ? sp : 0
  const de = p.steerDensity - BREAKDOWN.steer * x
  p.steerDensity = de > 0 ? de : 0
  p.fogBase = min(CAP.fog, p.fogBase + BREAKDOWN.fog * x)
  moveMassTo(p.cameraWeights, CAM_HOVER, BREAKDOWN.cameraHover * x)
}

/**
 * Scales the hard-effect propensities by the fast-layer gate (0..1): lens / mirror engage, shock / flare /
 * spark / strobe, and the reactive chromatic-aberration gain. Only ever LOWERS them.
 */
export function applyIntensityGate(p: LookRow, gate: number): void {
  const g = clamp01(gate)
  if (g >= 1) return
  p.lensEngage *= g
  p.mirrorEngage *= g
  p.fxShock *= g
  p.fxFlare *= g
  p.fxSpark *= g
  p.fxStrobe *= g
  p.caReact *= g
}

/**
 * Timbre-descriptor modulation (each 0..1, NaN -> 0.5, 0.5 = identity). See `DESCRIPTOR`.
 *
 *  - harsh: scales `lensEngage` by (0.6 + 0.8 harsh); moves up to 40% of soft lens weight onto pixel sort /
 *    glitch (and back when low); raises `caBase` slightly; lowers `trailsBase`.
 *  - busy: scales `mirrorEngage` (by the row's `mirrorBusyGain`); raises `steerComplexity` / `steerDensity`.
 *  - sparse: raises `fogBase` and `trailsBase`; lowers `echoGate` and `steerSpeed`.
 *
 * Multiplicative, so a dial a mood does not use (0) stays 0, and every factor is within +-40%.
 */
export function applyDescriptors(p: LookRow, harsh: number, busy: number, sparse: number): void {
  const h = descriptor01(harsh)
  const uh = 2 * h - 1
  const ub = 2 * descriptor01(busy) - 1
  const us = 2 * descriptor01(sparse) - 1

  p.lensEngage = min(CAP.lensEngage, p.lensEngage * factor(DESCRIPTOR.harshEngageBase + DESCRIPTOR.harshEngageGain * h))
  shiftLensHarsh(p.lensWeights, uh)
  p.caBase *= factor(1 + DESCRIPTOR.harshCa * uh)
  p.trailsBase = min(CAP.trails, p.trailsBase * factor((1 - DESCRIPTOR.harshTrails * uh) * (1 + DESCRIPTOR.sparseTrails * us)))

  const gain = clamp01(p.mirrorBusyGain)
  p.mirrorEngage = min(CAP.mirrorEngage, p.mirrorEngage * factor(1 + DESCRIPTOR.busyMirror * gain * ub))
  p.steerComplexity = min(CAP.steer, p.steerComplexity * factor(1 + DESCRIPTOR.busySteer * ub))
  p.steerDensity = min(CAP.steer, p.steerDensity * factor(1 + DESCRIPTOR.busySteer * ub))

  p.fogBase = min(CAP.fog, p.fogBase * factor(1 + DESCRIPTOR.sparseFog * us))
  p.echoGate = min(CAP.echoGate, p.echoGate * factor(1 - DESCRIPTOR.sparseEcho * us))
  p.steerSpeed = min(CAP.steer, p.steerSpeed * factor(1 - DESCRIPTOR.sparseSpeed * us))
}

// @hot-path:end

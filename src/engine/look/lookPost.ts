import { createEmptyCharacterState, type CharacterMood, type CharacterState } from '../../audio/characterTypes'
import type { MoodState } from '../../audio/types'
import { habituatedGate, type Habituation } from '../habituation'
import { MIRROR_OFF, type MirrorTarget } from '../opticalDirector'
import { approach } from '../performanceState'
import { lookFamilies, lookForceMood } from './lookFlags'
import { clamp01, easeFactor } from './lookModifiers'
import { LookProfileTracker, type LookInput } from './lookProfile'
import { LENS, MIRROR_MODES, SEGMENT_CHOICES, type LookFamilies, type LookProfile } from './lookRow'

/**
 * The PURE half of the mood look's post-fx wiring (plan P3): everything `PerformanceStateBridge` computes from
 * `performanceState.look` for bloom, chromatic aberration, vignette, fog, trails, echo, the lens and the mirror
 * lives here as small functions of plain numbers, so the bridge only holds refs and calls them, and the
 * arithmetic is unit-tested (`__tests__/lookPost.test.ts`) instead of asserted.
 *
 * ## The contract with the profile (see `lookProfile.ts`)
 *
 *  - The tracker has ALREADY applied the fast-layer modifiers (build, drop afterglow, breakdown) and the
 *    intensity gate to the profile fields, and the descriptor modulation before that. Nothing here multiplies
 *    any of them in again; a target below reads a field once.
 *  - Continuous fields (bloom, CA, vignette, fog, trails, echo gate, mirror mix) are read straight off the
 *    smoothed profile every frame. DISCRETE choices (lens material, mirror mode / segment count) arrive as weight
 *    vectors that need not sum to 1; they are SAMPLED proportionally, once, at the decision edges the bridge
 *    already has (section change, phrase edge), never per frame, so nothing flips because the blended
 *    distribution wobbled.
 *  - Consumers gate on {@link postLookActive}; when it is false the bridge runs its original code, untouched.
 *
 * ## Determinism
 *
 * No `Math.random`. The engagement roll is the existing `habituatedGate(seed, habituation, ...)`; the choice
 * WITHIN an engaged decision (which lens style, which mirror mode / segment count / vortex direction) is a
 * pure hash of the same per-decision seed under a per-question salt ({@link unit01}), so a recorded set replays
 * identically and the four questions do not share a bit (the mirror's old vortex-sign bug, F229).
 *
 * The functions marked hot-path run every frame and allocate nothing; the sampling functions run at decision
 * edges only.
 */

// ---------------------------------------------------------------------------------------------------------
// Tuning constants (art direction; the legacy formula each one replaces is named beside it)
// ---------------------------------------------------------------------------------------------------------

/** Legacy `visualTension` / drop terms of the vignette: `+ tension * 0.16 - (drop ? 0.2 : 0)` on top of the resting level. */
export const VIGNETTE_TENSION = 0.16
export const VIGNETTE_DROP_DIP = 0.2
/** Legacy fog terms: `sparse * 0.6` and the `relaxed` head's `* 0.2`, now added to the row's `fogBase` (which replaces the old `ambient ? 0.25`). */
export const FOG_SPARSE_GAIN = 0.6
/** Legacy chromatic-aberration reactive terms (`caReact` scales the whole reactive sum). */
export const CA_PULSE = 0.0035
export const CA_TENSION = 0.002
export const CA_DROP = 0.004
export const CA_AGGRESSIVE = 0.0015
/** Legacy `trailsTarget` busy penalty (flux) and energy penalty. Pinned equal to it by test. */
export const TRAILS_FLUX_CEILING = 0.9
export const TRAILS_BUSY_PENALTY = 0.32
export const TRAILS_ENERGY_PENALTY = 0.1
/** Time constant (s) the feedback SHAPE multipliers ease with, so a mood change or a kill switch never steps the tunnel's motion. */
export const TRAILS_SHAPE_TAU_SEC = 0.7
/** The multipliers are design-ranged 0..2. */
export const TRAILS_SHAPE_MAX = 2

/** Engagement caps (rows and modifiers stay under these; a hard cap keeps a bad profile from a certain engage). */
export const LENS_ENGAGE_MAX = 0.85
export const MIRROR_ENGAGE_MAX = 0.9
/** Habituation dampening / floor: the lens keeps `lensForSection`'s defaults, the mirror its tightened pair (see `mirrorForSection`). */
const LENS_DAMPENING = 0.7
const LENS_FLOOR = 0.1
const MIRROR_DAMPENING = 0.85
const MIRROR_FLOOR = 0.05
/** `pixels` (style 5): `amount` is inverted cell coarseness, so it needs this floor to read as a deliberate LED wall (see `lensAmountTarget`). */
export const PIXELS_AMOUNT_FLOOR = 0.55
/** Rate (1/s) the lens amount eases toward its target: `lensAmountTarget`'s own 0.5. */
export const LENS_AMOUNT_RATE = 0.5
/** Rate (1/s) the amount dips toward 0 before a style swap: faster than the rise, so a swap takes about two seconds to hide. */
export const LENS_DIP_RATE = 1.2
/** The style index only changes while the amount is below this (about invisible: `RACK_OFF_THRESHOLD` is 0.01). */
export const LENS_SWAP_BELOW = 0.05

/** Kaleidoscope spin cap, before and AFTER the `(0.6 + level * 0.7)` breathing scale (past ~0.7 a fold reads as a strobe, see `mirrorForSection`). */
export const MIRROR_SPIN_CAP = 0.7
/** Vortex twist magnitude is `mirrorTwistMax * (TWIST_AT_REST + (1 - TWIST_AT_REST) * tension)`: never above the row's ceiling. */
export const MIRROR_TWIST_AT_REST = 0.6

// ---------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------

/** A finite number, else the fallback. */
function fin(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback
}

/** Clamp into [lo, hi] (a non-finite input is `lo`). */
function clampRange(x: number, lo: number, hi: number): number {
  return x > lo ? (x < hi ? x : hi) : lo
}

/** The slice of `AudioFeatures` the tracker input is built from (`audioEngine.features` satisfies it structurally). */
export interface LookInputFeatures {
  character: CharacterState
  timbre: { harsh: number; busy: number; sparse: number }
  structureValid: boolean
  songSection: { isBuild: boolean; buildProgress: number; isDrop: boolean; isBreakdown: boolean; beatsTillDrop: number }
  mood: { isBuilding: boolean }
  drop: boolean
  delta: number
}

/** Eased multipliers on the feedback pass's fixed zoom / rotate / swirl / wobble ratios (1 = today's look). */
export interface TrailsShape {
  zoom: number
  rotate: number
  swirl: number
  wobble: number
}

/** What the lens rack is RENDERING: the material index and its amount. */
export interface LensSwapState {
  style: number
  amount: number
}

// @hot-path:begin (every function until the matching end runs per frame: no `new`, no array/object literals, no closures, no spread)

// ---------------------------------------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------------------------------------

/**
 * May the mood profile drive the post-fx family (bloom, CA, vignette, fog, trails, echo, lens, mirror) this frame?
 *
 * True when the profile is a real read (`valid`), the `post` family is on (`?look=-post` and `?scenepick=legacy`
 * clear it), and the fast layer is not in `silence`. The last clause is a deliberate restraint beyond the plan's
 * bare `valid && families.post`: the character read HOLDS its last mood through silence (`emotionDimensions`),
 * so without it a gap between two tracks would keep the previous song's row (a euphoric row's 0.75 bloom, its
 * trails) on a dark, empty screen, where the legacy tables go dim and clean (`silence`: bloom 0.3, no trails,
 * no echo, no lens, no mirror). Silence therefore stays on the original code path, EXCEPT under `?lookforce`
 * (`source === 'forced'`): a pinned row is a tuning tool, and it must not vanish when the player is paused.
 * (The intensity gate is 0 in silence, so a forced row still shows no lens or mirror there, only its post look.)
 */
export function postLookActive(look: Pick<LookProfile, 'valid' | 'families' | 'source'>, legacyLook: MoodState): boolean {
  return look.valid === true && look.families.post === true && (legacyLook !== 'silence' || look.source === 'forced')
}

// ---------------------------------------------------------------------------------------------------------
// Feeding the tracker (no allocation)
// ---------------------------------------------------------------------------------------------------------

/**
 * Overwrites `out` in place from this frame's features and returns it. `character` and `timbre` are re-pointed
 * every frame (never cached across frames: `resetAnalysis()` REPLACES `features.timbre`, see `AudioFeatures`).
 * `legacyBuilding` is the everyday build signal: the mood engine's `isBuilding` OR the fast look being `building`.
 */
export function fillLookInput(out: LookInput, f: LookInputFeatures, legacyLook: MoodState): LookInput {
  out.character = f.character
  out.legacyLook = legacyLook
  out.timbre = f.timbre
  const s = out.song
  const ss = f.songSection
  s.structureValid = f.structureValid
  s.isBuild = ss.isBuild
  s.buildProgress = ss.buildProgress
  s.isDrop = ss.isDrop
  s.isBreakdown = ss.isBreakdown
  s.beatsTillDrop = ss.beatsTillDrop
  out.legacyBuilding = f.mood.isBuilding || legacyLook === 'building'
  out.drop = f.drop
  out.dt = f.delta
  return out
}

// ---------------------------------------------------------------------------------------------------------
// Continuous post targets (each is the legacy formula with its hard-coded resting level read off the profile)
// ---------------------------------------------------------------------------------------------------------

/**
 * Bloom: `(bloomBase + reactive * bloomReact + voiceLift) * intensity`. `reactive` is the bridge's existing
 * `(bass * 0.7 + pulse * 0.7 + drop * 0.8) * reactivity` sum and `voiceLift` its vocal term, both passed through
 * untouched, so at `bloomBase` = the old table's value and `bloomReact` = 1 this IS the legacy bloom.
 */
export function bloomFromProfile(
  look: Pick<LookProfile, 'bloomBase' | 'bloomReact'>,
  reactive: number,
  voiceLift: number,
  intensity: number,
): number {
  const v = (look.bloomBase + reactive * look.bloomReact + voiceLift) * intensity
  return v > 0 ? v : 0
}

/**
 * Chromatic aberration ("glitch"): `caBase + (pulse * .0035 + tension * .002 + drop * .004 + aggressive * .0015) * caReact`.
 * `aggressive` is the `aggressive` mood head (0 when the heads are not valid). `caReact` already carries the
 * intensity gate, so a quiet passage's aberration barely reacts. The caller keeps the quality-low zeroing.
 */
export function glitchFromProfile(
  look: Pick<LookProfile, 'caBase' | 'caReact'>,
  pulse: number,
  tension: number,
  drop: boolean,
  aggressive: number,
): number {
  const v = look.caBase + (pulse * CA_PULSE + tension * CA_TENSION + (drop ? CA_DROP : 0) + aggressive * CA_AGGRESSIVE) * look.caReact
  return v > 0 ? v : 0
}

/** Vignette TARGET (the caller keeps its `approach`): the row's resting level, tightening with tension, dipping on a drop. Clamped 0..1. */
export function vignetteFromProfile(look: Pick<LookProfile, 'vignette'>, tension: number, drop: boolean): number {
  return clamp01(look.vignette + tension * VIGNETTE_TENSION - (drop ? VIGNETTE_DROP_DIP : 0))
}

/**
 * Fog TARGET: the row's `fogBase` plus the legacy live terms, `sparse` (the bridge's `1 - min(1, level * 1.3)`)
 * at 0.6 and the `relaxed` head's air. `fogBase` replaces the old `ambient ? 0.25` bump. Capped at 1.
 */
export function fogFromProfile(look: Pick<LookProfile, 'fogBase'>, sparse: number, relaxedAir: number): number {
  const v = look.fogBase + sparse * FOG_SPARSE_GAIN + relaxedAir
  return v > 0 ? (v < 1 ? v : 1) : 0
}

/**
 * Trails TARGET (the caller keeps its `approach` and the `rackSuppressed` zeroing): the row's `trailsBase` reduced
 * by onset density (`flux`, up to 32%) and slightly by energy, exactly like `trailsTarget`'s
 * `base * (1 - busy * 0.32) * (1 - energy * 0.1)`. Pinned to it by test.
 */
export function trailsFromProfile(look: Pick<LookProfile, 'trailsBase'>, flux: number, energy: number): number {
  const f = flux > 0 ? flux : 0
  const busy = f / TRAILS_FLUX_CEILING
  const sustained = 1 - (busy < 1 ? busy : 1) * TRAILS_BUSY_PENALTY
  const e = energy > 0 ? (energy < 1 ? energy : 1) : 0
  const v = look.trailsBase * sustained * (1 - e * TRAILS_ENERGY_PENALTY)
  return v > 0 ? (v < 1 ? v : 1) : 0
}

/**
 * Echo strength: `echoGate * pulse`, like `echoTarget` (which is `pulse * gate`). NOT eased (F232: `pulse` is
 * already the per-beat envelope), and not scaled by anything else: the tap spacing stays `resolveEchoTapSpacingSec`'s.
 */
export function echoFromProfile(look: Pick<LookProfile, 'echoGate'>, pulse: number): number {
  const p = Number.isFinite(pulse) ? clamp01(pulse) : 0
  return p * clamp01(look.echoGate)
}

/** Mirror mix CEILING while a fold is engaged (the caller eases toward it, and toward 0 when not visible). */
export function mirrorMixFromProfile(look: Pick<LookProfile, 'mirrorMix'>): number {
  return clamp01(look.mirrorMix)
}

/**
 * The `(0.6 + level * 0.7)` breathing the bridge applies to a kaleidoscope's base spin, now capped at
 * {@link MIRROR_SPIN_CAP} AFTER the scale (the legacy path is left uncapped, see the bridge).
 */
export function scaleMirrorSpin(spin: number, level: number): number {
  const s = spin * (0.6 + level * 0.7)
  return s < MIRROR_SPIN_CAP ? s : MIRROR_SPIN_CAP
}

// ---------------------------------------------------------------------------------------------------------
// Feedback shape (trails zoom / rotate / swirl / wobble multipliers)
// ---------------------------------------------------------------------------------------------------------

/** A design-ranged multiplier: clamped 0..2, a non-finite value is the neutral 1. */
function shapeMult(x: number): number {
  if (!Number.isFinite(x)) return 1
  return x < 0 ? 0 : x > TRAILS_SHAPE_MAX ? TRAILS_SHAPE_MAX : x
}

/**
 * One step of the shape multipliers toward the profile's (or toward neutral when the post family is off, so a
 * kill switch or a lost character read eases out instead of stepping). Mutates `cur`; `dt` is guarded by
 * `easeFactor` (a NaN / zero step holds).
 */
export function stepTrailsShape(
  cur: TrailsShape,
  look: Pick<LookProfile, 'valid' | 'families' | 'trailsZoom' | 'trailsRotate' | 'trailsSwirl' | 'trailsWobble'>,
  dt: number,
): void {
  const on = look.valid === true && look.families.post === true
  const k = easeFactor(dt, TRAILS_SHAPE_TAU_SEC)
  cur.zoom += ((on ? shapeMult(look.trailsZoom) : 1) - cur.zoom) * k
  cur.rotate += ((on ? shapeMult(look.trailsRotate) : 1) - cur.rotate) * k
  cur.swirl += ((on ? shapeMult(look.trailsSwirl) : 1) - cur.swirl) * k
  cur.wobble += ((on ? shapeMult(look.trailsWobble) : 1) - cur.wobble) * k
}

// ---------------------------------------------------------------------------------------------------------
// Lens: amount and the dip-and-swap
// ---------------------------------------------------------------------------------------------------------

/**
 * Engaged lens amount TARGET: `lerp(lensAmountFloor, lensAmountCeil, tension^2)` like `lensAmountTarget`
 * (floor plus the range times tension squared), 0 when not engaged, with the same `pixels` floor of 0.55.
 * The caller passes `engaged = false` in silence (the legacy `lensAmountTarget` returns 0 there).
 */
export function lensAmountFromProfile(
  look: Pick<LookProfile, 'lensAmountFloor' | 'lensAmountCeil'>,
  tension: number,
  engaged: boolean,
  style?: number,
): number {
  if (!engaged) return 0
  const t = clamp01(tension)
  const floor = fin(look.lensAmountFloor, 0.15)
  const range = fin(look.lensAmountCeil, 0.24) - floor
  const amt = floor + (range > 0 ? range : 0) * t * t
  return style === LENS.pixels && amt < PIXELS_AMOUNT_FLOOR ? PIXELS_AMOUNT_FLOOR : amt
}

/**
 * One frame of the lens's amount, with a DIP-AND-SWAP so a change of material never hard-swaps a visible lens.
 *
 * `desiredStyle` is what the director chose at its last decision (`lensFromProfile`), `state` is what is on
 * screen. When a lens is engaged and the two differ, the amount eases toward ~0 (`LENS_DIP_RATE`); the style
 * index changes ONLY on a frame where the amount is already below `LENS_SWAP_BELOW`, and on that frame the
 * amount is held (it starts easing back up, at `LENS_AMOUNT_RATE`, the next one). So the material is never
 * replaced while it can be seen, and a swap costs about two seconds of dip. Everything else (same style, or
 * not engaged: eases to 0 with the material held, exactly like the legacy rack) is a plain ease toward
 * `targetAmount` at the legacy rate 0.5. A non-finite `targetAmount` is 0; `approach` holds on a bad `dt`.
 */
export function stepLensSwap(state: LensSwapState, desiredStyle: number, targetAmount: number, engaged: boolean, dt: number): void {
  if (engaged && desiredStyle >= 0 && desiredStyle !== state.style) {
    if (state.amount < LENS_SWAP_BELOW) state.style = desiredStyle
    else state.amount = approach(state.amount, 0, LENS_DIP_RATE, dt)
    return
  }
  const target = engaged && Number.isFinite(targetAmount) ? targetAmount : 0
  state.amount = approach(state.amount, target, LENS_AMOUNT_RATE, dt)
}

// @hot-path:end

// ---------------------------------------------------------------------------------------------------------
// Decision-edge sampling (runs at section / phrase edges only)
// ---------------------------------------------------------------------------------------------------------

/**
 * A deterministic pseudo-random number in [0, 1) from a per-decision `seed` and a per-question `salt`
 * (murmur3's finalizer over a multiplicative mix). Decorrelated from `habituatedGate`'s own roll (a Knuth
 * multiplicative hash reduced mod 997) and from every other salt, so "does it engage", "which style", "which
 * mode", "which segment count" and "which way does the vortex wind" are independent questions. Pure.
 */
export function unit01(seed: number, salt: number): number {
  const s = Number.isFinite(seed) ? Math.trunc(seed) | 0 : 0
  let h = (Math.imul(s, 0x9e3779b1) + Math.imul(salt | 0, 0x85ebca77)) | 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** A weight that counts: finite and positive, else 0. */
function weightOf(x: number): number {
  return x > 0 && x < Infinity ? x : 0
}

/**
 * Index sampled in proportion to `weights` (which need not sum to 1) at the uniform draw `u` in [0, 1),
 * skipping up to two indices. -1 when nothing has weight left. Non-finite and negative weights count as 0.
 */
export function sampleWeighted(weights: ArrayLike<number>, u: number, skipA = -1, skipB = -1): number {
  let total = 0
  for (let i = 0; i < weights.length; i++) if (i !== skipA && i !== skipB) total += weightOf(weights[i])
  if (!(total > 0)) return -1
  let r = clamp01(u) * total
  let last = -1
  for (let i = 0; i < weights.length; i++) {
    if (i === skipA || i === skipB) continue
    const w = weightOf(weights[i])
    if (w <= 0) continue
    last = i
    if (r < w) return i
    r -= w
  }
  return last
}

/** Salts for {@link unit01}, one per question a decision asks. */
const SALT_LENS_STYLE = 0x1e4a
const SALT_MIRROR_MODE = 0x2b7d
const SALT_MIRROR_SEGMENTS = 0x3c91
const SALT_MIRROR_SIGN = 0x4da3

/**
 * Whether the lens engages for this decision, and with which material: -1 for none, else a `LENS` index.
 *
 * Engagement is `habituatedGate` at the profile's `lensEngage` (a probability, already carrying the harsh
 * descriptor, the build ramp and the intensity gate), with the legacy dampening. The floor is capped at half
 * the base rate, so a row that barely engages (or the gate's 0 in silence) is never raised to the gate's flat
 * 10% and a 0 engage NEVER engages. The material is sampled from `lensWeights` in proportion, excluding
 * `flyEye` (retired: its weight is ignored even if a profile carried some) and the currently held material
 * (`avoidStyle`, the anti-repeat of F229), so back-to-back engagements cannot repeat. Like the legacy pool it
 * falls back to allowing the held material only when it is the ONLY one with weight.
 */
export function lensFromProfile(
  look: Pick<LookProfile, 'lensEngage' | 'lensWeights'>,
  seed: number,
  habituation: Habituation,
  avoidStyle?: number,
): number {
  const engage = clampRange(fin(look.lensEngage, 0), 0, LENS_ENGAGE_MAX)
  if (!(engage > 0)) return -1
  if (!habituatedGate(seed, habituation, engage, LENS_DAMPENING, Math.min(LENS_FLOOR, engage * 0.5))) return -1
  const u = unit01(seed, SALT_LENS_STYLE)
  const i = sampleWeighted(look.lensWeights, u, LENS.flyEye, avoidStyle === undefined ? -1 : avoidStyle)
  return i >= 0 ? i : sampleWeighted(look.lensWeights, u, LENS.flyEye)
}

/**
 * The mirror rack's whole state for a decision, from the profile: `MIRROR_OFF` when it does not engage.
 *
 * Engagement is `habituatedGate` at the profile's `mirrorEngage` (the blend, with the `busy` descriptor, the
 * build / afterglow lift and the intensity gate already in it) with the mirror's tightened dampening. Mode is
 * sampled from `mirrorMode` (kaleido / vortex). A kaleidoscope's segments are sampled from `mirrorSegments`
 * (4 / 6 / 8) and its base spin sits in `[mirrorSpinMin, mirrorSpinMax]` by tension (both capped at 0.7; the
 * bridge's breathing scale is capped again by {@link scaleMirrorSpin}). A vortex's twist has a magnitude of at
 * most `mirrorTwistMax` (rising with tension), a random direction, and no spin (the fold's angle only turns
 * a kaleidoscope, so a vortex spin would be inert). The segment / spin / twist draws only happen for the mode
 * that uses them. Scene exclusions (kifs / maze / wingfold / djcam) are the caller's, downstream, as before.
 */
export function mirrorFromProfile(
  look: Pick<LookProfile, 'mirrorEngage' | 'mirrorMode' | 'mirrorSegments' | 'mirrorSpinMin' | 'mirrorSpinMax' | 'mirrorTwistMax'>,
  tension: number,
  seed: number,
  habituation: Habituation,
): MirrorTarget {
  const engage = clampRange(fin(look.mirrorEngage, 0), 0, MIRROR_ENGAGE_MAX)
  if (!(engage > 0)) return MIRROR_OFF
  if (!habituatedGate(seed, habituation, engage, MIRROR_DAMPENING, Math.min(MIRROR_FLOOR, engage * 0.5))) return MIRROR_OFF
  const t = clamp01(fin(tension, 0))
  const modeIdx = sampleWeighted(look.mirrorMode, unit01(seed, SALT_MIRROR_MODE))
  if (modeIdx < 0) return MIRROR_OFF
  if (MIRROR_MODES[modeIdx] === 'vortex') {
    const twistMax = fin(look.mirrorTwistMax, 0)
    const magnitude = (twistMax > 0 ? twistMax : 0) * (MIRROR_TWIST_AT_REST + (1 - MIRROR_TWIST_AT_REST) * t)
    const sign = unit01(seed, SALT_MIRROR_SIGN) < 0.5 ? -1 : 1
    return { mode: 'vortex', segments: 0, tiles: 0, twist: sign * magnitude, slice: 0, spin: 0 }
  }
  const segIdx = sampleWeighted(look.mirrorSegments, unit01(seed, SALT_MIRROR_SEGMENTS))
  if (segIdx < 0) return MIRROR_OFF
  const lo = clampRange(fin(look.mirrorSpinMin, 0), 0, MIRROR_SPIN_CAP)
  const hi = clampRange(fin(look.mirrorSpinMax, 0), lo, MIRROR_SPIN_CAP)
  return { mode: 'kaleido', segments: SEGMENT_CHOICES[segIdx], tiles: 0, twist: 0, slice: 0, spin: lo + (hi - lo) * t }
}

// ---------------------------------------------------------------------------------------------------------
// Runtime (built once per mounted bridge)
// ---------------------------------------------------------------------------------------------------------

/** Everything the bridge holds for the look system: the tracker, its reusable input, and the flags read ONCE. */
export interface LookRuntime {
  readonly tracker: LookProfileTracker
  readonly input: LookInput
  readonly force: CharacterMood | null
  readonly families: LookFamilies
}

/** A reusable, correctly shaped tracker input (mutated in place by {@link fillLookInput} every frame). */
export function createLookInput(force: CharacterMood | null, families: LookFamilies): LookInput {
  return {
    character: createEmptyCharacterState(),
    legacyLook: 'silence',
    timbre: { harsh: 0.5, busy: 0.5, sparse: 0.5 },
    song: { structureValid: false, isBuild: false, buildProgress: 0, isDrop: false, isBreakdown: false, beatsTillDrop: -1 },
    legacyBuilding: false,
    drop: false,
    dt: 0,
    force,
    families,
  }
}

/**
 * Builds the runtime. The URL flags (`?lookforce`, `?look=`, `?scenepick=legacy`) are read here, ONCE, from
 * `search` (default `location.search`, i.e. the window that actually runs the engine, which is why the console
 * forwards them: see `lookUrl.ts`).
 */
export function createLookRuntime(search?: string): LookRuntime {
  const force = lookForceMood(search)
  const families = lookFamilies(search)
  return { tracker: new LookProfileTracker(), input: createLookInput(force, families), force, families }
}

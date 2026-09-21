import { CHARACTER_MOODS, type CharacterMood, type CharacterState } from '../../audio/characterTypes'
import type { MoodState } from '../../audio/types'
import {
  applyAfterglow,
  applyBreakdown,
  applyBuild,
  applyDescriptors,
  applyIntensityGate,
  BUILD_INTENT,
  BREAKDOWN,
  calmMirrorShare,
  clamp01,
  descriptor01,
  easeFactor,
  intensityGate,
  INTENSITY_GATE_TAU_SEC,
  smoothstep01,
  stepAfterglow,
  stepRamp,
  stepStructuralBuild,
} from './lookModifiers'
import {
  createNeutralRow,
  ROW_ARRAY_KEYS,
  ROW_SCALAR_KEYS,
  type LookFamilies,
  type LookProfile,
  type LookRow,
} from './lookRow'
import { MOOD_ROWS } from './moodRows'

/**
 * The per-frame look computation (plan: "One profile, many readers").
 *
 * `LookProfileTracker.update` turns the character read + the fast intensity layer + the timbre descriptors into
 * the live `LookProfile`, IN PLACE (no allocation), once per frame from `PerformanceStateBridge`:
 *
 *   dist^p weights (p = 1 + 2 confidence)  ->  relax toward NEUTRAL when the read is unsure
 *     -> blend the 14 authored rows (scalars linearly, discrete weight vectors elementwise)
 *     -> descriptor modulation (harsh / busy / sparse, bounded +-40%)
 *     -> one-pole smoothing into the tracker's private STATE (grade 6 s, everything else 3 s)
 *     -> copy to `out`, then the FAST modifiers on that copy (build, drop afterglow, breakdown, intensity gate).
 *
 * The modifiers run after the smoothing and only on the published copy, so they never feed back into the
 * state and cannot compound. Their own state (build ramp, afterglow, breakdown ease, gate ease) advances every
 * frame even while the profile is not valid, so it is continuous when validity begins.
 *
 * ## Contract notes for consumers
 *  - `valid === false` (`source === 'legacy'`): use the legacy code path. The row fields then hold the NEUTRAL row
 *    with an IDENTITY grade (sat 1, temp 0, contrast 1), so a consumer that forgot to check still does no harm.
 *  - Gate every family on `valid && families.<family>`.
 *  - The fast modifiers and `intensityGate` are ALREADY applied to the fields (the gate multiplies
 *    lensEngage, mirrorEngage, fxShock, fxFlare, fxSpark, fxStrobe and caReact). `buildIntent`, `afterglow`,
 *    `breakdown` and `intensityGate` are published for information / scene picking; do not apply them again.
 *  - `buildIntent` is the EFFECTIVE value (already scaled down by the breakdown).
 *  - Discrete weight vectors (`lensWeights`, `mirrorMode`, `mirrorSegments`, `cameraWeights`,
 *    `transitionWeights`) need not sum to 1; sample proportionally at the consumer's decision edge.
 *
 * `secondaryWeight` (the classifier's runner-up blend) is NOT used: `dist^p` already carries the runner-up's mass
 * in proportion, and `primary` / `secondary` are hysteresis-held (they flip discretely), so blending them in
 * again would double count and reintroduce steps.
 */

// ---------------------------------------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------------------------------------

/** One-pole time constants, seconds. */
export const LOOK_TAU = {
  /** Colour grade: the slowest thing on screen. */
  grade: 6,
  /** Everything else (post base, trails, lens, mirror, steer, camera, transition weights, fx propensity). */
  main: 3,
} as const

export const BLEND = {
  /** Weight sharpening exponent p = sharpenBase + sharpenPerConfidence * confidence. */
  sharpenBase: 1,
  sharpenPerConfidence: 2,
  /** Maximum pull toward the NEUTRAL row. */
  relaxMax: 0.6,
  /** Normalised entropy where relaxing starts (relax reaches `relaxMax` at entropy 1). */
  relaxEntropyStart: 0.8,
  /** `out.primary` only moves when another mood's smoothed weight beats the current one by this much (overlay stability). */
  primaryHysteresis: 0.04,
} as const

const MOOD_N = CHARACTER_MOODS.length
const SCALAR_N = ROW_SCALAR_KEYS.length
type RowArrayKey = keyof typeof ROW_ARRAY_KEYS
const ARRAY_KEYS = Object.keys(ROW_ARRAY_KEYS) as RowArrayKey[]
/** Parallel to `ROW_SCALAR_KEYS`: true for the colour-grade columns (slow time constant). */
const IS_GRADE_KEY: readonly boolean[] = ROW_SCALAR_KEYS.map((k) => k.startsWith('grade'))

/** What the tracker is fed each frame. */
export interface LookInput {
  /** `f.character`. */
  character: CharacterState
  /** `lookOf(f.mood)`: the fast 7-state look. */
  legacyLook: MoodState
  /** `f.timbre`, 0..1 (defaults 0.5). */
  timbre: { harsh: number; busy: number; sparse: number }
  song: {
    structureValid: boolean
    isBuild: boolean
    buildProgress: number
    isDrop: boolean
    isBreakdown: boolean
    beatsTillDrop: number
  }
  /** `f.mood.isBuilding || legacyLook === 'building'`: the everyday build signal. */
  legacyBuilding: boolean
  /** `f.drop` (latched window; the afterglow arms on its rising edge). */
  drop: boolean
  /** Seconds since the last frame. May be 0 / NaN / negative / huge: guarded. */
  dt: number
  /** `?lookforce`. */
  force: CharacterMood | null
  /** From `lookFlags`. */
  families: LookFamilies
}

// @hot-path:begin (everything below runs per frame: no `new`, no array/object literals, no closures, no spread)

function copyRow(src: LookRow, dst: LookRow): void {
  for (let k = 0; k < SCALAR_N; k++) {
    const key = ROW_SCALAR_KEYS[k]
    dst[key] = src[key]
  }
  for (let a = 0; a < ARRAY_KEYS.length; a++) {
    const key = ARRAY_KEYS[a]
    const s = src[key]
    const d = dst[key]
    const n = ROW_ARRAY_KEYS[key]
    for (let j = 0; j < n; j++) d[j] = s[j]
  }
}

function copyFamilies(src: LookFamilies, dst: LookFamilies): void {
  dst.grade = src.grade
  dst.post = src.post
  dst.scene = src.scene
  dst.camera = src.camera
}

// @hot-path:end

export class LookProfileTracker {
  /** Rows in `CHARACTER_MOODS` order. */
  private readonly rowList: LookRow[]
  private readonly neutral: LookRow = createNeutralRow()
  /** The blended (and descriptor-modulated) target, recomputed every frame. */
  private readonly target: LookRow = createNeutralRow()
  /** The smoothed state: what `out` is built from BEFORE the fast modifiers. */
  private readonly state: LookRow = createNeutralRow()
  private readonly rawW: number[] = new Array<number>(MOOD_N).fill(0)
  private readonly smoothW: number[] = new Array<number>(MOOD_N).fill(0)
  private seeded = false
  private relaxState = 1
  private primaryIdx = -1

  // fast-layer modifier state
  private structBuild = 0
  private legacyRamp = 0
  private afterglow = 0
  private breakdownRamp = 0
  private prevDrop = false
  private gate = 1
  private gateSeeded = false

  constructor(rows: Record<CharacterMood, LookRow> = MOOD_ROWS) {
    this.rowList = CHARACTER_MOODS.map((m) => rows[m])
  }

  /** Forget all state: the next valid frame seeds directly and the fast-layer modifiers restart from zero. */
  reset(): void {
    this.seeded = false
    this.relaxState = 1
    this.primaryIdx = -1
    this.structBuild = 0
    this.legacyRamp = 0
    this.afterglow = 0
    this.breakdownRamp = 0
    this.prevDrop = false
    this.gate = 1
    this.gateSeeded = false
  }

  // @hot-path:begin (per-frame methods)

  /** Mutates `out` in place. No allocation. */
  update(input: LookInput, out: LookProfile): void {
    const dt = input.dt > 0 && input.dt !== Infinity ? input.dt : 0
    this.advanceFastLayer(input, dt)

    const fam = input.families
    const cs = input.character
    const forceIdx = input.force === null ? -1 : CHARACTER_MOODS.indexOf(input.force)
    const forced = forceIdx >= 0
    if (!(fam.grade || fam.post || fam.scene || fam.camera) || (!cs.valid && !forced)) {
      this.writeLegacy(input, out)
      return
    }

    // 1. weights ------------------------------------------------------------------------------------------
    const relax = forced ? this.forcedWeights(forceIdx) : this.characterWeights(cs)

    // 2. blend + descriptor modulation --------------------------------------------------------------------
    this.blendTarget(relax)
    const harsh = descriptor01(input.timbre.harsh)
    const busy = descriptor01(input.timbre.busy)
    const sparse = descriptor01(input.timbre.sparse)
    applyDescriptors(this.target, harsh, busy, sparse)

    // 3. smoothing (first valid frame seeds directly) -----------------------------------------------------
    const kMain = easeFactor(dt, LOOK_TAU.main)
    if (!this.seeded) {
      copyRow(this.target, this.state)
      for (let i = 0; i < MOOD_N; i++) this.smoothW[i] = this.rawW[i]
      this.relaxState = relax
      this.primaryIdx = -1
      this.seeded = true
    } else {
      this.smoothState(kMain, easeFactor(dt, LOOK_TAU.grade))
      for (let i = 0; i < MOOD_N; i++) this.smoothW[i] += (this.rawW[i] - this.smoothW[i]) * kMain
      this.relaxState += (relax - this.relaxState) * kMain
    }

    // 4. publish: state -> out, then the fast modifiers on the copy ---------------------------------------
    copyRow(this.state, out)
    const sw = this.smoothW
    let best = 0
    for (let i = 1; i < MOOD_N; i++) if (sw[i] > sw[best]) best = i
    if (this.primaryIdx < 0 || sw[best] > sw[this.primaryIdx] + BLEND.primaryHysteresis) this.primaryIdx = best
    const ow = out.weights
    for (let i = 0; i < MOOD_N; i++) ow[i] = sw[i]
    out.primary = CHARACTER_MOODS[this.primaryIdx]

    const breakdown = smoothstep01(this.breakdownRamp)
    const build = Math.max(this.structBuild, BUILD_INTENT.legacyCap * this.legacyRamp) * (1 - breakdown)
    applyBuild(out, build)
    applyAfterglow(out, this.afterglow)
    applyBreakdown(out, breakdown, calmMirrorShare(sw))
    applyIntensityGate(out, this.gate)

    out.valid = true
    out.source = forced ? 'forced' : 'character'
    copyFamilies(fam, out.families)
    out.relax = this.relaxState
    out.harsh = harsh
    out.busy = busy
    out.sparse = sparse
    out.buildIntent = build
    out.afterglow = this.afterglow
    out.breakdown = breakdown
    out.intensityGate = this.gate
  }

  /** Steps the modifier state (build ramp, afterglow, breakdown ease, gate). Runs whether or not the profile is valid. */
  private advanceFastLayer(input: LookInput, dt: number): void {
    const song = input.song
    const structural = song.structureValid && song.isBuild ? clamp01(song.buildProgress) : 0
    this.structBuild = stepStructuralBuild(this.structBuild, structural, dt)
    this.legacyRamp = stepRamp(this.legacyRamp, input.legacyBuilding, dt, BUILD_INTENT.legacyAttackSec, BUILD_INTENT.legacyReleaseSec)

    this.afterglow = stepAfterglow(this.afterglow, input.drop && !this.prevDrop, dt)
    this.prevDrop = input.drop

    this.breakdownRamp = stepRamp(this.breakdownRamp, song.structureValid && song.isBreakdown, dt, BREAKDOWN.attackSec, BREAKDOWN.releaseSec)

    const gateTarget = intensityGate(input.legacyLook)
    if (!this.gateSeeded) {
      this.gate = gateTarget
      this.gateSeeded = true
    } else {
      this.gate += (gateTarget - this.gate) * easeFactor(dt, INTENSITY_GATE_TAU_SEC)
    }
  }

  /** `?lookforce`: one-hot on the pinned mood, no relax. Returns relax. */
  private forcedWeights(idx: number): number {
    const w = this.rawW
    for (let i = 0; i < MOOD_N; i++) w[i] = i === idx ? 1 : 0
    return 0
  }

  /** `dist^p` sharpened, normalised weights into `rawW`. Returns relax (0..relaxMax). */
  private characterWeights(cs: CharacterState): number {
    const conf = cs.confidence > 0 ? (cs.confidence < 1 ? cs.confidence : 1) : 0
    const p = BLEND.sharpenBase + BLEND.sharpenPerConfidence * conf
    const w = this.rawW
    const dist = cs.dist
    let sum = 0
    for (let i = 0; i < MOOD_N; i++) {
      const d = dist[CHARACTER_MOODS[i]]
      const x = d > 0 ? Math.pow(d, p) : 0
      w[i] = x
      sum += x
    }
    if (!(sum > 1e-12) || sum === Infinity) {
      // No usable distribution (valid but all zero / non-finite): no information, so the pure NEUTRAL row.
      for (let i = 0; i < MOOD_N; i++) w[i] = 1 / MOOD_N
      return 1
    }
    const inv = 1 / sum
    for (let i = 0; i < MOOD_N; i++) w[i] *= inv
    const e = cs.entropy === cs.entropy ? cs.entropy : 1
    const t = clamp01((e - BLEND.relaxEntropyStart) / (1 - BLEND.relaxEntropyStart))
    return BLEND.relaxMax * t
  }

  /** `target = (1 - relax) * sum_i w_i * row_i + relax * neutral`, generically over the scalar and array keys. */
  private blendTarget(relax: number): void {
    const tgt = this.target
    const neutral = this.neutral
    const rows = this.rowList
    const w = this.rawW
    const keep = 1 - relax
    for (let k = 0; k < SCALAR_N; k++) {
      const key = ROW_SCALAR_KEYS[k]
      let v = 0
      for (let i = 0; i < MOOD_N; i++) {
        const wi = w[i]
        if (wi > 0) v += wi * rows[i][key]
      }
      tgt[key] = keep * v + relax * neutral[key]
    }
    for (let a = 0; a < ARRAY_KEYS.length; a++) {
      const key = ARRAY_KEYS[a]
      const n = ROW_ARRAY_KEYS[key]
      const t = tgt[key]
      const nv = neutral[key]
      for (let j = 0; j < n; j++) {
        let v = 0
        for (let i = 0; i < MOOD_N; i++) {
          const wi = w[i]
          if (wi > 0) v += wi * rows[i][key][j]
        }
        t[j] = keep * v + relax * nv[j]
      }
    }
  }

  /** One-pole step of `state` toward `target`; a non-finite target value is skipped so state can never be poisoned. */
  private smoothState(kMain: number, kGrade: number): void {
    const t = this.target
    const s = this.state
    for (let k = 0; k < SCALAR_N; k++) {
      const key = ROW_SCALAR_KEYS[k]
      const v = t[key]
      if (Number.isFinite(v)) s[key] += (v - s[key]) * (IS_GRADE_KEY[k] ? kGrade : kMain)
    }
    for (let a = 0; a < ARRAY_KEYS.length; a++) {
      const key = ARRAY_KEYS[a]
      const n = ROW_ARRAY_KEYS[key]
      const tv = t[key]
      const sv = s[key]
      for (let j = 0; j < n; j++) {
        const v = tv[j]
        if (Number.isFinite(v)) sv[j] += (v - sv[j]) * kMain
      }
    }
  }

  /** Not valid: legacy code paths. Neutral row, identity grade, zero weights, modifier state published for info. */
  private writeLegacy(input: LookInput, out: LookProfile): void {
    copyRow(this.neutral, out)
    out.gradeSat = 1
    out.gradeTemp = 0
    out.gradeContrast = 1
    out.valid = false
    out.source = 'legacy'
    copyFamilies(input.families, out.families)
    out.primary = null
    const ow = out.weights
    for (let i = 0; i < MOOD_N; i++) ow[i] = 0
    out.relax = 1
    out.harsh = descriptor01(input.timbre.harsh)
    out.busy = descriptor01(input.timbre.busy)
    out.sparse = descriptor01(input.timbre.sparse)
    const breakdown = smoothstep01(this.breakdownRamp)
    out.buildIntent = Math.max(this.structBuild, BUILD_INTENT.legacyCap * this.legacyRamp) * (1 - breakdown)
    out.afterglow = this.afterglow
    out.breakdown = breakdown
    out.intensityGate = this.gate
  }

  // @hot-path:end
}

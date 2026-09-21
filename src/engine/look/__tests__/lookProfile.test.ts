import { describe, expect, it } from 'vitest'
import { CHARACTER_MOODS, createEmptyCharacterState, type CharacterMood, type CharacterState } from '../../../audio/characterTypes'
import { MOOD_STATES } from '../../../audio/types'
import PROFILE_SRC from '../lookProfile.ts?raw'
import { findAllocations, hotPath } from './hotPath'
import { BLEND, LOOK_TAU, LookProfileTracker, type LookInput } from '../lookProfile'
import { HARD_LENS_STYLES, INTENSITY_GATE, SOFT_LENS_STYLES } from '../lookModifiers'
import {
  createLookProfile,
  createNeutralRow,
  LENS,
  ROW_ARRAY_KEYS,
  ROW_SCALAR_KEYS,
  type LookProfile,
  type LookRow,
} from '../lookRow'

// ---------------------------------------------------------------------------------------------------------
// Fixtures: SYNTHETIC rows (the real ones live in moodRows.ts and are tuned by eye; nothing here depends on them)
// ---------------------------------------------------------------------------------------------------------

const ARRAY_KEYS = Object.keys(ROW_ARRAY_KEYS) as (keyof typeof ROW_ARRAY_KEYS)[]
const N = CHARACTER_MOODS.length

/** Every scalar is the neutral value times a per-(mood, key) factor in 0.4..1.0 (all 14 moods differ); every array is a distinct positive vector. */
function synthRow(i: number): LookRow {
  const base = createNeutralRow()
  const row = createNeutralRow()
  ROW_SCALAR_KEYS.forEach((key, k) => {
    row[key] = base[key] * (0.4 + (0.6 * ((i * 5 + k * 3) % 14)) / 13)
  })
  row.fxStrobe = 0.1 + 0.05 * i // neutral is 0, which would make every strobe assertion vacuous
  for (const key of ARRAY_KEYS) {
    row[key] = Array.from({ length: ROW_ARRAY_KEYS[key] }, (_, j) => 0.05 + ((i * 5 + j * 3) % 7) / 10)
  }
  return row
}

const ROWS = Object.fromEntries(CHARACTER_MOODS.map((m, i) => [m, synthRow(i)])) as Record<CharacterMood, LookRow>
const NEUTRAL = createNeutralRow()
const idx = (m: CharacterMood) => CHARACTER_MOODS.indexOf(m)
const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0)
const sweep = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n)

function makeCharacter(dist: Partial<Record<CharacterMood, number>>, o: { confidence?: number; entropy?: number; valid?: boolean } = {}): CharacterState {
  const cs = createEmptyCharacterState()
  const total = sum(CHARACTER_MOODS.map((m) => dist[m] ?? 0))
  let h = 0
  let best: CharacterMood | null = null
  for (const m of CHARACTER_MOODS) {
    const p = total > 0 ? (dist[m] ?? 0) / total : 0
    cs.dist[m] = p
    if (p > 0) h -= p * Math.log(p)
    if (p > 0 && (best === null || p > cs.dist[best])) best = m
  }
  cs.entropy = o.entropy ?? h / Math.log(N)
  cs.confidence = o.confidence ?? 1
  cs.valid = o.valid ?? true
  cs.primary = best
  return cs
}

function makeInput(over: Partial<LookInput> = {}): LookInput {
  return {
    character: makeCharacter({ serene: 1 }),
    legacyLook: 'peak', // gate 1: the intensity gate is out of the way unless a test is about it
    timbre: { harsh: 0.5, busy: 0.5, sparse: 0.5 },
    song: { structureValid: false, isBuild: false, buildProgress: 0, isDrop: false, isBreakdown: false, beatsTillDrop: -1 },
    legacyBuilding: false,
    drop: false,
    dt: 1 / 60,
    force: null,
    families: { grade: true, post: true, scene: true, camera: true },
    ...over,
  }
}

/** Runs `seconds` of frames at `dt`, like the bridge would. */
function step(tr: LookProfileTracker, out: LookProfile, input: LookInput, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt)
  input.dt = dt
  for (let i = 0; i < n; i++) tr.update(input, out)
}

function rig(over: Partial<LookInput> = {}) {
  const tr = new LookProfileTracker(ROWS)
  const out = createLookProfile()
  const input = makeInput(over)
  return { tr, out, input }
}

function allFinite(out: LookProfile): boolean {
  for (const k of ROW_SCALAR_KEYS) if (!Number.isFinite(out[k])) return false
  for (const k of ARRAY_KEYS) for (const v of out[k]) if (!Number.isFinite(v)) return false
  for (const v of out.weights) if (!Number.isFinite(v)) return false
  for (const v of [out.relax, out.harsh, out.busy, out.sparse, out.buildIntent, out.afterglow, out.breakdown, out.intensityGate]) {
    if (!Number.isFinite(v)) return false
  }
  return true
}

function expectRowMatches(out: LookProfile, row: LookRow, digits = 9): void {
  for (const k of ROW_SCALAR_KEYS) expect(out[k], k).toBeCloseTo(row[k], digits)
  for (const k of ARRAY_KEYS) row[k].forEach((v, j) => expect(out[k][j], `${k}[${j}]`).toBeCloseTo(v, digits))
}

/** `(1 - relax) * sum_i w_i row_i + relax * neutral` for one scalar key. */
function blended(key: (typeof ROW_SCALAR_KEYS)[number], weights: readonly number[], relax: number): number {
  let v = 0
  CHARACTER_MOODS.forEach((m, i) => (v += weights[i] * ROWS[m][key]))
  return (1 - relax) * v + relax * NEUTRAL[key]
}

function expectedWeights(dist: readonly number[], confidence: number): number[] {
  const p = 1 + 2 * confidence
  const raw = dist.map((d) => (d > 0 ? d ** p : 0))
  const s = sum(raw)
  return raw.map((x) => x / s)
}

// ---------------------------------------------------------------------------------------------------------

describe('fixtures', () => {
  it('the synthetic rows differ from each other in the fields the tests read', () => {
    for (const key of ['bloomBase', 'gradeSat', 'gradeTemp', 'fogBase', 'trailsBase', 'lensEngage', 'mirrorEngage'] as const) {
      const vals = new Set(CHARACTER_MOODS.map((m) => ROWS[m][key].toFixed(6)))
      expect(vals.size, key).toBeGreaterThan(6)
    }
    expect(ROWS.serene.bloomBase).not.toBe(ROWS.aggressive.bloomBase)
    expect(ROWS.serene.gradeSat).not.toBe(ROWS.aggressive.gradeSat)
  })
})

describe('weights and blending', () => {
  it('weights are non-negative and sum to 1, in every regime', () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    const dists: Partial<Record<CharacterMood, number>>[] = [{ tense: 1 }, { tense: 0.5, dreamy: 0.5 }, { serene: 0.2, epic: 0.7, groove: 0.1 }]
    for (let n = 0; n < 8; n++) dists.push(Object.fromEntries(CHARACTER_MOODS.map((m) => [m, rnd()])))
    for (const dist of dists) {
      for (const confidence of [0, 0.5, 1]) {
        const { tr, out, input } = rig({ character: makeCharacter(dist, { confidence }) })
        step(tr, out, input, 0.5)
        expect(sum(out.weights)).toBeCloseTo(1, 9)
        for (const w of out.weights) expect(w).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('weights still sum to 1 while easing between two reads', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
    step(tr, out, input, 1)
    input.character = makeCharacter({ aggressive: 0.7, tense: 0.3 })
    for (let f = 0; f < 600; f++) {
      step(tr, out, input, 1 / 60)
      expect(sum(out.weights)).toBeCloseTo(1, 9)
    }
  })

  it('the first valid frame seeds the profile directly instead of easing from neutral', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ euphoric: 1 }) })
    tr.update(input, out)
    expectRowMatches(out, ROWS.euphoric)
    expect(out.valid).toBe(true)
    expect(out.source).toBe('character')
    expect(out.primary).toBe('euphoric')
    expect(out.relax).toBe(0)
  })

  it('a one-hot dist at confidence 1 reproduces that mood row once smoothing has converged (all 14 moods)', () => {
    CHARACTER_MOODS.forEach((m, i) => {
      const from = CHARACTER_MOODS[(i + 5) % N]
      const { tr, out, input } = rig({ character: makeCharacter({ [from]: 1 }) })
      step(tr, out, input, 1)
      input.character = makeCharacter({ [m]: 1 })
      step(tr, out, input, 150, 0.1)
      expectRowMatches(out, ROWS[m])
      expect(out.primary).toBe(m)
      expect(out.weights[i]).toBeCloseTo(1, 9)
      expect(out.relax).toBeCloseTo(0, 9)
    })
  })

  it('weights are dist^p with p = 1 + 2 confidence, normalised', () => {
    const dist = { tense: 0.6, driving: 0.3, groove: 0.1 }
    const arr = CHARACTER_MOODS.map((m) => (dist as Partial<Record<CharacterMood, number>>)[m] ?? 0)
    for (const confidence of [0, 0.5, 1]) {
      const { tr, out, input } = rig({ character: makeCharacter(dist, { confidence }) })
      tr.update(input, out)
      const want = expectedWeights(arr, confidence)
      want.forEach((w, i) => expect(out.weights[i]).toBeCloseTo(w, 9))
    }
    // sharper with confidence: the leader's weight rises
    const lo = rig({ character: makeCharacter(dist, { confidence: 0 }) })
    const hi = rig({ character: makeCharacter(dist, { confidence: 1 }) })
    lo.tr.update(lo.input, lo.out)
    hi.tr.update(hi.input, hi.out)
    expect(hi.out.weights[idx('tense')]).toBeGreaterThan(lo.out.weights[idx('tense')])
  })

  it('scalars are the weighted blend of the rows', () => {
    const dist = { tense: 0.6, driving: 0.3, groove: 0.1 }
    const { tr, out, input } = rig({ character: makeCharacter(dist, { confidence: 0.5 }) })
    tr.update(input, out)
    for (const key of ROW_SCALAR_KEYS) {
      if (key === 'lensEngage' || key === 'mirrorEngage') continue // gate / descriptors are exercised elsewhere; both are identity here anyway
      expect(out[key], key).toBeCloseTo(blended(key, out.weights, out.relax), 9)
    }
  })

  it('discrete weight vectors are elementwise blends of the row vectors', () => {
    const dist = { tense: 0.7, dreamy: 0.3 }
    const { tr, out, input } = rig({ character: makeCharacter(dist, { confidence: 0 }) })
    tr.update(input, out)
    for (const key of ARRAY_KEYS) {
      for (let j = 0; j < ROW_ARRAY_KEYS[key]; j++) {
        const want = 0.7 * ROWS.tense[key][j] + 0.3 * ROWS.dreamy[key][j]
        expect(out[key][j], `${key}[${j}]`).toBeCloseTo(want, 9)
      }
    }
    // and each stays between its two source rows
    for (let j = 0; j < 8; j++) {
      const lo = Math.min(ROWS.tense.lensWeights[j], ROWS.dreamy.lensWeights[j])
      const hi = Math.max(ROWS.tense.lensWeights[j], ROWS.dreamy.lensWeights[j])
      expect(out.lensWeights[j]).toBeGreaterThanOrEqual(lo - 1e-12)
      expect(out.lensWeights[j]).toBeLessThanOrEqual(hi + 1e-12)
    }
  })

  it('high entropy relaxes the blend toward the NEUTRAL row (max 0.6)', () => {
    const uniform = Object.fromEntries(CHARACTER_MOODS.map((m) => [m, 1])) as Record<CharacterMood, number>
    const { tr, out, input } = rig({ character: makeCharacter(uniform, { confidence: 0 }) })
    tr.update(input, out)
    expect(out.relax).toBeCloseTo(BLEND.relaxMax, 9)
    const even = CHARACTER_MOODS.map(() => 1 / N)
    for (const key of ['bloomBase', 'trailsBase', 'gradeSat', 'gradeTemp', 'steerSpeed', 'fogBase'] as const) {
      expect(out[key], key).toBeCloseTo(blended(key, even, BLEND.relaxMax), 9)
    }
    for (const key of ARRAY_KEYS) {
      for (let j = 0; j < ROW_ARRAY_KEYS[key]; j++) {
        const mean = sum(CHARACTER_MOODS.map((m) => ROWS[m][key][j])) / N
        expect(out[key][j], `${key}[${j}]`).toBeCloseTo(0.4 * mean + 0.6 * NEUTRAL[key][j], 9)
      }
    }
  })

  it('relax follows (entropy - 0.8) / 0.2, is 0 for a confident read, and is monotone', () => {
    const relaxAt = (entropy: number, confidence = 1) => {
      const { tr, out, input } = rig({ character: makeCharacter({ tense: 0.6, dreamy: 0.4 }, { entropy, confidence }) })
      tr.update(input, out)
      return out.relax
    }
    expect(relaxAt(0)).toBe(0)
    expect(relaxAt(0.5)).toBe(0)
    expect(relaxAt(0.8)).toBe(0)
    expect(relaxAt(0.9)).toBeCloseTo(0.3, 9)
    expect(relaxAt(1)).toBeCloseTo(0.6, 9)
    expect(relaxAt(2)).toBeCloseTo(0.6, 9) // out-of-range entropy is clamped
    expect(relaxAt(0.9, 0)).toBeCloseTo(0.3, 9) // relax is about entropy, not confidence
    let prev = -1
    for (const e of sweep(20)) {
      const r = relaxAt(e)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })

  it('a valid read with no usable distribution is the pure neutral row', () => {
    const cs = makeCharacter({})
    cs.valid = true
    const { tr, out, input } = rig({ character: cs })
    tr.update(input, out)
    expect(out.valid).toBe(true)
    expect(out.relax).toBe(1)
    expect(sum(out.weights)).toBeCloseTo(1, 9)
    for (const key of ['bloomBase', 'trailsBase', 'gradeSat', 'gradeTemp', 'fogBase', 'steerSpeed'] as const) {
      expect(out[key]).toBeCloseTo(NEUTRAL[key], 9)
    }
  })

  it('primary is the heaviest mood and does not flicker on a near tie', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ tense: 0.51, dreamy: 0.49 }, { confidence: 0 }) })
    step(tr, out, input, 1)
    expect(out.primary).toBe('tense')
    for (let f = 0; f < 240; f++) {
      input.character = makeCharacter(f % 2 === 0 ? { tense: 0.49, dreamy: 0.51 } : { tense: 0.51, dreamy: 0.49 }, { confidence: 0 })
      step(tr, out, input, 1 / 60)
      expect(out.primary).toBe('tense')
    }
    input.character = makeCharacter({ dreamy: 1 })
    step(tr, out, input, 10)
    expect(out.primary).toBe('dreamy')
  })
})

describe('forced mood (?lookforce)', () => {
  it('works with an INVALID character: valid, source forced, the pinned row', () => {
    const { tr, out, input } = rig({ character: createEmptyCharacterState(), force: 'aggressive' })
    step(tr, out, input, 1)
    expect(out.valid).toBe(true)
    expect(out.source).toBe('forced')
    expect(out.primary).toBe('aggressive')
    expect(out.relax).toBe(0)
    expect(out.weights[idx('aggressive')]).toBeCloseTo(1, 12)
    expect(sum(out.weights)).toBeCloseTo(1, 12)
    expectRowMatches(out, ROWS.aggressive)
  })

  it('overrides a valid character read of another mood, and its entropy', () => {
    const uniform = Object.fromEntries(CHARACTER_MOODS.map((m) => [m, 1])) as Record<CharacterMood, number>
    const { tr, out, input } = rig({ character: makeCharacter(uniform), force: 'serene' })
    step(tr, out, input, 1)
    expect(out.source).toBe('forced')
    expect(out.relax).toBe(0)
    expectRowMatches(out, ROWS.serene)
  })

  it('eases when the pinned mood changes', () => {
    const { tr, out, input } = rig({ character: createEmptyCharacterState(), force: 'serene' })
    step(tr, out, input, 1)
    input.force = 'aggressive'
    step(tr, out, input, 1 / 60)
    const gap = ROWS.aggressive.bloomBase - ROWS.serene.bloomBase
    expect(Math.abs(out.bloomBase - ROWS.serene.bloomBase)).toBeLessThan(Math.abs(gap) * 0.05)
    step(tr, out, input, 60, 0.1)
    expect(out.bloomBase).toBeCloseTo(ROWS.aggressive.bloomBase, 9)
  })

  it('is overridden by all families being off, and an unknown mood counts as no force', () => {
    const off = rig({ character: createEmptyCharacterState(), force: 'aggressive', families: { grade: false, post: false, scene: false, camera: false } })
    off.tr.update(off.input, off.out)
    expect(off.out.valid).toBe(false)
    const bogus = rig({ character: createEmptyCharacterState(), force: 'happy' as CharacterMood })
    bogus.tr.update(bogus.input, bogus.out)
    expect(bogus.out.valid).toBe(false)
    expect(bogus.out.source).toBe('legacy')
  })
})

describe('validity and the legacy fall-back', () => {
  function expectLegacy(out: LookProfile): void {
    expect(out.valid).toBe(false)
    expect(out.source).toBe('legacy')
    expect(out.gradeSat).toBe(1)
    expect(out.gradeTemp).toBe(0)
    expect(out.gradeContrast).toBe(1)
    expect(out.bloomBase).toBe(NEUTRAL.bloomBase)
    expect(out.trailsBase).toBe(NEUTRAL.trailsBase)
    expect(out.lensWeights).toEqual(NEUTRAL.lensWeights)
    expect(out.primary).toBeNull()
    expect(out.weights.every((w) => w === 0)).toBe(true)
    expect(out.relax).toBe(1)
    expect(allFinite(out)).toBe(true)
  }

  it('an invalid character and no force: not valid, neutral fields, identity grade', () => {
    const { tr, out, input } = rig({ character: createEmptyCharacterState() })
    step(tr, out, input, 1)
    expectLegacy(out)
    expect(out.families).toEqual({ grade: true, post: true, scene: true, camera: true })
  })

  it('all families off: not valid even with a confident valid character, and the flags are copied', () => {
    const off = { grade: false, post: false, scene: false, camera: false }
    const { tr, out, input } = rig({ character: makeCharacter({ tense: 1 }), families: off })
    step(tr, out, input, 1)
    expectLegacy(out)
    expect(out.families).toEqual(off)
  })

  it('some families off leaves the profile valid and publishes the flags', () => {
    const fam = { grade: false, post: true, scene: true, camera: false }
    const { tr, out, input } = rig({ character: makeCharacter({ tense: 1 }), families: fam })
    step(tr, out, input, 1)
    expect(out.valid).toBe(true)
    expect(out.families).toEqual(fam)
  })

  it('the legacy path resets stale values from an earlier valid stretch', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ euphoric: 1 }) })
    step(tr, out, input, 1)
    expect(out.gradeSat).toBeCloseTo(ROWS.euphoric.gradeSat, 9)
    input.character = createEmptyCharacterState()
    step(tr, out, input, 1)
    expectLegacy(out)
  })

  it('valid -> invalid -> valid resumes smoothly from the held state (no re-seed pop)', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
    step(tr, out, input, 1)
    input.character = createEmptyCharacterState()
    step(tr, out, input, 2)
    input.character = makeCharacter({ aggressive: 1 })
    step(tr, out, input, 1 / 60)
    expect(out.valid).toBe(true)
    const gap = ROWS.aggressive.bloomBase - ROWS.serene.bloomBase
    expect(Math.abs(out.bloomBase - ROWS.serene.bloomBase)).toBeLessThan(Math.abs(gap) * 0.05)
  })

  it('mutates the profile in place: nothing on it is replaced', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ tense: 1 }) })
    const refs = { weights: out.weights, lens: out.lensWeights, seg: out.mirrorSegments, cam: out.cameraWeights, tr: out.transitionWeights, mode: out.mirrorMode, fam: out.families }
    expect(tr.update(input, out)).toBeUndefined()
    input.character = createEmptyCharacterState()
    tr.update(input, out)
    input.character = makeCharacter({ euphoric: 1 })
    input.force = 'epic'
    tr.update(input, out)
    expect(out.weights).toBe(refs.weights)
    expect(out.lensWeights).toBe(refs.lens)
    expect(out.mirrorSegments).toBe(refs.seg)
    expect(out.cameraWeights).toBe(refs.cam)
    expect(out.transitionWeights).toBe(refs.tr)
    expect(out.mirrorMode).toBe(refs.mode)
    expect(out.families).toBe(refs.fam)
  })
})

describe('dt and input safety', () => {
  const BAD_DTS = [NaN, 0, -1, -Infinity, Infinity, 1e9, Number.MAX_VALUE, 1e-12]

  it('no dt poisons the state, and the output stays finite with sane weights', () => {
    for (const dt of BAD_DTS) {
      const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
      step(tr, out, input, 1)
      for (let f = 0; f < 60; f++) {
        input.character = makeCharacter(f % 2 === 0 ? { aggressive: 1 } : { dreamy: 0.5, epic: 0.5 })
        input.legacyBuilding = f % 3 === 0
        input.drop = f % 7 === 0
        input.song.structureValid = true
        input.song.isBreakdown = f % 5 === 0
        input.dt = dt
        tr.update(input, out)
        expect(allFinite(out), `dt=${dt} frame ${f}`).toBe(true)
        expect(sum(out.weights)).toBeCloseTo(1, 6)
      }
      // and it recovers: a normal dt afterwards still converges to the pinned row
      input.character = makeCharacter({ tense: 1 })
      input.legacyBuilding = false
      input.drop = false
      input.song.isBreakdown = false
      step(tr, out, input, 200, 0.1)
      expect(allFinite(out)).toBe(true)
      expectRowMatches(out, ROWS.tense)
    }
  })

  it('a NaN / zero / negative dt holds the state exactly (only a real step moves it)', () => {
    for (const dt of [NaN, 0, -1, -Infinity, Infinity]) {
      const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
      step(tr, out, input, 1)
      input.character = makeCharacter({ aggressive: 1 })
      const before = structuredClone(out)
      input.dt = dt
      tr.update(input, out)
      expect(out, `dt=${dt}`).toEqual(before)
    }
  })

  it('a huge dt snaps to the target without overshoot', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
    step(tr, out, input, 1)
    input.character = makeCharacter({ aggressive: 1 })
    input.dt = 1e9
    tr.update(input, out)
    expectRowMatches(out, ROWS.aggressive)
  })

  it('the very first frame seeds even with a NaN or zero dt', () => {
    for (const dt of [NaN, 0, -3]) {
      const { tr, out, input } = rig({ character: makeCharacter({ euphoric: 1 }), dt })
      tr.update(input, out)
      expect(out.valid).toBe(true)
      expectRowMatches(out, ROWS.euphoric)
    }
  })

  it('NaN in the timbre, confidence, entropy, dist and build progress cannot produce non-finite output', () => {
    const cs = makeCharacter({ tense: 0.5, dreamy: 0.5 })
    cs.confidence = NaN
    cs.entropy = NaN
    cs.dist.epic = NaN
    const { tr, out, input } = rig({ character: cs, timbre: { harsh: NaN, busy: NaN, sparse: NaN } })
    input.song.structureValid = true
    input.song.isBuild = true
    input.song.buildProgress = NaN
    step(tr, out, input, 2)
    expect(allFinite(out)).toBe(true)
    expect([out.harsh, out.busy, out.sparse]).toEqual([0.5, 0.5, 0.5])
    expect(out.buildIntent).toBe(0)
  })

  it('an infinite dist entry falls back to the neutral row instead of NaN weights', () => {
    const cs = makeCharacter({ tense: 1 })
    cs.dist.tense = Infinity
    const { tr, out, input } = rig({ character: cs })
    step(tr, out, input, 1)
    expect(allFinite(out)).toBe(true)
    expect(out.relax).toBe(1)
  })
})

describe('time constants', () => {
  const frac = (v: number, from: number, to: number) => (v - from) / (to - from)

  it('everything but the grade eases with tau 3 s; the grade with tau 6 s', () => {
    expect(LOOK_TAU.main).toBe(3)
    expect(LOOK_TAU.grade).toBe(6)
    const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
    step(tr, out, input, 1)
    input.character = makeCharacter({ aggressive: 1 })
    const a = ROWS.serene
    const b = ROWS.aggressive
    for (const k of ['bloomBase', 'trailsBase', 'steerSpeed', 'fogBase'] as const) expect(Math.abs(b[k] - a[k])).toBeGreaterThan(0.01)
    for (const k of ['gradeSat', 'gradeTemp', 'gradeContrast'] as const) expect(Math.abs(b[k] - a[k])).toBeGreaterThan(0.01)

    step(tr, out, input, 3)
    for (const k of ['bloomBase', 'trailsBase', 'steerSpeed', 'fogBase'] as const) expect(frac(out[k], a[k], b[k]), k).toBeCloseTo(1 - Math.exp(-1), 6)
    for (const k of ['gradeSat', 'gradeTemp', 'gradeContrast'] as const) expect(frac(out[k], a[k], b[k]), k).toBeCloseTo(1 - Math.exp(-0.5), 6)

    step(tr, out, input, 3) // 6 s in total
    for (const k of ['bloomBase', 'trailsBase'] as const) expect(frac(out[k], a[k], b[k]), k).toBeCloseTo(1 - Math.exp(-2), 6)
    for (const k of ['gradeSat', 'gradeTemp'] as const) expect(frac(out[k], a[k], b[k]), k).toBeCloseTo(1 - Math.exp(-1), 6)
  })

  it('the discrete weight vectors and the mood weights ease with the main constant too', () => {
    const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
    step(tr, out, input, 1)
    input.character = makeCharacter({ aggressive: 1 })
    step(tr, out, input, 3)
    for (const key of ARRAY_KEYS) {
      ROWS.serene[key].forEach((from, j) => {
        const to = ROWS.aggressive[key][j]
        if (Math.abs(to - from) > 0.01) expect(frac(out[key][j], from, to), `${key}[${j}]`).toBeCloseTo(1 - Math.exp(-1), 6)
      })
    }
    expect(out.weights[idx('aggressive')]).toBeCloseTo(1 - Math.exp(-1), 6)
  })

  it('the step size does not depend on how the time is chopped into frames', () => {
    const run = (dt: number) => {
      const { tr, out, input } = rig({ character: makeCharacter({ serene: 1 }) })
      step(tr, out, input, 1)
      input.character = makeCharacter({ aggressive: 1 })
      step(tr, out, input, 4, dt)
      return out.bloomBase
    }
    expect(run(1 / 144)).toBeCloseTo(run(1 / 30), 6)
    expect(run(1 / 60)).toBeCloseTo(run(0.5), 6)
  })
})

describe('timbre descriptors through the tracker', () => {
  const oneMood = (over: Partial<LookInput>) => rig({ character: makeCharacter({ tense: 1 }), ...over })
  const row = ROWS.tense

  it('the neutral descriptors leave the mood row untouched', () => {
    const { tr, out, input } = oneMood({})
    tr.update(input, out)
    expectRowMatches(out, row)
  })

  it('harsh scales lensEngage by (0.6 + 0.8 harsh) and moves lens weight from the soft styles to pixel sort / glitch', () => {
    let prevHard = -Infinity
    for (const h of sweep(10)) {
      const { tr, out, input } = oneMood({ timbre: { harsh: h, busy: 0.5, sparse: 0.5 } })
      tr.update(input, out)
      expect(out.lensEngage / row.lensEngage).toBeCloseTo(0.6 + 0.8 * h, 9)
      const hard = HARD_LENS_STYLES.reduce((s, i) => s + out.lensWeights[i], 0)
      expect(hard).toBeGreaterThanOrEqual(prevHard - 1e-12)
      prevHard = hard
      expect(sum(out.lensWeights)).toBeCloseTo(sum(row.lensWeights), 9)
    }
    const hi = oneMood({ timbre: { harsh: 1, busy: 0.5, sparse: 0.5 } })
    hi.tr.update(hi.input, hi.out)
    const softBase = SOFT_LENS_STYLES.reduce((s, i) => s + row.lensWeights[i], 0)
    expect(SOFT_LENS_STYLES.reduce((s, i) => s + hi.out.lensWeights[i], 0)).toBeCloseTo(softBase * 0.6, 9)
  })

  it('harsh raises caBase slightly and lowers trailsBase, monotonically', () => {
    let prevCa = -Infinity
    let prevTrails = Infinity
    for (const h of sweep(10)) {
      const { tr, out, input } = oneMood({ timbre: { harsh: h, busy: 0.5, sparse: 0.5 } })
      tr.update(input, out)
      expect(out.caBase).toBeGreaterThanOrEqual(prevCa)
      expect(out.trailsBase).toBeLessThanOrEqual(prevTrails)
      prevCa = out.caBase
      prevTrails = out.trailsBase
    }
  })

  it('busy scales mirrorEngage (by the row gain) and raises steer complexity and density', () => {
    let prev: LookProfile | null = null
    for (const b of sweep(10)) {
      const { tr, out, input } = oneMood({ timbre: { harsh: 0.5, busy: b, sparse: 0.5 } })
      tr.update(input, out)
      expect(out.mirrorEngage / row.mirrorEngage).toBeCloseTo(1 + 0.4 * row.mirrorBusyGain * (2 * b - 1), 9)
      if (prev !== null) {
        expect(out.mirrorEngage).toBeGreaterThanOrEqual(prev.mirrorEngage)
        expect(out.steerComplexity).toBeGreaterThanOrEqual(prev.steerComplexity)
        expect(out.steerDensity).toBeGreaterThanOrEqual(prev.steerDensity)
      }
      prev = structuredClone(out)
    }
  })

  it('sparse raises fog and trails, lowers the echo gate and steer speed, monotonically', () => {
    let prev: LookProfile | null = null
    for (const s of sweep(10)) {
      const { tr, out, input } = oneMood({ timbre: { harsh: 0.5, busy: 0.5, sparse: s } })
      tr.update(input, out)
      if (prev !== null) {
        expect(out.fogBase).toBeGreaterThanOrEqual(prev.fogBase)
        expect(out.trailsBase).toBeGreaterThanOrEqual(prev.trailsBase)
        expect(out.echoGate).toBeLessThanOrEqual(prev.echoGate)
        expect(out.steerSpeed).toBeLessThanOrEqual(prev.steerSpeed)
      }
      prev = structuredClone(out)
    }
  })

  it('stays within +-40% of the unmodulated row for every descriptor combination', () => {
    const fields = ['lensEngage', 'caBase', 'trailsBase', 'mirrorEngage', 'steerComplexity', 'steerDensity', 'fogBase', 'echoGate', 'steerSpeed'] as const
    for (const h of [0, 0.5, 1])
      for (const b of [0, 0.5, 1])
        for (const s of [0, 0.5, 1]) {
          const { tr, out, input } = oneMood({ timbre: { harsh: h, busy: b, sparse: s } })
          tr.update(input, out)
          for (const f of fields) {
            const ratio = out[f] / row[f]
            expect(ratio, `${f} h${h} b${b} s${s}`).toBeGreaterThanOrEqual(0.6 - 1e-9)
            expect(ratio, `${f} h${h} b${b} s${s}`).toBeLessThanOrEqual(1.4 + 1e-9)
          }
          expect(out.harsh).toBe(h)
          expect(out.busy).toBe(b)
          expect(out.sparse).toBe(s)
        }
  })

  it('never changes which family a mood uses: a zero dial stays zero', () => {
    const rows = { ...ROWS, tense: { ...ROWS.tense, lensEngage: 0, mirrorEngage: 0, fogBase: 0, echoGate: 0 } } as Record<CharacterMood, LookRow>
    for (const h of [0, 1])
      for (const b of [0, 1])
        for (const s of [0, 1]) {
          const tr = new LookProfileTracker(rows)
          const out = createLookProfile()
          const input = makeInput({ character: makeCharacter({ tense: 1 }), timbre: { harsh: h, busy: b, sparse: s } })
          tr.update(input, out)
          expect(out.lensEngage).toBe(0)
          expect(out.mirrorEngage).toBe(0)
          expect(out.fogBase).toBe(0)
          expect(out.echoGate).toBe(0)
        }
  })

  it('descriptor changes are smoothed (no step), settling with the main constant', () => {
    const { tr, out, input } = oneMood({})
    step(tr, out, input, 1)
    input.timbre.harsh = 1
    step(tr, out, input, 1 / 60)
    expect(out.lensEngage / row.lensEngage).toBeLessThan(1.02)
    step(tr, out, input, 120, 0.1)
    expect(out.lensEngage / row.lensEngage).toBeCloseTo(1.4, 6)
  })
})

describe('fast-layer modifiers through the tracker', () => {
  const tenseRow = ROWS.tense

  function settled(over: Partial<LookInput> = {}) {
    const r = rig({ character: makeCharacter({ tense: 1 }), ...over })
    step(r.tr, r.out, r.input, 1)
    return { ...r, base: structuredClone(r.out) }
  }

  describe('build', () => {
    it('a structural build follows buildProgress and raises bloom, trails, steer and saturation monotonically', () => {
      const { tr, out, input, base } = settled()
      input.song.structureValid = true
      input.song.isBuild = true
      let prev = structuredClone(out)
      for (const p of sweep(20)) {
        input.song.buildProgress = p
        step(tr, out, input, 1 / 60)
        expect(out.buildIntent).toBeCloseTo(p, 9)
        expect(out.bloomBase).toBeGreaterThanOrEqual(prev.bloomBase - 1e-12)
        expect(out.trailsBase).toBeGreaterThanOrEqual(prev.trailsBase - 1e-12)
        expect(out.trailsZoom).toBeGreaterThanOrEqual(prev.trailsZoom - 1e-12)
        expect(out.steerSpeed).toBeGreaterThanOrEqual(prev.steerSpeed - 1e-12)
        expect(out.steerComplexity).toBeGreaterThanOrEqual(prev.steerComplexity - 1e-12)
        expect(out.gradeSat).toBeGreaterThanOrEqual(prev.gradeSat - 1e-12)
        prev = structuredClone(out)
      }
      expect(out.buildIntent).toBe(1)
      expect(out.bloomBase).toBeCloseTo(base.bloomBase + 0.15, 9)
      expect(out.trailsBase).toBeCloseTo(base.trailsBase + 0.1, 9)
      expect(out.steerSpeed).toBeCloseTo(base.steerSpeed + 0.15, 9)
      expect(out.gradeSat).toBeCloseTo(base.gradeSat + 0.05, 9)
      expect(out.mirrorSegments[2]).toBeGreaterThan(base.mirrorSegments[2])
    })

    it('a structural build is ignored unless the structure read is valid', () => {
      const { tr, out, input } = settled()
      input.song.isBuild = true
      input.song.buildProgress = 1
      step(tr, out, input, 2)
      expect(out.buildIntent).toBe(0)
    })

    it('the everyday (legacy) build ramps in about 2 s, is capped at 0.5, and releases in about 1.5 s', () => {
      const { tr, out, input, base } = settled()
      input.legacyBuilding = true
      step(tr, out, input, 1)
      expect(out.buildIntent).toBeCloseTo(0.25, 9)
      step(tr, out, input, 1)
      expect(out.buildIntent).toBeCloseTo(0.5, 9)
      step(tr, out, input, 10)
      expect(out.buildIntent).toBeCloseTo(0.5, 9) // never more than the cap
      expect(out.bloomBase).toBeCloseTo(base.bloomBase + 0.15 * 0.5, 9)
      input.legacyBuilding = false
      step(tr, out, input, 0.75)
      expect(out.buildIntent).toBeCloseTo(0.25, 9)
      step(tr, out, input, 1)
      expect(out.buildIntent).toBe(0)
      expect(out.bloomBase).toBeCloseTo(base.bloomBase, 9)
    })

    it('only a confirmed structural build reaches 1: the higher of the two signals wins', () => {
      const { tr, out, input } = settled()
      input.legacyBuilding = true
      input.song.structureValid = true
      input.song.isBuild = true
      input.song.buildProgress = 0.3
      step(tr, out, input, 5)
      expect(out.buildIntent).toBeCloseTo(0.5, 9) // legacy 0.5 beats structural 0.3
      input.song.buildProgress = 0.8
      step(tr, out, input, 1 / 60)
      expect(out.buildIntent).toBeCloseTo(0.8, 9)
      input.song.buildProgress = 1
      step(tr, out, input, 1 / 60)
      expect(out.buildIntent).toBe(1)
    })

    it('the structural build releases over 1.5 s when the build ends (no pop at the drop)', () => {
      const { tr, out, input } = settled()
      input.song.structureValid = true
      input.song.isBuild = true
      input.song.buildProgress = 1
      step(tr, out, input, 1 / 60)
      input.song.isBuild = false
      step(tr, out, input, 0.75)
      expect(out.buildIntent).toBeCloseTo(0.5, 9)
      step(tr, out, input, 1)
      expect(out.buildIntent).toBe(0)
    })

    it('adds no strobe (or any other effect propensity) at any point of a build', () => {
      const { tr, out, input, base } = settled()
      input.song.structureValid = true
      input.song.isBuild = true
      input.legacyBuilding = true
      expect(base.fxStrobe).toBeGreaterThan(0)
      for (const p of sweep(20)) {
        input.song.buildProgress = p
        step(tr, out, input, 0.25)
        expect(out.fxStrobe).toBeCloseTo(base.fxStrobe, 12)
        expect(out.fxShock).toBeCloseTo(base.fxShock, 12)
        expect(out.fxFlare).toBeCloseTo(base.fxFlare, 12)
        expect(out.fxSpark).toBeCloseTo(base.fxSpark, 12)
      }
    })

    it('weights only hard lens styles up, and pushes the camera toward push', () => {
      const { tr, out, input, base } = settled()
      input.song.structureValid = true
      input.song.isBuild = true
      input.song.buildProgress = 1
      step(tr, out, input, 1 / 60)
      for (const i of HARD_LENS_STYLES) expect(out.lensWeights[i]).toBeCloseTo(base.lensWeights[i] * 2, 9)
      for (const i of [LENS.ribs, LENS.fan, LENS.anamorphic, LENS.melt, LENS.pixels]) expect(out.lensWeights[i]).toBeCloseTo(base.lensWeights[i], 9)
      expect(out.cameraWeights[2]).toBeGreaterThan(base.cameraWeights[2])
    })

    it('modifiers do not compound: a steady build gives a steady output', () => {
      const { tr, out, input, base } = settled()
      input.legacyBuilding = true
      step(tr, out, input, 30)
      const a = structuredClone(out)
      step(tr, out, input, 1 / 60)
      const b = structuredClone(out)
      for (const k of ROW_SCALAR_KEYS) expect(b[k], k).toBeCloseTo(a[k], 12)
      expect(out.bloomBase).toBeCloseTo(base.bloomBase + 0.075, 9)
      step(tr, out, input, 60)
      expect(out.bloomBase).toBeCloseTo(base.bloomBase + 0.075, 9)
    })
  })

  describe('drop afterglow', () => {
    it('arms to 1 on the rising edge of the drop, then decays linearly over about 4 s', () => {
      const { tr, out, input, base } = settled()
      input.drop = true
      step(tr, out, input, 1 / 60)
      expect(out.afterglow).toBe(1)
      expect(out.gradeSat).toBeCloseTo(base.gradeSat + 0.1, 9)
      expect(out.gradeContrast).toBeCloseTo(base.gradeContrast + 0.05, 9)
      expect(out.mirrorSegments[2]).toBeCloseTo(sum(base.mirrorSegments), 9) // all on 8 segments
      step(tr, out, input, 2) // the drop window stays latched: no re-arm
      expect(out.afterglow).toBeCloseTo(0.5, 9)
      expect(out.gradeSat).toBeCloseTo(base.gradeSat + 0.05, 9)
      step(tr, out, input, 2)
      expect(out.afterglow).toBeCloseTo(0, 9)
      expect(out.gradeSat).toBeCloseTo(base.gradeSat, 9)
      expect(out.gradeContrast).toBeCloseTo(base.gradeContrast, 9)
    })

    it('decays monotonically and re-arms on the next rising edge only', () => {
      const { tr, out, input } = settled()
      input.drop = true
      step(tr, out, input, 1 / 60)
      let prev = out.afterglow
      for (let f = 0; f < 200; f++) {
        step(tr, out, input, 1 / 60)
        expect(out.afterglow).toBeLessThanOrEqual(prev)
        prev = out.afterglow
      }
      input.drop = false
      step(tr, out, input, 1)
      expect(out.afterglow).toBe(0)
      input.drop = true
      step(tr, out, input, 1 / 60)
      expect(out.afterglow).toBe(1)
    })

    it('touches neither the strobe nor bloom', () => {
      const { tr, out, input, base } = settled()
      input.drop = true
      step(tr, out, input, 1 / 60)
      expect(out.fxStrobe).toBeCloseTo(base.fxStrobe, 12)
      expect(out.bloomBase).toBeCloseTo(base.bloomBase, 12)
    })
  })

  describe('breakdown', () => {
    it('eases in over about 2 s (smoothstep) and out over about 1 s', () => {
      const { tr, out, input } = settled()
      input.song.structureValid = true
      input.song.isBreakdown = true
      step(tr, out, input, 0.5)
      const quarter = out.breakdown
      expect(quarter).toBeCloseTo(0.15625, 9) // smoothstep(0.25)
      step(tr, out, input, 0.5)
      expect(out.breakdown).toBeCloseTo(0.5, 9)
      step(tr, out, input, 1)
      expect(out.breakdown).toBe(1)
      input.song.isBreakdown = false
      step(tr, out, input, 0.5)
      expect(out.breakdown).toBeCloseTo(0.5, 9)
      step(tr, out, input, 1)
      expect(out.breakdown).toBe(0)
    })

    it('needs a valid structure read', () => {
      const { tr, out, input } = settled()
      input.song.isBreakdown = true
      step(tr, out, input, 5)
      expect(out.breakdown).toBe(0)
    })

    it('at full strength: bloom x.7, trails +.15, echo 0, soft lens styles only, steer -.2, fog +.15, camera hover', () => {
      const { tr, out, input, base } = settled()
      input.song.structureValid = true
      input.song.isBreakdown = true
      step(tr, out, input, 3)
      expect(out.breakdown).toBe(1)
      expect(out.bloomBase).toBeCloseTo(base.bloomBase * 0.7, 9)
      expect(out.trailsBase).toBeCloseTo(base.trailsBase + 0.15, 9)
      expect(out.echoGate).toBe(0)
      expect(out.steerSpeed).toBeCloseTo(base.steerSpeed - 0.2, 9)
      expect(out.steerDensity).toBeCloseTo(base.steerDensity - 0.2, 9)
      expect(out.fogBase).toBeCloseTo(base.fogBase + 0.15, 9)
      for (let i = 0; i < out.lensWeights.length; i++) {
        if (!SOFT_LENS_STYLES.includes(i)) expect(out.lensWeights[i], `style ${i}`).toBeCloseTo(0, 9)
      }
      expect(sum(out.lensWeights)).toBeCloseTo(sum(base.lensWeights), 9)
      expect(out.cameraWeights.indexOf(Math.max(...out.cameraWeights))).toBe(1) // hover
      expect(out.fxStrobe).toBeCloseTo(base.fxStrobe, 12)
    })

    it('switches the mirror off unless the mood is dreamy / serene / mysterious, which keep it and slow the spin', () => {
      const tense = settled()
      tense.input.song.structureValid = true
      tense.input.song.isBreakdown = true
      step(tense.tr, tense.out, tense.input, 3)
      expect(tense.out.mirrorEngage).toBe(0)

      for (const m of ['dreamy', 'serene', 'mysterious'] as const) {
        const { tr, out, input } = rig({ character: makeCharacter({ [m]: 1 }) })
        step(tr, out, input, 1)
        const engage = out.mirrorEngage
        expect(engage).toBeGreaterThan(0)
        input.song.structureValid = true
        input.song.isBreakdown = true
        step(tr, out, input, 3)
        expect(out.mirrorEngage, m).toBeCloseTo(engage, 9)
        expect(out.mirrorSpinMax, m).toBeLessThanOrEqual(0.12 + 1e-9)
        expect(out.mirrorSpinMin, m).toBeLessThanOrEqual(out.mirrorSpinMax)
      }
    })

    it('cancels a build in progress (a breakdown is not a build)', () => {
      const { tr, out, input } = settled()
      input.legacyBuilding = true
      step(tr, out, input, 3)
      expect(out.buildIntent).toBeCloseTo(0.5, 9)
      input.song.structureValid = true
      input.song.isBreakdown = true
      step(tr, out, input, 3)
      expect(out.buildIntent).toBe(0)
    })
  })

  describe('intensity gate', () => {
    it('is the specified multiplier per legacy look state, applied to the hard-effect propensities only', () => {
      for (const state of MOOD_STATES) {
        const { tr, out, input } = rig({ character: makeCharacter({ tense: 1 }), legacyLook: state })
        tr.update(input, out) // the gate seeds directly on the first frame
        const g = INTENSITY_GATE[state]
        expect(out.intensityGate).toBe(g)
        expect(out.lensEngage, state).toBeCloseTo(tenseRow.lensEngage * g, 9)
        expect(out.mirrorEngage, state).toBeCloseTo(tenseRow.mirrorEngage * g, 9)
        expect(out.fxShock, state).toBeCloseTo(tenseRow.fxShock * g, 9)
        expect(out.fxFlare, state).toBeCloseTo(tenseRow.fxFlare * g, 9)
        expect(out.fxSpark, state).toBeCloseTo(tenseRow.fxSpark * g, 9)
        expect(out.fxStrobe, state).toBeCloseTo(tenseRow.fxStrobe * g, 9)
        expect(out.caReact, state).toBeCloseTo(tenseRow.caReact * g, 9)
        expect(out.bloomBase, state).toBeCloseTo(tenseRow.bloomBase, 9) // not a hard-effect field
        expect(out.trailsBase, state).toBeCloseTo(tenseRow.trailsBase, 9)
      }
    })

    it('silence kills the hard effects and peak / aggressive leave them alone', () => {
      const silent = rig({ character: makeCharacter({ tense: 1 }), legacyLook: 'silence' })
      silent.tr.update(silent.input, silent.out)
      for (const k of ['lensEngage', 'mirrorEngage', 'fxShock', 'fxFlare', 'fxSpark', 'fxStrobe', 'caReact'] as const) expect(silent.out[k]).toBe(0)
      const peak = rig({ character: makeCharacter({ tense: 1 }), legacyLook: 'peak' })
      peak.tr.update(peak.input, peak.out)
      expect(peak.out.fxStrobe).toBeCloseTo(tenseRow.fxStrobe, 12)
    })

    it('eases (about 0.5 s) when the fast look changes, so caReact does not step', () => {
      const { tr, out, input } = rig({ character: makeCharacter({ tense: 1 }), legacyLook: 'peak' })
      step(tr, out, input, 1)
      expect(out.intensityGate).toBe(1)
      input.legacyLook = 'silence'
      step(tr, out, input, 0.5)
      expect(out.intensityGate).toBeCloseTo(Math.exp(-1), 6)
      step(tr, out, input, 10)
      expect(out.intensityGate).toBeCloseTo(0, 6)
      input.legacyLook = 'mellow'
      step(tr, out, input, 10)
      expect(out.intensityGate).toBeCloseTo(0.35, 6)
    })

    it('a breakdown in a peak song is NOT gated (the gate is the fast look only)', () => {
      const { tr, out, input } = rig({ character: makeCharacter({ tense: 1 }), legacyLook: 'ambient' })
      step(tr, out, input, 1)
      expect(out.fxShock).toBeCloseTo(tenseRow.fxShock * 0.35, 9)
    })
  })

  describe('state', () => {
    it('reset() restarts the modifier state and re-seeds the next valid frame', () => {
      const { tr, out, input } = settled()
      input.drop = true
      input.legacyBuilding = true
      step(tr, out, input, 1)
      expect(out.afterglow).toBeGreaterThan(0)
      tr.reset()
      input.drop = false
      input.legacyBuilding = false
      input.character = makeCharacter({ euphoric: 1 })
      tr.update(input, out)
      expectRowMatches(out, ROWS.euphoric)
      expect(out.afterglow).toBe(0)
      expect(out.buildIntent).toBe(0)
      expect(out.breakdown).toBe(0)
    })

    it('the modifier state keeps advancing while the profile is not valid', () => {
      const { tr, out, input } = rig({ character: createEmptyCharacterState() })
      input.legacyBuilding = true
      step(tr, out, input, 2)
      expect(out.valid).toBe(false)
      expect(out.buildIntent).toBeCloseTo(0.5, 9)
      input.drop = true
      step(tr, out, input, 1 / 60)
      expect(out.afterglow).toBe(1)
      // the profile turns valid mid-build: the build is already there
      input.character = makeCharacter({ tense: 1 })
      step(tr, out, input, 1 / 60)
      expect(out.valid).toBe(true)
      expect(out.buildIntent).toBeCloseTo(0.5, 9)
    })
  })
})

describe('fuzz: invariants hold for arbitrary inputs', () => {
  const ALL_ON = { grade: true, post: true, scene: true, camera: true }
  const ALL_OFF = { grade: false, post: false, scene: false, camera: false }

  /**
   * Drives a tracker with `frames` of pseudo-random input (bad dts, flapping flags, invalid reads, forced moods,
   * families off). Returns the last profile and every invariant violation found (collected, not asserted per frame:
   * tens of thousands of `expect` calls would dominate the run time).
   */
  function run(seed0: number, frames: number): { out: LookProfile; bad: string[] } {
    let seed = seed0
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
    const bad: string[] = []
    const chk = (ok: boolean, what: string, f: number) => {
      if (!ok && bad.length < 20) bad.push(`frame ${f}: ${what}`)
    }
    const { tr, out, input } = rig()
    for (let f = 0; f < frames; f++) {
      if (f % 50 === 0) {
        const dist = Object.fromEntries(CHARACTER_MOODS.map((m) => [m, rnd() ** 3])) as Record<CharacterMood, number>
        const cs = makeCharacter(dist, { confidence: rnd(), valid: rnd() > 0.1 })
        cs.entropy = rnd()
        input.character = cs
        input.legacyLook = pick(MOOD_STATES)
        input.timbre = { harsh: rnd(), busy: rnd(), sparse: rnd() }
        input.force = rnd() > 0.9 ? pick(CHARACTER_MOODS) : null
        input.families = rnd() > 0.95 ? ALL_OFF : ALL_ON
      }
      if (f % 30 === 0) {
        input.song.structureValid = rnd() > 0.2
        input.song.isBuild = rnd() > 0.7
        input.song.buildProgress = rnd()
        input.song.isBreakdown = !input.song.isBuild && rnd() > 0.7
        input.legacyBuilding = rnd() > 0.6
      }
      input.drop = rnd() > 0.93
      input.dt = rnd() > 0.9 ? pick([1 / 30, 1 / 144, 0.5, 0, NaN, -1, 1e6]) : 1 / 60
      tr.update(input, out)

      chk(allFinite(out), 'non-finite value', f)
      if (!out.valid) {
        chk(out.weights.every((w) => w === 0), 'legacy weights not zero', f)
        chk(out.gradeSat === 1 && out.gradeTemp === 0 && out.gradeContrast === 1, 'legacy grade not identity', f)
        continue
      }
      chk(Math.abs(sum(out.weights) - 1) < 1e-6, 'weights do not sum to 1', f)
      chk(out.lensEngage >= 0 && out.lensEngage <= 0.85 + 1e-9, 'lensEngage range', f)
      chk(out.mirrorEngage >= 0 && out.mirrorEngage <= 0.9 + 1e-9, 'mirrorEngage range', f)
      for (const k of ['steerSpeed', 'steerComplexity', 'steerDensity', 'trailsBase', 'echoGate', 'bloomBase', 'buildIntent', 'afterglow', 'breakdown', 'intensityGate', 'relax'] as const) {
        chk(out[k] >= 0 && out[k] <= 1 + 1e-9, `${k} outside 0..1: ${out[k]}`, f)
      }
      chk(out.trailsZoom <= 2 + 1e-9, 'trailsZoom cap', f)
      chk(out.fogBase >= 0 && out.fogBase <= 0.6 + 1e-9, 'fogBase range', f)
      chk(out.gradeSat <= 1.4 + 1e-9 && out.gradeContrast <= 1.35 + 1e-9, 'grade cap', f)
      for (const k of ['fxShock', 'fxFlare', 'fxSpark', 'fxStrobe', 'caReact', 'caBase'] as const) chk(out[k] >= 0, `${k} negative`, f)
      for (const k of ARRAY_KEYS) for (const v of out[k]) chk(v >= -1e-12, `${k} has a negative weight`, f)
    }
    return { out, bad }
  }

  it('stays finite, normalised and within range over 6000 random frames (three seeds)', () => {
    for (const seed of [987654321, 1234567, 42]) expect(run(seed, 6000).bad).toEqual([])
  })

  it('is deterministic: the same inputs give the same profile (no hidden global state)', () => {
    expect(run(42, 3000).out).toEqual(run(42, 3000).out)
  })
})

describe('per-frame code', () => {
  it('contains no allocating constructs (no new, array / object literals, spread, closures)', () => {
    const src = hotPath(PROFILE_SRC)
    expect(src.length).toBeGreaterThan(1500) // the markers were found
    expect(findAllocations(src)).toEqual([])
  })
})

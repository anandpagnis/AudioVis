import { describe, expect, it } from 'vitest'
import { FULL_CHAIN_HOOKS, runTrack, type TrackRunResult } from '../../../../scripts/calibrate/features'
import { makeFixture } from '../../../../scripts/calibrate/fixtures'
import { COLUMN_NAMES } from '../cadenceTrace'

/**
 * Regression guard for the phase 0C changes to `scripts/calibrate/features.ts` (SectionTracker stepped after
 * `StructureAnalyzer`, opt-in drop state machine / character read / trace). Every existing `FrameSample` field must
 * come out exactly as before for the default hooks: the emotion, structure and downbeat harnesses rely on it.
 *
 * The GOLDEN digest below was recorded from the UNMODIFIED `features.ts` (per-field sums over the frames, booleans
 * as 0/1, string fields as a hash of their first characters) on the two fixtures used here.
 *
 * RE-RECORDED once, after PhraseDetector was made more sensitive (THRESHOLD 0.45 -> 0.30, high band weighted up, 6-beat
 * cooldown): `sectionChangeStrength`, `sectionChange` and `phrase` moved, and on `four_on_floor` a section change now
 * fires once, which softens the key tracker (`keyValid`, `key*`). Every other field is byte-identical.
 */

const TIMEOUT = 60_000

function digest(res: TrackRunResult) {
  const sums: Record<string, number> = {}
  const strs: Record<string, string> = {}
  for (const fr of res.frames) {
    for (const [k, v] of Object.entries(fr)) {
      if (typeof v === 'number') sums[k] = (sums[k] ?? 0) + v
      else if (typeof v === 'boolean') sums[k] = (sums[k] ?? 0) + (v ? 1 : 0)
      else if (typeof v === 'string') strs[k] = (strs[k] ?? '') + (v.length ? v[0] : '-')
    }
  }
  const hash = (s: string) => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
    return h
  }
  return {
    frames: res.frames.length,
    beats: res.beats.length,
    runs: res.structureRuns.length,
    salience: res.salience.length,
    sums,
    strHash: Object.fromEntries(Object.entries(strs).map(([k, v]) => [k, hash(v)])),
  }
}

const GOLDEN = {
  build_drop: {
    frames: 597,
    beats: 21,
    runs: 0,
    salience: 19,
    sums: {
      t: 2965.1, rms: 249.884229, loudness: 428.644895, energy: 242.926444, sub: 187.408528, bass: 190.298099,
      mid: 240.74992, presence: 216.99576, high: 162.670618, vocal: 306.756096, air: 162.643497, sparkle: 153.537075,
      centroid: 457.030104, spectralFlatness: 287.665127, spectralRolloff: 291.201876, crestFactor: 966.827526,
      flux: 35.3143191, transient: 52.5500584, bpm: 71886.7158, confidence: 16.6455861, beatGridAccuracy: 70.2223054,
      octaveCorrection: 581.5, beat: 21, phrase: 0, sectionChange: 2, sectionChangeStrength: 277.0879712153116, drop: 36,
      buildUp: 0, silence: 48, moodConfidence: 242.734777, moodAmbiguity: 286.910087, moodChanged: 3, moodLevel: 204.743468,
      energyVel: -99.7007977, keyValid: 0, keyModeStrength: 0, keyConfidence: 0, harmonicTensionValid: 537,
      harmonicTension: 175.232848, harmonicTonalness: 218.515227, harmonicRoughness: 186.809564,
      harmonicDissonance: 54.5973022, structureBuildActive: 0,
    },
    strHash: { moodState: 1195873051, key: -1875098643, scale: -1875098643 },
  },
  four_on_floor: {
    frames: 477,
    beats: 16,
    runs: 0,
    salience: 16,
    sums: {
      t: 1892.1000000000001, rms: 128.34501827425566, loudness: 454.7246527940977, energy: 195.3645084267424,
      sub: 162.38067225242375, bass: 114.34228342481317, mid: 309.3280260499175, presence: 246.59968654852796,
      high: 98.16467623989368, vocal: 327.2327860742805, air: 97.90525830349456, sparkle: 96.25512927870649,
      centroid: 388.00537445486043, spectralFlatness: 176.97775634216043, spectralRolloff: 172.81439383812776, crestFactor: 1071.2890929389187,
      flux: 69.16909865307593, transient: 103.25613758081482, bpm: 58998.93375198087, confidence: 74.93460215952697,
      beatGridAccuracy: 157.07886768807967, octaveCorrection: 477, beat: 16, phrase: 0,
      sectionChange: 1, sectionChangeStrength: 92.28798093004049, drop: 0, buildUp: 0,
      silence: 0, moodConfidence: 170.40949654307886, moodAmbiguity: 279.74231301064805, moodChanged: 1,
      moodLevel: 164.02045193374343, energyVel: -109.83343654916509, keyValid: 0, keyModeStrength: 0,
      keyConfidence: 0, harmonicTensionValid: 417, harmonicTension: 171.3712186525655, harmonicTonalness: 235.2664883935678,
      harmonicRoughness: 217.61913128108705, harmonicDissonance: 101.4491141480695, structureBuildActive: 0,
    },
    strHash: {moodState: 519522977, key: -1485826707, scale: -1485826707},
  },
} as const

const CASES = [
  ['build_drop', 10],
  ['four_on_floor', 8],
] as const

function expectMatchesGolden(res: TrackRunResult, name: keyof typeof GOLDEN): void {
  const d = digest(res)
  const g = GOLDEN[name]
  expect(d.frames).toBe(g.frames)
  expect(d.beats).toBe(g.beats)
  expect(d.runs).toBe(g.runs)
  expect(d.salience).toBe(g.salience)
  expect(Object.keys(d.sums).sort()).toEqual(Object.keys(g.sums).sort())
  for (const [k, want] of Object.entries(g.sums)) {
    const got = d.sums[k]
    expect(Math.abs(got - want), `${name}.${k}: ${got} vs ${want}`).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(want)))
  }
  expect(d.strHash).toEqual(g.strHash)
}

describe('runTrack: phase 0C additions leave every existing field unchanged', () => {
  for (const [regime, seconds] of CASES) {
    it(
      `${regime}: default hooks reproduce the pre-change digest and return no trace`,
      () => {
        const fx = makeFixture({ regime, seconds })
        const res = runTrack(fx.pcm, fx.sampleRate)
        expectMatchesGolden(res, regime)
        expect(res.trace).toBeUndefined()
      },
      TIMEOUT,
    )
  }

  it(
    'turning on the trace and the character read changes no FrameSample field (the drop state machine is the one opt-in that may)',
    () => {
      const fx = makeFixture({ regime: 'build_drop', seconds: 10 })
      const res = runTrack(fx.pcm, fx.sampleRate, { trace: true, character: true })
      expectMatchesGolden(res, 'build_drop')
      expect(res.trace).toBeDefined()
    },
    TIMEOUT,
  )

  it(
    'the trace mirrors the frames it was recorded beside, column for column',
    () => {
      const fx = makeFixture({ regime: 'four_on_floor', seconds: 8 })
      const res = runTrack(fx.pcm, fx.sampleRate, FULL_CHAIN_HOOKS)
      const t = res.trace
      expect(t).toBeDefined()
      if (!t) return
      expect(t.n).toBe(res.frames.length)
      expect(Object.keys(t.cols).sort()).toEqual([...COLUMN_NAMES].sort())
      expect(t.meta).toMatchObject({ characterStepped: true, dropStateMachine: true })
      let beatsSeen = 0
      for (let i = 0; i < t.n; i++) {
        const fr = res.frames[i]
        expect(t.cols.beat[i] === 1).toBe(fr.beat)
        expect(t.cols.sectionChange[i] === 1).toBe(fr.sectionChange)
        expect(t.cols.silence[i] === 1).toBe(fr.silence)
        expect(t.cols.buildUp[i] === 1).toBe(fr.buildUp)
        expect(Math.abs(t.cols.energy[i] / 255 - fr.energy)).toBeLessThanOrEqual(1 / 255)
        expect(t.enums.moods[t.cols.moodState[i]]).toBe(fr.moodState)
        if (fr.beat) beatsSeen++
      }
      expect(beatsSeen).toBe(res.beats.length)
      // beatIndex is monotone and steps only on a beat frame
      for (let i = 1; i < t.n; i++) {
        expect(t.cols.beatIndex[i]).toBeGreaterThanOrEqual(t.cols.beatIndex[i - 1])
        if (t.cols.beat[i] === 0) expect(t.cols.beatIndex[i]).toBe(t.cols.beatIndex[i - 1])
      }
    },
    TIMEOUT,
  )
})

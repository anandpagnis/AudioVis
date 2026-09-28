import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  CH_HARMONY,
  CH_HIGH,
  CH_LEVEL,
  CH_LOW,
  CH_MID,
  CH_RHYTHM,
  CH_TEXTURE,
  CH_TIMBRE,
  FEATURE_DIM,
  FeatureRing,
  OFF_CHROMA,
  OFF_HIGH,
  OFF_LEVEL,
  OFF_LOW,
  OFF_MEL,
  OFF_MID,
  RunningMoments,
  channelDistances,
  cosDistance,
  extractFeatures,
  harmonyDistance,
} from '../barFeatures'
import { CHORUS, VERSE, makeCell, mulberry } from './cellFactory'

const feat = (spec = VERSE, o = {}) => {
  const out = new Float64Array(FEATURE_DIM)
  extractFeatures(makeCell(spec, 1, mulberry(1), { jitter: 0, ...o }), out)
  return out
}

describe('extractFeatures', () => {
  it('reads the raw dB level and tilts relative to the RMS, and centres the mel and chroma blocks', () => {
    const f = feat()
    expect(f[OFF_LEVEL]).toBeCloseTo(VERSE.levelDb, 6)
    expect(f[OFF_LOW]).toBeCloseTo(VERSE.lowTilt, 6)
    expect(f[OFF_MID]).toBeCloseTo(VERSE.midTilt, 6)
    expect(f[OFF_HIGH]).toBeCloseTo(VERSE.highTilt, 6)
    let mel = 0
    let chroma = 0
    for (let i = 0; i < 13; i++) mel += f[OFF_MEL + i]
    for (let i = 0; i < 12; i++) chroma += f[OFF_CHROMA + i]
    expect(mel).toBeCloseTo(0, 9)
    expect(chroma).toBeCloseTo(0, 9)
  })

  it('a uniform gain moves ONLY the level channel: every other feature is exactly invariant', () => {
    const a = feat(VERSE)
    const b = feat(VERSE, { gainDb: 6 })
    expect(b[OFF_LEVEL] - a[OFF_LEVEL]).toBeCloseTo(6, 6)
    for (let i = 1; i < FEATURE_DIM; i++) expect(b[i]).toBeCloseTo(a[i], 4)
    const d = new Float64Array(CHANNELS)
    channelDistances(b, a, d)
    expect(d[CH_LEVEL]).toBeCloseTo(6, 6)
    for (const k of [CH_LOW, CH_MID, CH_HIGH, CH_TIMBRE, CH_HARMONY, CH_RHYTHM, CH_TEXTURE]) expect(Math.abs(d[k])).toBeLessThan(1e-3)
  })

  it('a different timbre / harmony moves the 1-cos channels and identical vectors are at distance 0', () => {
    const v = feat(VERSE)
    const c = feat(CHORUS)
    const d = new Float64Array(CHANNELS)
    channelDistances(v, v, d)
    expect(Array.from(d).every((x) => x === 0)).toBe(true)
    channelDistances(c, v, d)
    expect(d[CH_TIMBRE]).toBeGreaterThan(0.05)
    expect(d[CH_HARMONY]).toBeGreaterThan(0.05)
    expect(d[CH_HARMONY]).toBe(harmonyDistance(c, v))
    expect(d[CH_RHYTHM]).toBeCloseTo(CHORUS.onset - VERSE.onset, 6)
    expect(d[CH_TEXTURE]).toBeGreaterThan(0.1)
  })

  it('is total: NaN, Infinity, short arrays and a missing raw block read as neutral values', () => {
    const cell = makeCell(VERSE, 1, mulberry(1))
    cell.mfcc = [Number.NaN, Number.POSITIVE_INFINITY]
    cell.hpcp = []
    cell.centroid = Number.NaN
    const out = new Float64Array(FEATURE_DIM)
    extractFeatures(cell, out)
    expect(Array.from(out).every(Number.isFinite)).toBe(true)
    const noRaw = makeCell(VERSE, 1, mulberry(1))
    delete noRaw.raw
    extractFeatures(noRaw, out)
    expect(Array.from(out).every(Number.isFinite)).toBe(true)
  })

  it('cosDistance of a zero vector is 0 (nothing to compare), not NaN', () => {
    const z = new Float64Array(4)
    const v = Float64Array.of(1, 2, 3, 4)
    expect(cosDistance(z, 0, v, 0, 4)).toBe(0)
    expect(cosDistance(v, 0, v, 0, 4)).toBeCloseTo(0, 12)
    expect(cosDistance(v, 0, Float64Array.of(-1, -2, -3, -4), 0, 4)).toBeCloseTo(2, 12)
  })
})

describe('FeatureRing', () => {
  it('holds the newest cap cells, indexes by age, and windows are means over ages', () => {
    const ring = new FeatureRing(5)
    for (let b = 1; b <= 8; b++) {
      const o = ring.writeOffset()
      ring.data.fill(b, o, o + FEATURE_DIM)
      ring.commit(b, b * 0.5, b * 10)
    }
    expect(ring.count).toBe(5)
    expect(ring.beatAt(0)).toBe(8)
    expect(ring.beatAt(4)).toBe(4)
    expect(ring.seqAt(0)).toBe(80)
    expect(ring.timeAt(1)).toBeCloseTo(3.5, 9)
    expect(ring.ageOfSeq(60)).toBe(2)
    expect(ring.ageOfSeq(10)).toBe(-1) // evicted
    const mean = new Float64Array(FEATURE_DIM)
    expect(ring.meanWindow(0, 3, mean)).toBe(true)
    expect(mean[0]).toBeCloseTo((8 + 7 + 6) / 3, 12)
    expect(ring.meanWindow(3, 3, mean)).toBe(false) // only 2 older cells exist
    ring.dropNewest(2)
    expect(ring.count).toBe(3)
    expect(ring.beatAt(0)).toBe(6)
    ring.clear()
    expect(ring.count).toBe(0)
  })
})

describe('RunningMoments', () => {
  it('tracks the mean and standard deviation of a stream', () => {
    const m = new RunningMoments(2)
    const rnd = mulberry(5)
    const v = new Float64Array(2)
    for (let i = 0; i < 400; i++) {
      v[0] = 3 + 2 * (rnd() - 0.5) * Math.sqrt(12)
      v[1] = -1
      m.add(v, 0)
    }
    expect(m.mean[0]).toBeCloseTo(3, 0)
    expect(m.std(0)).toBeGreaterThan(1.5)
    expect(m.std(0)).toBeLessThan(2.5)
    expect(m.std(1)).toBeCloseTo(0, 9)
    m.reset()
    expect(m.n).toBe(0)
    expect(m.std(0)).toBe(0)
  })
})

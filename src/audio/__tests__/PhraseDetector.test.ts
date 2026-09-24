import { describe, expect, it } from 'vitest'
import { PhraseDetector } from '../PhraseDetector'
import { createEmptyFeatures, type AudioFeatures } from '../types'

function tick(pd: PhraseDetector, f: AudioFeatures, now: number) {
  f.time = now
  pd.update(now, f)
}

/** Drives ~8s of a stable profile (enough history), then a shifted profile
 * for `shiftSec`, without ever firing a downbeat. Returns the elapsed time. */
function buildHistory(
  pd: PhraseDetector,
  f: AudioFeatures,
  stable: [number, number, number, number],
  shifted: [number, number, number, number],
  shiftSec: number,
  dt = 0.05,
): number {
  let now = 0
  for (; now < 8; now += dt) {
    ;[f.bass, f.mid, f.high, f.centroid] = stable
    f.beat = false
    tick(pd, f, now)
  }
  const shiftStart = now
  for (; now < shiftStart + shiftSec; now += dt) {
    ;[f.bass, f.mid, f.high, f.centroid] = shifted
    f.beat = false
    tick(pd, f, now)
  }
  return now
}

describe('PhraseDetector', () => {
  function makeFeatures(): AudioFeatures {
    const f = createEmptyFeatures()
    f.silence = false
    f.bpm = 120
    return f
  }

  it('flags a section change with a strong sectionChangeStrength on a large sustained shift at a downbeat', () => {
    const pd = new PhraseDetector()
    const f = makeFeatures()
    const now = buildHistory(pd, f, [0.2, 0.2, 0.2, 0.2], [0.9, 0.9, 0.9, 0.9], 1.3)
    f.beat = true
    f.beatInBar = 0
    f.beatIndex = 64
    tick(pd, f, now)
    expect(f.sectionChange).toBe(true)
    expect(f.sectionChangeStrength).toBeGreaterThan(0.45)
  })

  it('does not flag a change on a small drift, but still updates the continuous strength', () => {
    const pd = new PhraseDetector()
    const f = makeFeatures()
    const now = buildHistory(pd, f, [0.2, 0.2, 0.2, 0.2], [0.24, 0.22, 0.21, 0.2], 1.3)
    f.beat = true
    f.beatInBar = 0
    f.beatIndex = 64
    tick(pd, f, now)
    expect(f.sectionChange).toBe(false)
    expect(f.sectionChangeStrength).toBeLessThan(0.45)
  })

  it('respects the 8-beat cooldown after a detected boundary', () => {
    const pd = new PhraseDetector()
    const f = makeFeatures()
    let now = buildHistory(pd, f, [0.2, 0.2, 0.2, 0.2], [0.9, 0.9, 0.9, 0.9], 1.3)
    f.beat = true
    f.beatInBar = 0
    f.beatIndex = 64
    tick(pd, f, now)
    expect(f.sectionChange).toBe(true)

    now += 0.05
    f.bass = 0.1
    f.mid = 0.1
    f.high = 0.1
    f.centroid = 0.9
    f.beat = true
    f.beatInBar = 0
    f.beatIndex = 65
    tick(pd, f, now)
    expect(f.sectionChange).toBe(false)
  })

  it('snaps to the bar line as reported by f.beatInBar, not to beatIndex % 4', () => {
    // With a locked downbeat offset, beatInBar === 0 lands on beatIndex values that are NOT multiples of 4.
    const onBar = new PhraseDetector()
    const f1 = makeFeatures()
    const t1 = buildHistory(onBar, f1, [0.2, 0.2, 0.2, 0.2], [0.9, 0.9, 0.9, 0.9], 1.3)
    f1.beat = true
    f1.beatInBar = 0
    f1.beatIndex = 66 // 66 % 4 === 2: a legacy phase would call this an off-beat
    tick(onBar, f1, t1)
    expect(f1.sectionChange).toBe(true)

    const offBar = new PhraseDetector()
    const f2 = makeFeatures()
    const t2 = buildHistory(offBar, f2, [0.2, 0.2, 0.2, 0.2], [0.9, 0.9, 0.9, 0.9], 1.3)
    f2.beat = true
    f2.beatInBar = 2
    f2.beatIndex = 64 // 64 % 4 === 0, but the estimated bar line says this is beat 3
    tick(offBar, f2, t2)
    expect(f2.sectionChange).toBe(false)
  })

  it('phrase / phraseProgress stay continuous when beatInBar jumps (a downbeat offset adopted mid-phrase)', () => {
    const pd = new PhraseDetector()
    const f = makeFeatures()
    let prev = -1
    for (let beat = 0; beat < 48; beat++) {
      f.beat = true
      f.beatIndex = beat
      f.beatProgress = 0
      f.beatInBar = beat < 20 ? beat % 4 : (beat - 2) % 4 // the offset moves once, at beat 20
      tick(pd, f, beat * 0.5)
      const pos = f.phrase + f.phraseProgress
      expect(pos).toBeGreaterThanOrEqual(prev)
      prev = pos
    }
  })

  it('never flags a boundary during silence', () => {
    const pd = new PhraseDetector()
    const f = makeFeatures()
    const now = buildHistory(pd, f, [0.2, 0.2, 0.2, 0.2], [0.9, 0.9, 0.9, 0.9], 1.3)
    f.silence = true
    f.beat = true
    f.beatInBar = 0
    f.beatIndex = 64
    tick(pd, f, now)
    expect(f.sectionChange).toBe(false)
  })
})

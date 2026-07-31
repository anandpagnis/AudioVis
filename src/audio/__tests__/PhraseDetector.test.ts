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

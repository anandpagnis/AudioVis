import { describe, expect, it } from 'vitest'
import { COLUMN_NAMES, CadenceTraceBuilder, createEmptyTrace, packTrace, unpackTrace, type PackedTrace } from '../cadenceTrace'
import { createEmptyFeatures } from '../../types'

describe('cadenceTrace pack / unpack', () => {
  it('round-trips every column exactly through JSON (RLE and base64 columns both)', () => {
    const t = createEmptyTrace(1000, 60)
    let a = 12345
    const rnd = () => {
      a = (a * 1103515245 + 12345) & 0x7fffffff
      return a
    }
    // step-like columns (RLE wins) and noisy columns (base64 wins)
    for (let i = 0; i < t.n; i++) {
      t.cols.beat[i] = i % 30 === 0 ? 1 : 0
      t.cols.beatIndex[i] = Math.floor(i / 30)
      t.cols.energy[i] = rnd() % 256
      t.cols.moodConfidence[i] = rnd() % 256
      t.cols.beatsTillDrop10[i] = (rnd() % 2000) - 1000
      t.cols.charPrimary[i] = (rnd() % 15) - 1
      t.cols.changeCount[i] = rnd() % 60000
      t.cols.bar[i] = -5 + Math.floor(i / 120)
    }
    t.analyserBoundaries.push({ beat: 12, seenFrame: 300 })
    t.meta = { characterStepped: true, dropStateMachine: true, id: 'x' }
    const json = JSON.stringify(packTrace(t))
    const back = unpackTrace(JSON.parse(json) as PackedTrace)
    for (const name of COLUMN_NAMES) expect(Array.from(back.cols[name]), name).toEqual(Array.from(t.cols[name]))
    expect(back.n).toBe(t.n)
    expect(back.analyserBoundaries).toEqual(t.analyserBoundaries)
    expect(back.meta).toEqual(t.meta)
    // the step columns did compress: the whole trace is well under the raw byte size in base64
    expect(json.length).toBeLessThan(t.n * COLUMN_NAMES.length * 1.4)
  })

  it('refuses a stale cache version', () => {
    const p = packTrace(createEmptyTrace(10))
    expect(() => unpackTrace({ ...p, version: 999 })).toThrow(/regenerate/)
  })

  it('the builder records the fields the directors read, quantised', () => {
    const f = createEmptyFeatures()
    f.beat = true
    f.beatIndex = 7
    f.beatInBar = 3
    f.bar = 1
    f.bpm = 127.44
    f.confidence = 0.5
    f.energy = 0.4
    f.sectionChange = true
    f.sectionChangeStrength = 0.93
    f.drop = true
    f.structureValid = true
    f.songSection.boundaryChanged = true
    f.songSection.section = 'breakdown'
    f.songSection.isSustain = true
    f.songSection.beatsTillDrop = 5.5
    f.songSection.repetitionLabel = 'B'
    f.mood.state = 'peak'
    f.mood.predictedState = 'aggressive'
    f.mood.confidence = 0.8
    f.mood.beatsTillTransition = -1
    f.mood.changeCount = 2
    const b = new CadenceTraceBuilder(4, 60, 44100, 1, { characterStepped: false })
    b.push(0, f)
    b.noteBoundaries(0, [8, 9, 24])
    b.noteBoundaries(1, [10, 24, 40])
    const t = b.finish()
    expect(t.n).toBe(1) // only one frame pushed: the capacity is trimmed
    const c = t.cols
    expect([c.beat[0], c.beatIndex[0], c.beatInBar[0], c.bar[0], c.bpm10[0]]).toEqual([1, 7, 3, 1, 1274])
    expect(c.confidence[0]).toBe(128)
    expect(c.sectionChangeStrength[0]).toBe(93)
    expect([c.sectionChange[0], c.drop[0], c.structureValid[0], c.boundaryChanged[0], c.isSustain[0]]).toEqual([1, 1, 1, 1, 1])
    expect(t.enums.sections[c.section[0]]).toBe('breakdown')
    expect(t.enums.labels[c.repetitionLabel[0]]).toBe('B')
    expect(t.enums.moods[c.moodState[0]]).toBe('peak')
    expect(t.enums.moods[c.predictedState[0]]).toBe('aggressive')
    expect(c.beatsTillDrop10[0]).toBe(55)
    expect(c.beatsTillTransition10[0]).toBe(-10)
    expect(c.moodChangeCount[0]).toBe(2)
    expect(c.charPrimary[0]).toBe(-1)
    // boundaries within +-2 beats of a known one are the same physical boundary
    expect(t.analyserBoundaries).toEqual([
      { beat: 8, seenFrame: 0 },
      { beat: 24, seenFrame: 0 },
      { beat: 40, seenFrame: 1 },
    ])
  })
})

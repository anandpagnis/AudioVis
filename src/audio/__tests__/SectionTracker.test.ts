import { describe, expect, it } from 'vitest'
import { SectionTracker, classifyBreakdown, segmentAt } from '../SectionTracker'
import { createEmptyFeatures, createEmptySongSection, type AudioFeatures } from '../types'
import type { StructureRaw, StructureSegment } from '../essentia/structureProtocol'

/** Drive the tracker `frames` frames at 60 fps, applying `patch` each frame.
 * `patch` may return a `StructureRaw` to deliver on that frame. */
function run(
  frames: number,
  patch: (f: AudioFeatures, i: number) => StructureRaw | null | void,
  bpm = 120,
): { tracker: SectionTracker; f: AudioFeatures } {
  const tracker = new SectionTracker()
  const f = createEmptyFeatures()
  f.silence = false
  f.bpm = bpm
  const dt = 1 / 60
  const secPerBeat = 60 / bpm
  for (let i = 0; i < frames; i++) {
    f.time = i * dt
    f.delta = dt
    const beatFloat = f.time / secPerBeat
    const bi = Math.floor(beatFloat)
    f.beat = bi !== f.beatIndex
    f.beatIndex = bi
    f.beatProgress = beatFloat - bi
    f.beatInBar = bi % 4
    const raw = patch(f, i) ?? null
    tracker.update(f, raw)
  }
  return { tracker, f }
}

function seg(
  startBeat: number,
  endBeat: number,
  kind: StructureSegment['kind'],
  o: Partial<StructureSegment> = {},
): StructureSegment {
  return {
    startBeat,
    endBeat,
    kind,
    repetitionLabel: o.repetitionLabel ?? 'A',
    meanEnergy: o.meanEnergy ?? 0.5,
    meanFlatness: o.meanFlatness ?? 0.3,
  }
}

function rawWith(
  segments: StructureSegment[],
  atBeat: number,
  boundaries: number[] = [],
): StructureRaw {
  return {
    atBeat,
    novelty: [],
    boundaries,
    segments,
    build: { active: false, score: 0, progress: 0, beatsTillDrop: -1, startBeat: -1 },
    costMs: 20,
  }
}

describe('helpers', () => {
  it('segmentAt finds the covering segment, clamps to the last', () => {
    const segs = [seg(0, 16, 'intro'), seg(16, 48, 'section'), seg(48, 80, 'section')]
    expect(segmentAt(segs, 8)?.kind).toBe('intro')
    expect(segmentAt(segs, 20)?.startBeat).toBe(16)
    expect(segmentAt(segs, 999)?.startBeat).toBe(48)
    expect(segmentAt([], 5)).toBeNull()
  })

  it('classifyBreakdown fires on a sustained energy collapse', () => {
    const hist = []
    for (let b = 0; b < 16; b++) hist.push({ beat: b, e: 0.7 })
    for (let b = 16; b < 20; b++) hist.push({ beat: b, e: 0.2 })
    expect(classifyBreakdown(hist, 19, false)).toBe(true)
    expect(classifyBreakdown(hist, 19, true)).toBe(false) // silence guard
  })
})

describe('SectionTracker', () => {
  it('is inert with no analyzer result — structureValid stays false', () => {
    const { f } = run(600, () => null)
    expect(f.structureValid).toBe(false)
    expect(f.songSection.section).toBe('')
    expect(f.songSection.changeCount).toBe(0)
  })

  it('the synchronous drop overlay works with no worker', () => {
    const { f } = run(240, (f, i) => {
      f.drop = i >= 60 && i < 66 // a ~0.1 s pulse around frame 60
    })
    // The drop latch (8 beats @ 120 BPM = 4 s = 240 frames) is still active.
    expect(f.songSection.isDrop).toBe(true)
    expect(f.songSection.section).toBe('drop')
    expect(f.songSection.boundaryChanged).toBe(false) // one-frame flag, long past
  })

  it('bootstraps structureValid and the section from the first segmentation', () => {
    const segs = [seg(0, 40, 'intro', { meanEnergy: 0.2 }), seg(40, 200, 'section')]
    const { f } = run(400, (f, i) => {
      if (i === 120) return rawWith(segs, f.beatIndex, [40])
      return null
    })
    expect(f.structureValid).toBe(true)
    expect(['intro', 'section']).toContain(f.songSection.section)
    expect(f.songSection.sectionConfidence).toBeGreaterThan(0)
  })

  it('commits build on a sustained f.buildUp and exposes isSustain + buildProgress', () => {
    const { f } = run(600, (f, i) => {
      f.buildUp = i >= 120
    })
    expect(f.songSection.section).toBe('build')
    expect(f.songSection.isBuild).toBe(true)
    expect(f.songSection.isSustain).toBe(true)
    expect(f.songSection.buildProgress).toBeGreaterThan(0)
  })

  it('releases the build on a drop: section=drop, one-frame boundaryChanged, previousSection=build', () => {
    let sawBoundaryChanged = 0
    let prevAtDropChange = ''
    let sectionAtDrop = ''
    let isDropAtDrop = false
    const { f } = run(900, (f, i) => {
      f.buildUp = i >= 120 && i < 480
      f.drop = i >= 480 && i < 486
      if (f.songSection.boundaryChanged) {
        sawBoundaryChanged++
        if (f.songSection.section === 'drop') prevAtDropChange = f.songSection.previousSection
      }
      if (i === 500) {
        sectionAtDrop = f.songSection.section
        isDropAtDrop = f.songSection.isDrop
      }
    })
    expect(sectionAtDrop).toBe('drop')
    expect(isDropAtDrop).toBe(true)
    expect(sawBoundaryChanged).toBeGreaterThanOrEqual(2) // → build, then → drop
    expect(prevAtDropChange).toBe('build')
    // The build state is gone — no lingering isBuild after the drop.
    expect(f.songSection.isBuild).toBe(false)
  })

  it('fizzles a build with no drop softly — no boundaryChanged on the way out', () => {
    let changesAfterFizzle = 0
    const { f } = run(1800, (f, i) => {
      f.buildUp = i >= 120 && i < 360 // ~4 s of build, then nothing
      if (i > 900 && f.songSection.boundaryChanged) changesAfterFizzle++
    })
    expect(f.songSection.isBuild).toBe(false)
    expect(f.songSection.section).not.toBe('build')
    expect(changesAfterFizzle).toBe(0)
  })

  it('follows a breakdown segment kind from the analyzer', () => {
    const segs = [
      seg(0, 40, 'section', { meanEnergy: 0.7 }),
      seg(40, 400, 'breakdown', { meanEnergy: 0.2, meanFlatness: 0.2 }),
    ]
    // 2400 frames @ 120 BPM = 40 s = 80 beats — well past the beat-40 boundary.
    const { f } = run(2400, (f, i) => {
      f.energy = f.beatIndex < 40 ? 0.7 : 0.25
      if (i === 60) return rawWith(segs, f.beatIndex, [40])
      return null
    })
    expect(f.songSection.section).toBe('breakdown')
    expect(f.songSection.isBreakdown).toBe(true)
  })

  it('decays sectionConfidence once the analyzer goes stale but keeps structureValid', () => {
    const segs = [seg(0, 400, 'section')]
    const { tracker, f } = run(120, (f, i) => (i === 30 ? rawWith(segs, f.beatIndex) : null))
    const fresh = f.songSection.sectionConfidence
    // Keep ticking for ~60 s of engine time with no new raw.
    const dt = 1 / 60
    for (let i = 120; i < 120 + 60 * 60; i++) {
      f.time = i * dt
      f.delta = dt
      f.beatIndex = Math.floor(f.time / 0.5)
      tracker.update(f, null)
    }
    expect(f.structureValid).toBe(true)
    expect(f.songSection.sectionConfidence).toBeLessThan(fresh)
  })

  it('reset() restores createEmptySongSection()', () => {
    const { tracker, f } = run(600, (f, i) => {
      f.buildUp = i >= 120
    })
    expect(f.songSection.section).toBe('build')
    tracker.reset()
    // Next update with a fresh feature object writes the neutral shape.
    const f2 = createEmptyFeatures()
    f2.silence = false
    tracker.update(f2, null)
    expect(f2.songSection).toEqual(createEmptySongSection())
    expect(f2.structureValid).toBe(false)
  })
})

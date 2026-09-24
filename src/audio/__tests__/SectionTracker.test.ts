import { describe, expect, it } from 'vitest'
import {
  SectionTracker,
  boundarySpacing,
  classifyBreakdown,
  segmentAt,
} from '../SectionTracker'
import { createEmptyFeatures, createEmptySongSection, type AudioFeatures } from '../types'
import type { StructureBuild, StructureRaw, StructureSegment } from '../essentia/structureProtocol'

/** Drive the tracker `frames` frames at 60 fps (120 BPM => beat b starts at frame 30*b), applying
 * `patch` each frame. `patch` may return a `StructureRaw` to deliver on that frame. NOTE `patch`
 * runs BEFORE `tracker.update` on the same frame, so inside it `f.songSection` still holds the
 * PREVIOUS frame's result. */
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

/** First frame of `beat` at 120 BPM / 60 fps. */
const frameOf = (beat: number) => beat * 30

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

const NO_BUILD: StructureBuild = { active: false, score: 0, progress: 0, beatsTillDrop: -1, startBeat: -1 }

function rawWith(
  segments: StructureSegment[],
  atBeat: number,
  boundaries: number[] = [],
  build: StructureBuild = NO_BUILD,
): StructureRaw {
  return { atBeat, novelty: [], boundaries, segments, build, costMs: 20 }
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

  it('boundarySpacing: median gap snapped to the 8- then 4-beat grid, 0 when unknown/irregular', () => {
    expect(boundarySpacing([])).toBe(0)
    expect(boundarySpacing([5])).toBe(0) // one boundary has no spacing
    expect(boundarySpacing([0, 16, 32])).toBe(16)
    expect(boundarySpacing([0, 8, 16, 24])).toBe(8)
    expect(boundarySpacing([0, 15, 31, 48])).toBe(16) // gaps 15,16,17 -> jitter absorbed by the median
    expect(boundarySpacing([0, 12, 24])).toBe(12) // not an 8-multiple, still a 4-multiple
    expect(boundarySpacing([0, 32, 48, 64])).toBe(16) // one missed boundary (gap 32) doesn't move the median
    expect(boundarySpacing([10, 24, 38])).toBe(0) // gaps of 14 fit neither grid
    expect(boundarySpacing([0, 4, 8])).toBe(0) // < 8 beats is below the analyzer's minimum segment
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

  // UPDATED: this test used to inject a boundary in the FUTURE ([40] at beat 4), the shape the analyzer
  // can never produce (its novelty zeroes the outer kernel cells, so every boundary is >= ~8 beats
  // BEHIND the live beat). Now the first segmentation arrives at beat 40 and reports boundaries that
  // already happened.
  it('bootstraps structureValid and the section from the first segmentation, dated from its newest past boundary', () => {
    const segs = [seg(0, 16, 'intro', { meanEnergy: 0.2 }), seg(16, 200, 'section')]
    const { f } = run(frameOf(40) + 1, (f, i) => {
      if (i === frameOf(40)) return rawWith(segs, f.beatIndex, [16])
      return null
    })
    expect(f.structureValid).toBe(true)
    expect(f.songSection.section).toBe('section') // the segment covering beat 40
    expect(f.songSection.boundaryChanged).toBe(false) // bootstrap is not a musical event
    expect(f.songSection.changeCount).toBe(0)
    expect(f.songSection.beatsInSection).toBe(24) // 40 - 16: counted from the boundary, not from the read
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

  // UPDATED for the same reason as the bootstrap test: the old version delivered the segmentation at
  // beat 2 with a FUTURE boundary at 40. Here the analyzer learns of the breakdown 12 beats after it
  // began (a realistic lag), and energy is held constant so ONLY the analyzer's segment can produce it.
  it('follows a breakdown segment kind from the analyzer, promptly, once its boundary is confirmed', () => {
    const { f } = run(frameOf(52) + 1, (f, i) => {
      f.energy = 0.6
      if (i === frameOf(1)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
      if (i === frameOf(52)) {
        return rawWith(
          [
            seg(0, 40, 'section', { meanEnergy: 0.7 }),
            seg(40, 400, 'breakdown', { meanEnergy: 0.2, meanFlatness: 0.2 }),
          ],
          f.beatIndex,
          [40],
        )
      }
      return null
    })
    // Committed on the very frame the boundary arrived — aged evidence needs no fresh hold.
    expect(f.songSection.section).toBe('breakdown')
    expect(f.songSection.isBreakdown).toBe(true)
    expect(f.songSection.boundaryChanged).toBe(true)
    expect(f.songSection.beatsInSection).toBe(12)
  })

  it('still honours a boundary announced AHEAD of the beat (legacy providers): follows the breakdown once the beat gets there', () => {
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

/**
 * REALISTIC boundaries. `StructureAnalyzer`'s novelty curve is zero over its outer kernel half-width
 * (8+ cells), so every boundary in `raw.boundaries` is a CONFIRMED PAST boundary at least ~8 beats
 * behind the live beat. Every scenario below therefore delivers boundaries >= 8 (usually 12-20) beats
 * behind `f.beatIndex`; none relies on a boundary "near now" or in the future.
 */
describe('SectionTracker: confirmed-past boundaries (>= 8 beats behind the live beat)', () => {
  it('adopts the covering segment kind from a boundary 20 beats old, on the frame it is learned', () => {
    const { f } = run(frameOf(60) + 1, (f, i) => {
      if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
      if (i === frameOf(60)) {
        return rawWith([seg(0, 40, 'section'), seg(40, 400, 'outro')], f.beatIndex, [40])
      }
      return null
    })
    expect(f.songSection.section).toBe('outro')
    expect(f.songSection.previousSection).toBe('section')
    expect(f.songSection.boundaryChanged).toBe(true)
    expect(f.songSection.changeCount).toBe(1)
    expect(f.songSection.beatsInSection).toBe(20) // the section began at the boundary, 20 beats ago
  })

  it('regression: the old "boundary within 4 beats of now" path is no longer the ONLY route to a commit', () => {
    // Same scenario but with the boundary a fresh 2 beats old: it must still wait its (8-beat) hold,
    // proving the aged-evidence commit above is a distinct, working path rather than the old snap.
    const patch = (boundary: number) => (f: AudioFeatures, i: number) => {
      if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
      if (i === frameOf(60)) {
        return rawWith([seg(0, boundary, 'section'), seg(boundary, 400, 'outro')], f.beatIndex, [boundary])
      }
      return null
    }
    const aged = run(frameOf(60) + 1, patch(40)).f
    expect(aged.songSection.section).toBe('outro') // 20 beats old: prompt
    const fresh = run(frameOf(60) + 1, patch(58)).f
    expect(fresh.songSection.section).toBe('section') // 2 beats old: not yet
    const freshLater = run(frameOf(67), patch(58)).f
    expect(freshLater.songSection.section).toBe('outro') // ... but it commits once held (beat 66)
  })

  it('a same-kind boundary restarts beatsInSection from the boundary without an event', () => {
    const { tracker, f } = run(frameOf(60) + 1, (f, i) => {
      if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
      if (i === frameOf(60)) {
        return rawWith(
          [seg(0, 40, 'section', { repetitionLabel: 'A' }), seg(40, 400, 'section', { repetitionLabel: 'B' })],
          f.beatIndex,
          [40],
        )
      }
      return null
    })
    expect(f.songSection.section).toBe('section')
    expect(f.songSection.boundaryChanged).toBe(false)
    expect(f.songSection.changeCount).toBe(0)
    expect(f.songSection.beatsInSection).toBe(20)
    expect(f.songSection.repetitionLabel).toBe('B')
    // ...and it keeps counting from there.
    f.time += 5
    f.beatIndex += 10
    tracker.update(f, null)
    expect(f.songSection.beatsInSection).toBe(30)
  })

  it('ignores a boundary older than 48 beats (history, not news)', () => {
    const { f } = run(frameOf(70), (f, i) => {
      if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
      if (i === frameOf(60)) {
        // Boundary at 10 is 50 beats old by the time it is learned.
        return rawWith([seg(0, 10, 'section'), seg(10, 400, 'outro')], f.beatIndex, [10])
      }
      return null
    })
    expect(f.songSection.section).toBe('section')
    expect(f.songSection.changeCount).toBe(0)
  })

  it('treats a re-picked boundary that shifted a beat or two as the same boundary (no new event)', () => {
    const { f } = run(frameOf(70) + 1, (f, i) => {
      if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
      if (i === frameOf(60)) {
        return rawWith([seg(0, 40, 'section'), seg(40, 400, 'outro')], f.beatIndex, [40])
      }
      // The next batch re-picks the same physical boundary a beat later (fresh arrays, new peak).
      if (i === frameOf(70)) {
        return rawWith([seg(0, 41, 'section'), seg(41, 400, 'outro')], f.beatIndex, [41])
      }
      return null
    })
    expect(f.songSection.section).toBe('outro')
    expect(f.songSection.changeCount).toBe(1) // not 2
    expect(f.songSection.beatsInSection).toBe(30) // still dated from 40, not 41
  })

  describe('build -> drop resolved by a boundary', () => {
    const scenario = (opts: { boundary: number; energy: number; buildUpUntil?: number }) =>
      run(frameOf(60) + 1, (f, i) => {
        f.energy = opts.energy
        f.buildUp = i >= frameOf(4) && i < (opts.buildUpUntil ?? frameOf(60))
        if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
        if (i === frameOf(60)) {
          return rawWith(
            [seg(0, opts.boundary, 'section'), seg(opts.boundary, 400, 'section', { repetitionLabel: 'B' })],
            f.beatIndex,
            [opts.boundary],
          )
        }
        return null
      })

    it('a boundary 30 beats after the build began, with energy high, ENDS the build retroactively - and fires NO late drop', () => {
      let dropFrames = 0
      let eventFrames = 0
      let buildBefore = false
      const { f } = run(frameOf(60) + 300, (f, i) => {
        f.energy = 0.8
        f.buildUp = i >= frameOf(4) && i < frameOf(60) // the instant flag stops once the ramp is over
        if (i === frameOf(60) - 1) buildBefore = f.songSection.isBuild
        if (i > frameOf(60)) {
          if (f.songSection.isDrop) dropFrames++
          if (f.songSection.boundaryChanged) eventFrames++
        }
        if (i === frameOf(2)) return rawWith([seg(0, 400, 'section')], f.beatIndex)
        if (i === frameOf(60)) {
          return rawWith(
            [seg(0, 30, 'section'), seg(30, 400, 'section', { repetitionLabel: 'B' })],
            f.beatIndex,
            [30],
          )
        }
        return null
      })
      // Until the boundary was learned the build was live...
      expect(buildBefore).toBe(true)
      // ...afterwards it is over, the section moved on, and nothing fired retroactively (not now, not later).
      expect(f.songSection.isBuild).toBe(false)
      expect(f.songSection.section).toBe('section')
      expect(dropFrames).toBe(0)
      expect(eventFrames).toBe(0)
    })

    it('on the frame it resolves, the section dates from the boundary and previousSection is the build', () => {
      const { f } = scenario({ boundary: 30, energy: 0.8 })
      expect(f.songSection.isBuild).toBe(false)
      expect(f.songSection.isDrop).toBe(false)
      expect(f.songSection.section).toBe('section')
      expect(f.songSection.previousSection).toBe('build')
      expect(f.songSection.boundaryChanged).toBe(false) // silent state correction
      expect(f.songSection.beatsInSection).toBe(30)
    })

    it('does not resolve while energy is still low (a boundary inside a build that has not paid off)', () => {
      const { f } = scenario({ boundary: 30, energy: 0.3 })
      expect(f.songSection.isBuild).toBe(true)
      expect(f.songSection.section).toBe('build')
    })

    it('does not resolve on a boundary from BEFORE the build started', () => {
      // Build starts at beat 4; a boundary at beat 3 (still consumable: > section start 2) is not its end.
      const { f } = scenario({ boundary: 3, energy: 0.8 })
      expect(f.songSection.isBuild).toBe(true)
    })

    it('a boundary within ~2 beats of now (a provider reporting fresh boundaries) still fires the drop cue', () => {
      const { f } = scenario({ boundary: 59, energy: 0.8 })
      expect(f.songSection.isDrop).toBe(true)
      expect(f.songSection.section).toBe('drop')
      expect(f.songSection.previousSection).toBe('build')
      expect(f.songSection.boundaryChanged).toBe(true)
    })
  })

  describe('beatsTillBoundary', () => {
    /** First segmentation delivered at beat 60 with the given past boundaries; then sampled at `beats`. */
    function sample(boundaries: number[], beats: number[]): number[] {
      const out: number[] = []
      const raws = new Map<number, StructureRaw>()
      const segs = [seg(0, 400, 'section')]
      raws.set(frameOf(60), rawWith(segs, 60, boundaries))
      const { tracker, f } = run(frameOf(60) + 1, (f, i) => raws.get(i) ?? null)
      out.push(f.songSection.beatsTillBoundary)
      for (const b of beats) {
        f.beatIndex = b
        f.time = b * 0.5
        tracker.update(f, null)
        out.push(f.songSection.beatsTillBoundary)
      }
      return out
    }

    it('predicts lastBoundary + median spacing (phase-locked) from past boundaries', () => {
      // boundaries 8,24,40 -> period 16 -> next 72 (56 is past). Sampled at beats 60, 66, 71, 72, 75.
      expect(sample([8, 24, 40], [66, 71, 72, 75])).toEqual([12, 6, 1, 16, 13])
    })

    it('absorbs jitter and a missed boundary in the median', () => {
      expect(sample([8, 24, 41], [])).toEqual([13]) // gaps 16,17 -> 16 -> 41+32 = 73 - 60
      expect(sample([-12, 4, 20, 52], [])).toEqual([8]) // gaps 16,16,32: the missed one is an outlier; 52+16 = 68 - 60
    })

    it('is -1 with fewer than two boundaries or an irregular spacing', () => {
      expect(sample([], [])).toEqual([-1])
      expect(sample([40], [])).toEqual([-1])
      expect(sample([10, 24, 38], [])).toEqual([-1]) // gaps of 14 fit no 4/8 grid
    })

    it('is -1 once the last boundary is more than 4 periods stale', () => {
      // period 16, last 40: at beat 104 the 5th period is needed -> too stale to claim.
      expect(sample([8, 24, 40], [103, 104])).toEqual([12, 1, -1])
    })

    it('still reports a boundary announced ahead of the beat', () => {
      expect(sample([8, 24, 80], [])).toEqual([20])
    })
  })
})

/**
 * `StructureAnalyzer` (after its first batch) delivers a `StructureRaw` on EVERY beat: the same
 * segmentation (same array references) with a FRESH riser read. These pin down that repeated raws are
 * idempotent for segments/boundaries/staleness and that the riser latch behaves with per-beat reads.
 */
describe('SectionTracker: per-beat raws (cached segmentation + fresh riser read)', () => {
  const riserActive = (startBeat: number, beatsTillDrop: number): StructureBuild => ({
    active: true,
    score: 0.8,
    progress: 0.5,
    beatsTillDrop,
    startBeat,
  })

  it('replaying the same segmentation every beat does not refresh the staleness clock', () => {
    const segs = [seg(0, 400, 'section')]
    const bnds: number[] = []
    const cached = rawWith(segs, 0, bnds)
    const freshEveryBeat = (f: AudioFeatures) => (f.beat ? rawWith([seg(0, 400, 'section')], f.beatIndex, []) : null)
    const frames = frameOf(1) + 90 * 60 // ~90 s of engine time
    const replay = run(frames, (f, i) => (i === frameOf(1) ? cached : f.beat ? { ...cached, atBeat: f.beatIndex } : null))
    const fresh = run(frames, (f, i) => (i >= frameOf(1) ? freshEveryBeat(f) : null))
    expect(replay.f.structureValid).toBe(true)
    // Segments were last (re)loaded ~90 s ago: confidence must have decayed despite ~180 replays...
    expect(replay.f.songSection.sectionConfidence).toBeLessThan(0.15)
    // ...whereas genuinely fresh segmentations keep it up.
    expect(fresh.f.songSection.sectionConfidence).toBeCloseTo(0.45, 5)
  })

  it('a replay is idempotent: the boundary is consumed once, no extra events, no re-bootstrap', () => {
    const first = [seg(0, 400, 'section')]
    const second = [seg(0, 40, 'section'), seg(40, 400, 'outro')]
    const bnds = [40]
    let events = 0
    const { f } = run(frameOf(100), (f, i) => {
      if (f.songSection.boundaryChanged) events++
      if (i === frameOf(2)) return rawWith(first, f.beatIndex)
      if (i === frameOf(60)) return rawWith(second, f.beatIndex, bnds) // fresh: boundary 40, learned 20 beats late
      // ...then the analyzer replays that SAME segmentation on every beat for 40 more beats.
      if (f.beat && f.beatIndex > 60) return rawWith(second, f.beatIndex, bnds)
      return null
    })
    expect(f.songSection.section).toBe('outro')
    expect(events).toBe(1)
    expect(f.songSection.changeCount).toBe(1)
    expect(f.songSection.beatsInSection).toBe(59) // beat 99 - 40, counting on undisturbed
  })

  it('per-beat riser reads set the build latch, and the projected drop counts down exactly once per beat', () => {
    const segs = [seg(0, 400, 'section')]
    const bnds: number[] = []
    const seen: number[] = []
    const { f } = run(frameOf(24), (f, i) => {
      // Sample the state one frame after each beat frame (patch sees the PREVIOUS frame's result).
      if (i % 30 === 1 && f.beatIndex >= 8 && f.beatIndex <= 20) seen.push(f.songSection.beatsTillDrop)
      if (i === frameOf(1)) return rawWith(segs, f.beatIndex, bnds)
      if (f.beat && f.beatIndex >= 4) {
        return rawWith(segs, f.beatIndex, bnds, riserActive(4, 30 - (f.beatIndex - 4)))
      }
      return null
    })
    expect(f.songSection.isBuild).toBe(true)
    expect(f.songSection.isDrop).toBe(false)
    // 30 at beat 4, one less per beat: exactly what the analyzer reported for that beat.
    expect(seen).toEqual(Array.from({ length: 13 }, (_, k) => 30 - (8 + k - 4)))
  })

  it('after a drop the still-active riser window cannot re-arm the build when the latch lifts; a genuinely new riser can', () => {
    const segs = [seg(0, 400, 'section')]
    const bnds: number[] = []
    let buildAfterDrop = 0
    let prevAtDrop = ''
    const { f } = run(frameOf(84), (f, i) => {
      f.energy = 0.7
      f.drop = i >= frameOf(40) && i < frameOf(40) + 6
      const beat = f.beatIndex
      // The build (armed by per-beat riser reads from beat 4, with a countdown that shrinks every
      // beat) must still be alive when the drop lands at 40: the projected drop is re-made each beat,
      // so a build whose projected drop keeps being pushed out is not "overrun" merely because
      // beats have passed since it started.
      if (f.songSection.boundaryChanged && f.songSection.section === 'drop') prevAtDrop = f.songSection.previousSection
      // Frames after the drop's latch has lifted (beat 48) up to the second, genuinely new riser (beat 70).
      if (beat > 48 && beat < 70 && (f.songSection.isBuild || f.songSection.section === 'build')) buildAfterDrop++
      if (i === frameOf(1)) return rawWith(segs, beat, bnds)
      if (!f.beat) return null
      // Riser active 4..51 (the drop is at 40, but a 24-beat slope window keeps scoring "active" for a
      // while afterwards), quiet 52..69, and a genuinely new one from 70.
      if (beat >= 4 && beat < 52) return rawWith(segs, beat, bnds, riserActive(4, Math.max(1, 36 - beat)))
      if (beat >= 70) return rawWith(segs, beat, bnds, riserActive(70, 12))
      return rawWith(segs, beat, bnds)
    })
    expect(prevAtDrop).toBe('build')
    expect(buildAfterDrop).toBe(0)
    // ...and the new riser at 70 did arm a build (checked at beat 83).
    expect(f.songSection.isBuild).toBe(true)
  })

  it('a build that is armed by per-beat reads and then hit by an instant drop still reports previousSection=build', () => {
    const segs = [seg(0, 400, 'section')]
    const bnds: number[] = []
    let prevAtDrop = ''
    run(frameOf(30), (f, i) => {
      f.drop = i >= frameOf(20) && i < frameOf(20) + 6
      if (f.songSection.boundaryChanged && f.songSection.section === 'drop') prevAtDrop = f.songSection.previousSection
      if (i === frameOf(1)) return rawWith(segs, f.beatIndex, bnds)
      if (f.beat && f.beatIndex >= 4 && f.beatIndex < 20) return rawWith(segs, f.beatIndex, bnds, riserActive(4, 16))
      return f.beat ? rawWith(segs, f.beatIndex, bnds) : null
    })
    expect(prevAtDrop).toBe('build')
  })
})

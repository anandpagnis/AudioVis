import { describe, expect, it } from 'vitest'
import { beatMotion, beatRelax, beatSwell, snapGlide, stepBeatMotion } from '../beatMotion'

/** Drive the clock like the engine does: `bpm` for `seconds` at `fps`, weights per beat from `weightOf`. */
function drive(
  bpm: number,
  seconds: number,
  fps = 60,
  weightOf: (beat: number) => number = () => 1,
  skipBeats: (beat: number) => boolean = () => false,
) {
  const m = beatMotion()
  const dt = 1 / fps
  const beatSec = 60 / bpm
  const eased: number[] = []
  const linear: number[] = []
  for (let i = 0; i < seconds * fps; i++) {
    const t = i * dt
    const beat = Math.floor(t / beatSec)
    const prog = (t % beatSec) / beatSec
    if (skipBeats(beat)) {
      // no grid delivered: index and progress frozen
      stepBeatMotion(m, 0, 0, 1, dt, bpm)
    } else {
      stepBeatMotion(m, beat, prog, weightOf(beat), dt, bpm)
    }
    eased.push(m.eased)
    linear.push(m.linear)
  }
  return { m, eased, linear }
}

describe('snapGlide / beatSwell', () => {
  it('snapGlide runs 0 -> 1, front-loaded, and clamps', () => {
    expect(snapGlide(0)).toBe(0)
    expect(snapGlide(1)).toBe(1)
    expect(snapGlide(0.5)).toBeGreaterThan(0.85)
    expect(snapGlide(-3)).toBe(0)
    expect(snapGlide(9)).toBe(1)
    expect(beatRelax(0)).toBe(1)
    expect(beatRelax(1)).toBe(0)
  })

  it('beatSwell starts and ends at 0 (no one-frame pop) and peaks near 1 shortly after the beat line', () => {
    expect(beatSwell(0)).toBe(0)
    expect(beatSwell(1)).toBe(0)
    let peak = 0
    let at = 0
    for (let p = 0; p <= 1; p += 0.01) {
      const v = beatSwell(p)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      if (v > peak) {
        peak = v
        at = p
      }
    }
    expect(peak).toBeGreaterThan(0.95)
    expect(at).toBeLessThan(0.25)
    // The attack is a ramp of several frames at 60 fps / 120 BPM (30 frames a beat), never one step.
    expect(beatSwell(1 / 30)).toBeLessThan(0.5)
  })
})

describe('stepBeatMotion', () => {
  it('is monotone, and continuous across the beat line (no jump bigger than one frame of travel)', () => {
    const { eased, linear } = drive(120, 12)
    let maxStep = 0
    for (let i = 1; i < eased.length; i++) {
      expect(eased[i]).toBeGreaterThanOrEqual(eased[i - 1])
      expect(linear[i]).toBeGreaterThanOrEqual(linear[i - 1])
      maxStep = Math.max(maxStep, eased[i] - eased[i - 1])
    }
    // one beat of unit weight is 30 frames; the eased step is front-loaded (cubic: 3 * 1/30 at the line) but is
    // never a whole-beat jump
    expect(maxStep).toBeLessThan(0.2)
  })

  it('advances by exactly the sum of the beat weights it has passed', () => {
    const weights = [1.6, 0.7, 1.0, 0.7]
    const { m } = drive(120, 8, 60, (b) => weights[b % 4])
    // 8 s at 120 BPM = 16 beats = 4 bars of total weight 4 each; the last beat is nearly through
    expect(m.acc).toBeGreaterThan(14.5)
    expect(m.acc).toBeLessThan(16.5)
  })

  it('hits hardest right after the beat line and settles before the next (on the beat by construction)', () => {
    const { eased } = drive(120, 4)
    // frames 30..59 are beat 1: >85% of its travel is done half-way through, ~all at the end
    const start = eased[30]
    const mid = eased[45]
    const end = eased[59]
    expect((mid - start) / (end - start)).toBeGreaterThan(0.85)
  })

  it('a re-lock that moves the progress backwards never moves the position backwards', () => {
    const m = beatMotion()
    stepBeatMotion(m, 5, 0.9, 1, 1 / 60, 120)
    const before = m.eased
    stepBeatMotion(m, 5, 0.1, 1, 1 / 60, 120)
    expect(m.eased).toBeGreaterThanOrEqual(before)
  })

  it('a jump in beatIndex (a seek) counts as at most two beats, never a burst', () => {
    const m = beatMotion()
    stepBeatMotion(m, 0, 0.2, 1, 1 / 60, 120)
    const before = m.acc
    stepBeatMotion(m, 400, 0.2, 1, 1 / 60, 120)
    expect(m.acc - before).toBeLessThanOrEqual(2)
  })

  it('free-runs at the tempo when no grid is delivered, and re-syncs when it returns', () => {
    // beats 4..11 undelivered (4 s at 120 BPM)
    const { eased } = drive(120, 8, 60, () => 1, (b) => b >= 4 && b < 12)
    let frozen = 0
    for (let i = 240; i < 400; i++) if (eased[i] === eased[i - 1]) frozen++
    expect(frozen).toBeLessThan(10) // it keeps moving through the gap after the 2-beat grace
    for (let i = 1; i < eased.length; i++) expect(eased[i]).toBeGreaterThanOrEqual(eased[i - 1])
  })

  it('ignores a garbage weight, progress and dt', () => {
    const m = beatMotion()
    stepBeatMotion(m, 1, Number.NaN, Number.NaN, Number.NaN, Number.NaN)
    stepBeatMotion(m, 2, 0.5, -4, -1, -10)
    expect(Number.isFinite(m.eased)).toBe(true)
    expect(Number.isFinite(m.linear)).toBe(true)
  })
})

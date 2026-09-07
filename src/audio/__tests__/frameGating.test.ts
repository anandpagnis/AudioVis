import { describe, expect, it } from 'vitest'
import { evictExpired, fftAdvanced, makeWaveProbe } from '../frameGating'
import { PercussionDetector, createEmptyPercussion } from '../PercussionDetector'

/**
 * Audit items 7 and 8 — the two frame-loop gates.
 *
 * Both bugs have the same shape: a statistic defined in FRAMES rather than in
 * seconds of audio, silently changing meaning when the render rate moves away
 * from 60 fps. The fixes shipped without tests, so these pin the specific
 * claims each one makes.
 */

interface Sample {
  t: number
  v: number
}

/** Fill a ring by pushing one sample per frame at `fps`, evicting as we go. */
function driveRing(fps: number, seconds: number, windowSec: number): Sample[] {
  const ring: Sample[] = []
  const dt = 1 / fps
  const frames = Math.round(seconds * fps)
  for (let i = 0; i < frames; i++) {
    const now = i * dt
    ring.push({ t: now, v: i })
    evictExpired(ring, now, windowSec)
  }
  return ring
}

describe('evictExpired — the flux ring holds a fixed WALL-CLOCK window (item 7)', () => {
  const WINDOW = 1.0

  it('spans the same duration at 30, 60 and 144 fps', () => {
    const spanOf = (fps: number) => {
      const ring = driveRing(fps, 5, WINDOW)
      return ring[ring.length - 1].t - ring[0].t
    }
    // Each ring spans one window minus a single frame interval (the oldest
    // still-live sample sits just inside the boundary), so they agree to within
    // the coarsest frame period involved — 1/30 s.
    const s30 = spanOf(30)
    const s60 = spanOf(60)
    const s144 = spanOf(144)
    for (const s of [s30, s60, s144]) {
      expect(s).toBeGreaterThan(WINDOW - 1 / 30 - 1e-9)
      expect(s).toBeLessThanOrEqual(WINDOW)
    }
    expect(Math.abs(s30 - s144)).toBeLessThanOrEqual(1 / 30 + 1e-9)
    expect(Math.abs(s60 - s144)).toBeLessThanOrEqual(1 / 60 + 1e-9)
  })

  it('holds a DIFFERENT number of samples at each rate — proving it is time-based, not count-based', () => {
    // This is the actual regression. The old fixed 60-count ring held 60
    // samples at every rate, which is why its real window was 2 s at 30 fps
    // and 0.4 s at 144 fps.
    expect(driveRing(30, 5, WINDOW).length).toBe(30)
    expect(driveRing(60, 5, WINDOW).length).toBe(60)
    expect(driveRing(144, 5, WINDOW).length).toBe(144)
  })

  it('holds EXACTLY 60 samples at a steady 60 fps — no behaviour change at the reference rate', () => {
    // The eviction epsilon exists for this: the onset threshold was calibrated
    // against a fixed 60-sample ring, and 60 fps must stay bit-identical to it.
    expect(driveRing(60, 5, WINDOW).length).toBe(60)
  })

  it('never leaves an entry older than the window', () => {
    for (const fps of [24, 30, 60, 90, 144, 240]) {
      const ring = driveRing(fps, 4, WINDOW)
      const now = ring[ring.length - 1].t
      expect(now - ring[0].t).toBeLessThan(WINDOW)
    }
  })

  it('drains a ring completely once time jumps past the window', () => {
    const ring: Sample[] = [
      { t: 0, v: 1 },
      { t: 0.5, v: 2 },
    ]
    evictExpired(ring, 100, 1.0)
    expect(ring.length).toBe(0)
  })

  it('is a no-op on an empty ring', () => {
    const ring: Sample[] = []
    expect(() => evictExpired(ring, 5, 1)).not.toThrow()
    expect(ring.length).toBe(0)
  })
})

describe('PercussionDetector inherits the same time-based window (item 7)', () => {
  /**
   * The detector's history is private, so the observable claim is behavioural:
   * an identical pattern of hits in WALL-CLOCK time must produce the same
   * detections regardless of the frame rate it was sampled at. Under the old
   * fixed-count ring the threshold statistics covered a different span of
   * music at each rate, so the same music detected differently.
   *
   * Counted from `startAfter` seconds, which skips the warm-up. `MIN_SAMPLES`
   * is deliberately still a SAMPLE count (20 samples is a statistical bar for
   * mean/σ, not a musical duration), so the detector goes live after 20/fps
   * seconds — 0.67 s at 30 fps, 0.14 s at 144 fps. That residual frame-rate
   * dependence is confined to the warm-up; the steady-state window this test
   * measures is pure wall-clock.
   */
  function countKicks(fps: number, startAfter = 1.5): number {
    const det = new PercussionDetector()
    const state = createEmptyPercussion()
    const dt = 1 / fps
    const frames = Math.round(4 * fps)
    let hits = 0
    for (let i = 0; i < frames; i++) {
      const now = i * dt
      // A kick every 0.5 s, defined on the clock rather than on a frame count.
      const phase = now % 0.5
      const kick = phase < dt ? 1 : 0.02
      det.update(state, { kickFlux: kick, snareFlux: 0, hihatFlux: 0 }, now, dt, false)
      if (state.kick.trigger && now >= startAfter) hits++
    }
    return hits
  }

  it('detects the same number of kicks at 30, 60 and 144 fps once warmed up', () => {
    const at60 = countKicks(60)
    // 4 s of kicks every 0.5 s, counted from 1.5 s: beats at 1.5..3.5 = 5.
    expect(at60).toBe(5)
    expect(countKicks(30)).toBe(at60)
    expect(countKicks(144)).toBe(at60)
  })
})

describe('fftAdvanced — duplicate frames are skipped (item 8)', () => {
  const waveOf = (fill: number, len = 8) => {
    const w = new Float32Array(len)
    for (let i = 0; i < len; i++) w[i] = fill + i * 0.01
    return w
  }

  it('reports advanced on the very first frame', () => {
    // Probes start NaN, and NaN !== anything, so a fresh source's first frame
    // is never mistaken for a duplicate of the previous source's last.
    expect(fftAdvanced(waveOf(0.5), makeWaveProbe())).toBe(true)
  })

  it('reports NOT advanced when the identical buffer is re-read', () => {
    const probe = makeWaveProbe()
    const wave = waveOf(0.5)
    expect(fftAdvanced(wave, probe)).toBe(true)
    expect(fftAdvanced(wave, probe)).toBe(false)
    expect(fftAdvanced(wave, probe)).toBe(false)
  })

  it('reports advanced again as soon as the buffer changes', () => {
    const probe = makeWaveProbe()
    fftAdvanced(waveOf(0.5), probe)
    expect(fftAdvanced(waveOf(0.5), probe)).toBe(false)
    expect(fftAdvanced(waveOf(0.7), probe)).toBe(true)
  })

  it('skips exactly the duplicates when the render loop outruns the audio callback', () => {
    // The real scenario: a 180 fps render loop over an analyser advancing at
    // 60 Hz. Every third frame carries new data; the other two are re-reads.
    const probe = makeWaveProbe()
    let advancedCount = 0
    for (let frame = 0; frame < 90; frame++) {
      const block = Math.floor(frame / 3) // a new FFT block every 3rd frame
      if (fftAdvanced(waveOf(block * 0.1), probe)) advancedCount++
    }
    // 90 render frames / 3 = 30 genuinely new blocks.
    expect(advancedCount).toBe(30)
  })

  it('detects a change at any one of the three probe positions', () => {
    for (const idx of [0, 4, 7]) {
      const probe = makeWaveProbe()
      const a = waveOf(0.5)
      fftAdvanced(a, probe)
      const b = waveOf(0.5)
      b[idx] += 0.25
      expect(fftAdvanced(b, probe)).toBe(true)
    }
  })
})

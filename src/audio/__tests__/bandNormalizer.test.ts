import { describe, expect, it } from 'vitest'
import {
  BandNormalizer,
  DIGITAL_SILENCE,
  PEAK_GUARD,
  ProgramLevel,
  type SilenceConfig,
} from '../bandNormalizer'

/**
 * The guard on the whole point of this module: **visual reactivity must not
 * depend on how loud the audio is being played.**
 *
 * This regressed silently for a long time — an absolute 0.02 floor in the old
 * normalizer sat above the entire operating range of every band from `mid`
 * upward, so `raw / peak` degenerated into a linear function of input level.
 * Nothing caught it because the app still rendered; it just rendered a
 * different show at a different volume. Measured on real music, a 16x gain
 * change moved the `high` band's median output by 15.6x.
 *
 * A synthetic envelope is used rather than real audio because the property is
 * a property of the normalizer, not of any particular track, and the test has
 * to run without shipping audio files. The real-music verification lives in the
 * derivation recorded in AudioEngine's threshold comments.
 */

const CFG: SilenceConfig = { enterRatio: 0.004, exitRatio: 0.01 }
const DT = 1 / 60

/**
 * A music-like envelope: a slow section-scale swell, a bar-level pulse, and a
 * quiet breakdown. Deliberately spans a wide dynamic range, since a normalizer
 * that only works on steady material is not much use.
 */
function envelope(i: number): number {
  const t = i * DT
  const section = 0.5 + 0.5 * Math.sin(t * 0.15)
  const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 2))
  const breakdown = t > 20 && t < 26 ? 0.08 : 1
  return 1e-3 * section * pulse * breakdown
}

/** Run the normalizer over the envelope scaled by `gain`, returning outputs. */
function runAtGain(gain: number, frames = 3000): number[] {
  const n = new BandNormalizer()
  const out: number[] = []
  for (let i = 0; i < frames; i++) out.push(n.update(envelope(i) * gain, DT, false, 1, 1))
  return out
}

describe('BandNormalizer scale invariance', () => {
  it('produces identical output across a 100x input gain change', () => {
    const lo = runAtGain(0.1)
    const mid = runAtGain(1)
    const hi = runAtGain(10)
    for (let i = 0; i < mid.length; i++) {
      expect(lo[i]).toBeCloseTo(mid[i], 9)
      expect(hi[i]).toBeCloseTo(mid[i], 9)
    }
  })

  it('holds invariance at extreme gains, where an absolute floor would bind', () => {
    // The old floor was 0.02 against band values whose real median is ~1e-4.
    // Any constant that can bind on real signal reintroduces the bug, so the
    // spread here is deliberately far wider than a volume slider's range.
    const ref = runAtGain(1, 1200)
    for (const gain of [1e-3, 1e-2, 1, 1e2, 1e3]) {
      const got = runAtGain(gain, 1200)
      for (let i = 0; i < ref.length; i++) {
        expect(got[i], `gain ${gain} frame ${i}`).toBeCloseTo(ref[i], 8)
      }
    }
  })

  it('still tracks musical dynamics — it is not a compressor', () => {
    // Invariance to the volume knob must NOT mean flattening the music. The
    // breakdown at t=20..26s has to read as visibly quieter than the peak.
    const out = runAtGain(1)
    const atBreakdown = out[Math.floor(23 / DT)]
    const peak = Math.max(...out)
    expect(atBreakdown).toBeLessThan(peak * 0.5)
  })

  it('converges immediately rather than over a minute', () => {
    // The old seed (peak 0.15, decaying 4%/s) needed >60s to reach a band whose
    // real magnitude is ~1e-4, so every source change began under-reactive.
    const out = runAtGain(1, 120) // 2 seconds
    expect(Math.max(...out)).toBeGreaterThan(0.5)
  })
})

/**
 * The gap the first version of this file missed.
 *
 * Every test above holds the gain CONSTANT for the whole run, and the old
 * running-max reference passed all of them — it was genuinely scale-invariant
 * in steady state. What it was not was symmetric in its RESPONSE to a gain
 * change: `max()` lifted the reference instantly on the way up (the show
 * flashed to full brightness) and could only decay at 4%/s on the way down
 * (the show went dim and sluggish for ~30 s). A volume knob is nothing but
 * transients, so the property that actually matters is this one.
 */
describe('BandNormalizer response to a LIVE gain change', () => {
  /**
   * STATIONARY source — a steady beat pulse with no section-scale drift.
   *
   * Deliberately not the `envelope()` used above: that carries a 42 s swell, so
   * windows before and after a step differ for reasons that have nothing to do
   * with gain, and the measurement stops being about the reference at all. Here
   * the only thing that changes is the gain, so any deviation IS the reference
   * adapting.
   */
  const steady = (i: number) => 1e-3 * (0.6 + 0.4 * Math.abs(Math.sin(i * DT * Math.PI * 2)))

  /** Steady input, then a step change in gain partway through. */
  function runWithStep(stepAt: number, gainAfter: number, frames = 3000): number[] {
    const n = new BandNormalizer()
    const out: number[] = []
    for (let i = 0; i < frames; i++) {
      const g = i < stepAt ? 1 : gainAfter
      out.push(n.update(steady(i) * g, DT, false, 1, 1))
    }
    return out
  }

  /** The same stationary source at a constant gain, for comparison. */
  function runSteady(gain: number, frames = 3000): number[] {
    const n = new BandNormalizer()
    const out: number[] = []
    for (let i = 0; i < frames; i++) out.push(n.update(steady(i) * gain, DT, false, 1, 1))
    return out
  }

  const STEP = 900 // 15 s in

  it('does not flash to full brightness when the volume goes up', () => {
    const out = runWithStep(STEP, 8)
    const before = out.slice(STEP - 300, STEP)
    const justAfter = out.slice(STEP, STEP + 30) // first half-second
    const peakBefore = Math.max(...before)
    // The old reference put this at 1.0 within a frame or two.
    expect(Math.max(...justAfter)).toBeLessThan(peakBefore * 1.35)
  })

  it('recovers within a comparable time in both directions', () => {
    // Asymmetry was the actual defect: instant one way, a 17 s half-life the
    // other. Both directions must now settle, and neither may take drastically
    // longer than the other.
    //
    // Measured as time-to-settle rather than as a ratio of the two: the
    // volume-up case now deviates so little that it is already inside the
    // tolerance band on the first frame, and dividing by a zero recovery time
    // says nothing. Bounding each direction separately is the real property.
    const meanOf = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
    const settle = (gainAfter: number) => {
      const out = runWithStep(STEP, gainAfter)
      const target = meanOf(out.slice(STEP - 300, STEP))
      for (let i = STEP; i < out.length - 120; i += 30) {
        const w = meanOf(out.slice(i, i + 120))
        if (Math.abs(w - target) < target * 0.15) return i - STEP
      }
      return Infinity
    }
    for (const [label, gain] of [
      ['up', 8],
      ['down', 1 / 8],
    ] as const) {
      // Under ~15 s. The old reference could not settle a volume-down inside
      // the whole 50 s run.
      expect(settle(gain), `${label} settle frames`).toBeLessThan(900)
    }
  })

  it('never overshoots — a volume increase cannot flash the show', () => {
    // The worse half of the reported symptom, and the one that IS fully
    // fixable: turning the volume up used to lift the reference within a single
    // frame, pinning `raw / peak` at 1.0 and blowing the picture out.
    const meanOf = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
    for (const gain of [2, 8, 64]) {
      const out = runWithStep(STEP, gain)
      const target = meanOf(out.slice(STEP - 300, STEP))
      const during = out.slice(STEP, STEP + 240) // first 4 s
      expect(Math.max(...during) / target, `gain x${gain}`).toBeLessThan(1.35)
    }
  })

  it('dips on a volume decrease, then recovers — the deliberate half', () => {
    // Documents a limit rather than a guarantee. A sustained 8x level drop is
    // INDISTINGUISHABLE from a deep breakdown: both are "the music got much
    // quieter and stayed that way". Adapting fast enough to hide a volume-down
    // would equally erase every breakdown, which is the dynamic range the
    // visuals exist to show. So the reference stays slow, and the seconds right
    // after turning the volume down read as a breakdown.
    //
    // What IS guaranteed is that it recovers on a bounded, musical timescale.
    // REF_RATE 0.15 is a ~4.6 s half-life, so an 8x drop needs ln(8)/0.15 ~ 14 s
    // to unwind; the old 0.04 needed ~52 s, which is longer than most sections
    // and is why it read as permanent.
    const meanOf = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
    const out = runWithStep(STEP, 1 / 8, 3600)
    const target = meanOf(out.slice(STEP - 300, STEP))
    // Deep at first — this is the part that reads as a breakdown...
    expect(meanOf(out.slice(STEP, STEP + 60)) / target).toBeLessThan(0.5)
    // ...and fully back within ~20s, which is what makes it survivable. The
    // measured trajectory is 0.10 at the step, 0.44 at +10s, 1.00 by +15s.
    expect(meanOf(out.slice(STEP + 1080, STEP + 1380)) / target).toBeGreaterThan(0.9)
  })

  it('settles to the same steady state the gain was never changed from', () => {
    const stepped = runWithStep(STEP, 8)
    const never = runSteady(8)
    const tail = (a: number[]) => a.slice(2400, 3000)
    const meanOf = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
    expect(meanOf(tail(stepped))).toBeCloseTo(meanOf(tail(never)), 2)
  })
})

describe('BandNormalizer silence handling', () => {
  it('holds its reference through silence instead of amplifying noise', () => {
    const n = new BandNormalizer()
    for (let i = 0; i < 600; i++) n.update(1e-3, DT, false, 1, 1)
    const peakBefore = n.state.peak

    // Noise floor, correctly flagged silent: the reference must NOT walk down
    // onto it, or the visuals fire at full strength on room tone.
    for (let i = 0; i < 3000; i++) n.update(1e-7, DT, true, 1, 1)
    expect(n.state.peak).toBeCloseTo(peakBefore, 12)
    expect(n.state.value).toBeLessThan(0.01)
  })

  it('would have run away if the reference decayed through silence', () => {
    // Demonstrates why the `silent` argument exists: same input, decaying.
    const n = new BandNormalizer()
    for (let i = 0; i < 600; i++) n.update(1e-3, DT, false, 1, 1)
    for (let i = 0; i < 20000; i++) n.update(1e-7, DT, false, 1, 1)
    expect(n.state.value).toBeGreaterThan(0.5)
  })

  it('never divides by zero on a dead channel', () => {
    const n = new BandNormalizer()
    for (let i = 0; i < 100; i++) {
      const v = n.update(0, DT, false, 1, 1)
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(n.state.peak).toBeGreaterThanOrEqual(0)
  })

  it('resets cleanly for a new source', () => {
    const n = new BandNormalizer()
    for (let i = 0; i < 600; i++) n.update(1, DT, false, 1, 1)
    n.reset()
    expect(n.state.seeded).toBe(false)
    // A far quieter second track must not inherit the first's reference.
    for (let i = 0; i < 120; i++) n.update(1e-5, DT, false, 1, 1)
    expect(n.state.value).toBeGreaterThan(0.5)
  })
})

describe('ProgramLevel silence gate', () => {
  const feed = (p: ProgramLevel, level: number, frames: number) => {
    let last = false
    for (let i = 0; i < frames; i++) last = p.update(level, DT, CFG)
    return last
  }

  it('judges silence identically at any volume', () => {
    // The old gate was `rmsRaw > 0.008`, so a track played quietly read as
    // silent and the whole show gated off.
    for (const gain of [0.01, 0.25, 1, 4, 100]) {
      const p = new ProgramLevel()
      expect(feed(p, 0.1 * gain, 600), `gain ${gain} playing`).toBe(true)
      expect(feed(p, 0.1 * gain * 1e-4, 600), `gain ${gain} silent`).toBe(false)
    }
  })

  it('treats a quiet passage as signal, not as silence', () => {
    const p = new ProgramLevel()
    feed(p, 0.2, 600)
    // 5% of program level — quiet, but unmistakably still playing.
    expect(feed(p, 0.01, 30)).toBe(true)
  })

  it('applies hysteresis so the gate cannot chatter', () => {
    const p = new ProgramLevel()
    feed(p, 1, 600)
    // Between enterRatio (0.004) and exitRatio (0.01): whichever state we are
    // already in must persist, because f.silence hard-stops every director.
    expect(feed(p, 0.007, 5)).toBe(true) // was playing → stays playing
    feed(p, 1e-6, 60) // force silent
    expect(feed(p, 0.007, 5)).toBe(false) // was silent → stays silent
  })

  it('reports true digital silence with no program level to compare against', () => {
    const p = new ProgramLevel()
    expect(p.update(DIGITAL_SILENCE / 2, DT, CFG)).toBe(false)
  })
})

describe('constants', () => {
  it('keeps the guard far below any real band magnitude', () => {
    // Measured band medians run 9.8e-5 (air) to 9.9e-3 (bass). A guard anywhere
    // near those is the original bug.
    expect(PEAK_GUARD).toBeLessThan(1e-5 / 1000)
  })
})

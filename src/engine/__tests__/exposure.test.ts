import { beforeEach, describe, expect, it } from 'vitest'
import {
  BLOWN_TOLERANCE,
  GAIN_MAX,
  GAIN_MIN,
  HOT_MEAN,
  MUDDY_ENERGY_GATE,
  MUDDY_MEAN,
  STEP_DOWN,
  STEP_UP,
  TARGET_HIGHLIGHT,
  analyseLuma,
  applyExposureSample,
  exposure,
  exposureError,
  recoverExposure,
  resetExposure,
  stepExposure,
  type LumaSample,
} from '../exposure'

/**
 * The exposure servo.
 *
 * The properties worth defending are safety properties: it must pull down on a
 * wash, must not lift a deliberate darkness, and must converge rather than
 * hunt. A servo that is merely "roughly right on average" is the one that
 * flattens a drop.
 */

const s = (mean: number, p85: number, blownShare = 0, p99 = p85): LumaSample => ({
  mean,
  // p50 has no dedicated fault threshold yet (see LumaSample's own doc), so
  // exposureError never reads it — approximating it from mean here keeps
  // every existing call site's intent (`s(mean, p85, ...)`) unchanged.
  p50: mean,
  p85,
  p99,
  blownShare,
})

/** Build RGBA bytes for `n` pixels at a uniform grey level 0..1. */
const flat = (level: number, n = 384) => {
  const v = Math.round(level * 255)
  const px = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    px[i * 4] = v
    px[i * 4 + 1] = v
    px[i * 4 + 2] = v
    px[i * 4 + 3] = 255
  }
  return px
}

describe('analyseLuma', () => {
  it('reads a flat frame back at the level it was given', () => {
    const a = analyseLuma(flat(0.5))
    expect(a.mean).toBeCloseTo(0.5, 2)
    expect(a.p85).toBeCloseTo(0.5, 2)
    expect(a.blownShare).toBe(0)
  })

  it('counts blown pixels as a share, not a count', () => {
    // Half the frame at full white.
    const px = flat(0)
    for (let i = 0; i < 192; i++) {
      px[i * 4] = 255
      px[i * 4 + 1] = 255
      px[i * 4 + 2] = 255
    }
    expect(analyseLuma(px).blownShare).toBeCloseTo(0.5, 2)
  })

  it('reports a highlight shoulder, not the peak', () => {
    // 90% black, 10% white: the p85 must sit in the dark majority, because the
    // 85th percentile is below the top 10%. A servo reading the PEAK here would
    // think the frame was blown when it is mostly black.
    const px = flat(0)
    for (let i = 346; i < 384; i++) {
      px[i * 4] = 255
      px[i * 4 + 1] = 255
      px[i * 4 + 2] = 255
    }
    const a = analyseLuma(px)
    expect(a.p85).toBeLessThan(0.5)
    expect(a.blownShare).toBeCloseTo(0.1, 1)
  })

  it('survives an empty buffer', () => {
    expect(analyseLuma(new Uint8ClampedArray(0))).toEqual({ mean: 0, p50: 0, p85: 0, p99: 0, blownShare: 0 })
  })

  it('reuses the caller-supplied object rather than allocating', () => {
    const into: LumaSample = { mean: 0, p50: 0, p85: 0, p99: 0, blownShare: 0 }
    expect(analyseLuma(flat(0.3), into)).toBe(into)
  })
})

describe('exposureError', () => {
  it('pulls down hard on a wash', () => {
    // The projector guard. This is the one regime that must react decisively.
    const err = exposureError(s(0.7, 0.95, 0.5), 0.8)
    expect(err).toBeLessThan(-0.5)
  })

  it('eases down when the mean is merely hot', () => {
    // Just past the threshold — "merely" hot. A frame at twice HOT_MEAN is not
    // merely anything, and corrects about as hard as a wash, which is correct
    // behaviour but does not test what this test is named for.
    const err = exposureError(s(HOT_MEAN * 1.2, 0.4, 0, 0.85), 0.8)
    expect(err).toBeLessThan(0)
    // ...but nothing like as hard as a wash.
    expect(err).toBeGreaterThan(exposureError(s(0.7, 0.95, 0.5), 0.8))
  })

  it('lifts a muddy frame only while the music is loud', () => {
    // p99 low: the subject itself has gone dim, which is what muddy means.
    const muddy = s(MUDDY_MEAN * 0.3, 0.05, 0, 0.2)
    expect(exposureError(muddy, MUDDY_ENERGY_GATE + 0.2)).toBeGreaterThan(0)
    // The load-bearing gate: a dim screen over quiet audio is the product
    // working. Without this the servo lifts every breakdown and destroys the
    // dynamic range it exists to protect.
    expect(exposureError(muddy, MUDDY_ENERGY_GATE - 0.2)).toBe(0)
  })

  it('never lifts an intentionally dark frame, however loud the music', () => {
    // Distinct from the energy gate: nothing is drawn here, so lifting would
    // amplify noise and nothing else.
    expect(exposureError(s(0.005, 0.01, 0, 0.02), 1)).toBe(0)
  })

  it('leaves sparse-but-punchy content alone', () => {
    // Low mean with healthy highlights is what most of this roster looks like —
    // a bright subject on true black. It is not muddy and it is not hot, and a
    // servo with no dead zone here would hunt between the two.
    // p85 is deliberately near-zero here — 85% of a sparse frame IS black — while
    // p99 is high because the subject is bright. Reading p85 as the highlight
    // signal is exactly the bug measured on real frames; see TARGET_HIGHLIGHT.
    expect(exposureError(s(0.19, 0.01, 0.005, 0.85), 0.9)).toBe(0)
  })

  it('tolerates a hot core but not a wash', () => {
    // Plasma's core is authored to sit near full brightness and is small.
    const core = s(0.19, 0.3, BLOWN_TOLERANCE * 0.5, 0.9)
    expect(exposureError(core, 0.8)).toBe(0)
    const wash = s(0.19, 0.3, Math.min(1, BLOWN_TOLERANCE * 2), 0.9)
    expect(exposureError(wash, 0.8)).toBeLessThan(0)
  })

  it('does not lift sparse line-art, whatever p85 says', () => {
    // The regression this whole constant exists for. Values are from a real
    // measured frame: a wireframe scene reads mean 0.03, p85 0.01 (85% of the
    // frame is genuinely black) and p99 0.85 (the lines are bright). Reading
    // p85 as "highlights" concluded the frame was muddy and drove the gain to
    // its ceiling on a picture that was working as authored.
    // mean below MUDDY_MEAN so the ONLY thing preventing a lift is p99.
    expect(exposureError(s(MUDDY_MEAN * 0.5, 0.01, 0, 0.85), 0.9)).toBe(0)
  })

  it('still lifts when the subject itself has gone dim', () => {
    // Same sparsity, but now nothing is bright. This IS muddy.
    expect(exposureError(s(MUDDY_MEAN * 0.5, 0.01, 0, 0.25), 0.9)).toBeGreaterThan(0)
  })

  it('treats TARGET_HIGHLIGHT as the boundary between those two cases', () => {
    // Pins the constant itself rather than two hand-picked points either side
    // of it, so retuning it cannot silently invalidate the two tests above.
    const dim = s(MUDDY_MEAN * 0.5, 0.01, 0, TARGET_HIGHLIGHT - 0.05)
    const bright = s(MUDDY_MEAN * 0.5, 0.01, 0, TARGET_HIGHLIGHT + 0.05)
    expect(exposureError(dim, 0.9)).toBeGreaterThan(0)
    expect(exposureError(bright, 0.9)).toBe(0)
  })

  it('is bounded, so one bad frame cannot swing the gain', () => {
    expect(exposureError(s(1, 1, 1), 1)).toBeGreaterThanOrEqual(-1)
    expect(exposureError(s(1e-4, 1e-4, 0, 0.6), 1)).toBeLessThanOrEqual(1)
  })

  it('returns no correction on non-finite input', () => {
    expect(exposureError(s(NaN, 0.5), 1)).toBe(0)
    expect(exposureError(s(0.5, 0.5, 0, NaN), 1)).toBe(0)
  })
})

describe('normal content is left completely alone', () => {
  // The regression behind "it applied a permanent darkness effect". The servo
  // used to aim at this project's documented art-direction budget (mean 0.078)
  // and treat 1.4x of that as hot — but the composited frame measures 0.09-0.19
  // in normal operation, so it was above the threshold nearly always and pulled
  // the whole show down by about half, permanently.
  //
  // A budget is a goal for scene authors; a servo threshold has to describe a
  // FAULT.
  //
  // These are the real measured distribution, re-taken AFTER the missing
  // linear-to-sRGB conversion in GradePass was fixed — the first set was
  // measured through that broken pipeline and was ~5x too dark, which made the
  // thresholds derived from it wrong in the same direction all over again.
  // 89 samples: min 0.07, median 0.19, max 0.459.
  const MEASURED_NORMAL = [0.07, 0.109, 0.188, 0.211, 0.282, 0.368, 0.459]

  it('reports zero error across the whole measured normal range', () => {
    for (const mean of MEASURED_NORMAL) {
      expect(exposureError(s(mean, 0.3, 0, 0.84), 0.9), `mean ${mean}`).toBe(0)
    }
  })

  it('holds the gain at unity over a long run of normal frames', () => {
    resetExposure()
    for (const mean of MEASURED_NORMAL) {
      for (let i = 0; i < 40; i++) applyExposureSample(s(mean, 0.3, 0, 0.84), 0.9)
    }
    expect(exposure.gain).toBe(1)
  })
})

describe('recovery — the servo is a loop, not a ratchet', () => {
  beforeEach(resetExposure)

  it('returns to unity once a fault clears', () => {
    // Without a restoring force a single hot passage darkened the rest of the
    // session, and the effect accumulated across a set. Zero error means
    // "nothing is wrong", which is exactly when the gain should be going home.
    for (let i = 0; i < 60; i++) applyExposureSample(s(0.7, 0.95, 0.5), 0.9)
    expect(exposure.gain).toBeLessThan(0.8)
    for (let i = 0; i < 400; i++) applyExposureSample(s(0.19, 0.3, 0, 0.84), 0.9)
    expect(exposure.gain).toBeCloseTo(1, 3)
  })

  it('recovers more slowly than it corrects, so a real fault still wins', () => {
    // Alternating fault and clear frames must not average out to no protection.
    for (let i = 0; i < 200; i++) {
      applyExposureSample(s(0.8, 0.97, 0.6), 0.9)
      applyExposureSample(s(0.19, 0.3, 0, 0.84), 0.9)
    }
    expect(exposure.gain).toBeLessThan(0.9)
  })

  it('eases home rather than snapping', () => {
    // A snap would undo a correction the instant the fault left the sampled
    // window, which on a flickering source reads as the exposure flickering.
    const from = 0.5
    const next = recoverExposure(from)
    expect(next).toBeGreaterThan(from)
    expect(next).toBeLessThan(0.55)
  })

  it('settles exactly on unity instead of creeping past it', () => {
    expect(recoverExposure(1)).toBe(1)
    expect(recoverExposure(0.9999)).toBe(1)
  })
})

describe('stepExposure', () => {
  it('stays inside the gain limits under sustained pressure', () => {
    let down = 1
    let up = 1
    for (let i = 0; i < 500; i++) {
      down = stepExposure(down, -1)
      up = stepExposure(up, 1)
    }
    expect(down).toBe(GAIN_MIN)
    expect(up).toBe(GAIN_MAX)
  })

  it('moves slowly enough that a musical event passes through untouched', () => {
    // One sample must barely move the gain. At ~5.5 samples/sec this is what
    // makes the loop slower than any kick, build or drop.
    expect(stepExposure(1, -1)).toBeGreaterThan(0.9)
  })

  it('holds still on zero error', () => {
    expect(stepExposure(0.8, 0)).toBe(0.8)
  })

  it('recovers from a poisoned gain', () => {
    expect(stepExposure(NaN, -0.5)).toBe(1)
  })
})

describe('the closed loop', () => {
  beforeEach(resetExposure)

  it('converges on a hot frame and then stops', () => {
    // Feed a fixed hot frame and watch the gain settle rather than run away.
    for (let i = 0; i < 200; i++) applyExposureSample(s(HOT_MEAN * 2, 0.4, 0, 0.85), 0.8)
    const settled = exposure.gain
    expect(settled).toBeLessThan(1)
    expect(settled).toBeGreaterThanOrEqual(GAIN_MIN)
    // Another hundred samples of the same input must not keep pushing.
    for (let i = 0; i < 100; i++) applyExposureSample(s(HOT_MEAN * 2, 0.4, 0, 0.85), 0.8)
    expect(exposure.gain).toBeCloseTo(settled, 6)
  })

  it('does not drift while the picture is already on target', () => {
    // The anti-hunting property. A servo that wanders on good input is more
    // visible than one that is slightly off.
    for (let i = 0; i < 300; i++) applyExposureSample(s(0.12, 0.3, 0, 0.85), 0.9)
    expect(exposure.gain).toBe(1)
  })

  it('publishes what it measured, for calibration', () => {
    expect(exposure.sampled).toBe(false)
    applyExposureSample(s(0.2, 0.6, 0.03), 0.5)
    expect(exposure.sampled).toBe(true)
    expect(exposure.mean).toBeCloseTo(0.2, 6)
    expect(exposure.p85).toBeCloseTo(0.6, 6)
    expect(exposure.blownShare).toBeCloseTo(0.03, 6)
  })

  it('resets to unity', () => {
    applyExposureSample(s(0.9, 0.95, 0.8), 1)
    expect(exposure.gain).not.toBe(1)
    resetExposure()
    expect(exposure.gain).toBe(1)
    expect(exposure.sampled).toBe(false)
  })
})

describe('analyseLuma — p50 (F162/F164 audit: percentile metering)', () => {
  it('reads the median back on a flat frame, matching mean and p85', () => {
    const a = analyseLuma(flat(0.4))
    expect(a.p50).toBeCloseTo(0.4, 2)
  })

  it('sits in the dark majority on a mostly-black frame, same as p85', () => {
    // 90% black, 10% white — the median must be in the black majority.
    const px = flat(0)
    for (let i = 346; i < 384; i++) {
      px[i * 4] = 255
      px[i * 4 + 1] = 255
      px[i * 4 + 2] = 255
    }
    expect(analyseLuma(px).p50).toBe(0)
  })

  it('is more robust than mean to a handful of blown outliers', () => {
    // Ten percent of the frame blown to white; the rest a dim, uniform 0.1.
    // The mean is pulled noticeably upward by the outliers; the median is not
    // moved at all, because a majority of pixels are still exactly 0.1. This is
    // the concrete case the whole statistic exists for — see LumaSample's doc.
    const px = flat(0.1)
    for (let i = 0; i < 38; i++) {
      px[i * 4] = 255
      px[i * 4 + 1] = 255
      px[i * 4 + 2] = 255
    }
    const a = analyseLuma(px)
    expect(a.p50).toBeCloseTo(0.1, 2)
    expect(a.mean).toBeGreaterThan(a.p50 + 0.05)
  })

  it('is monotone with p85 and p99 on the same frame', () => {
    const a = analyseLuma(flat(0.3))
    // On a uniform frame all three coincide; the ordering is still checkable
    // and must never invert.
    expect(a.p50).toBeLessThanOrEqual(a.p85)
    expect(a.p85).toBeLessThanOrEqual(a.p99)
  })
})

describe('stepExposure — asymmetric rate (F162/F164 audit)', () => {
  it('darkens strictly faster than it brightens for the same error magnitude', () => {
    const darkened = stepExposure(1, -0.5)
    const brightened = stepExposure(1, 0.5)
    // Distance travelled in log space from 1.
    const downDistance = Math.abs(Math.log(darkened))
    const upDistance = Math.abs(Math.log(brightened))
    expect(downDistance).toBeGreaterThan(upDistance)
  })

  it('STEP_UP is exactly half of STEP_DOWN, and STEP_DOWN is unchanged from the pre-split constant', () => {
    // STEP_DOWN must equal the OLD single STEP value (0.08) so every already-
    // validated darkening/hot/wash dynamic is untouched by this change.
    expect(STEP_DOWN).toBe(0.08)
    expect(STEP_UP).toBeCloseTo(STEP_DOWN / 2, 10)
  })

  it('still holds still on zero error and still recovers a poisoned gain', () => {
    // The two existing invariants must survive the sign-aware branch.
    expect(stepExposure(0.8, 0)).toBe(0.8)
    expect(stepExposure(NaN, -0.5)).toBe(1)
    expect(stepExposure(NaN, 0.5)).toBe(1)
  })

  it('both directions still reach their clamp under sustained pressure', () => {
    // Time-to-CLAMP is not a valid proxy for rate here and deliberately not
    // asserted either way: GAIN_MIN (0.35) sits roughly 1.05 in log-distance
    // from 1, GAIN_MAX (1.25) only about 0.22 — the range itself is far more
    // asymmetric than the 2x rate difference, so the slower-but-shorter climb
    // to GAIN_MAX actually clamps in FEWER steps than the faster-but-longer
    // descent to GAIN_MIN. That is a fact about the gain limits, not a
    // regression in the rate split — see the direct rate comparison above and
    // the fixed-step-count comparison below for what actually pins the rate.
    let down = 1
    let up = 1
    for (let i = 0; i < 500; i++) {
      down = stepExposure(down, -1)
      up = stepExposure(up, 1)
    }
    expect(down).toBeCloseTo(GAIN_MIN, 5)
    expect(up).toBeCloseTo(GAIN_MAX, 5)
  })

  it('travels less log-distance than a hot correction after the same number of samples, unclamped', () => {
    // The direct, unconfounded version of the rate comparison: same sample
    // count, same |err|, gain never reaches a clamp (few enough steps that
    // even the faster direction stays interior), so only STEP_DOWN vs
    // STEP_UP can explain the difference.
    let down = 1
    let up = 1
    for (let i = 0; i < 4; i++) {
      down = stepExposure(down, -1)
      up = stepExposure(up, 1)
    }
    expect(down).toBeGreaterThan(GAIN_MIN)
    expect(up).toBeLessThan(GAIN_MAX)
    const downDistance = Math.abs(Math.log(down))
    const upDistance = Math.abs(Math.log(up))
    expect(upDistance).toBeLessThan(downDistance)
  })
})

describe('the closed loop — asymmetric rate does not break convergence or recovery', () => {
  beforeEach(resetExposure)

  it('a muddy frame still lifts the gain and still settles', () => {
    const muddy = (): LumaSample => ({
      mean: MUDDY_MEAN * 0.3,
      p50: MUDDY_MEAN * 0.3,
      p85: 0.05,
      p99: 0.2,
      blownShare: 0,
    })
    for (let i = 0; i < 400; i++) applyExposureSample(muddy(), MUDDY_ENERGY_GATE + 0.3)
    const settled = exposure.gain
    expect(settled).toBeGreaterThan(1)
    expect(settled).toBeLessThanOrEqual(GAIN_MAX)
    for (let i = 0; i < 200; i++) applyExposureSample(muddy(), MUDDY_ENERGY_GATE + 0.3)
    expect(exposure.gain).toBeCloseTo(settled, 6)
  })

  it('after equally many samples, a hot fault has moved the gain further (in log space) than an equally-extreme muddy one', () => {
    // Fixed sample count, both wells short of their clamp, so only the rate
    // split can explain the gap — same reasoning as the unclamped
    // stepExposure comparison above, run through the actual closed loop.
    const N = 5
    for (let i = 0; i < N; i++) applyExposureSample(s(HOT_MEAN * 2, 0.4, 0, 0.85), 0.8)
    const hotGain = exposure.gain
    expect(hotGain).toBeGreaterThan(GAIN_MIN)

    resetExposure()
    const muddy = (): LumaSample => ({
      mean: MUDDY_MEAN * 0.1,
      p50: MUDDY_MEAN * 0.1,
      p85: 0.02,
      p99: 0.1,
      blownShare: 0,
    })
    for (let i = 0; i < N; i++) applyExposureSample(muddy(), MUDDY_ENERGY_GATE + 0.3)
    const muddyGain = exposure.gain
    expect(muddyGain).toBeLessThan(GAIN_MAX)

    const hotDistance = Math.abs(Math.log(hotGain))
    const muddyDistance = Math.abs(Math.log(muddyGain))
    expect(muddyDistance).toBeLessThan(hotDistance)
  })
})

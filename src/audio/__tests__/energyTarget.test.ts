import { describe, expect, it } from 'vitest'
import {
  ENERGY_LOUD_W,
  ENERGY_WEIGHT_SUM,
  LOUDNESS_MIX,
  broadbandEnergyTerm,
  energyTargetOf,
} from '../energyTarget'

/**
 * Audit item 12, Part B — `f.loudness` reaching the energy blend at all.
 *
 * BS.1770 K-weighted loudness shipped, was put on the contract and on both
 * panels, and then fed into NOTHING: the blend still ran on `f.rms`. The naive
 * swap was tried and rejected (it moved the dominant mood on 3/8 reference
 * tracks), so this is a deliberately partial wiring — a 25% share — and these
 * tests pin the two properties that make a partial wiring safe: it is bounded
 * by a quarter of the rejected perturbation, and it leaves the overall energy
 * scale untouched so no existing threshold silently shifts underneath it.
 */

/**
 * Corpus percentiles measured in the F171 A/B and recorded in `energyTarget.ts`
 * — the low tail is where the naive swap broke, so it is the worst case.
 */
const RMS_P10 = 0.06
const LOUDNESS_P10 = 0.29

describe('broadbandEnergyTerm', () => {
  it('is mostly f.rms — the loudness share is a minority', () => {
    expect(LOUDNESS_MIX).toBeLessThan(0.5)
    const t = broadbandEnergyTerm(0, 1)
    expect(t).toBeCloseTo(LOUDNESS_MIX, 12)
  })

  it('is the identity when both inputs agree', () => {
    expect(broadbandEnergyTerm(0.42, 0.42)).toBeCloseTo(0.42, 12)
  })

  it('reduces to pure f.rms at mix 0 and pure f.loudness at mix 1', () => {
    // The endpoints the CALIB_ENERGY_TERM A/B still reaches.
    const rms = 0.2
    const loud = 0.8
    const manual = (m: number) => rms * (1 - m) + loud * m
    expect(manual(0)).toBe(rms)
    expect(manual(1)).toBe(loud)
    expect(broadbandEnergyTerm(rms, loud)).toBeCloseTo(manual(LOUDNESS_MIX), 12)
  })

  it('actually moves the value — loudness is no longer wired to nothing', () => {
    // The entire point of item 12B. If this passes trivially, the feature is
    // still inert.
    expect(broadbandEnergyTerm(RMS_P10, LOUDNESS_P10)).toBeGreaterThan(RMS_P10)
  })
})

describe('the blend is a quarter of the perturbation that was rejected', () => {
  /** Broadband term's share of the normalised blend: 0.3 / 1.3 = 0.2308. */
  const share = ENERGY_LOUD_W / ENERGY_WEIGHT_SUM

  it('has the documented weight share', () => {
    expect(share).toBeCloseTo(0.230769, 6)
  })

  it("lifts the p10 energy target by ~0.0133, a quarter of the full swap's ~0.0531", () => {
    const bands = { bass: 0.3, mid: 0.3, high: 0.3 }
    const base = energyTargetOf(bands.bass, bands.mid, bands.high, RMS_P10)
    const blended = energyTargetOf(
      bands.bass,
      bands.mid,
      bands.high,
      broadbandEnergyTerm(RMS_P10, LOUDNESS_P10),
    )
    const fullSwap = energyTargetOf(bands.bass, bands.mid, bands.high, LOUDNESS_P10)

    const swapShift = fullSwap - base
    const blendShift = blended - base

    // (0.29 - 0.06) * 0.2308 = 0.0531 — the shift measured to move 3/8 tracks.
    expect(swapShift).toBeCloseTo(0.0531, 4)
    // A quarter of it.
    expect(blendShift).toBeCloseTo(0.0133, 4)
    expect(blendShift).toBeCloseTo(swapShift * LOUDNESS_MIX, 12)
  })
})

describe('the energy scale is unmoved, so no existing threshold shifts under it', () => {
  it('leaves the weight sum exactly as it was', () => {
    // The blend is a linear interpolation INSIDE the broadband term, not a new
    // fifth band, so the normalising denominator is untouched. A fifth term
    // would have rescaled every E_* mood edge silently.
    expect(ENERGY_WEIGHT_SUM).toBeCloseTo(1.3, 12)
  })

  it('still maps all-zero to 0 and all-one to 1', () => {
    expect(energyTargetOf(0, 0, 0, broadbandEnergyTerm(0, 0))).toBe(0)
    expect(energyTargetOf(1, 1, 1, broadbandEnergyTerm(1, 1))).toBeCloseTo(1, 12)
  })

  it('is unchanged from the pre-item-12B value whenever loudness tracks rms', () => {
    // On material where the two agree the blend is a no-op, so the change can
    // only ever act where K-weighting genuinely disagrees with plain RMS.
    for (const v of [0.1, 0.35, 0.7, 0.95]) {
      expect(energyTargetOf(0.4, 0.5, 0.6, broadbandEnergyTerm(v, v))).toBeCloseTo(
        energyTargetOf(0.4, 0.5, 0.6, v),
        12,
      )
    }
  })
})

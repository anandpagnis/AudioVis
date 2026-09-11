/**
 * The per-frame "energy" blend — shared by `AudioEngine.update()` (live) and
 * `scripts/calibrate/features.ts` (offline) so the two can never drift.
 *
 * This used to be a copy-pasted expression in both files. It is the input to
 * `f.energy` → `MoodEstimator` `m.level` → every `E_*` mood edge and
 * `detectStructure`'s drop/build ratio, so a silent divergence between the live
 * value and the value the constants were calibrated against is a whole class of
 * bug. One function, one set of weights.
 *
 * `loud` is the broadband loudness term. Both call sites now pass
 * {@link broadbandEnergyTerm}(`f.rms`, `f.loudness`) — a mostly-`f.rms` blend
 * with a minority share of the K-weighted value. See that function for why it
 * is a blend rather than the swap F171 originally intended.
 */

/** Band weights. `LOUD` is the broadband term's weight — see {@link broadbandEnergyTerm}. */
export const ENERGY_BASS_W = 0.5
export const ENERGY_MID_W = 0.3
export const ENERGY_HIGH_W = 0.2
export const ENERGY_LOUD_W = 0.3
export const ENERGY_WEIGHT_SUM =
  ENERGY_BASS_W + ENERGY_MID_W + ENERGY_HIGH_W + ENERGY_LOUD_W

/**
 * Asymmetric smoothing rates for the step toward the target — fast attack, slow
 * release, so a transient lifts `energy` promptly but a gap doesn't collapse it.
 * Tuned against `f.rms`'s ~20 ms envelope dynamics.
 */
export const ENERGY_ATTACK = 14
export const ENERGY_RELEASE = 4

/**
 * Share of the broadband energy term taken from `f.loudness` (ITU-R BS.1770
 * K-weighted) rather than `f.rms`. Audit item 12, Part B.
 *
 * ## Why a blend and not the swap
 *
 * `f.loudness` is the perceptually-correct broadband signal and it was being
 * computed, contract-exposed, panelled — and read by NOTHING. F171 tried the
 * obvious fix, passing it here in place of `f.rms`, and an 8-track A/B in the
 * calibrate harness measured the dominant mood moving on 3 of 8 reference
 * tracks. The cause is distributional, not a threshold being slightly off:
 * `f.loudness` through a BandNormalizer has essentially no low tail (corpus
 * p10 ≈ 0.29 against `f.rms`'s ≈ 0.06), so quiet passages stop reading as
 * low-energy and a genuinely ambient track climbs into `mellow`.
 *
 * ## Deriving the weight
 *
 * Take the measured p10 pair as the worst case, since the low tail is where
 * the swap broke. Substituting `f.loudness` wholesale lifts the broadband term
 * at p10 by `0.29 - 0.06 = 0.23`. The broadband term's share of the normalised
 * blend is `ENERGY_LOUD_W / ENERGY_WEIGHT_SUM = 0.3 / 1.3 = 0.2308`, so the
 * full swap lifts the p10 energy target by
 *
 *     0.23 * 0.2308 = 0.0531
 *
 * — and that 0.0531 is the perturbation measured to move 3/8 tracks. At the
 * mix below the same worst case lifts it by
 *
 *     0.0531 * 0.25 = 0.0133
 *
 * i.e. exactly a quarter of the shift that was shown to break things, or ~1.3
 * points of full scale on the quietest tenth of frames. Above p10 the two
 * distributions converge, so this is an upper bound, not a typical frame.
 *
 * ## What this is NOT
 *
 * This is a partial, deliberately conservative wiring, not the fix the audit's
 * own remedy column asks for. The real remedy is a distribution-matching remap
 * of `f.loudness` into this blend plus a full re-derivation of every `E_*` and
 * `detectStructure` constant against a real corpus — necessary because
 * K-weighting *reorders* which frames are hot, which no monotone constant
 * nudge can undo. That remains future work; this only gets loudness perception
 * into the blend at a magnitude small enough not to need the re-derivation
 * first. `CALIB_ENERGY_TERM=loudness` still runs the full-swap A/B.
 */
export const LOUDNESS_MIX = 0.25

/**
 * The broadband energy term: `f.rms` with a {@link LOUDNESS_MIX} share of
 * `f.loudness` blended in.
 *
 * A linear interpolation, so the total broadband weight stays exactly
 * `ENERGY_LOUD_W` and the overall energy scale — and therefore every threshold
 * derived against it — is unmoved. Passing `loudness === rms` is the identity.
 */
export function broadbandEnergyTerm(rms: number, loudness: number): number {
  return rms * (1 - LOUDNESS_MIX) + loudness * LOUDNESS_MIX
}

/** Instantaneous energy target from the four band terms, normalised to 0..1. */
export function energyTargetOf(
  bass: number,
  mid: number,
  high: number,
  loud: number,
): number {
  return (
    (bass * ENERGY_BASS_W +
      mid * ENERGY_MID_W +
      high * ENERGY_HIGH_W +
      loud * ENERGY_LOUD_W) /
    ENERGY_WEIGHT_SUM
  )
}

/** One asymmetric-smoothing step of `f.energy` toward `target`. */
export function stepEnergy(prev: number, target: number, delta: number): number {
  return (
    prev +
    (target - prev) *
      Math.min(1, delta * (target > prev ? ENERGY_ATTACK : ENERGY_RELEASE))
  )
}

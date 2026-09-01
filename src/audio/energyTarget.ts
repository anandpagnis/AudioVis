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
 * `loud` is the broadband loudness term. Today both call sites pass `f.rms`.
 * F171 intended to pass `f.loudness` (ITU-R BS.1770 K-weighted) instead — the
 * perceptually-correct choice — but an 8-track A/B showed the naive swap moves
 * the dominant mood on 3/8 reference tracks: `f.loudness` through a
 * BandNormalizer has essentially no low tail (corpus p10 ≈ 0.29 vs `f.rms`
 * ≈ 0.06), so quiet passages stop reading as low-energy and a genuinely ambient
 * track flips to `mellow` / locks the mood hysteresis onto `silence`. The swap
 * needs a distribution-matching remap of `f.loudness` into this blend plus a
 * full 1500-track re-derivation of every `E_*` / `detectStructure` constant —
 * not just a threshold nudge, because K-weighting *reorders* which frames are
 * hot. `CALIB_ENERGY_TERM=loudness` runs that A/B in the harness.
 */

/** Band weights. `LOUD` is the broadband term's weight (`f.rms` today; see above). */
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

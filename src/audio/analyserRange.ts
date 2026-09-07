/**
 * The dB window every `AnalyserNode` in this codebase is configured with.
 *
 * ## What these properties actually control (audit item 5)
 *
 * `minDecibels`/`maxDecibels` are the dB window that
 * `AnalyserNode.getByteFrequencyData()` maps onto 0..255. Per the Web Audio
 * spec they affect ONLY the byte accessors: `getFloatFrequencyData()` writes
 * un-normalized dBFS and ignores both properties entirely.
 *
 * That distinction matters, because the audit filed this as "hot masters
 * saturate the FFT readout, pinning raw/peak at 1.0". For the three float-path
 * analysers in `AudioEngine` that diagnosis is wrong — they only ever call the
 * float accessors, so no clamp was ever applied to their data, and
 * `loudnessInvariance.test.ts` records the empirical check (an oscillator at
 * +18 dBFS through an `OfflineAudioContext` analyser read the SAME float bin
 * value with `maxDecibels` at -30, -10, 0, and un-set).
 *
 * It is real, however, for the one byte-path analyser: `landing/tunnelAudio`
 * is this repo's only `getByteFrequencyData()` caller.
 *
 * ## The arithmetic
 *
 * The spec's mapping, with `b = 255 / (max - min)`:
 *
 *     byte(dB) = round(b * (dB - min)), clamped to 0..255
 *
 * The defaults are `minDecibels = -100`, `maxDecibels = -30`. A -30 dBFS
 * ceiling sits far below where mastered music lives, so ordinary programme
 * material pins at 255:
 *
 *     defaults  (-100..-30, 70 dB span), bin at -14 dBFS:
 *         (-14 - -100) / 70 = 86 / 70 = 1.229  -> clamped to 255  (SATURATED)
 *     this range (-90..0, 90 dB span), same bin:
 *         (-14 - -90)  / 90 = 76 / 90 = 0.844  -> byte 215        (headroom)
 *
 * -14 dBFS is not a hypothetical there: `tunnelAudio` puts a
 * `DynamicsCompressor` (threshold -14 dB, ratio 8) directly in front of its
 * analyser, so its input is held near that level by construction. Its `band()`
 * helper then divides the bin sum by 255, so a saturated low band read exactly
 * 1.0 on essentially every frame and its `peakBass` auto-gain reference sat at
 * 1.0 with it — the "pinning raw/peak at 1.0" the audit described.
 *
 * ## Why these two values
 *
 * `maxDecibels = 0` rather than -6: 0 dBFS is the top of the digital scale, so
 * no real bin can exceed it and nothing downstream can clip against the
 * ceiling. `minDecibels = -90` sits just inside 16-bit dynamic range (-96
 * dBFS) — low enough to cover real programme material, high enough to keep
 * dither and the FFT noise floor out of the bottom of the byte range. The pair
 * also makes the window a round 90 dB.
 *
 * Applied at the float-path analysers as well. It is a genuine no-op for them
 * today, and is set only so that a future byte read is correct by default
 * rather than silently saturated.
 */

/** Bottom of the byte-mapping window, dBFS. */
export const ANALYSER_MIN_DB = -90
/** Top of the byte-mapping window, dBFS. */
export const ANALYSER_MAX_DB = 0

/**
 * Apply the shared dB window to a freshly created analyser.
 *
 * Every `createAnalyser()` site in this codebase calls this, so the window can
 * never drift between the capture path, the file path, the taps and the
 * landing tunnel.
 */
export function applyAnalyserRange(analyser: AnalyserNode): void {
  analyser.minDecibels = ANALYSER_MIN_DB
  analyser.maxDecibels = ANALYSER_MAX_DB
}

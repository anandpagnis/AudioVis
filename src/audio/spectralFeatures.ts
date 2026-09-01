/** Per-frame spectral analysis output: the legacy bands plus texture cues. */
export interface SpectralBandsResult {
  sub: number
  bass: number
  mid: number
  /** Presence / upper-mid, ~2–5 kHz. */
  presence: number
  /** Brilliance, ~5–9 kHz. Non-overlapping with `presence` since F167 (was
   * 2–9 kHz, i.e. `presence` was a strict subset — audit item 10). */
  high: number
  vocal: number
  /** High-frequency "air" content above `high` (~9-16 kHz) — shimmer, cymbal wash, breath. */
  air: number
  /**
   * "Sparkle" — mean linear magnitude from 16 kHz to Nyquist, above where `air`
   * stops. Non-overlapping with `air` by construction. High on an air-heavy
   * master, ~floor on a dull or lossy-encoded one.
   */
  sparkle: number
  /**
   * 0..~1+ — spectral centroid (mean frequency) as a fraction of 9 kHz.
   * Accumulated over the FULL spectrum, so an air-heavy master reads brighter
   * than one that rolls off early; can exceed 1 for very bright material (the
   * consumer clamps). Still normalized to a fixed 9 kHz reference, so it is
   * sample-rate-invariant.
   */
  centroidRaw: number
  bassFlux: number
  /** 0..1 — tonal/harmonic (low) vs. noisy/distorted (high) spectral texture. */
  spectralFlatness: number
  /** 0..1 — normalized frequency below which 85% of [1, highEnd) energy sits. */
  spectralRolloff: number

  /**
   * Half-wave-rectified flux confined to each drum's characteristic band, so a
   * kick, a snare, and a hat can be detected as INDEPENDENT events rather than
   * all collapsing into one broadband onset. Consumed by PercussionDetector.
   */
  kickFlux: number
  snareFlux: number
  hihatFlux: number
}

/** Upper edge of the "air" band; also the lower edge of "sparkle". */
const AIR_HZ = 16000

/** Drum-band edges (Hz). Deliberately narrow — overlap blurs the three apart. */
const KICK_LO = 20
const KICK_HI = 120
const SNARE_LO = 150
const SNARE_HI = 400
const HIHAT_LO = 6000
const HIHAT_HI = 12000

/**
 * Reused across calls so the per-frame analysis path allocates nothing (the
 * engine's documented invariant). The caller must copy out anything it needs to
 * retain — AudioEngine does exactly that, straight into `features`.
 */
const result: SpectralBandsResult = {
  sub: 0,
  bass: 0,
  mid: 0,
  presence: 0,
  high: 0,
  vocal: 0,
  air: 0,
  sparkle: 0,
  centroidRaw: 0,
  bassFlux: 0,
  spectralFlatness: 0,
  spectralRolloff: 0,
  kickFlux: 0,
  snareFlux: 0,
  hihatFlux: 0,
}

/**
 * Pure per-frame spectral analysis: bands, centroid, flux, and the texture
 * cues (flatness/rolloff/air/sparkle). Extracted from AudioEngine.update() so it
 * can be unit-tested against synthetic spectra without a real AudioContext.
 *
 * Reproduces the original inline loop's math for `sub/bass/mid/presence/vocal`,
 * the three drum-flux bands, `bassFlux`, `spectralFlatness` and
 * `spectralRolloff` — those stay BYTE-IDENTICAL and a golden-value test locks
 * them. Two bands deliberately changed: `centroidRaw` now accumulates over the
 * whole spectrum instead of stopping at 9 kHz (F154), and `high` was narrowed
 * from 2–9 kHz to 5–9 kHz so it no longer contains `presence` (F167, audit
 * item 10) — the golden test asserts the new `high` value.
 *
 * `prevMag` is mutated in place — it carries flux state frame-to-frame and is
 * owned by the caller (same buffer AudioEngine already allocates once).
 *
 * The returned object is a REUSED module-level scratch value, not a fresh
 * allocation — copy anything you need to keep beyond the current frame.
 */
export function computeSpectralBands(
  freqDb: Float32Array,
  prevMag: Float32Array,
  binHz: number,
): SpectralBandsResult {
  const n = freqDb.length
  const bassEnd = Math.min(n, Math.ceil(160 / binHz))
  const midEnd = Math.min(n, Math.ceil(2000 / binHz))
  const presenceEnd = Math.min(n, Math.ceil(5000 / binHz))
  const highEnd = Math.min(n, Math.ceil(9000 / binHz))
  const subEnd = Math.min(n, Math.ceil(80 / binHz))
  const vocalStart = Math.min(n, Math.ceil(250 / binHz))
  const airEnd = Math.min(n, Math.ceil(AIR_HZ / binHz))
  const kickLo = Math.min(n, Math.floor(KICK_LO / binHz))
  const kickHi = Math.min(n, Math.ceil(KICK_HI / binHz))
  const snareLo = Math.min(n, Math.floor(SNARE_LO / binHz))
  const snareHi = Math.min(n, Math.ceil(SNARE_HI / binHz))
  const hihatLo = Math.min(n, Math.floor(HIHAT_LO / binHz))
  const hihatHi = Math.min(n, Math.ceil(HIHAT_HI / binHz))

  let bass = 0
  let mid = 0
  let sub = 0
  let presence = 0
  let high = 0
  let vocal = 0
  let bandW = 0 // energy sum over [1, highEnd) — flatness + rolloff reference
  let bassFlux = 0
  let sumLogMag = 0
  let kickFlux = 0
  let snareFlux = 0
  let hihatFlux = 0
  // Centroid accumulates over the FULL spectrum (all three loops below), so
  // content above 9 kHz pulls the mean up. Normalized to `highEnd` (a fixed
  // 9 kHz reference) to stay sample-rate-invariant.
  let centW = 0
  let centWF = 0

  for (let i = 1; i < highEnd; i++) {
    const mag = Math.pow(10, freqDb[i] / 20)
    if (i < bassEnd) bass += mag
    else if (i < midEnd) mid += mag
    // `high` is [presenceEnd, highEnd) = 5–9 kHz — the "brilliance" band, NOT
    // overlapping `presence` (2–5 kHz). Before F167 it ran [midEnd, highEnd) so
    // its lower 43 % of bins duplicated `presence` and `f.high` / `f.presence`
    // were ~1.0 correlated by construction (audit item 10).
    else if (i >= presenceEnd) high += mag
    if (i < subEnd) sub += mag
    if (i >= vocalStart && i < presenceEnd) vocal += mag
    if (i >= midEnd && i < presenceEnd) presence += mag
    bandW += mag
    centW += mag
    centWF += mag * i
    sumLogMag += Math.log(mag + 1e-6)
    // Half-wave-rectified, bass-weighted — see AudioEngine for the rationale;
    // unchanged from the original inline loop.
    const diff = mag - prevMag[i]
    if (diff > 0) {
      if (i < midEnd) bassFlux += diff * (i < bassEnd ? 2.5 : 1)
      if (i >= kickLo && i < kickHi) kickFlux += diff
      if (i >= snareLo && i < snareHi) snareFlux += diff
      // The hat band (6–12 kHz) straddles highEnd, so its lower half is
      // accumulated here and its upper half in the air loop below.
      if (i >= hihatLo) hihatFlux += diff
    }
    prevMag[i] = mag
  }
  bass /= Math.max(1, bassEnd - 1)
  mid /= Math.max(1, midEnd - bassEnd)
  sub /= Math.max(1, subEnd - 1)
  presence /= Math.max(1, presenceEnd - midEnd)
  high /= Math.max(1, highEnd - presenceEnd) // F167: 5–9 kHz, was 2–9 kHz
  vocal /= Math.max(1, presenceEnd - vocalStart)

  // Flatness: geometric mean / arithmetic mean of magnitude — ~1 for a
  // white-noise-like spectrum, ~0 for a single dominant tone. Kept on the
  // [1, highEnd) range: extending it to the (near-dead) top octave would sink
  // the geometric mean and collapse the cue for tonal material.
  const nBins = Math.max(1, highEnd - 1)
  const meanMag = bandW / nBins
  const spectralFlatness = meanMag > 1e-9 ? Math.min(1, Math.exp(sumLogMag / nBins) / meanMag) : 0

  // Rolloff: the bin below which 85% of [1, highEnd) energy sits, normalized
  // 0..1 — a brightness cue that isn't skewed by one hot bin the way centroid
  // can be. Kept referenced to `highEnd` (not Nyquist): its one consumer reads
  // it as a 2–9 kHz harshness cue, and a Nyquist reference would spend most of
  // the 0..1 range on the octave where a musical rolloff point never sits.
  let spectralRolloff = 0
  if (bandW > 1e-9 && highEnd > 1) {
    const target = bandW * 0.85
    let acc = 0
    let rolloffBin = highEnd - 1
    for (let i = 1; i < highEnd; i++) {
      acc += Math.pow(10, freqDb[i] / 20)
      if (acc >= target) {
        rolloffBin = i
        break
      }
    }
    spectralRolloff = rolloffBin / highEnd
  }

  // Air: shimmer/cymbal-wash content the six bands above never see. A
  // separate pass over bins past highEnd, so it can't leak into `high`. This
  // pass also carries prevMag forward for its bins — without that, the hat
  // band's upper half would diff against a permanently-zero baseline and
  // report a huge flux every single frame.
  let air = 0
  for (let i = highEnd; i < airEnd; i++) {
    const mag = Math.pow(10, freqDb[i] / 20)
    air += mag
    centW += mag
    centWF += mag * i
    const diff = mag - prevMag[i]
    if (diff > 0 && i < hihatHi) hihatFlux += diff
    prevMag[i] = mag
  }
  air /= Math.max(1, airEnd - highEnd)

  // Sparkle: 16 kHz → Nyquist, above where `air` stops. Same prevMag hygiene
  // as the air loop even though nothing reads flux up here yet. Also feeds the
  // full-spectrum centroid accumulators.
  let sparkle = 0
  for (let i = airEnd; i < n; i++) {
    const mag = Math.pow(10, freqDb[i] / 20)
    sparkle += mag
    centW += mag
    centWF += mag * i
    prevMag[i] = mag
  }
  sparkle /= Math.max(1, n - airEnd)

  const centroidRaw = centW > 1e-6 ? centWF / centW / highEnd : 0

  result.sub = sub
  result.bass = bass
  result.mid = mid
  result.presence = presence
  result.high = high
  result.vocal = vocal
  result.air = air
  result.sparkle = sparkle
  result.centroidRaw = centroidRaw
  result.bassFlux = bassFlux
  result.spectralFlatness = spectralFlatness
  result.spectralRolloff = spectralRolloff
  result.kickFlux = kickFlux
  result.snareFlux = snareFlux
  result.hihatFlux = hihatFlux
  return result
}

/**
 * dB → linear magnitude, clamped to the `f.spectrum` 0..1-per-bin contract.
 * Writes `out.length` bins (`FFT_SIZE / 2`, spanning 0..Nyquist). A real
 * `AnalyserNode` does NOT clamp `getFloatFrequencyData` to `maxDecibels`, so a
 * hot master genuinely pushes bins past 1.0 linear (~1.6) — hence the clamp.
 * Pure and allocation-free (writes into the caller's buffer) so it is testable.
 */
export function writeLinearSpectrum(freqDb: Float32Array, out: Float32Array): void {
  for (let i = 0; i < out.length; i++) {
    const mag = Math.pow(10, freqDb[i] / 20)
    out[i] = mag < 1 ? mag : 1
  }
}

/** Reused scratch — the low-band path allocates nothing, matching `result`. */
const lowResult = { sub: 0, bass: 0 }

/**
 * Sub/bass mean linear magnitude from a dedicated high-resolution analyser
 * (AudioEngine's second AnalyserNode, fftSize 8192 ≈ 5.4 Hz/bin at 44.1 kHz).
 *
 * Mirrors the sub/bass accumulation in {@link computeSpectralBands} EXACTLY —
 * bins `[1, ceil(cut / binHz))`, skip DC, divide by `endBin - 1` — just on a
 * finer grid, so `f.sub` keeps the same contract and the same BandNormalizer
 * behaviour. Only `sub` is sourced from here in practice: `bass` includes kick
 * fundamentals that this window's ~186 ms span would smear, so it stays on the
 * 2048 grid. `bass` is returned anyway for symmetry / callers that want it.
 *
 * `lowFreqDb` is `getFloatFrequencyData` output (dB); `lowBinHz` MUST be
 * `nyquist / lowFreqDb.length` (do not hardcode — it is sample-rate dependent).
 */
export function computeLowBands(
  lowFreqDb: Float32Array,
  lowBinHz: number,
): { sub: number; bass: number } {
  const n = lowFreqDb.length
  const subEnd = Math.min(n, Math.ceil(80 / lowBinHz))
  const bassEnd = Math.min(n, Math.ceil(160 / lowBinHz))
  let sub = 0
  let bass = 0
  for (let i = 1; i < bassEnd; i++) {
    const mag = Math.pow(10, lowFreqDb[i] / 20)
    if (i < subEnd) sub += mag
    bass += mag
  }
  lowResult.sub = sub / Math.max(1, subEnd - 1)
  lowResult.bass = bass / Math.max(1, bassEnd - 1)
  return lowResult
}

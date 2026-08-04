/** Per-frame spectral analysis output: the legacy bands plus texture cues. */
export interface SpectralBandsResult {
  sub: number
  bass: number
  mid: number
  presence: number
  high: number
  vocal: number
  /** High-frequency "air" content above `high` (~9-16 kHz) — shimmer, cymbal wash, breath. */
  air: number
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

/** Upper edge of the "air" band. */
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
 * cues (flatness/rolloff/air). Extracted from AudioEngine.update() so it can
 * be unit-tested against synthetic spectra without a real AudioContext.
 *
 * Reproduces the original inline loop's math exactly for the six legacy
 * outputs (sub/bass/mid/presence/high/vocal/centroidRaw/bassFlux) — this is a
 * refactor, not a rebalance. `air` reads a separate bin range past `highEnd`
 * so it can never perturb the bands above it.
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
  let centW = 0
  let centWF = 0
  let bassFlux = 0
  let sumLogMag = 0
  let kickFlux = 0
  let snareFlux = 0
  let hihatFlux = 0

  for (let i = 1; i < highEnd; i++) {
    const mag = Math.pow(10, freqDb[i] / 20)
    if (i < bassEnd) bass += mag
    else if (i < midEnd) mid += mag
    else high += mag
    if (i < subEnd) sub += mag
    if (i >= vocalStart && i < presenceEnd) vocal += mag
    if (i >= midEnd && i < presenceEnd) presence += mag
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
  high /= Math.max(1, highEnd - midEnd)
  vocal /= Math.max(1, presenceEnd - vocalStart)
  const centroidRaw = centW > 1e-6 ? centWF / centW / highEnd : 0

  // Flatness: geometric mean / arithmetic mean of magnitude — ~1 for a
  // white-noise-like spectrum, ~0 for a single dominant tone.
  const nBins = Math.max(1, highEnd - 1)
  const meanMag = centW / nBins
  const spectralFlatness = meanMag > 1e-9 ? Math.min(1, Math.exp(sumLogMag / nBins) / meanMag) : 0

  // Rolloff: the bin below which 85% of [1, highEnd) energy sits, normalized
  // 0..1 — a brightness cue that isn't skewed by one hot bin the way centroid
  // can be. Needs the total (centW) first, so it's necessarily a second pass.
  let spectralRolloff = 0
  if (centW > 1e-9 && highEnd > 1) {
    const target = centW * 0.85
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
    const diff = mag - prevMag[i]
    if (diff > 0 && i < hihatHi) hihatFlux += diff
    prevMag[i] = mag
  }
  air /= Math.max(1, airEnd - highEnd)

  result.sub = sub
  result.bass = bass
  result.mid = mid
  result.presence = presence
  result.high = high
  result.vocal = vocal
  result.air = air
  result.centroidRaw = centroidRaw
  result.bassFlux = bassFlux
  result.spectralFlatness = spectralFlatness
  result.spectralRolloff = spectralRolloff
  result.kickFlux = kickFlux
  result.snareFlux = snareFlux
  result.hihatFlux = hihatFlux
  return result
}

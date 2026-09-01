import { describe, expect, it } from 'vitest'
import { computeLowBands, computeSpectralBands } from '../spectralFeatures'

const FFT_LEN = 1024 // FFT_SIZE / 2, matching AudioEngine
const SAMPLE_RATE = 44100
const BIN_HZ = SAMPLE_RATE / 2 / FFT_LEN // ~21.53 Hz/bin

function silentDb(len = FFT_LEN): Float32Array {
  return new Float32Array(len).fill(-100)
}

function freshPrevMag(): Float32Array {
  return new Float32Array(FFT_LEN)
}

describe('computeSpectralBands', () => {
  it('reports low spectral flatness for a single dominant tone', () => {
    const db = silentDb()
    db[50] = 0 // one loud bin amid near-silence
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.spectralFlatness).toBeLessThan(0.15)
  })

  it('reports high spectral flatness for a flat (white-noise-like) spectrum', () => {
    const db = new Float32Array(FFT_LEN).fill(-20)
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.spectralFlatness).toBeGreaterThan(0.6)
  })

  it('isolates bass from mid/high/air when energy is concentrated below 160 Hz', () => {
    const db = silentDb()
    const bassEnd = Math.ceil(160 / BIN_HZ)
    for (let i = 1; i < bassEnd; i++) db[i] = 0
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.bass).toBeGreaterThan(r.mid * 5)
    expect(r.high).toBeLessThan(0.01)
    expect(r.air).toBeLessThan(0.01)
  })

  it('keeps `air` and `high` independently controllable (energy above 9 kHz never reaches `high`)', () => {
    const db = silentDb()
    const highEnd = Math.ceil(9000 / BIN_HZ)
    const airEnd = Math.ceil(16000 / BIN_HZ)
    for (let i = highEnd; i < airEnd; i++) db[i] = 0 // loud only in the air range
    const r = computeSpectralBands(db, freshPrevMag(), BIN_HZ)
    expect(r.high).toBeLessThan(0.01)
    expect(r.air).toBeGreaterThan(0.5)
  })

  it('rolloff sits lower when energy concentrates in the bottom half of the band, higher for the top half', () => {
    const highEnd = Math.ceil(9000 / BIN_HZ)
    const mid = Math.floor(highEnd / 2)

    // NOTE: computeSpectralBands returns a REUSED object, so each result must
    // be read out before the next call rather than held as a reference.
    const lowHalf = silentDb()
    for (let i = 1; i < mid; i++) lowHalf[i] = 0
    const rolloffLow = computeSpectralBands(lowHalf, freshPrevMag(), BIN_HZ).spectralRolloff

    const highHalf = silentDb()
    for (let i = mid; i < highEnd; i++) highHalf[i] = 0
    const rolloffHigh = computeSpectralBands(highHalf, freshPrevMag(), BIN_HZ).spectralRolloff

    expect(rolloffLow).toBeLessThan(0.6)
    expect(rolloffHigh).toBeGreaterThan(rolloffLow)
  })

  it('separates kick/snare/hihat flux by band — energy in one must not leak into the others', () => {
    // Bin indices for the middle of each drum band (binHz ~= 21.5).
    const kickBin = Math.round(60 / BIN_HZ) // ~2.8k Hz below kick's 120Hz top
    const snareBin = Math.round(250 / BIN_HZ)
    const hihatBin = Math.round(9000 / BIN_HZ) // deliberately above highEnd

    for (const [name, bin] of [
      ['kick', kickBin],
      ['snare', snareBin],
      ['hihat', hihatBin],
    ] as const) {
      const prevMag = freshPrevMag()
      computeSpectralBands(silentDb(), prevMag, BIN_HZ) // establish baseline
      const loud = silentDb()
      loud[bin] = 0 // one loud bin in this drum's band
      const r = computeSpectralBands(loud, prevMag, BIN_HZ)
      const got = { kick: r.kickFlux, snare: r.snareFlux, hihat: r.hihatFlux }
      expect(got[name]).toBeGreaterThan(0)
      for (const other of ['kick', 'snare', 'hihat'] as const) {
        if (other !== name) expect(got[other]).toBeCloseTo(0, 6)
      }
    }
  })

  it('hihat flux above the 9kHz main-loop ceiling settles instead of spiking every frame', () => {
    // Regression guard: the air-band pass must carry prevMag forward for its
    // bins. If it does not, every frame diffs against zero and reports a
    // permanent false hi-hat.
    const prevMag = freshPrevMag()
    const steady = silentDb()
    steady[Math.round(10000 / BIN_HZ)] = 0 // constant tone above highEnd
    computeSpectralBands(steady, prevMag, BIN_HZ)
    const second = computeSpectralBands(steady, prevMag, BIN_HZ)
    expect(second.hihatFlux).toBeCloseTo(0, 6)
  })

  it('bassFlux is half-wave rectified: rises on an onset, drops to ~0 on decay', () => {
    const prevMag = freshPrevMag()
    const quiet = silentDb()
    const loud = silentDb()
    loud[5] = 0 // a bass bin (bassEnd ~= 8), well within the bass range

    computeSpectralBands(quiet, prevMag, BIN_HZ) // establish baseline in prevMag
    const rising = computeSpectralBands(loud, prevMag, BIN_HZ)
    expect(rising.bassFlux).toBeGreaterThan(0)

    const falling = computeSpectralBands(quiet, prevMag, BIN_HZ)
    expect(falling.bassFlux).toBeCloseTo(0, 6)
  })

  it('golden values: a single loud bin lands only in its band, at exactly 1/(binCount)', () => {
    // Exact arithmetic the C4 centroid/sparkle work must not perturb: one 0 dB
    // bin (magnitude 1) amid a -100 dB floor gives band = 1 / (endBin - startBin)
    // for the one band that owns it, and the noise-floor value (1e-5, averaged)
    // everywhere else.
    const BIN = BIN_HZ
    const bassEnd = Math.ceil(160 / BIN)
    const midEnd = Math.ceil(2000 / BIN)
    const presenceEnd = Math.ceil(5000 / BIN)
    const highEnd = Math.ceil(9000 / BIN)

    // Values carry a tiny +6·1e-5-style term from the -100 dB (1e-5) floor on
    // the other bins in the band, so compare at 4 digits, not machine epsilon.
    const bassCase = silentDb()
    bassCase[5] = 0
    const rb = computeSpectralBands(bassCase, freshPrevMag(), BIN)
    expect(rb.bass).toBeCloseTo(1 / (bassEnd - 1), 4)
    expect(rb.mid).toBeCloseTo(1e-5, 6)
    expect(rb.high).toBeCloseTo(1e-5, 6)

    const midCase = silentDb()
    midCase[70] = 0 // ~1.5 kHz
    const rm = computeSpectralBands(midCase, freshPrevMag(), BIN)
    expect(rm.mid).toBeCloseTo(1 / (midEnd - bassEnd), 4)
    expect(rm.bass).toBeCloseTo(1e-5, 6)

    const presCase = silentDb()
    presCase[160] = 0 // ~3.4 kHz, inside [midEnd, presenceEnd)
    const rp = computeSpectralBands(presCase, freshPrevMag(), BIN)
    expect(rp.presence).toBeCloseTo(1 / (presenceEnd - midEnd), 4)
    // F167: `high` is 5–9 kHz now, so a 3.4 kHz bin lands ONLY in `presence`,
    // not in `high` — the bands no longer overlap.
    expect(rp.high).toBeCloseTo(1e-5, 6)

    const highCase = silentDb()
    highCase[280] = 0 // ~6 kHz, inside [presenceEnd, highEnd)
    const rh = computeSpectralBands(highCase, freshPrevMag(), BIN)
    expect(rh.high).toBeCloseTo(1 / (highEnd - presenceEnd), 4)
    expect(rh.presence).toBeCloseTo(1e-5, 6)
  })

  it('centroid now responds to content above the old 9 kHz ceiling', () => {
    // Same low-frequency energy, but one spectrum also has strong 17 kHz
    // content. Pre-C4 both read an identical centroid (everything above 9 kHz
    // was invisible); now the air-heavy one reads brighter.
    const base = silentDb()
    base[40] = 0 // a ~860 Hz tone
    const dull = computeSpectralBands(base, freshPrevMag(), BIN_HZ).centroidRaw

    const airy = silentDb()
    airy[40] = 0
    for (let i = 760; i < 1024; i++) airy[i] = -6 // loud 16–22 kHz shelf
    const bright = computeSpectralBands(airy, freshPrevMag(), BIN_HZ).centroidRaw

    expect(bright).toBeGreaterThan(dull * 2)
  })

  it('sparkle isolates 16 kHz–Nyquist from air (9–16 kHz) and never leaks into high', () => {
    const BIN = BIN_HZ
    const airEnd = Math.ceil(16000 / BIN) // ~744

    const sparkleOnly = silentDb()
    for (let i = airEnd; i < 1024; i++) sparkleOnly[i] = 0
    const s = computeSpectralBands(sparkleOnly, freshPrevMag(), BIN)
    expect(s.sparkle).toBeGreaterThan(0.5)
    expect(s.air).toBeLessThan(0.01)
    expect(s.high).toBeLessThan(0.01)

    const airOnly = silentDb()
    const highEnd = Math.ceil(9000 / BIN)
    for (let i = highEnd; i < airEnd; i++) airOnly[i] = 0
    const a = computeSpectralBands(airOnly, freshPrevMag(), BIN)
    expect(a.air).toBeGreaterThan(0.5)
    expect(a.sparkle).toBeLessThan(0.01)
  })

  it('sparkle bins settle instead of spiking every frame (prevMag carried forward)', () => {
    // Regression guard mirroring the hi-hat one: the sparkle pass must write
    // prevMag for its bins, or a steady tone up there would look like constant
    // change to anything that later diffs against it.
    const prevMag = freshPrevMag()
    const steady = silentDb()
    steady[900] = 0 // constant ~19 kHz tone
    const first = computeSpectralBands(steady, prevMag, BIN_HZ)
    const second = computeSpectralBands(steady, prevMag, BIN_HZ)
    // prevMag[900] must equal this frame's magnitude (1.0), not 0.
    expect(prevMag[900]).toBeCloseTo(1, 6)
    expect(second.sparkle).toBeCloseTo(first.sparkle, 6)
  })
})

describe('computeLowBands', () => {
  // The dedicated low analyser is fftSize 8192 → 4096 bins spanning Nyquist.
  const LOW_LEN = 4096
  const LOW_BIN_HZ = 44100 / 2 / LOW_LEN // ~5.386 Hz/bin

  const lowSilent = () => new Float32Array(LOW_LEN).fill(-100)

  it('isolates sub (<80 Hz) from bass (<160 Hz) on the fine grid', () => {
    const subEnd = Math.ceil(80 / LOW_BIN_HZ) // ~15
    const db = lowSilent()
    for (let i = 1; i < subEnd; i++) db[i] = 0
    const r = computeLowBands(db, LOW_BIN_HZ)
    expect(r.sub).toBeGreaterThan(0.5)
    // bass spans [1,160Hz) which includes the sub bins, so it is non-zero but
    // diluted by the empty 80–160 Hz bins.
    expect(r.bass).toBeGreaterThan(0)
    expect(r.bass).toBeLessThan(r.sub)
  })

  it('skips DC and divides by the bin count, matching computeSpectralBands', () => {
    const db = lowSilent()
    db[0] = 0 // DC — must be ignored
    const r = computeLowBands(db, LOW_BIN_HZ)
    expect(r.sub).toBeLessThan(0.01)
    expect(r.bass).toBeLessThan(0.01)
  })

  it('returns a reused scratch object (no per-call allocation)', () => {
    const a = computeLowBands(lowSilent(), LOW_BIN_HZ)
    const b = computeLowBands(lowSilent(), LOW_BIN_HZ)
    expect(a).toBe(b)
  })
})

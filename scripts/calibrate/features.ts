/**
 * Offline reproduction of `AudioEngine.update()`'s per-frame feature pipeline,
 * for the calibration harness only. NOT shipped.
 *
 * Everything that is a pure, exported module in `src/audio` is imported and
 * used directly — `computeSpectralBands`, `computeLowBands`, `BandNormalizer`,
 * `ProgramLevel`, `BpmEstimator`, `PhraseDetector`, `MoodEstimator`,
 * `PercussionDetector`. Only the glue that lives inline inside `AudioEngine`
 * (the FFT reads, the RMS/crest loop, the smoothing lines, the energy blend,
 * the fps-independent onset/percussion tick, `advanceGrid`, `detectStructure`)
 * is re-implemented here, each block tagged with the `AudioEngine.ts` step it
 * mirrors. `crosscheck.calib.ts` bounds the residual difference against a real
 * browser decode.
 *
 * Faithful to AudioEngine as of the F154 front-end sweep: the 2048 main FFT +
 * 8192 sub/bass FFT, `f.sub` off the 8192 grid, `f.sparkle`, the age-windowed
 * flux ring, and the stale-frame guard (a no-op here — this harness steps at a
 * fixed 60 Hz over real decoded audio, so the FFT always advances).
 */
import { BandNormalizer, ProgramLevel, type SilenceConfig } from '../../src/audio/bandNormalizer'
import { BpmEstimator } from '../../src/audio/BpmEstimator'
import { MoodEstimator } from '../../src/audio/MoodEstimator'
import { PercussionDetector } from '../../src/audio/PercussionDetector'
import { PhraseDetector } from '../../src/audio/PhraseDetector'
import { computeLowBands, computeSpectralBands } from '../../src/audio/spectralFeatures'
import { createEmptyFeatures, type AudioFeatures } from '../../src/audio/types'
import { frequencyDataDb } from './fft'

// --- AudioEngine.ts constants ---
const FFT_SIZE = 2048
const LOW_FFT_SIZE = 8192 // dedicated sub/bass analyser — f.sub only
const FLUX_WINDOW_SEC = 1.0
const SILENCE_CONFIG: SilenceConfig = { enterRatio: 0.004, exitRatio: 0.01 }
const ENERGY_WEIGHT_SUM = 0.5 + 0.3 + 0.2 + 0.3

/** Optional per-frame hook for a synthetic model tempo read (Essentia stand-in). */
export interface StepHooks {
  /** Called before `bpmEstimator.update`; return a `[bpm, confidence01]` to feed
   * `setModelTempo`, or null. Lets the harness exercise the model-vote path. */
  modelTempo?: (now: number) => [number, number] | null
}

export interface TrackRunResult {
  /** One entry per analysed frame. */
  frames: FrameSample[]
  frameRate: number
  sampleRate: number
  durationSec: number
}

/** The subset of `AudioFeatures` the calibration reports read, per frame. */
export interface FrameSample {
  t: number
  rms: number
  energy: number
  sub: number
  bass: number
  mid: number
  presence: number
  high: number
  vocal: number
  air: number
  sparkle: number
  centroid: number
  spectralFlatness: number
  spectralRolloff: number
  crestFactor: number
  flux: number
  transient: number
  bpm: number
  confidence: number
  beatGridAccuracy: number
  octaveCorrection: number
  beat: boolean
  phrase: number
  sectionChange: boolean
  sectionChangeStrength: number
  drop: boolean
  buildUp: boolean
  silence: boolean
  moodState: string
  moodConfidence: number
  moodAmbiguity: number
  moodChanged: boolean
  moodLevel: number
  energyVel: number
}

/**
 * Steps one decoded mono track through the pipeline at a fixed 60 Hz and
 * returns a per-frame sample stream.
 */
export function runTrack(
  pcm: Float32Array,
  sampleRate: number,
  hooks: StepHooks = {},
): TrackRunResult {
  const frameRate = 60
  const hop = Math.round(sampleRate / frameRate)
  const delta = 1 / frameRate
  const f = createEmptyFeatures()

  // Per-source mutable state — the fields AudioEngine keeps on `this`.
  const bands = {
    rms: new BandNormalizer(),
    bass: new BandNormalizer(),
    mid: new BandNormalizer(),
    sub: new BandNormalizer(),
    presence: new BandNormalizer(),
    high: new BandNormalizer(),
    vocal: new BandNormalizer(),
    air: new BandNormalizer(),
    sparkle: new BandNormalizer(),
    flux: new BandNormalizer(),
  }
  const programLevel = new ProgramLevel()
  const bpmEstimator = new BpmEstimator()
  const phraseDetector = new PhraseDetector()
  const moodEstimator = new MoodEstimator()
  const percussionDetector = new PercussionDetector()

  const freqDb = new Float32Array(FFT_SIZE / 2)
  const prevMag = new Float32Array(FFT_SIZE / 2)
  const lowFreqDb = new Float32Array(LOW_FFT_SIZE / 2)
  const lowFrame = new Float32Array(LOW_FFT_SIZE)
  const waveform = new Float32Array(1024)
  const fftFrame = new Float32Array(FFT_SIZE)
  // C7: age-windowed, not a fixed 60-count. C8: skip stale frames (never true
  // here — this harness steps at a fixed 60 Hz over real decoded audio — but
  // mirrored so the code paths match AudioEngine.).
  let fluxHistory: { t: number; v: number }[] = []
  let waveProbe0 = NaN
  let waveProbeMid = NaN
  let waveProbeLast = NaN
  let lastOnsetTime = -10
  let silenceSince = 0
  let lastGridIndex = -1
  let dropUntil = -1
  const energyLog: { t: number; e: number }[] = []

  const frames: FrameSample[] = []
  // `end` is anchored to FFT_SIZE (NOT LOW_FFT_SIZE) so the 2048/1024/onset/mood
  // path is bit-identical to the pre-C6 harness — a live AnalyserNode right-
  // aligns every analyser to the same "now", and the wider 8192 window just
  // reaches further back, zero-padded at the track start like a real node's
  // warm-up.
  const totalFrames = Math.floor((pcm.length - FFT_SIZE) / hop)

  for (let i = 0; i < totalFrames; i++) {
    const now = i * delta
    const end = FFT_SIZE + i * hop

    // AudioEngine.ts update() — MoodEstimator reads `f.time` for its hysteresis
    // clock and velocity windows, so this MUST be written every frame.
    f.time = now
    f.delta = delta

    // All windows right-aligned to the same newest sample `end`: latest 2048
    // for the main FFT, latest 8192 for the sub/bass FFT (left-zero-padded for
    // the first ~8 frames), latest 1024 for waveform/RMS.
    for (let k = 0; k < FFT_SIZE; k++) fftFrame[k] = pcm[end - FFT_SIZE + k] ?? 0
    for (let k = 0; k < LOW_FFT_SIZE; k++) lowFrame[k] = pcm[end - LOW_FFT_SIZE + k] ?? 0
    for (let k = 0; k < 1024; k++) waveform[k] = pcm[end - 1024 + k] ?? 0
    frequencyDataDb(fftFrame, FFT_SIZE, freqDb)
    frequencyDataDb(lowFrame, LOW_FFT_SIZE, lowFreqDb)

    // C8 — did the FFT advance? (Always yes here; see the declaration comment.)
    const w0 = waveform[0]
    const wMid = waveform[512]
    const wLast = waveform[1023]
    const fftAdvanced = w0 !== waveProbe0 || wMid !== waveProbeMid || wLast !== waveProbeLast
    waveProbe0 = w0
    waveProbeMid = wMid
    waveProbeLast = wLast

    // --- AudioEngine.ts update() ---
    const nyquist = sampleRate / 2
    const binHz = nyquist / freqDb.length

    // --- RMS + crest (AudioEngine.ts RMS+crest loop) ---
    let sq = 0
    let peakAbs = 0
    for (let k = 0; k < waveform.length; k++) {
      const s = waveform[k]
      sq += s * s
      const a = Math.abs(s)
      if (a > peakAbs) peakAbs = a
    }
    const rmsRaw = Math.sqrt(sq / waveform.length)
    const crestRaw = Math.min(20, peakAbs / (rmsRaw + 1e-6))

    // --- Bands (AudioEngine.ts computeSpectralBands + computeLowBands) ---
    const spectral = computeSpectralBands(freqDb, prevMag, binHz)
    // f.sub from the dedicated 8192 grid (the shipped graph always builds it);
    // f.bass stays on the 2048 grid, matching AudioEngine.
    const lowSub = computeLowBands(lowFreqDb, nyquist / lowFreqDb.length).sub

    // --- Silence ---
    if (programLevel.update(rmsRaw, delta, SILENCE_CONFIG)) silenceSince = now
    f.silence = now - silenceSince > 0.6

    // --- Adaptive normalization + smoothing ---
    const norm = (b: BandNormalizer, raw: number) => b.update(raw, delta, f.silence, 1, 1)
    f.rms = norm(bands.rms, rmsRaw)
    f.bass = norm(bands.bass, spectral.bass)
    f.mid = norm(bands.mid, spectral.mid)
    f.sub = norm(bands.sub, lowSub)
    f.presence = norm(bands.presence, spectral.presence)
    f.high = norm(bands.high, spectral.high)
    f.vocal = norm(bands.vocal, spectral.vocal)
    f.air = norm(bands.air, spectral.air)
    f.sparkle = norm(bands.sparkle, spectral.sparkle)
    f.flux = norm(bands.flux, spectral.bassFlux)
    f.transient += (Math.min(1, f.flux * 1.5) - f.transient) * Math.min(1, delta * 20)
    f.centroid += (Math.min(1, spectral.centroidRaw * 2.1) - f.centroid) * Math.min(1, delta * 8)
    f.spectralFlatness += (spectral.spectralFlatness - f.spectralFlatness) * Math.min(1, delta * 8)
    f.spectralRolloff += (spectral.spectralRolloff - f.spectralRolloff) * Math.min(1, delta * 8)
    f.crestFactor += (crestRaw - f.crestFactor) * Math.min(1, delta * 4)
    const energyTarget =
      (f.bass * 0.5 + f.mid * 0.3 + f.high * 0.2 + f.rms * 0.3) / ENERGY_WEIGHT_SUM
    f.energy += (energyTarget - f.energy) * Math.min(1, delta * (energyTarget > f.energy ? 14 : 4))

    // --- Percussion + broadband onset (AudioEngine.ts: gated on fftAdvanced) ---
    if (fftAdvanced) {
      percussionDetector.update(f.percussion, spectral, now, delta, f.silence)

      fluxHistory.push({ t: now, v: spectral.bassFlux })
      while (fluxHistory.length > 0 && now - fluxHistory[0].t >= FLUX_WINDOW_SEC - 1e-6)
        fluxHistory.shift()
      if (fluxHistory.length > 20 && !f.silence) {
        let mean = 0
        for (const e of fluxHistory) mean += e.v
        mean /= fluxHistory.length
        let variance = 0
        for (const e of fluxHistory) variance += (e.v - mean) * (e.v - mean)
        const std = Math.sqrt(variance / fluxHistory.length)
        const threshold = mean + 1.6 * std + 1e-6
        if (spectral.bassFlux > threshold && now - lastOnsetTime > 0.18) {
          lastOnsetTime = now
          const strength = Math.min(1, (spectral.bassFlux - mean) / (std * 4 + 1e-6))
          bpmEstimator.addOnset(now, strength)
        }
      }
    }

    // --- Model tempo hook (stands in for essentiaBridge.update) ---
    const model = hooks.modelTempo?.(now)
    if (model) bpmEstimator.setModelTempo(model[0], model[1], now, 8)

    bpmEstimator.update(now)

    // --- advanceGrid (AudioEngine.ts advanceGrid) ---
    f.bpm = bpmEstimator.bpm
    f.confidence = bpmEstimator.confidence
    f.beatGridAccuracy = bpmEstimator.hitScore
    {
      const est = bpmEstimator
      const idx = Math.floor((now - est.phase) / est.period)
      f.beatProgress = (now - est.phase) / est.period - idx
      f.nextBeatTime = est.phase + (idx + 1) * est.period
      f.beat = false
      if (idx !== lastGridIndex) {
        if (lastGridIndex !== -1 && idx > lastGridIndex) {
          f.beat = true
          f.beatIndex += Math.min(idx - lastGridIndex, 4)
          f.beatInBar = f.beatIndex % 4
          f.bar = Math.floor(f.beatIndex / 4)
          f.measure = Math.floor(f.beatIndex / 16)
          f.beatStrength = Math.min(1, 0.25 + f.bass * 0.9) * (0.35 + 0.65 * f.confidence)
        }
        lastGridIndex = idx
      }
    }

    // --- detectStructure (AudioEngine.ts detectStructure) ---
    energyLog.push({ t: now, e: f.energy })
    while (energyLog.length > 0 && now - energyLog[0].t > 6) energyLog.shift()
    {
      let recent = 0
      let recentN = 0
      let before = 0
      let beforeN = 0
      let oldest = now
      for (const s of energyLog) {
        if (s.t < oldest) oldest = s.t
        if (now - s.t < 0.35) {
          recent += s.e
          recentN++
        } else if (now - s.t < 2.2) {
          before += s.e
          beforeN++
        }
      }
      if (recentN > 3 && beforeN > 10) {
        recent /= recentN
        before /= beforeN
        if (recent > before * 1.573 && recent > 0.447 && f.bass > 0.507 && now > dropUntil + 4) {
          dropUntil = now + 0.6
        }
        const span = now - oldest
        const first = energyLog[0]
        const slope = span > 3 ? (recent - first.e) / span : 0
        f.buildUp = slope > 0.197 && recent > 0.295 && recent > before
      }
      f.drop = now < dropUntil
    }

    // --- Phrase + mood (AudioEngine.ts phraseDetector + moodEstimator) ---
    // NOTE: no Essentia worker runs here, so f.danceability / f.key / f.moods*
    // stay at their defaults. MoodEstimator's `danceBonus` term (F166) and
    // `partyBonus` are both therefore identically 0 in every calibrate frame —
    // intentional, not a bug. Those two only have effect in the live app.
    phraseDetector.update(now, f)
    moodEstimator.update(f)

    frames.push({
      t: now,
      rms: f.rms,
      energy: f.energy,
      sub: f.sub,
      bass: f.bass,
      mid: f.mid,
      presence: f.presence,
      high: f.high,
      vocal: f.vocal,
      air: f.air,
      sparkle: f.sparkle,
      centroid: f.centroid,
      spectralFlatness: f.spectralFlatness,
      spectralRolloff: f.spectralRolloff,
      crestFactor: f.crestFactor,
      flux: f.flux,
      transient: f.transient,
      bpm: f.bpm,
      confidence: f.confidence,
      beatGridAccuracy: f.beatGridAccuracy,
      octaveCorrection: bpmEstimator.octaveCorrection,
      beat: f.beat,
      phrase: f.phrase,
      sectionChange: f.sectionChange,
      sectionChangeStrength: f.sectionChangeStrength,
      drop: f.drop,
      buildUp: f.buildUp,
      silence: f.silence,
      moodState: f.mood.state,
      moodConfidence: f.mood.confidence,
      moodAmbiguity: f.mood.ambiguity,
      moodChanged: f.mood.changed,
      moodLevel: f.mood.level,
      energyVel: f.mood.energyVel,
    })
  }

  return {
    frames,
    frameRate,
    sampleRate,
    durationSec: pcm.length / sampleRate,
  }
}

export type { AudioFeatures }

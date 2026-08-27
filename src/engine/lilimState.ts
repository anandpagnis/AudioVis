import type { SceneFrame } from './sceneFrame'

/**
 * The audio state a lilim-authored scene body expects.
 *
 * This exists so a scene's `update()` math ports across **verbatim** — the
 * shaders were tuned against these exact field names, ranges and ballistics, and
 * retyping `s.mids` as `b.mid` at every use site is how a port silently
 * relandscapes a look that took an afternoon to tune. The adapter absorbs the
 * translation once, in one testable place, instead of 20 times by hand.
 *
 * ## What is deliberately NOT here
 *
 * lilim's `s` also carried `bands` (8), `spec` (30 bins) and `loud`. No scene
 * read `bands` or `spec` — they fed its meters — and this codebase's standing
 * rule is that a field with no reader gets deleted rather than kept for later
 * (see `performanceState.ts`). `wave` is omitted for the same reason: only
 * lilim's `signal` scene sampled it, and that scene is not ported yet. Adding
 * `wave` back is `f.waveform` for both channels (this engine's analysis is mono)
 * plus `f.midWaveform` if a scene wants the lead rather than the drums.
 */
export interface LilimAudioState {
  /** Sub-bass level, 0..1-ish. */
  sub: number
  /**
   * Kick punch envelope, 0..~1.2 — continuous but fast (~140 ms tail), so it
   * reads as a decaying impulse. NOT a per-frame trigger; that is `onKick`.
   */
  kick: number
  /** Mid level, 0..1-ish. */
  mids: number
  /** High level, 0..1-ish. */
  highs: number
  /** Air / cymbal wash above where `highs` stops, 0..1-ish. */
  air: number
  /** Master intensity term, 0..~1.1. */
  energy: number
  /**
   * Slow programme loudness, 0..1 — what makes a quiet section read quiet.
   * Much slower than `energy`; use it to scale a whole look, not a hit.
   */
  loud: number
  /** Kick onset: 0 on most frames, a strength spike on the hit. */
  onKick: number
  /** Mid/snare onset. Same shape as {@link onKick}. */
  onMid: number
  /** High/hat onset. Same shape as {@link onKick}. */
  onHigh: number
  /**
   * 192 log-spaced spectrum bins, 0..1 — the analyser feed, for scenes that
   * read spectral *shape* rather than band levels.
   *
   * Deliberately dB-mapped, unlike every band above. See the note on
   * {@link updateLilimState} for why that asymmetry is load-bearing.
   */
  specHi: Float32Array
  /**
   * Rolling peak the `specHi` dB mapping is referenced to.
   *
   * Internal to the adapter — scenes must not read it. It lives on the state
   * rather than at module scope because two scenes can be mounted at once (a
   * primary and a layer, or both sides of a crossfade), and a shared peak would
   * decay once per *instance* per frame instead of once per frame, dragging the
   * reference floor down and washing the spectrum out whenever more than one
   * scene was on screen.
   */
  specPeak: number
}

/** Number of log bins in {@link LilimAudioState.specHi}. lilim's figure. */
const SPEC_HI_BINS = 192

/**
 * Frequency range covered by `specHi`.
 *
 * lilim ran 35 Hz–18 kHz. This engine's `f.spectrum` keeps only the lower 512
 * of 1024 FFT bins — up to about 11 kHz at 44.1 kHz — so the top of the range is
 * genuinely unavailable rather than merely quiet. Scenes that pick structure out
 * of the spectrum (Chladni mode selection, analyser displays) work from the
 * bottom three-quarters, so this is a real but tolerable reduction. Widening it
 * means raising `SPECTRUM_BINS` in `AudioEngine.ts`.
 */
const SPEC_LO_HZ = 35
const SPEC_HI_HZ = 11000

/**
 * Hz per `f.spectrum` bin.
 *
 * `FFT_SIZE / 2 = 1024` bins spanning Nyquist. Assumes a 44.1 kHz context; a
 * 48 kHz device shifts every bin's centre up about 9%, which is under a
 * semitone and a third of this resampler's bin width — invisible for the
 * shape-reading these bins exist to serve. `AudioFeatures` does not carry
 * `sampleRate`; if a scene ever needs true calibration, that is the fix.
 */
const BIN_HZ = 44100 / 2 / 1024

/**
 * Precomputed source-bin span for each output bin, so the frame loop only sums.
 *
 * Verified numerically: no span is empty and the widest end index is 511, inside
 * `f.spectrum`'s 512 entries — 11 kHz was chosen to land just under the 11.025
 * kHz the buffer actually reaches.
 *
 * One real limitation to know about: at 21.5 Hz per source bin, the bottom
 * ~30 output bins all resolve to the same single source bin, so the low end of
 * `specHi` is duplicated rather than detailed. lilim did not have this problem
 * because it fused a dedicated filterbank in below 500 Hz. A scene picking
 * structure out of the spectrum should read the mids and up, and take the bass
 * from `s.sub` / `s.kick` instead.
 */
const binStart = new Int32Array(SPEC_HI_BINS)
const binEnd = new Int32Array(SPEC_HI_BINS)
{
  const ratio = SPEC_HI_HZ / SPEC_LO_HZ
  for (let i = 0; i < SPEC_HI_BINS; i++) {
    const loHz = SPEC_LO_HZ * Math.pow(ratio, i / SPEC_HI_BINS)
    const hiHz = SPEC_LO_HZ * Math.pow(ratio, (i + 1) / SPEC_HI_BINS)
    const lo = Math.floor(loHz / BIN_HZ)
    // At the bottom of the range one output bin is narrower than one FFT bin,
    // so without the max() the span is empty and the low end reads as silence.
    binStart[i] = lo
    binEnd[i] = Math.max(lo + 1, Math.ceil(hiHz / BIN_HZ))
  }
}

/** dB window `specHi` is mapped over. lilim's figure. */
const SPEC_DB_RANGE = 48

/** Decay time constant of the `specHi` reference peak. lilim's figure. */
const SPEC_PEAK_DECAY_SEC = 25

/** Allocate a reusable state object. Call once per scene, in a `useMemo`. */
export function createLilimState(): LilimAudioState {
  return {
    sub: 0,
    kick: 0,
    mids: 0,
    highs: 0,
    air: 0,
    energy: 0,
    loud: 0,
    onKick: 0,
    onMid: 0,
    onHigh: 0,
    specHi: new Float32Array(SPEC_HI_BINS),
    specPeak: 1e-4,
  }
}

/**
 * Refresh a lilim audio state from this engine's per-frame context.
 *
 * Mutates `s` in place — allocate it once with {@link createLilimState} and call
 * this at the top of the scene's frame callback, exactly where lilim's engine
 * built its own `s`.
 *
 * ## The mappings that are not one-to-one
 *
 * - **`mids`** is the mean of `mid` and `presence`. lilim's `mids` averaged its
 *   bands 2–4, roughly 240 Hz–1.9 kHz, which this engine splits across two named
 *   bands. Taking `mid` alone loses the upper half of the range the shaders were
 *   tuned against and reads noticeably duller on vocal-led material.
 * - **`loud`** has no direct equivalent. lilim derived it from a 30-second
 *   rolling peak of a weighted band sum. `f.rms` is the closest honest stand-in:
 *   it is a true programme level rather than a normalised band, so it keeps the
 *   "quiet sections read quiet" behaviour that is the whole point of the field.
 *   It is NOT reactivity-scaled, matching lilim, where `loud` was exempt from
 *   the REACT master on the grounds that it is measurement, not reaction.
 * - **`onKick` / `onMid` / `onHigh`** come from this engine's independent
 *   per-drum detectors (`f.percussion.kick/snare/hihat`), which is strictly
 *   better than lilim's three band-limited flux detectors — a snare and a
 *   mid-range synth stab are separable here and were not there. The shape is
 *   preserved: zero on most frames, the hit's strength on the frame it fires.
 *
 * ## Why the bands are linear and `specHi` is dB
 *
 * lilim recorded this the hard way and the finding is worth carrying with the
 * code (`rebuild/web/analysis.js`): dB-mapping the *band* feed flatlined its
 * kick detector — "dB bands gave 0 onKick events in 10 s of a beat-heavy clip,
 * linear gives one per beat" — because in dB a dense mix's kick-to-rest swing
 * compresses to about a quarter of its linear range, while onset detection is
 * tuned for the linear swing. This engine's bands are already linear magnitudes
 * normalised against a rolling peak (`bandNormalizer.ts`), so that requirement
 * is satisfied upstream and must stay that way.
 *
 * The two spectra are deliberately the opposite. dB is right there precisely
 * because nothing does onset detection on them — they are read for shape, and a
 * linear spectrum is all bass and no visible detail anywhere else.
 */
export function updateLilimState(s: LilimAudioState, ctx: SceneFrame): void {
  const { f, b, dt } = ctx

  s.sub = b.sub
  s.kick = b.kick
  s.mids = (b.mid + b.presence) * 0.5
  s.highs = b.high
  s.air = b.air
  s.energy = b.energy
  s.loud = f.rms

  const R = ctx.params.reactivity
  const { kick, snare, hihat } = f.percussion
  s.onKick = kick.trigger ? kick.strength * R : 0
  s.onMid = snare.trigger ? snare.strength * R : 0
  s.onHigh = hihat.trigger ? hihat.strength * R : 0

  // --- specHi: log-bin the linear spectrum, then map to dB against a rolling
  // peak. Shared peak rather than per-bin, so the true spectral tilt survives;
  // per-bin normalisation flattens every frame into the same silhouette.
  const spectrum = f.spectrum
  const out = s.specHi
  let frameMax = 0
  for (let i = 0; i < SPEC_HI_BINS; i++) {
    let sum = 0
    const end = Math.min(binEnd[i], spectrum.length)
    let n = 0
    for (let j = binStart[i]; j < end; j++) {
      sum += spectrum[j]
      n++
    }
    const mag = n > 0 ? sum / n : 0
    out[i] = mag
    if (mag > frameMax) frameMax = mag
  }
  const peak = Math.max(frameMax, s.specPeak * Math.exp(-dt / SPEC_PEAK_DECAY_SEC), 1e-6)
  s.specPeak = peak
  const invRange = 20 / SPEC_DB_RANGE
  for (let i = 0; i < SPEC_HI_BINS; i++) {
    // 1 + 20*log10(mag/peak)/range — 0 at range dB down, 1 at the peak.
    const db = 1 + Math.log10(Math.max(out[i], 1e-9) / peak) * invRange
    out[i] = db < 0 ? 0 : db > 1 ? 1 : db
  }
}

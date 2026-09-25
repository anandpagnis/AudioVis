/**
 * The RAW (un-normalised) level tap: what the live change scorer (`changeScorer.ts`) needs so that "the chorus is
 * louder" is visible.
 *
 * WHY. The engine's front end normalises every band by a running maximum (`bandNormalizer.ts`: instant attack, ~4.6 s
 * half-life, then gamma 2.8), so a sustained level difference between two sections is divided away within a few
 * seconds and a slow crescendo pins near 1. The per-beat `BeatCell` the slow analyser folds therefore says nothing
 * about level. This tap copies six band levels and the RMS in dB, straight off the same locals `AudioEngine.update()`
 * computes for the normaliser (`spectral.*`, `subRaw`, `rmsRaw`), BEFORE any normalisation. It does no DSP of its own.
 *
 * GAIN-INVARIANT USE ONLY. The absolute dB scale depends on the analyser (smoothing, window, playback volume, an
 * operator's input gain), so the values are only ever used through DIFFERENCES between beat windows (`barFeatures.ts`:
 * the level channel is a difference; the band channels are tilts relative to the RMS). A uniform shift of every channel
 * with an unchanged spectral shape is a volume knob and is classified `gain` by `EventLayer`, never a scene change.
 *
 * CHANNELS (dB of mean linear magnitude; RMS is dB of the time-domain RMS):
 *   0 sub (<80 Hz, the 8192 analyser when present)   1 bass (<160 Hz)    2 mid (160 Hz-2 kHz)
 *   3 presence (2-5 kHz)   4 high (5-9 kHz)   5 air (9-16 kHz)   6 rms
 *
 * Pure. `write` performs no allocation; the buffer is one reused `Float64Array`.
 */

export const RAW_CHANNELS = 7
export const RAW_SUB = 0
export const RAW_BASS = 1
export const RAW_MID = 2
export const RAW_PRESENCE = 3
export const RAW_HIGH = 4
export const RAW_AIR = 5
export const RAW_RMS = 6

/** Floor of the dB scale: digital silence and analyser noise floors read as this, never -Infinity / NaN. */
export const RAW_DB_FLOOR = -120

/** 20 log10 of a linear magnitude, floored at {@link RAW_DB_FLOOR} (non-finite and non-positive read as the floor). */
export function linToDb(lin: number): number {
  if (!(lin > 1e-6)) return RAW_DB_FLOOR
  const db = 20 * Math.log10(lin)
  return db > RAW_DB_FLOOR ? db : RAW_DB_FLOOR
}

/** The band magnitudes the tap reads (linear, as `computeSpectralBands` returns them). */
export interface RawBandsIn {
  sub: number
  bass: number
  mid: number
  presence: number
  high: number
  air: number
}

/**
 * One reused buffer of the seven raw dB channels for the CURRENT frame. `AudioEngine` writes it once per frame beside
 * the normaliser calls; `StructureAnalyzer` averages it into the beat cell.
 */
export class RawTap {
  readonly db = new Float64Array(RAW_CHANNELS).fill(RAW_DB_FLOOR)
  /** False until the first `write`, so an analyser that was never fed leaves `raw` off the cell. */
  written = false

  /** `subLin` is the sub-bass magnitude the engine hands the normaliser (`subRaw`), `rmsLin` the time-domain RMS. */
  write(bands: RawBandsIn, subLin: number, rmsLin: number): void {
    const d = this.db
    d[RAW_SUB] = linToDb(subLin)
    d[RAW_BASS] = linToDb(bands.bass)
    d[RAW_MID] = linToDb(bands.mid)
    d[RAW_PRESENCE] = linToDb(bands.presence)
    d[RAW_HIGH] = linToDb(bands.high)
    d[RAW_AIR] = linToDb(bands.air)
    d[RAW_RMS] = linToDb(rmsLin)
    this.written = true
  }

  reset(): void {
    this.db.fill(RAW_DB_FLOOR)
    this.written = false
  }
}

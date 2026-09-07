import { describe, expect, it } from 'vitest'
import {
  ANALYSER_MAX_DB,
  ANALYSER_MIN_DB,
  applyAnalyserRange,
} from '../analyserRange'

/**
 * Audit item 5 — the analyser dB window.
 *
 * The audit filed this as "hot masters saturate the FFT readout, pinning
 * raw/peak at 1.0". Half of that is wrong and half is right, and the split is
 * what these tests pin:
 *
 *  - WRONG for `AudioEngine`'s three float-path analysers. `min/maxDecibels`
 *    affect only `getByteFrequencyData`; `getFloatFrequencyData` writes
 *    un-normalized dBFS and ignores them. `loudnessInvariance.test.ts` carries
 *    the empirical check and guards the real invariance property end-to-end.
 *  - RIGHT for `landing/tunnelAudio`, this repo's only byte-data reader, whose
 *    analyser ran on the -100..-30 defaults.
 *
 * `vite.config.ts` sets `environment: 'node'`, so there is no Web Audio
 * implementation here and a literal `AnalyserNode` cannot be constructed. The
 * saturation arithmetic is therefore checked against the spec's own mapping
 * formula, transcribed below, and the property assignment is checked against a
 * minimal stand-in. That is an honest test of the arithmetic, not of Chromium.
 */

/**
 * The Web Audio spec's dB → byte conversion for `getByteFrequencyData`:
 * linearly map [minDecibels, maxDecibels] onto [0, 255] and clamp.
 */
function byteFromDb(db: number, minDb: number, maxDb: number): number {
  const b = 255 / (maxDb - minDb)
  return Math.max(0, Math.min(255, Math.round(b * (db - minDb))))
}

/** Web Audio's documented defaults for a freshly created AnalyserNode. */
const DEFAULT_MIN_DB = -100
const DEFAULT_MAX_DB = -30

describe('applyAnalyserRange', () => {
  it('sets the shared window on an analyser', () => {
    const node = { minDecibels: DEFAULT_MIN_DB, maxDecibels: DEFAULT_MAX_DB }
    applyAnalyserRange(node as unknown as AnalyserNode)
    expect(node.minDecibels).toBe(-90)
    expect(node.maxDecibels).toBe(0)
  })

  it('keeps min below max, and max at the top of the digital scale', () => {
    expect(ANALYSER_MIN_DB).toBeLessThan(ANALYSER_MAX_DB)
    // 0 dBFS is the ceiling of the digital scale, so no real bin can exceed it
    // and nothing downstream can clip against the top of the byte range.
    expect(ANALYSER_MAX_DB).toBe(0)
  })
})

describe('the saturation the defaults cause (item 5, the half that is real)', () => {
  /**
   * -14 dBFS is the level `tunnelAudio`'s DynamicsCompressor (threshold -14 dB,
   * ratio 8) holds its analyser input near, so this is the operating point, not
   * a contrived one.
   */
  const OPERATING_DBFS = -14

  it('pins a -14 dBFS bin at 255 on the Web Audio defaults', () => {
    expect(byteFromDb(OPERATING_DBFS, DEFAULT_MIN_DB, DEFAULT_MAX_DB)).toBe(255)
  })

  it('leaves real headroom at the same level on the new window', () => {
    const byte = byteFromDb(OPERATING_DBFS, ANALYSER_MIN_DB, ANALYSER_MAX_DB)
    // (-14 + 90) / 90 = 0.8444 -> round(0.8444 * 255) = 215
    expect(byte).toBe(215)
    expect(byte).toBeLessThan(255)
  })

  it('restores loudness DISCRIMINATION above the old -30 dB ceiling', () => {
    // The property the audit actually cared about: two signals that differ in
    // level must not read identically. On the defaults, -10 and -20 dBFS both
    // sit above the -30 ceiling and collapse onto the same byte.
    const defaultsLoud = byteFromDb(-10, DEFAULT_MIN_DB, DEFAULT_MAX_DB)
    const defaultsQuiet = byteFromDb(-20, DEFAULT_MIN_DB, DEFAULT_MAX_DB)
    expect(defaultsLoud).toBe(255)
    expect(defaultsQuiet).toBe(255)
    expect(defaultsLoud).toBe(defaultsQuiet) // indistinguishable — the bug

    const fixedLoud = byteFromDb(-10, ANALYSER_MIN_DB, ANALYSER_MAX_DB)
    const fixedQuiet = byteFromDb(-20, ANALYSER_MIN_DB, ANALYSER_MAX_DB)
    expect(fixedLoud).toBeGreaterThan(fixedQuiet)
    // 255/90 = 2.8333 byte steps per dB, so a 10 dB gap is ~28.3 steps ideally.
    // At these two points the rounding lands on 29:
    //   -10 dBFS: round(2.8333 * 80) = round(226.67) = 227
    //   -20 dBFS: round(2.8333 * 70) = round(198.33) = 198
    expect(fixedLoud).toBe(227)
    expect(fixedQuiet).toBe(198)
    expect(fixedLoud - fixedQuiet).toBe(29)
  })

  it('still bottoms out at 0 for true digital silence', () => {
    expect(byteFromDb(-200, ANALYSER_MIN_DB, ANALYSER_MAX_DB)).toBe(0)
  })

  it('reaches full scale only at 0 dBFS', () => {
    expect(byteFromDb(0, ANALYSER_MIN_DB, ANALYSER_MAX_DB)).toBe(255)
    expect(byteFromDb(-1, ANALYSER_MIN_DB, ANALYSER_MAX_DB)).toBeLessThan(255)
  })
})

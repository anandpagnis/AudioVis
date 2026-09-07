/**
 * Two gates the per-frame analysis path applies before it lets a frame reach
 * the onset/percussion detectors, pulled out as pure functions so both can be
 * tested without a real `AudioContext`.
 *
 * Both exist for the same underlying reason: the render loop's rate is set by
 * the display, not by the audio clock, and every statistic built from
 * "frames" rather than "seconds of audio" silently changes meaning when those
 * two diverge.
 */

/** Anything carrying an engine-clock timestamp in seconds. */
export interface Timestamped {
  t: number
}

/**
 * Eviction epsilon, in seconds.
 *
 * Without it, float drift in the frame clock makes a ring that should hold a
 * steady N samples wobble between N and N+1. With it, a steady 60 fps holds
 * EXACTLY 60 samples over a 1 s window, bit-identical to the fixed-count ring
 * this replaced — so the onset calibration derived against that ring is
 * preserved at the reference rate.
 *
 * Derivation at 60 fps, window 1 s: frames arrive at t = j/60, and eviction
 * fires when `now - t >= 1 - 1e-6`. At `now = k/60` that is
 * `(k - j)/60 >= 1 - 1e-6`, i.e. `k - j >= 60 - 6e-5`; since `k - j` is an
 * integer this is `k - j >= 60`. Entries j = k-59 .. k survive: 60 samples.
 */
export const RING_EPSILON = 1e-6

/**
 * Drop ring entries older than `windowSec` (audit item 7).
 *
 * The rings this serves used to be evicted by a fixed SAMPLE COUNT — a
 * "60-sample ring ≈ 1 s" that was only ≈1 s at 60 fps, and silently became 2 s
 * at 30 fps and 0.4 s at 144 fps. Everything downstream reads mean/σ over the
 * ring, so the adaptive onset threshold's sensitivity drifted with the user's
 * display refresh rate. Evicting by AGE makes the window a fixed span of
 * wall-clock time at any frame rate; only the number of samples inside it
 * varies.
 *
 * `ring` is mutated in place and must be in ascending `t` order (it is: every
 * caller pushes once per frame from a monotonic clock).
 */
export function evictExpired<T extends Timestamped>(
  ring: T[],
  now: number,
  windowSec: number,
): void {
  while (ring.length > 0 && now - ring[0].t >= windowSec - RING_EPSILON) {
    ring.shift()
  }
}

/**
 * Last frame's time-domain samples at three probe indices — the state
 * {@link fftAdvanced} carries between frames. `NaN` until the first frame, so
 * the first comparison always reports "advanced".
 */
export interface WaveProbe {
  p0: number
  pMid: number
  pLast: number
}

export function makeWaveProbe(): WaveProbe {
  return { p0: NaN, pMid: NaN, pLast: NaN }
}

/**
 * Has the analyser produced a new FFT since the last call? (audit item 8)
 *
 * `AnalyserNode` recomputes its FFT on the audio callback, not on demand. When
 * the render loop runs faster than that callback — real above roughly 90 fps,
 * and whenever a tab is throttled — `getFloatFrequencyData` simply re-reads the
 * last computed block, and the render loop sees the same frame twice.
 *
 * That is not harmless for a flux-based detector: `bassFlux` diffs the current
 * magnitudes against `prevMag`, so a duplicate frame produces `flux ≈ 0` BY
 * CONSTRUCTION rather than because the music went quiet. Feeding those zeros
 * into the adaptive threshold drags its rolling mean and σ down and suppresses
 * genuine onsets. The caller therefore runs the detectors only when this
 * returns true.
 *
 * Three probes rather than a full buffer compare: an `=== ` scan over 2048
 * floats every frame costs more than the gate saves, and three widely spaced
 * samples of a real signal are vanishingly unlikely to be simultaneously equal
 * across two genuinely different blocks. Digital silence DOES make all three
 * compare equal — that is correct and desirable here, since a silent duplicate
 * carries no onset information either way, and the caller gates on
 * `f.silence` separately.
 *
 * `probe` is updated in place to the current frame's values.
 */
export function fftAdvanced(wave: Float32Array, probe: WaveProbe): boolean {
  const p0 = wave[0]
  const pMid = wave[wave.length >> 1]
  const pLast = wave[wave.length - 1]
  const advanced = p0 !== probe.p0 || pMid !== probe.pMid || pLast !== probe.pLast
  probe.p0 = p0
  probe.pMid = pMid
  probe.pLast = pLast
  return advanced
}

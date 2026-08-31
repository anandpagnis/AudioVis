import type { AudioFeatures } from '../audio/types'

/**
 * Per-band clocks — seconds that advance while a frequency band is loud and
 * stop advancing when it is not, rather than the flat wall-clock every scene
 * currently has through `uTime`.
 *
 * ## Why (audit c14)
 *
 * `uTime` is one clock for the whole shader, driven from mount time alone —
 * so a scene animating off it moves at the same rate through a breakdown as
 * through a drop, and the only way to make motion feel "of the music" is to
 * multiply `uTime` by a band level ad hoc inside each scene's own shader,
 * which every scene currently does differently or not at all. Synesthesia
 * ships this exact idea as first-class uniforms (`syn_BassTime`,
 * `syn_MidTime`, `syn_HighTime`: "advance with that band's intensity, so
 * motion accumulates with energy and STOPS when the band does") specifically
 * because it is the cheapest way to make ANY animation read as audio-reactive
 * — one substitution, `uTime` for `uBassClock`, and a rotation or a drift
 * inherits the music's own rhythm of motion and stillness for free.
 *
 * ## Why three bands and not more
 *
 * `bass`, `mid`, `high` are already the three-way split used throughout the
 * rest of this engine (`AudioFeatures.bass/mid/high`, `MoodEstimator`'s own
 * scoring) — reusing it rather than inventing a fourth split (Synesthesia's
 * own Bass/Mid/MidHigh/High) keeps one vocabulary for "which band" across the
 * whole codebase instead of two slightly different ones.
 *
 * ## Why a session singleton, not per-scene state
 *
 * A primary, a crossfade partner and up to three composition layers can be
 * mounted at once, all sharing the same audio. A clock owned per-scene-
 * instance would restart on every mount (a layer swapping in would see
 * `uBassClock` reset to 0, reading as a hitch) and would drift out of sync
 * between simultaneously-mounted scenes for no reason — the music's bass
 * does not care how many scenes are drawing it. One clock, advanced once per
 * frame by `PerformanceStateBridge` (the established single-writer for
 * exactly this kind of derived-from-audio engine state — see
 * `performanceState.valence`/`.arousal`), read by every scene.
 */
export interface BandClocks {
  bass: number
  mid: number
  high: number
}

/** Every clock at zero — the state a fresh session starts in. */
export function createBandClocks(): BandClocks {
  return { bass: 0, mid: 0, high: 0 }
}

/**
 * Rate a band's clock advances per second of wall-clock time, per unit of
 * that band's own 0..1 level.
 *
 * 1.0 means a band pinned at full level advances its clock at the same rate
 * `uTime` does — so swapping `uTime` for a band clock in an existing rotation
 * or drift term reproduces the ORIGINAL speed exactly whenever that band is
 * maxed out, and only slows relative to it as the band falls quiet. That is
 * the property that makes the substitution safe to drop into a scene
 * authored against `uTime`: it changes what happens in the quiet, not what
 * happens at the loudest moment.
 */
const BAND_CLOCK_RATE = 1.0

/**
 * Advance every clock by one frame.
 *
 * Pure — takes and returns a `BandClocks`, allocates a new object rather than
 * mutating `state` in place, so it is trivially testable without a mutable
 * singleton in the loop. The singleton wrapper below is the only place that
 * mutates.
 *
 * Total: a non-finite `dt` or band level is treated as zero rather than
 * corrupting the clock — a single bad frame must not freeze or explode a
 * value every mounted scene reads every frame after it.
 */
export function stepBandClocks(state: BandClocks, f: Pick<AudioFeatures, 'bass' | 'mid' | 'high'>, dt: number): BandClocks {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0
  const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)
  return {
    bass: state.bass + clamp01(f.bass) * BAND_CLOCK_RATE * d,
    mid: state.mid + clamp01(f.mid) * BAND_CLOCK_RATE * d,
    high: state.high + clamp01(f.high) * BAND_CLOCK_RATE * d,
  }
}

/**
 * Live band clocks. A mutable singleton in the same shape as `exposure` and
 * `frameLoad`: one writer (`PerformanceStateBridge`), many readers
 * (`createShaderScene`, once per mounted scene per frame).
 */
export const bandClocks: BandClocks = createBandClocks()

/** Advance the live singleton in place — the one function anything other
 *  than a test should call. */
export function advanceBandClocks(f: Pick<AudioFeatures, 'bass' | 'mid' | 'high'>, dt: number): void {
  const next = stepBandClocks(bandClocks, f, dt)
  bandClocks.bass = next.bass
  bandClocks.mid = next.mid
  bandClocks.high = next.high
}

/** Reset to zero — for a context loss, or a test. */
export function resetBandClocks(): void {
  bandClocks.bass = 0
  bandClocks.mid = 0
  bandClocks.high = 0
}

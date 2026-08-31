/**
 * Tempo-locked oscillators, derived from the beat grid this engine already
 * tracks (`AudioFeatures.beatIndex` / `.beatProgress`) — a scene can be IN
 * TIME with the music without running its own beat detection.
 *
 * ## Why this needs no new state
 *
 * Unlike `bandClocks.ts`'s per-band clocks, a tempo oscillator is a pure
 * function of the beat position the audio engine already publishes every
 * frame — `beatProgress` (0..1 through the current beat) and `beatIndex`
 * (a running count) together are all three cycle lengths below need. No
 * accumulator, no singleton, no "advance once per frame" ordering to get
 * right.
 *
 * ## Why sine only, not sine-and-triangle
 *
 * Synesthesia ships both waveforms at all three rates (six uniforms). Sine is
 * the more broadly useful primitive — a scene wanting a sharper, triangle-like
 * edge can derive one from a sine in its own shader (`sign()`/`abs()`
 * combinations are cheap), where the reverse is not true. Shipping three sine
 * uniforms rather than six covers the actual ask ("tempo-locked oscillators")
 * without doubling the prelude's uniform surface for a waveform every scene
 * can approximate from the one already given.
 */

/**
 * 0..1 phase through a cycle spanning `beatsPerCycle` beats, given the
 * current beat index and progress through it.
 *
 * Pure and total: a non-finite or negative `beatsPerCycle` falls back to 1
 * (a per-beat cycle) rather than dividing by zero or producing NaN.
 */
export function beatCyclePhase(beatIndex: number, beatProgress: number, beatsPerCycle: number): number {
  const cycle = Number.isFinite(beatsPerCycle) && beatsPerCycle > 0 ? beatsPerCycle : 1
  const idx = Number.isFinite(beatIndex) ? Math.max(0, Math.trunc(beatIndex)) : 0
  const prog = Number.isFinite(beatProgress) ? Math.min(1, Math.max(0, beatProgress)) : 0
  const positionInCycle = (idx % cycle) + prog
  return (positionInCycle / cycle) % 1
}

/** sin(2π · phase) of a `beatsPerCycle`-beat cycle — -1..1. */
export function beatSin(beatIndex: number, beatProgress: number, beatsPerCycle: number): number {
  return Math.sin(beatCyclePhase(beatIndex, beatProgress, beatsPerCycle) * Math.PI * 2)
}

/** The three rates exposed as scene uniforms: per-beat, per-2-beats, per-bar
 *  (4 beats, matching this engine's own bar length). */
export interface BeatOscillators {
  /** sin at 1 cycle per beat. */
  sin1: number
  /** sin at 1 cycle per 2 beats — half the frequency of {@link sin1}. */
  sin2: number
  /** sin at 1 cycle per bar (4 beats) — a quarter the frequency of {@link sin1}. */
  sin4: number
}

/** All three oscillators for the current beat position. */
export function beatOscillators(beatIndex: number, beatProgress: number): BeatOscillators {
  return {
    sin1: beatSin(beatIndex, beatProgress, 1),
    sin2: beatSin(beatIndex, beatProgress, 2),
    sin4: beatSin(beatIndex, beatProgress, 4),
  }
}

/**
 * Sensory-adaptation state for a binary strong-effect gate — the mirror rack
 * and the lens rack, both of which `opticalDirector.ts` already describes as
 * "mostly off, chosen at a musical boundary, held for a duration once
 * chosen." What was missing (visual-engine audit, finding 03 — "every
 * selection in the product is modulo arithmetic on a counter") was memory:
 * each gate was a bare `seed % n` roll with no notion of how recently the
 * effect last fired, so it could legally engage in two consecutive sections
 * and then sit out six, and the roll could not tell "just fired" from
 * "hasn't fired in a while" apart. Documented directly in this codebase's own
 * comments — `mirrorForSection` retiring `wallpaper`/`shear` because "the
 * index-3 kaleido behind it had never once been selected" is the concrete
 * failure mode this exists to remove.
 *
 * ## The model
 *
 * One number, `exposure`, 0 (fresh) to 1 (fully habituated). It rises toward
 * 1 while the effect is engaged and decays toward 0 while it is not — real
 * sensory habituation, not a counter. `habituatedGate` reads it to DAMPEN the
 * base engagement rate rather than override it: a rack that just fired is
 * less likely to fire again next decision, and the effect wears off exactly
 * as the exposure that caused it does.
 *
 * ## Why the roll stays deterministic
 *
 * Every selection elsewhere in this engine — `pickPalette`, `pickVariedMode`,
 * `pickTransitionStyle` — is a pure function of a seed specifically so a
 * recorded set replays identically. `habituatedGate` keeps that: the state
 * shifts the THRESHOLD the seed is compared against, not the comparison
 * itself, so the same (seed, exposure) pair always produces the same
 * decision and a session log stays reproducible.
 */
export interface Habituation {
  /** 0 (fresh) .. 1 (fully habituated). */
  exposure: number
}

/** A rack that has never fired — the state every session starts in. */
export function createHabituation(): Habituation {
  return { exposure: 0 }
}

/**
 * Advance the exposure state by one DECISION (one phrase or section, not one
 * frame — the racks this feeds are re-decided at musical boundaries, and
 * stepping per-frame would make the rise/decay rates mean a different thing
 * depending on how long a section happened to last).
 *
 * `riseRate`/`decayRate` are the fraction of the remaining distance to the
 * target covered per step — the same exponential-approach shape `approach()`
 * in performanceState.ts uses elsewhere in this engine, discretised to one
 * step per call instead of scaled by `delta`. Rise is faster than decay by
 * default (0.45 vs 0.22): a SINGLE firing should meaningfully raise the
 * exposure (one showing is enough to risk feeling repetitive next time), but
 * forgetting that firing should take a few sections, not one — otherwise the
 * gate has no memory beyond the immediately preceding decision, which is the
 * bare-modulo behaviour this replaces in a single step's clothing.
 */
export function stepHabituation(
  state: Habituation,
  engaged: boolean,
  riseRate = 0.45,
  decayRate = 0.22,
): Habituation {
  const target = engaged ? 1 : 0
  const rate = engaged ? riseRate : decayRate
  const current = Number.isFinite(state.exposure) ? state.exposure : 0
  const next = current + (target - current) * rate
  return { exposure: Math.min(1, Math.max(0, next)) }
}

/**
 * Deterministically decide whether a strong effect should engage this
 * decision, given a seed (for reproducibility — see the module header) and
 * the current habituation state.
 *
 * `baseRate` is the engagement probability at zero habituation — e.g. 5/6
 * for the mirror rack's original "five sections in six". `dampening` (0..1)
 * is how much FULL habituation suppresses that rate; at 1, a fully-habituated
 * gate fires at `floor` only, at 0 habituation has no effect at all (which
 * degenerates to the original blind modulo). `floor` keeps a minimum chance
 * alive even at full habituation, so a long high-arousal passage cannot lock
 * the effect off for the rest of the set — a gate that can never reopen is a
 * switch, not a gate.
 *
 * The roll is `seed` reduced into a wide fixed range and compared against the
 * dampened rate, which is what lets the threshold move continuously while the
 * comparison itself stays a simple deterministic inequality.
 */
export function habituatedGate(
  seed: number,
  state: Habituation,
  baseRate: number,
  dampening = 0.7,
  floor = 0.1,
): boolean {
  const exposure = Number.isFinite(state.exposure) ? Math.min(1, Math.max(0, state.exposure)) : 0
  const rate = Math.max(floor, Math.min(1, baseRate * (1 - exposure * dampening)))
  const resolution = 997 // prime, so it shares no common factor with small seed strides
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 0
  const roll = ((s % resolution) + resolution) % resolution
  return roll < rate * resolution
}

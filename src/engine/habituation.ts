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
 * Spread a small, densely-sequential seed across the full 32-bit range in one
 * multiply (Knuth's multiplicative hash — the constant is `2^32` times the
 * golden ratio's conjugate, the standard choice for this exact purpose).
 *
 * ## Why this had to exist (F239)
 *
 * `habituatedGate` used to reduce `seed` into its comparison range with a bare
 * `seed % resolution` — reproducible, and reasoned as safe because `resolution`
 * is prime "so it shares no common factor with small seed strides." That
 * reasoning covers ALIASING (a fixed stride landing on a short repeating
 * cycle); it says nothing about DISTRIBUTION, and the callers that actually
 * exist in this codebase expose exactly the gap between those two properties.
 *
 * Every real caller's seed (`sectionCount`/`mirrorSeed` in
 * `PerformanceStateBridge.tsx`) is a `useRef(0)` incremented by exactly 1 per
 * DECISION, not per frame — and a decision is rare by design: the lens
 * re-decides on a section change or an 8-phrase backstop, on the order of
 * once a minute. `seed % resolution` for `seed = 0, 1, 2, 3, …` is just
 * `0, 1, 2, 3, …` again for any session with fewer than `resolution` (997)
 * decisions — every realistic session there is. A live 131s session recording
 * showed the failure directly: the lens's `roll` never rose out of the
 * single digits, and even FULL habituation only dampens the comparison
 * threshold down to `floor * resolution` (≈100 at the lens's own 0.1 floor)
 * — so `roll < threshold` held on literally every decision the whole
 * session, regardless of what the habituation state said. The gate was not
 * merely weak, it was structurally unreachable below ~100 decisions, which
 * at the lens's own cadence is on the order of an hour and a half. The
 * mirror's own seed happens to climb faster (a repick most phrase edges
 * rather than roughly once a minute), which is why its duty cycle in that
 * SAME recording showed real on/off cycling while the lens's read 100%,
 * `longest on` spanning nearly the entire session.
 *
 * A single multiplicative-hash step fixes this at the source: consecutive
 * seeds (0, 1, 2, …) hash to values scattered across the whole 32-bit range,
 * so `roll` explores the comparison range from the very first decision
 * instead of needing hundreds of calls to climb there. Deterministic and
 * total for the same reason the rest of this module is — same seed, same
 * hash, always.
 */
function hashSeed(s: number): number {
  return Math.imul(s, 0x9e3779b9) >>> 0
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
 * The roll is `seed` HASHED (see {@link hashSeed} — F239) into a wide fixed
 * range and compared against the dampened rate, which is what lets the
 * threshold move continuously while the comparison itself stays a simple
 * deterministic inequality.
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
  const roll = hashSeed(s) % resolution
  return roll < rate * resolution
}

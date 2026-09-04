/**
 * Response primitives — the SHAPES a scene can answer the music with.
 *
 * ## Why this file exists
 *
 * An audit of all 22 live scenes found the reaction vocabulary had collapsed to
 * one idea. Measured, not impressionistic:
 *
 *     brightness/glow from an audio envelope ... 22 of 22 scenes
 *     audio -> some size/scale term ............ 14 of 22
 *     spring / overshoot .......................  0
 *     audio-driven delay or propagation ........  0
 *     counter-motion (shrinks on a hit) ........  1
 *     scenes reading bar / phrase / section ....  3 of 22
 *
 * Ten of the twelve `createShaderScene` scenes share a near-identical mapping —
 * `mids`->a rate, `highs`->a detail term, `energy`->brightness, `onKick`->an
 * `exp(-dt*k)` decay into brightness, `sub`->one radius — and ten of them
 * independently wrote that same `exp()` decay with k between 0.9 and 4.5. The
 * bands ARE separated; they are separated onto the same three properties in ten
 * different scenes. That is why visually distinct scenes read as one idea.
 *
 * The cause is structural rather than a failure of imagination per scene: the
 * response SHAPE lived inside each scene, so every author reinvented the only
 * one the codebase made easy. This file is the missing half of the vocabulary —
 * each primitive here exists because **nothing in the roster could express it**.
 *
 * ## What is deliberately NOT here
 *
 * `approach()` (performanceState.ts) — the symmetric one-pole — and `drastic()`
 * / `bipolar()` (scenes/contract.ts) — the dial expansions — already exist and
 * are correct. This sits beside them; it does not replace or re-export them. A
 * scene wanting plain smoothing should still use `approach`.
 *
 * ## Frame-rate independence
 *
 * Every continuous helper here is exponential in `dt` for the reason
 * `approach()`'s own doc records at length: the first-order form
 * (`x += (target-x) * dt * rate`) both SNAPS once `dt*rate >= 1` and changes
 * shape with frame rate, so a response tuned on one machine is a different
 * response on another — and it stops easing at exactly the moment a struggling
 * machine most needs it to. The spring is the one exception and says why.
 */

/**
 * Longest frame step any helper here will integrate in one go, in seconds.
 *
 * A tab returning from the background, a shader compile, or a GC pause hands
 * the render loop a `dt` of hundreds of milliseconds. The exponential helpers
 * are unconditionally stable under that (they asymptote), but {@link springStep}
 * is a numerical integrator and genuinely explodes: one 0.5s step at a useful
 * stiffness overshoots so far that the spring never returns. Clamping costs a
 * comparison and turns "the scene detonates on the frame you alt-tabbed back"
 * into "the spring is a beat late", which is the correct trade for a visual.
 */
const MAX_STEP_SEC = 1 / 30

/** Frame delta, clamped and made safe against a non-finite or negative value. */
function safeDt(dt: number): number {
  if (!isFinite(dt) || dt <= 0) return 0
  return Math.min(dt, MAX_STEP_SEC)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/* ------------------------------------------------------------------ spring */

/**
 * A mass on a spring: position and velocity. Mutated in place.
 *
 * Mutable rather than returned-fresh for the reason `performanceState`'s header
 * gives — the render loop runs at 60fps and allocates nothing — and stored by
 * the scene in its own `state()` object exactly like the `shock` accumulators
 * it replaces.
 */
export interface SpringState {
  value: number
  velocity: number
}

/** A spring at rest at `value`. */
export function spring(value = 0): SpringState {
  return { value, velocity: 0 }
}

/**
 * Advance a spring one frame toward `target`. Returns the new value.
 *
 * ## Why this and not another `exp()` decay
 *
 * This is the primitive the roster had no way to express. `exp(-dt*k)` only
 * ever FALLS: charge it on a kick and it slides monotonically back to zero, so
 * every hit reads as the same soft thud. A spring overshoots and settles —
 * which is what makes a hit read as though the thing hit had MASS. It is the
 * difference between a brightness multiplier and a physical event, and it is
 * the single cheapest way to make two scenes reacting to the same kick feel
 * unlike each other.
 *
 * ## Integration
 *
 * Semi-implicit (symplectic) Euler — velocity updated from the force first,
 * then position from the NEW velocity. Explicit Euler (position first) injects
 * energy every step and a lightly-damped spring under it slowly winds itself
 * up instead of settling; the semi-implicit form is stable for the stiffnesses
 * a visual wants and costs the same two multiplies.
 *
 * `dt` is clamped by {@link safeDt} — see {@link MAX_STEP_SEC} for why this
 * integrator, unlike everything else in this file, genuinely needs that.
 *
 * @param stiffness pull toward the target. Higher = faster, tighter. ~40-200.
 * @param damping   velocity bleed. Below `2*sqrt(stiffness)` it overshoots
 *                  (which is usually the point); at that value it is critically
 *                  damped and settles without ringing; above, it is sluggish.
 */
export function springStep(
  st: SpringState,
  target: number,
  dt: number,
  stiffness: number,
  damping: number,
): number {
  const step = safeDt(dt)
  if (step === 0) return st.value
  const accel = stiffness * (target - st.value) - damping * st.velocity
  st.velocity += accel * step
  st.value += st.velocity * step
  return st.value
}

/**
 * Damping that makes {@link springStep} critically damped for a given
 * stiffness — the fastest approach to the target with NO overshoot.
 *
 * Offered because the useful range is relative to stiffness, not absolute:
 * `damping: 12` is bouncy at stiffness 400 and sluggish at stiffness 20, and a
 * scene author tuning by hand will otherwise discover that the hard way. Scale
 * this by <1 to get deliberate overshoot, >1 to get a lazy settle.
 */
export function criticalDamping(stiffness: number): number {
  return 2 * Math.sqrt(Math.max(0, stiffness))
}

/* -------------------------------------------------------------------- slew */

/**
 * Asymmetric follower: approach `target` at one rate when rising and another
 * when falling.
 *
 * The cheapest way to break the monoculture, because the roster's ubiquitous
 * `shock *= exp(-dt*k)` is exactly the symmetric case with an instant attack.
 * A fast rise and slow fall reads as a struck bell; a slow rise and fast fall
 * reads as a swell that gets cut off — completely different characters from
 * one identical kick envelope, with no new signal needed.
 *
 * Same exponential form as `approach()`, so it is frame-rate independent and
 * cannot snap; `riseRate === fallRate` reduces to exactly that function.
 */
export function slew(
  current: number,
  target: number,
  dt: number,
  riseRate: number,
  fallRate: number,
): number {
  const step = safeDt(dt)
  if (step === 0) return current
  const rate = target > current ? riseRate : fallRate
  if (!(rate > 0)) return current
  return current + (target - current) * (1 - Math.exp(-step * rate))
}

/* ----------------------------------------------------------------- impulse */

/**
 * When something last fired, in engine seconds. Mutated in place.
 *
 * The JS half of propagation: a travelling pulse needs to know how long ago the
 * impulse happened, and a shader cannot remember that on its own. Pair with
 * `TRAVELLING_PULSE_GLSL` (engine/shaderLib.ts), which turns
 * `(sinceImpulse, position)` into a wave crossing the geometry.
 */
export interface ImpulseClock {
  /** Engine time of the last fire. `-Infinity` until one happens. */
  lastAt: number
}

/** An impulse clock that has never fired. */
export function impulseClock(): ImpulseClock {
  return { lastAt: -Infinity }
}

/**
 * Record an impulse if `fired`, then report seconds since the last one.
 *
 * Returns a large finite number rather than `Infinity` before the first fire,
 * so a shader multiplying by it cannot produce a NaN — the same defensive
 * instinct as the `max(d, 1e-3)` guards throughout the roster's raymarchers.
 * A clock rewind (`features.time` restarts at 0 on a new source) reads as
 * negative elapsed and is reported as "long ago" for the same reason.
 */
export function sinceImpulse(st: ImpulseClock, now: number, fired = false): number {
  if (fired) st.lastAt = now
  const elapsed = now - st.lastAt
  return isFinite(elapsed) && elapsed >= 0 ? elapsed : 1e4
}

/* -------------------------------------------------------------------- gate */

/**
 * Deterministic 0..1 hash of an integer. Same input, same output, forever.
 */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Should this occurrence fire? Deterministic for a given `seed`.
 *
 * Restraint as a technique. Every kick doing something is what makes a scene
 * read as a strobe rather than as a performance — reactions that land
 * OCCASIONALLY read as intentional. Feed the beat index (or bar number) as the
 * seed so the pattern is stable: the same beat of the same track always makes
 * the same decision.
 *
 * Deterministic rather than `Math.random()` on purpose, and this is a hard
 * requirement rather than tidiness — the same reasoning `pickTransitionStyle`'s
 * rotation records: a recorded show has to replay identically, and a random
 * gate would make every playback of the same session a different edit.
 */
export function gate(seed: number, probability: number): boolean {
  const p = clamp01(probability)
  if (p >= 1) return true
  if (p <= 0) return false
  return hash01(Math.floor(seed)) < p
}

/* -------------------------------------------------------- structural gates */

/**
 * Is this the first beat of the bar?
 *
 * Exists because `f.beatInBar` currently has **zero readers across the entire
 * scene roster** — the engine has tracked bar position all along and nothing
 * has ever used it. A reaction that lands on the downbeat and sits still for
 * the other three beats is musically legible in a way that reacting to all four
 * identically is not, and it costs one comparison.
 */
export function isDownbeat(beatInBar: number): boolean {
  return Math.floor(beatInBar) === 0
}

/**
 * Position through the current bar, 0..1 — a continuous ramp rather than a
 * per-beat pulse, for anything that should sweep or build across four beats.
 *
 * `beatsPerBar` is a parameter rather than assumed 4 so a scene can ask for a
 * two-bar or half-bar sweep without reimplementing the modulo.
 */
export function barPhase(beatIndex: number, beatProgress: number, beatsPerBar = 4): number {
  const beats = Math.max(1, beatsPerBar)
  const pos = (beatIndex % beats) + clamp01(beatProgress)
  return clamp01(pos / beats)
}

/**
 * True once every `n` bars, on the downbeat.
 *
 * The coarse structural gate the roster has nothing for: three of 22 scenes
 * read anything above per-frame level at all, so nothing currently changes on a
 * musical timescale a listener actually tracks. Use for the changes that should
 * feel composed rather than reactive — a palette shift, a fold count, a camera
 * behaviour.
 */
export function everyNBars(beatIndex: number, beatInBar: number, n: number, beatsPerBar = 4): boolean {
  if (!isDownbeat(beatInBar)) return false
  const bars = Math.floor(Math.max(0, beatIndex) / Math.max(1, beatsPerBar))
  return bars % Math.max(1, Math.floor(n)) === 0
}

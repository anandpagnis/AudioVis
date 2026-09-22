import type { CharacterState } from './characterTypes'
import { LEGACY_MAP } from './moodTaxonomy'
import type { MoodMomentum, MoodState } from './types'

/**
 * The "look" of the show: what the post-FX racks, camera, filters, bloom and
 * scene steering key on, made CHARACTER-AWARE.
 *
 * Those systems are hand-tuned, art-directed tables keyed on the old 7-state
 * `MoodState`. Re-authoring them blind (no way to see the result here) would be
 * a gamble, so instead of replacing the tables this changes WHICH row they read.
 *
 * ## Who decides what
 *  - CHARACTER (slow, seconds; what the music feels like) supplies the FLAVOUR:
 *    a serene song reads `ambient`, a tense one `building`, an epic one `peak`
 *    (via `LEGACY_MAP`, the taxonomy's own mapping).
 *  - The OLD detector (fast, frame-level; how intense THIS moment is) keeps
 *    control of intensity events and of quiet moments:
 *      - `silence` stays `silence`.
 *      - `building` / `peak` (real energy dynamics: a build, a drop) pass through.
 *      - A quiet moment (`ambient`/`mellow`) CAPS the look at `groove`, so a
 *        breakdown in an epic song does not get peak effects.
 *      - `aggressive` stands when the character agrees it is intense.
 *  - Until the character read is valid, the old state is used unchanged.
 *
 * `MoodMomentum.look` holds the result; consumers read `lookOf(m)`. Timing
 * triggers (scene-switch edges, drops, predicted transitions) and telemetry
 * (the UI pill, the session log) deliberately stay on the old `state`.
 */
export function lookState(legacy: MoodState, cs: CharacterState): MoodState {
  if (legacy === 'silence') return 'silence'
  if (!cs.valid || cs.primary === null) return legacy
  if (legacy === 'building' || legacy === 'peak') return legacy
  if (legacy === 'aggressive' && cs.arousal > 0.75) return 'aggressive'
  const mapped: MoodState = LEGACY_MAP[cs.primary]
  const quiet = legacy === 'ambient' || legacy === 'mellow'
  if (quiet && (mapped === 'building' || mapped === 'peak' || mapped === 'aggressive')) return 'groove'
  return mapped
}

/**
 * Kill switch shared with the scene and palette pickers (`engine/characterPick.ts`): `?scenepick=legacy`
 * in the URL restores the original mood-label behaviour everywhere, including the look.
 */
export function characterLookEnabled(): boolean {
  try {
    if (typeof location === 'undefined') return true
    return new URLSearchParams(location.search).get('scenepick') !== 'legacy'
  } catch {
    return true
  }
}

/** The state the effect systems should read: the character-aware look, or the raw state before it exists. */
export function lookOf(m: Pick<MoodMomentum, 'state' | 'look'>): MoodState {
  return m.look ?? m.state
}

// --- visual multipliers --------------------------------------------------------

/** Ends of each multiplier's range: the same endpoints the old per-state table spans (ambient .. peak). */
const INTENSITY: readonly [number, number] = [0.78, 1.32]
const SPEED: readonly [number, number] = [0.6, 1.4]
const REACTIVITY: readonly [number, number] = [0.9, 1.4]
/** Share of the character-derived value in the final multiplier; the rest is the old state's, so drops keep their punch. */
export const CHARACTER_VIZ_SHARE = 0.65

const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * Math.min(1, Math.max(0, t))

export interface Viz {
  intensity: number
  speed: number
  reactivity: number
}

/**
 * Character-derived visual multipliers (intensity / speed / reactivity), eased slowly like the old ones
 * ("weather, not switches"), then blended with the old state's own multipliers.
 * Continuous in arousal and pulse, where the old table jumped between seven values.
 */
export class LookVizTracker {
  private v: Viz = { intensity: 1, speed: 1, reactivity: 1 }
  private seeded = false

  reset() {
    this.seeded = false
  }

  /** Writes the blended multipliers into `out` (reads `legacy`, the old state's smoothed values). */
  update(cs: CharacterState, legacy: Viz, dt: number, out: Viz): void {
    if (!cs.valid) {
      out.intensity = legacy.intensity
      out.speed = legacy.speed
      out.reactivity = legacy.reactivity
      return
    }
    const a = Number.isFinite(cs.arousal) ? cs.arousal : 0.5
    const p = Number.isFinite(cs.pulse) ? cs.pulse : 0.5
    const target: Viz = {
      intensity: lerp(INTENSITY, a),
      speed: lerp(SPEED, 0.65 * a + 0.35 * p),
      reactivity: lerp(REACTIVITY, 0.5 * a + 0.5 * p),
    }
    if (!this.seeded) {
      this.v = target
      this.seeded = true
    } else {
      // A non-finite or negative dt must not poison the smoothing state (Math.max(0, NaN) is NaN).
      const k = Number.isFinite(dt) && dt > 0 ? Math.min(1, dt * 0.8) : 0
      this.v.intensity += (target.intensity - this.v.intensity) * k
      this.v.speed += (target.speed - this.v.speed) * k
      this.v.reactivity += (target.reactivity - this.v.reactivity) * k
    }
    const s = CHARACTER_VIZ_SHARE
    out.intensity = s * this.v.intensity + (1 - s) * legacy.intensity
    out.speed = s * this.v.speed + (1 - s) * legacy.speed
    out.reactivity = s * this.v.reactivity + (1 - s) * legacy.reactivity
  }
}

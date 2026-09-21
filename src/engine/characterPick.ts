import { MOOD_PROTOTYPES } from '../audio/moodTaxonomy'
import type { CharacterPoint, CharacterState } from '../audio/characterTypes'
import type { SceneDef } from '../scenes'
import { pickSceneForCharacter, songSeedFrom } from '../scenes/character'

/**
 * Glue between the directors (AutoPilot, PerformanceDirector) and the
 * character-driven scene picker in `scenes/character.ts`.
 *
 * Every function returns `null` when it cannot decide (character read not ready,
 * feature switched off, nothing to pick from), and the caller then runs its
 * original mood-label pick. So the new path can only ever ADD variety; it can
 * never leave the show without a scene.
 */

/** Kill switch: `?scenepick=legacy` in the URL restores the old mood-label pick. */
export function characterPickEnabled(): boolean {
  try {
    if (typeof location === 'undefined') return true
    return new URLSearchParams(location.search).get('scenepick') !== 'legacy'
  } catch {
    return true
  }
}

/** Character drift (0..1, Euclidean over valence/arousal/tension) that counts as "a different song". */
const NEW_SONG_DISTANCE = 0.4
/** ... sustained for this many seconds, so one dramatic passage does not re-roll the cast. */
const NEW_SONG_HOLD_SEC = 25

/**
 * The per-song "cast" seed. A live stream has no reliable song boundary, so a
 * song is approximated as: from the first valid character read after a source
 * change, until the character moves far from where it was anchored and stays
 * there. Two songs with the same character then still get different scene casts.
 */
class SongSeedTracker {
  private anchor: CharacterPoint | null = null
  private seed = 0
  private driftSince = -1

  reset() {
    this.anchor = null
    this.driftSince = -1
  }

  get(cs: CharacterState, key: string, now: number): number {
    if (!this.anchor) {
      this.anchor = { valence: cs.valence, arousal: cs.arousal, tension: cs.tension, pulse: cs.pulse }
      this.seed = songSeedFrom(this.anchor, key)
      this.driftSince = -1
      return this.seed
    }
    const dv = cs.valence - this.anchor.valence
    const da = cs.arousal - this.anchor.arousal
    const dt = cs.tension - this.anchor.tension
    const far = Math.sqrt(dv * dv + da * da + dt * dt) > NEW_SONG_DISTANCE
    if (!far) this.driftSince = -1
    else if (this.driftSince < 0) this.driftSince = now
    else if (now - this.driftSince >= NEW_SONG_HOLD_SEC) {
      this.anchor = { valence: cs.valence, arousal: cs.arousal, tension: cs.tension, pulse: cs.pulse }
      this.seed = songSeedFrom(this.anchor, key)
      this.driftSince = -1
    }
    return this.seed
  }
}

const seedTracker = new SongSeedTracker()

/** The current per-song seed (shared by the scene picker and the palette picker so a song's cast and palette agree). */
export function songSeedFor(cs: CharacterState, key: string, now: number): number {
  return seedTracker.get(cs, key, now)
}

export interface CharacterPickOptions {
  /** The character read (`audioEngine.features.character`). */
  character: CharacterState
  /** Musical key string (`f.key`), '' if unknown; folded into the per-song seed. */
  key: string
  /** Seconds (`f.time`). */
  now: number
  recentIds: readonly string[]
  exclude?: readonly string[]
  /** Soft multiplier per scene (>1 favours). */
  boost?: (scene: SceneDef) => number
  /** Raise arousal to at least this (used to pre-arm the scene for an imminent drop). */
  minArousal?: number
  /**
   * Raise tension to at least this. With `minArousal` this is the "lift": it moves the point the picker fits,
   * not just the weights. That matters because affinity is raised to ^3.5, so a `boost` alone cannot flip a
   * poor fit (a calm-point pick never reaches a fast scene however hard it is favoured); a build or a drop
   * that wants a fast, tense scene lifts the point toward it instead.
   */
  minTension?: number
  /**
   * Apply `minArousal` / `minTension` to the runner-up mood's point as well (default false: primary point only,
   * as `minArousal` always was). The runner-up carries up to half the blended affinity, so an unlifted calm
   * runner-up keeps pulling calm scenes into a lifted pick; the confirmed-build switch turns this on.
   */
  liftSecondary?: boolean
  rng?: () => number
}

/** The runner-up mood's point, with the lift applied only when the caller asked for it (`liftSecondary`). */
function secondaryPoint(center: CharacterPoint, o: CharacterPickOptions): CharacterPoint {
  if (!o.liftSecondary) return center
  return {
    valence: center.valence,
    arousal: Math.max(o.minArousal ?? 0, center.arousal),
    tension: Math.max(o.minTension ?? 0, center.tension),
    pulse: center.pulse,
  }
}

/** Pick one scene from `candidates` by character fit, or null to make the caller fall back. */
export function pickByCharacter(candidates: readonly SceneDef[], o: CharacterPickOptions): SceneDef | null {
  const cs = o.character
  if (!characterPickEnabled() || !cs.valid || !cs.primary || candidates.length === 0) {
    if (!cs.valid) seedTracker.reset()
    return null
  }
  const point: CharacterPoint = {
    valence: cs.valence,
    arousal: Math.max(o.minArousal ?? 0, cs.arousal),
    tension: Math.max(o.minTension ?? 0, cs.tension),
    pulse: cs.pulse,
  }
  const boost: Record<string, number> = {}
  if (o.boost) {
    for (const c of candidates) {
      const b = o.boost(c)
      if (b !== 1 && Number.isFinite(b)) boost[c.id] = b
    }
  }
  const secondary =
    cs.secondary && cs.secondaryWeight > 0
      ? { point: secondaryPoint(MOOD_PROTOTYPES[cs.secondary].center, o), weight: cs.secondaryWeight }
      : null
  const id = pickSceneForCharacter({
    candidates: candidates.map((c) => c.id),
    character: point,
    secondary,
    recentIds: o.recentIds,
    songSeed: seedTracker.get(cs, o.key, o.now),
    rng: o.rng ?? Math.random,
    exclude: o.exclude,
    boost,
  })
  return id ? (candidates.find((c) => c.id === id) ?? null) : null
}

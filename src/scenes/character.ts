/**
 * Character-driven scene selection.
 *
 * ## Why this exists
 *
 * The mood engine used to pick scenes from a 6-way `MoodState` label through
 * `moodFit` tables. That produced "every song plays the same scenes":
 *
 *  - the per-mood pools overlap ~90% (nine of ten `ambient` primaries are also
 *    `groove` primaries),
 *  - `moodFit` weights only span 0.6-0.95 and were floored at 0.2, so a
 *    weighted-random pick over them is close to uniform,
 *  - recency memory was four scenes deep, and
 *  - a scene's valence/arousal was DERIVED by averaging its `moodFit`, so the
 *    roster clustered around the middle of the plane.
 *
 * The CHARACTER layer (`audio/characterTypes.ts`) describes the music as a
 * continuous point in a 4-D space (valence, arousal, tension, pulse) plus a
 * distribution over 14 named moods. This module is the other half of that
 * contract: every scene declares, EXPLICITLY, where in that same space it
 * looks right ({@link SCENE_CHARACTER}), and {@link pickSceneForCharacter}
 * chooses by geometric fit instead of by a shared mood label.
 *
 * ## What a scene's character is
 *
 * It is authored from what the scene looks like and does (palette, motion,
 * density, what it is *about*), NOT averaged from `moodFit`:
 *
 *   valence   0 = dark / cold / hostile        1 = bright / warm / joyful
 *   arousal   0 = near-still                   1 = frantic
 *   tension   0 = relaxed, consonant, smooth   1 = anxious, jagged, unresolved
 *   pulse     0 = free-floating, beat-agnostic 1 = beat-locked, rhythmic
 *
 * `spread` is one isotropic sigma (in the same 0..1 units): how far from its
 * centre the scene still looks convincing. Narrow (~0.2) for scenes with one
 * unmistakable mood, wide (~0.4+) for chameleons.
 *
 * ## Layering
 *
 * This file is pure: no three.js, no store, no scene registry import (so the
 * registry may import it without a cycle). The test in
 * `__tests__/characterSelection.test.ts` fails when a live scene has no entry
 * here, so every future scene is forced to declare its character.
 */

import type { CharacterMood, CharacterPoint } from '../audio/characterTypes'
import { MOOD_PROTOTYPES } from '../audio/moodTaxonomy'

// ---------------------------------------------------------------------------
// Scene centres
// ---------------------------------------------------------------------------

/** Where a scene sits in character space, plus how forgiving it is. */
export interface SceneCharacter extends CharacterPoint {
  /** Isotropic sigma of the scene's affinity Gaussian, 0..1 units. */
  spread: number
  /** One-line justification, from what the scene actually looks like/does. */
  notes: string
}

const sc = (
  valence: number,
  arousal: number,
  tension: number,
  pulse: number,
  spread: number,
  notes: string,
): SceneCharacter => ({ valence, arousal, tension, pulse, spread, notes })

/**
 * One explicit entry per scene id: every LIVE scene (`SCENES`) and every
 * quarantined one (`DISABLED_SCENES`), so promoting a scene out of quarantine
 * needs no new authoring. Validated by characterSelection.test.ts in both
 * directions (missing entry for a live scene; entry for an unknown id).
 */
export const SCENE_CHARACTER: Record<string, SceneCharacter> = {
  // --- Live primaries ------------------------------------------------------
  wireframe: sc(
    0.4,
    0.35,
    0.5,
    0.3,
    0.32,
    'Cold blueprint edge-cage with drafting annotations: analytic, detached, slightly uneasy; reads as a schematic more than a feeling, so it is a wide-spread cool scene.',
  ),
  plasma: sc(
    0.3,
    0.9,
    0.68,
    0.55,
    0.26,
    'One hot core spraying shard filaments into black, 70k particles: violent, radiating, hard-edged; the hostile high-arousal pole.',
  ),
  dissolve: sc(
    0.3,
    0.4,
    0.4,
    0.4,
    0.26,
    'A form scattering into particles inside a rigid cage and re-forming: wistful, loss-and-return; low-mid valence, mid arousal, loose pulse.',
  ),
  chrome: sc(
    0.68,
    0.3,
    0.15,
    0.4,
    0.26,
    'Polished chrome torus knot with slow travelling reflections: smooth, luxurious, warm-cool sheen; soft tender/uplifting rather than intense.',
  ),
  pointcloud: sc(
    0.4,
    0.55,
    0.58,
    0.45,
    0.28,
    'LIDAR-style 60k point scan sweeping a vast dark field: surveying, cold, ominous but large; between tense and epic without the swagger.',
  ),
  kifs: sc(
    0.68,
    0.78,
    0.55,
    0.5,
    0.24,
    'Fractal rose window: a centred neon mandala with orbit-trap laser lines; cathedral-scale symmetry, grand and radiant, tension from the razor lines.',
  ),
  maze: sc(
    0.32,
    0.82,
    0.58,
    0.85,
    0.24,
    'First-person flight down a hard-lit corridor maze on a hard beat: urgent, claustrophobic, relentless forward motion.',
  ),
  wingfold: sc(
    0.82,
    0.75,
    0.2,
    0.85,
    0.24,
    'Bright Julia fractal that breathes and punches on the beat ("dancy"); open, colourful, celebratory, low tension.',
  ),
  tribalentity: sc(
    0.22,
    0.5,
    0.8,
    0.3,
    0.3,
    'Horned moth-winged fractal entity watching through glowing slit eyes; dark, eerie, ritual, high tension. Time-driven, not beat-locked.',
  ),
  mothwings: sc(
    0.62,
    0.45,
    0.3,
    0.45,
    0.3,
    'Symmetric fractal moth whose wings breathe between two poses while light travels out along its veins; luminous, flowing, hypnotic, low tension. Flow-driven (mids pace the wingbeat), not beat-locked.',
  ),
  snowflake: sc(
    0.6,
    0.1,
    0.12,
    0.1,
    0.22,
    'Six-fold ice crystal turning slowly on a deep cold field with glints: hushed, pristine, weightless; the stillest primary.',
  ),
  beats: sc(
    0.5,
    0.8,
    0.45,
    0.95,
    0.24,
    '4D lattice whose animation IS the beat (floor(T)+sqrt(F)): mechanical, locked, tightening; pure propulsion with neutral valence.',
  ),
  travelling: sc(
    0.54,
    0.28,
    0.3,
    0.2,
    0.26,
    'Slow hypnotic kaleidoscope of eyes drifting through stacked planes: psychedelic, hazy, unhurried; dreamy with a faint uncanny edge.',
  ),
  web: sc(
    0.45,
    0.78,
    0.5,
    0.78,
    0.24,
    'Oversaturated glowing bezier strands rushing past: hot, pulsing, relentless; a driving scene that is more electric than joyful.',
  ),
  fridaylines: sc(
    0.58,
    0.5,
    0.3,
    0.6,
    0.26,
    'Lattice of glowing thread-tunnels breathing in and out around a wandering axis: hypnotic, steady, comfortable; a mid groove scene.',
  ),
  javazone: sc(
    0.72,
    0.85,
    0.3,
    0.95,
    0.22,
    'Rounded 4D lattice flythrough with a flash on every downbeat: bright, locked, exhilarating; festival-floor energy.',
  ),
  lattesfold: sc(
    0.22,
    0.65,
    0.88,
    0.45,
    0.24,
    'Chaotic complex-dynamics warp folded through a Menger box with scrolling depth stripes: unstable, disorienting, anxious.',
  ),
  butterfly: sc(
    0.8,
    0.42,
    0.14,
    0.5,
    0.24,
    'A luminous butterfly with sparks streaming along its field lines, flapping on the beat: delicate, light, quietly joyful.',
  ),
  truchet: sc(
    0.72,
    0.62,
    0.2,
    0.72,
    0.24,
    'Endless flight through stacked rolling Truchet kaleidoscope planes: patterned, optimistic, hypnotic forward glide.',
  ),

  // --- Live layers / backgrounds / effects --------------------------------
  ribbons: sc(
    0.7,
    0.34,
    0.16,
    0.3,
    0.26,
    'Silky flowing ribbons driven by the mid/vocal waveform: graceful, warm, tender; an accent layer, never a subject.',
  ),
  malachite: sc(
    0.38,
    0.2,
    0.58,
    0.12,
    0.25,
    'Warped botryoidal mineral veins in deep green: slow, dense, ancient; dark and enigmatic rather than sad.',
  ),
  matrix: sc(
    0.28,
    0.68,
    0.72,
    0.68,
    0.25,
    'Falling phosphor-green glyph rain, flickering and saturated: cold, digital, urgent; an anxious, machine-like overlay.',
  ),
  nebula: sc(
    0.55,
    0.14,
    0.22,
    0.1,
    0.26,
    'Slow soft domain-warped cloud, like fog or a nebula photograph: floating, hazy, weightless; a dreamy/serene ground.',
  ),
  dustfield: sc(
    0.36,
    0.12,
    0.25,
    0.12,
    0.24,
    'Sparse dust motes at three parallax depths in a faint light shaft: quiet, faded, wistful; a melancholic ground.',
  ),
  hold: sc(
    0.45,
    0.02,
    0.06,
    0.02,
    0.15,
    'Near-black breathing gradient: the authored answer to silence; only fits a nearly motionless, beatless passage.',
  ),
  shock: sc(
    0.5,
    0.9,
    0.55,
    0.8,
    0.3,
    'Bright expanding ring fired on a drop: an impact punctuation, mood-neutral but high arousal and rhythmic.',
  ),
  flare: sc(
    0.76,
    0.7,
    0.2,
    0.4,
    0.32,
    'Soft cross-shaped camera flash on a section change: radiant, relieved, bright; a positive release accent.',
  ),
  spark: sc(
    0.72,
    0.55,
    0.15,
    0.6,
    0.3,
    'Three small points of light popping on transients: playful glitter, light and quick.',
  ),
  strobe: sc(
    0.12,
    0.98,
    0.7,
    0.9,
    0.22,
    'Hard monochrome bar wipes in the techno/DnB idiom: harsh, cold, punishing; the most aggressive scene in the roster.',
  ),

  // --- Special-purpose scenes (not auto-selected by mood) -------------------
  limitless: sc(
    0.55,
    0.5,
    0.4,
    0.5,
    0.6,
    'Image-trip engine whose look is the user photo plus a physics mode: no fixed mood, so a very wide centre-of-cube spread.',
  ),
  djcam: sc(
    0.6,
    0.45,
    0.2,
    0.55,
    0.6,
    'Live camera cutaway to the DJ: mood-neutral, only reached by its own director; wide spread.',
  ),

  // --- Quarantined (DISABLED_SCENES): authored now so promotion is free -----
  harkonnen: sc(
    0.18,
    0.45,
    0.68,
    0.3,
    0.24,
    'Lit carved relief of an escape fractal, slow macro zoom, brutalist fortress feel: heavy, dark, imposing.',
  ),
  gyroid: sc(
    0.52,
    0.38,
    0.3,
    0.4,
    0.28,
    'Glowing gyroid minimal-surface lattice with an orbiting drifting camera: organic, curious, unhurried.',
  ),
  tunnel: sc(
    0.5,
    0.62,
    0.36,
    0.88,
    0.26,
    'Winding glowing tunnel flight, "hypnotic and driving rather than violent": steady propulsion, calm valence.',
  ),
  panic: sc(
    0.08,
    0.82,
    0.92,
    0.4,
    0.22,
    'Corrupted terminal crash screen on a 40 s scripted timeline: alarm, glitch, dread.',
  ),
  network: sc(
    0.6,
    0.28,
    0.3,
    0.22,
    0.26,
    'Living web of sparkling jittered nodes with layered parallax ("The Universe Within"): wonder, quiet awe.',
  ),
  inversion: sc(
    0.3,
    0.58,
    0.6,
    0.5,
    0.26,
    'Kali sphere-inversion fractal, raymarched: obsessive, cold, intricate; tension without hostility.',
  ),
  foldpath: sc(
    0.45,
    0.45,
    0.4,
    0.4,
    0.3,
    'Fixed-step heightfield flythrough over IFS-fold terrain: a wandering, neutral landscape drift.',
  ),
  torusfold: sc(
    0.5,
    0.52,
    0.44,
    0.5,
    0.3,
    'Mandelbox fold intersected with a torus, ring patterns: mechanical, mid-everything.',
  ),
  juliawings: sc(
    0.78,
    0.38,
    0.12,
    0.3,
    0.24,
    'The only light-background scene: delicate moth-wing Julia symmetry, airy and gentle.',
  ),
  heap: sc(
    0.14,
    0.72,
    0.85,
    0.55,
    0.22,
    'Allocator grid rotting from cold teal to hot magenta with row-tearing glitches: decay and corruption.',
  ),
  orbs: sc(
    0.72,
    0.1,
    0.06,
    0.15,
    0.22,
    'Three soft orbs drifting on Lissajous paths: floating and calm, the opposite pole from glitch.',
  ),
  kaleido: sc(
    0.84,
    0.75,
    0.15,
    0.9,
    0.22,
    'Pulsing ring mandala in a cosine palette: bright, rhythmic, celebratory.',
  ),
  trail: sc(
    0.42,
    0.42,
    0.3,
    0.32,
    0.28,
    'Rotating zooming sine stroke smearing a light trail: gestural, oscilloscope-like, contemplative.',
  ),
  synthgrid: sc(
    0.68,
    0.78,
    0.32,
    0.9,
    0.24,
    'Retro-futurist mirrored city under a hot magenta horizon with heavy bloom: nostalgic, glossy, driving.',
  ),
  crystalfold: sc(
    0.6,
    0.6,
    0.42,
    0.4,
    0.28,
    'Orbiting-camera twisted Mandelbox: glassy, ornate, majestic without hostility.',
  ),
  lumen: sc(
    0.22,
    0.5,
    0.58,
    0.55,
    0.24,
    'Machined light-panel head on a beton-brut wall: cold, industrial, watchful.',
  ),
  neonjungle: sc(
    0.82,
    0.66,
    0.3,
    0.7,
    0.24,
    'Portal between a tropical lagoon and a rain-slicked neon city: lush, colourful, adventurous.',
  ),
}

// ---------------------------------------------------------------------------
// Affinity
// ---------------------------------------------------------------------------

/**
 * Per-axis weights inside the Gaussian's squared distance. Valence and arousal
 * are the two axes the estimator is best at, so they count fully. Tension is
 * slightly down-weighted (0.85). Pulse is the weakest discriminator (a beat
 * says little about what a scene should LOOK like), so it counts a third.
 */
const AXIS_WEIGHT = { valence: 1, arousal: 1, tension: 0.85, pulse: 0.35 } as const

/**
 * What a scene with no entry in {@link SCENE_CHARACTER} is treated as: dead
 * centre, very wide, so an unregistered id is a mild everywhere-candidate and
 * never a crash. The registry test makes this unreachable for real scenes.
 */
const FALLBACK_CHARACTER: SceneCharacter = sc(0.5, 0.5, 0.5, 0.5, 0.6, 'fallback')

function resolve(scene: string | SceneCharacter): SceneCharacter {
  return typeof scene === 'string' ? (SCENE_CHARACTER[scene] ?? FALLBACK_CHARACTER) : scene
}

/**
 * Gaussian fit of a scene to a point, 0..1 (1 exactly at the scene's centre):
 * `exp(-d2 / (2 sigma^2))` with `d2` the axis-weighted squared distance and
 * `sigma = spread * spreadScale`. `spreadScale` > 1 makes every scene more
 * forgiving (used to relax a starved pool); < 1 makes the fit pickier.
 */
export function characterAffinity(
  scene: string | SceneCharacter,
  point: CharacterPoint,
  spreadScale = 1,
): number {
  const c = resolve(scene)
  const dv = c.valence - point.valence
  const da = c.arousal - point.arousal
  const dt = c.tension - point.tension
  const dp = c.pulse - point.pulse
  const d2 =
    AXIS_WEIGHT.valence * dv * dv +
    AXIS_WEIGHT.arousal * da * da +
    AXIS_WEIGHT.tension * dt * dt +
    AXIS_WEIGHT.pulse * dp * dp
  const sigma = Math.max(1e-3, c.spread * spreadScale)
  return Math.exp(-d2 / (2 * sigma * sigma))
}

/**
 * Distribution-weighted affinity: the expected {@link characterAffinity} of the
 * scene under a mood distribution, using each mood's PROTOTYPE centre from
 * `moodTaxonomy`. `dist` need not be normalised; an all-zero (or invalid)
 * distribution yields 0. Prefer scoring against the continuous point (which
 * {@link pickSceneForCharacter} does); this is for diagnostics and for callers
 * that only have `CharacterState.dist`.
 */
export function moodAffinity(
  sceneId: string,
  dist: Partial<Record<CharacterMood, number>>,
  spreadScale = PICK_SPREAD_SCALE,
): number {
  let num = 0
  let den = 0
  for (const mood of Object.keys(dist) as CharacterMood[]) {
    const w = dist[mood] ?? 0
    const proto = MOOD_PROTOTYPES[mood]
    if (!(w > 0) || !proto) continue
    num += w * characterAffinity(sceneId, proto.center, spreadScale)
    den += w
  }
  return den > 0 ? num / den : 0
}

// ---------------------------------------------------------------------------
// Per-song cast
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a over a string. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Final avalanche (murmur3 fmix32) so nearby inputs give unrelated outputs. */
function fmix32(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** Quantisation step of the character signature behind {@link songSeedFrom}. */
const SEED_QUANT = 0.1

/**
 * A stable per-song seed: a hash of the 0.1-quantised valence/arousal/tension
 * (pulse is left out, it is the noisiest axis) plus the musical key. Two
 * renditions of the same song get the same seed; two songs with a different
 * coarse character or key get unrelated ones. Compute it ONCE per song (or per
 * committed primary mood), not per frame: it is the "who is cast" dice, and
 * changing it mid-song recasts every scene.
 */
export function songSeedFrom(point: CharacterPoint, key: string): number {
  const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) / SEED_QUANT)
  return fmix32(fnv1a(`${q(point.valence)}|${q(point.arousal)}|${q(point.tension)}|${key}`))
}

/** Lowest / highest castBias multiplier. */
const CAST_MIN = 0.55
const CAST_MAX = 1.45

/**
 * Deterministic pseudo-random factor in [0.55, 1.45] from (songSeed, sceneId).
 * Mean 1.0, so it re-orders near-ties (a x2.6 spread between the luckiest and
 * unluckiest scene) without ever overriding a decisive character fit. This is
 * what makes two songs with the SAME character still get different casts.
 */
export function castBias(songSeed: number, sceneId: string): number {
  const u = fmix32(fnv1a(sceneId, songSeed >>> 0)) / 4294967296
  return CAST_MIN + (CAST_MAX - CAST_MIN) * u
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/**
 * Exponent applied to affinity before sampling. Affinity is in 0..1 with
 * typical values 0.9 / 0.5 / 0.25 for a great / fair / poor fit, so 3.5 turns
 * those into 0.69 / 0.09 / 0.005: the best two or three candidates carry
 * nearly all the mass, instead of the near-uniform draw `moodFit` produced.
 * Compared against 3 and 4 over the primary roster: 3.5 keeps a 16-pick song
 * at ~7 distinct scenes with under 10% of picks being poor fits.
 */
const SHARPNESS = 3.5

/**
 * The picker evaluates every scene at this multiple of its authored spread.
 * The authored spread says where a scene looks RIGHT; but the primary roster is
 * ~17 scenes in a 4-D space, and rejecting everything that is merely fair
 * collapsed a mood to 3-4 viable scenes (5.5 distinct first picks in 20 songs
 * at the same character, one scene taking 39%). 1.4x gives ~8 distinct and a
 * ~27% top share, while pool separation between moods (mean Jaccard) is
 * unchanged because it depends on the ranking, not on the width.
 */
export const PICK_SPREAD_SCALE = 1.4

/** Lowest `temperature` honoured (temperature -> 0 approaches argmax). */
const MIN_TEMPERATURE = 0.05

/**
 * Affinity floors tried in order until at least one candidate survives. A
 * candidate must reach `max(abs, rel * bestAffinity)`. Level 0 is the intent
 * (a real fit that is not dwarfed by the best one); the later levels relax so
 * a pool that is far from every scene still returns SOMETHING, and the last
 * level (0, 0) keeps everything.
 */
const FLOOR_LEVELS: ReadonlyArray<{ abs: number; rel: number }> = [
  { abs: 0.2, rel: 0.4 },
  { abs: 0.08, rel: 0.2 },
  { abs: 0.02, rel: 0.05 },
  { abs: 0, rel: 0 },
]

/** How many recent picks the novelty term remembers. */
export const RECENCY_DEPTH = 12

/**
 * Novelty multiplier by recency index (0 = the scene shown last). The last
 * three are near-excluded (they are what the viewer is still looking at or
 * just saw); older ones recover linearly to 0.95 at index 11; unseen = 1.
 */
/** Recent picks with index below this count as "just shown" (see {@link pickSceneForCharacter}). */
const JUST_SHOWN = 3
const NOVELTY_LAST_THREE: readonly number[] = [0.01, 0.03, 0.07]
const NOVELTY_OLDEST = 0.95
const NOVELTY_AT_INDEX_3 = 0.35

function novelty(index: number): number {
  if (index < 0 || index >= RECENCY_DEPTH) return 1
  if (index < NOVELTY_LAST_THREE.length) return NOVELTY_LAST_THREE[index]
  const t = (index - NOVELTY_LAST_THREE.length) / (RECENCY_DEPTH - 1 - NOVELTY_LAST_THREE.length)
  return NOVELTY_AT_INDEX_3 + (NOVELTY_OLDEST - NOVELTY_AT_INDEX_3) * t
}

/** A candidate whose novelty is at least this counts as "fresh" (not just shown). */
const FRESH_NOVELTY = 0.5

/**
 * The floor is relaxed until at least this many FRESH candidates survive it, so
 * recency can never shrink the viable set to the two or three scenes that were
 * all just shown (the floor alone would, and the show would ping-pong).
 */
const MIN_FRESH_SURVIVORS = 4

/** Weight of the secondary mood's point in the blended affinity, at most. */
const SECONDARY_MAX_WEIGHT = 0.5

export interface PickSceneInput {
  candidates: readonly string[]
  character: CharacterPoint
  /** Runner-up mood's implied point and its blend weight (contract: 0..0.5). */
  secondary?: { point: CharacterPoint; weight: number } | null
  /** Most-recent-first scene ids. Only the first {@link RECENCY_DEPTH} count. */
  recentIds: readonly string[]
  /** From {@link songSeedFrom}; fixed for the song. */
  songSeed: number
  /** Uniform [0,1) source; inject a seeded one for tests. */
  rng: () => number
  /** Never picked (e.g. current/pending scene), unless nothing else is left. */
  exclude?: readonly string[]
  /** Per-scene weight multiplier (band/voice preference etc.), default 1. */
  boost?: Record<string, number>
  /** Multiplies every scene's spread (default {@link PICK_SPREAD_SCALE}). */
  spreadScale?: number
  /** 1 = default sharpness; < 1 greedier (0.05 ~ argmax), > 1 flatter. */
  temperature?: number
}

/** Blended affinity of one scene to the primary point and optional secondary. */
function blendedAffinity(id: string, input: PickSceneInput): number {
  const k = input.spreadScale ?? PICK_SPREAD_SCALE
  const a = characterAffinity(id, input.character, k)
  const s = input.secondary
  if (!s || !(s.weight > 0)) return a
  const w = Math.min(SECONDARY_MAX_WEIGHT, s.weight)
  return (1 - w) * a + w * characterAffinity(id, s.point, k)
}

/**
 * Pick one scene id for the current character.
 *
 *   weight = affinity^(SHARPNESS/temperature) x novelty x castBias x boost
 *
 * over the candidates that clear the affinity floor (relaxed progressively, so
 * a non-empty `candidates` always yields an id). Returns null only for an empty
 * `candidates`. If `exclude` would remove everything, exclusion is ignored
 * rather than returning null: the caller can compare with the current scene.
 * The result is always a member of `candidates`.
 */
export function pickSceneForCharacter(input: PickSceneInput): string | null {
  const unique = Array.from(new Set(input.candidates))
  if (unique.length === 0) return null
  if (unique.length === 1) return unique[0]

  const excluded = new Set(input.exclude ?? [])
  const allowed = unique.filter((id) => !excluded.has(id))
  const pool = allowed.length > 0 ? allowed : unique

  const exponent = SHARPNESS / Math.max(MIN_TEMPERATURE, input.temperature ?? 1)
  const scored = pool.map((id) => ({ id, aff: blendedAffinity(id, input) }))
  const best = scored.reduce((m, c) => Math.max(m, c.aff), 0)

  const fresh = (id: string) => novelty(input.recentIds.indexOf(id)) >= FRESH_NOVELTY
  const needFresh = Math.min(MIN_FRESH_SURVIVORS, scored.filter((c) => fresh(c.id)).length)
  let kept = scored
  for (const { abs, rel } of FLOOR_LEVELS) {
    const floor = Math.max(abs, rel * best)
    const survivors = scored.filter((c) => c.aff >= floor)
    if (survivors.length > 0 && survivors.filter((c) => fresh(c.id)).length >= needFresh) {
      kept = survivors
      break
    }
  }

  // The last three shown are the ones the viewer is still looking at or just saw:
  // drop them outright whenever at least two other candidates remain, and keep
  // only the soft novelty penalty as the fallback for a starved pool.
  const notJustShown = kept.filter(
    (c) => input.recentIds.indexOf(c.id) < 0 || input.recentIds.indexOf(c.id) >= JUST_SHOWN,
  )
  if (notJustShown.length >= 2) kept = notJustShown

  const weights = kept.map(({ id, aff }) => {
    const recentIndex = input.recentIds.indexOf(id)
    const b = input.boost?.[id]
    const boost = b !== undefined && b > 0 ? b : b === undefined ? 1 : 0
    return Math.pow(aff, exponent) * novelty(recentIndex) * castBias(input.songSeed, id) * boost
  })
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (!(total > 0)) {
    // Every weight underflowed to 0 (extreme temperature or boost 0): fall back
    // to the best raw affinity so the contract "always returns something" holds.
    return kept.reduce((m, c) => (c.aff > m.aff ? c : m)).id
  }
  let roll = input.rng() * total
  for (let i = 0; i < kept.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return kept[i].id
  }
  return kept[kept.length - 1].id
}

/**
 * The top `n` candidates by affinity to `character`, best first. Ties break by
 * id so the result is deterministic. For diagnostics and tests; the picker
 * itself samples rather than taking this list verbatim.
 */
export function characterPool(
  candidates: readonly string[],
  character: CharacterPoint,
  n = 8,
): string[] {
  return Array.from(new Set(candidates))
    .map((id) => ({ id, aff: characterAffinity(id, character, PICK_SPREAD_SCALE) }))
    .sort((a, b) => b.aff - a.aff || (a.id < b.id ? -1 : 1))
    .slice(0, n)
    .map((c) => c.id)
}

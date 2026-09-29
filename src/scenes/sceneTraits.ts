/**
 * Scene traits: what a scene LOOKS like in the four terms a look row can ask for, plus how well it carries a
 * build-up and a drop (plan: "Mood-driven look system", phase P4).
 *
 * `scenes/character.ts` places a scene in (valence, arousal, tension, pulse) space, which is what the picker
 * fits. The look system also wants to say "slow and soft", "angular and dense", "radially symmetric", and a
 * build wants "fast, locked, tightening". None of that is a mood, so it lives here as a second, small table
 * that `sceneBoost` compares against the live `LookProfile`'s trait targets.
 *
 *   tempo      how fast the scene moves (0 = drifting, 1 = frantic)
 *   angular    hard edges / jagged geometry (0 = organic and round, 1 = blades and bars)
 *   busy       how much is on screen at once (0 = one quiet element, 1 = wall-to-wall detail)
 *   radial     inherently symmetric about the centre (mandalas, kaleidoscopes, rings)
 *   buildFit   how well it carries a rising build (fast, beat-locked motion that can tighten)
 *   dropFit    how well it lands a drop (violent, punchy, shock-like)
 *
 * ## Derived, then corrected
 *
 * `tempo`, `angular`, `busy`, `buildFit` and `dropFit` are DERIVED from the scene's authored
 * {@link SCENE_CHARACTER} (arousal -> tempo, tension -> angular, pulse and tension -> build/drop fit), so a new
 * scene gets a sensible row for free and the two tables cannot silently disagree about what a scene is. `radial`
 * cannot be derived from a mood position at all (a mandala is not "tense"), so it defaults low and is authored
 * per scene. A small {@link TRAIT_OVERRIDES} table then corrects the scenes where the derivation is wrong, each
 * with the reason. The registry test fails when a live scene has no row.
 *
 * A wide-spread scene (a chameleon such as `limitless`) has no strong look of its own, so its DERIVED values are
 * pulled toward neutral by how wide its spread is.
 *
 * This file is pure: no three.js, no store, no scene registry import (the registry imports it for
 * {@link preferredModes}, so importing the registry back would be a cycle).
 */

import type { LookProfile } from '../engine/look/lookRow'
import { SCENE_CHARACTER, type SceneCharacter } from './character'

export interface SceneTraits {
  tempo: number
  angular: number
  busy: number
  radial: number
  buildFit: number
  dropFit: number
}

/** All six trait keys, in table order. */
export const TRAIT_KEYS = ['tempo', 'angular', 'busy', 'radial', 'buildFit', 'dropFit'] as const

/** NaN-safe clamp to 0..1 (a non-finite input reads as 0). */
function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0
}

/** What an id with no authored character and no override resolves to: unremarkable on every axis. */
export const NEUTRAL_TRAITS: Readonly<SceneTraits> = Object.freeze({
  tempo: 0.5,
  angular: 0.4,
  busy: 0.5,
  radial: 0.3,
  buildFit: 0.5,
  dropFit: 0.5,
})

/** `radial` has no derivation, so an un-overridden scene is assumed only mildly symmetric. */
const DEFAULT_RADIAL = 0.25

/** Spread at which a scene starts to count as a chameleon, and the extra spread over which the pull saturates. */
const CHAMELEON_SPREAD = 0.28
const CHAMELEON_RANGE = 0.4
/** Largest fraction of the distance to 0.5 a chameleon's derived traits are pulled. */
const CHAMELEON_PULL = 0.5

function derive(c: SceneCharacter): SceneTraits {
  const tempo = clamp01(0.8 * c.arousal + 0.2 * c.pulse)
  const angular = clamp01(0.75 * c.tension + 0.25 * (1 - c.valence))
  const busy = clamp01(0.5 * c.arousal + 0.35 * c.tension + 0.15)
  // A build wants motion that is fast, locked to the beat and can tighten (tension): tempo dominates.
  const buildFit = clamp01(0.5 * tempo + 0.25 * c.pulse + 0.25 * c.tension)
  // A drop wants energy and impact, and reads harder when the scene is tense OR dark.
  const dropFit = clamp01(0.5 * c.arousal + 0.25 * c.pulse + 0.25 * Math.max(c.tension, 1 - c.valence))

  const pull = clamp01((c.spread - CHAMELEON_SPREAD) / CHAMELEON_RANGE) * CHAMELEON_PULL
  const toward = (v: number) => v + (0.5 - v) * pull
  return {
    tempo: toward(tempo),
    angular: toward(angular),
    busy: toward(busy),
    radial: DEFAULT_RADIAL,
    buildFit: toward(buildFit),
    dropFit: toward(dropFit),
  }
}

/**
 * Judgement calls where the derivation is wrong, or a trait cannot be derived. Every entry says why. Only the
 * keys listed replace the derived value. Roster checked against `scenes/index.ts` + `scenes/character.ts`.
 *
 * `radial` (authored for every scene that is, or is not, symmetric about the centre):
 *  - kifs .95 / snowflake .95: literal fold counts (rose window, six-fold crystal).
 *  - travelling .85: kaleidoscope of eyes; truchet .8: rolling kaleidoscope planes.
 *  - plasma .75: one hot core spraying filaments outward.
 *  - shock 1 / flare .9: ring and cross flashes centred on the frame (effects, never primaries).
 *  - wireframe .5 / chrome .4 / dissolve .4 / hold .5: one centred hero; wingfold .5 / javazone .5 / beats .5:
 *    inversion-folded 4D lattices, radial without being a mandala.
 *  - matrix .05 / strobe 0 / spark .1 / dustfield .1 / ribbons .1: vertical rain, horizontal bars, scattered
 *    points, drifting motes, flowing strands: nothing centred.
 *
 * `busy` (amount on screen; the derivation from arousal + tension over-rates the fast-but-sparse scenes):
 *  - javazone .9, web .85, lattesfold .9, matrix .85, kifs .8, beats .75: wall-to-wall lattice / strands / glyphs.
 *  - travelling .65, truchet .7: stacked planes of dense pattern although their mood point is calm-to-mid.
 *  - plasma .7 (derived .84: 70k particles read as one bright mass, not detail), maze .6 (derived .76: a corridor
 *    is one bold shape), wireframe .4, chrome .2, dustfield .15, hold .05: one hero, or almost nothing.
 *
 * `angular`:
 *  - strobe .95: hard bars, the most angular thing in the roster (derived .75).
 *  - web .35 (bezier strands), javazone .3 (rounded lattice), truchet .2 (arcs), fridaylines .25 (threads),
 *    butterfly .15 (organic): tension makes the derivation over-call these, but their geometry is curved.
 *
 * `buildFit` / `dropFit`:
 *  - Builds favour beat-locked flythroughs: beats .95, javazone .9, maze .9, web .85, plasma .8, pointcloud .7.
 *  - Drops favour violent / shock-like scenes: shock 1, strobe 1, plasma .9, lattesfold .8, javazone .85, maze .85.
 *  - limitless / djcam are cutaways owned by their own directors: buildFit .5 (neutral) so the build switch never
 *    tries to "improve on" one.
 */
export const TRAIT_OVERRIDES: Readonly<Record<string, Readonly<Partial<SceneTraits>>>> = {
  // --- Live primaries -----------------------------------------------------------------------------
  wireframe: { radial: 0.5, busy: 0.4 },
  plasma: { radial: 0.75, busy: 0.7, buildFit: 0.8, dropFit: 0.9 },
  dissolve: { radial: 0.4 },
  chrome: { radial: 0.4, busy: 0.2 },
  pointcloud: { buildFit: 0.7 },
  kifs: { radial: 0.95, busy: 0.8 },
  maze: { busy: 0.6, buildFit: 0.9, dropFit: 0.85 },
  wingfold: { radial: 0.5 },
  snowflake: { radial: 0.95 },
  beats: { radial: 0.5, busy: 0.75, buildFit: 0.95 },
  travelling: { radial: 0.85, busy: 0.65 },
  web: { angular: 0.35, busy: 0.85, radial: 0.4, buildFit: 0.85 },
  fridaylines: { angular: 0.25, radial: 0.55 },
  javazone: { angular: 0.3, busy: 0.9, radial: 0.5, buildFit: 0.9, dropFit: 0.85 },
  lattesfold: { busy: 0.9, radial: 0.4, dropFit: 0.8 },
  butterfly: { angular: 0.15, radial: 0.45 },
  truchet: { angular: 0.2, busy: 0.7, radial: 0.8 },

  // --- Live layers / backgrounds / effects --------------------------------------------------------
  ribbons: { radial: 0.1 },
  matrix: { busy: 0.85, radial: 0.05 },
  nebula: { busy: 0.25 },
  dustfield: { busy: 0.15, radial: 0.1 },
  hold: { busy: 0.05, radial: 0.5 },
  shock: { radial: 1, dropFit: 1, busy: 0.3 },
  flare: { radial: 0.9 },
  spark: { radial: 0.1 },
  strobe: { angular: 0.95, radial: 0, busy: 0.5, dropFit: 1 },

  // --- Cutaways: neutral build fit -----------------------------------------------------------------
  limitless: { buildFit: 0.5 },
  djcam: { buildFit: 0.5 },
}

const traitCache = new Map<string, Readonly<SceneTraits>>()

/** Does this id have an authored source (a `SCENE_CHARACTER` entry or an override) rather than the neutral fallback? */
export function hasSceneTraits(id: string): boolean {
  return id in SCENE_CHARACTER || id in TRAIT_OVERRIDES
}

/**
 * The trait row for a scene id. Derived from `SCENE_CHARACTER` and corrected by {@link TRAIT_OVERRIDES}; an id
 * with neither resolves to {@link NEUTRAL_TRAITS} (never undefined, never a crash). Memoised and frozen: safe to
 * call per candidate, and the result must not be mutated.
 */
export function getSceneTraits(id: string): Readonly<SceneTraits> {
  const cached = traitCache.get(id)
  if (cached) return cached
  const c = SCENE_CHARACTER[id]
  const base = c ? derive(c) : { ...NEUTRAL_TRAITS }
  const o = TRAIT_OVERRIDES[id]
  const row: SceneTraits = { ...base, ...o }
  for (const k of TRAIT_KEYS) row[k] = clamp01(row[k])
  const frozen = Object.freeze(row)
  traitCache.set(id, frozen)
  return frozen
}

// ---------------------------------------------------------------------------------------------------------
// sceneBoost
// ---------------------------------------------------------------------------------------------------------

/** The boost is always inside this range (the picker's affinity is raised to ^3.5 first, so this is a nudge). */
export const SCENE_BOOST_MIN = 0.4
export const SCENE_BOOST_MAX = 3

/** How much each trait counts in the closeness of a scene to the profile's targets. */
const TRAIT_WEIGHT = { tempo: 1, angular: 1, busy: 0.8, radial: 0.6 } as const
const TRAIT_WEIGHT_SUM = TRAIT_WEIGHT.tempo + TRAIT_WEIGHT.angular + TRAIT_WEIGHT.busy + TRAIT_WEIGHT.radial

/**
 * Closeness (0..1) at or below which a scene counts as the worst trait match, and at or above which as the best.
 * Measured over the live primaries against the 14 authored rows: closeness spans ~0.45 (a snowflake in a euphoric
 * song) to ~0.92 (javazone in the same).
 */
const CLOSE_WORST = 0.45
const CLOSE_BEST = 0.92

/** Which moment the pick is for. `auto` follows `look.buildIntent`; `build` / `drop` are explicit (AutoPilot's one-shot build switch and drop picks). */
export type BoostPhase = 'auto' | 'build' | 'drop'

/** Geometric map of a 0..1 fit onto [MIN, MAX]: 0 -> 0.4, 1 -> 3, and a fit^x scales the exponent, not the ends. */
function spanFactor(fit01: number): number {
  return SCENE_BOOST_MIN * Math.pow(SCENE_BOOST_MAX / SCENE_BOOST_MIN, clamp01(fit01))
}

function target(v: number): number {
  return Number.isFinite(v) ? clamp01(v) : 0.5
}

/** 0..1: how close a scene's four look traits are to the profile's targets (weighted mean absolute difference). */
export function traitCloseness(t: Readonly<SceneTraits>, look: LookProfile): number {
  const d =
    TRAIT_WEIGHT.tempo * Math.abs(t.tempo - target(look.traitTempo)) +
    TRAIT_WEIGHT.angular * Math.abs(t.angular - target(look.traitAngular)) +
    TRAIT_WEIGHT.busy * Math.abs(t.busy - target(look.traitBusy)) +
    TRAIT_WEIGHT.radial * Math.abs(t.radial - target(look.traitRadial))
  return 1 - d / TRAIT_WEIGHT_SUM
}

/**
 * Weight multiplier for one scene, in [{@link SCENE_BOOST_MIN}, {@link SCENE_BOOST_MAX}], to hand to the picker's
 * existing `boost` hook (multiply it into the voice / dominant-band boosts, do not replace them).
 *
 *  - Trait match: how close the scene's tempo / angular / busy / radial are to `look.trait*`, mapped
 *    geometrically onto [0.4, 3] and raised to `look.traitStrength`, so a strength of 0 is exactly 1 and the
 *    row's own strength (0.5 calm .. 0.8 aggressive) sets how hard the look leans on the roster.
 *  - Build: with `look.buildIntent > 0` (the tracker's effective value: structural build progress or the
 *    everyday `building` look, already scaled down by a breakdown) an extra factor from the scene's `buildFit`,
 *    raised to the intent, so a fast beat-locked scene such as `beats` is favoured while a build is on.
 *  - `phase: 'build'` treats the build as fully on (AutoPilot's one-shot switch on a confirmed build, where the
 *    ramp has barely started); `phase: 'drop'` swaps the build factor for `dropFit` (the drop pre-arm and the drop
 *    pick, where a build-fit scene is the wrong answer).
 *
 * Only meaningful for `look.valid && look.families.scene`; the consumers gate on that (see
 * {@link sceneLookActive}). The tracker has already applied the fast-layer modifiers to the published fields
 * (the trait targets are the blended row's, untouched by them), so this reads `buildIntent` as published and
 * applies no modifier of its own on top.
 */
export function sceneBoost(scene: string | { id: string }, look: LookProfile, phase: BoostPhase = 'auto'): number {
  const t = getSceneTraits(typeof scene === 'string' ? scene : scene.id)
  const strength = clamp01(look.traitStrength) // a non-finite strength reads as 0: no trait bias
  let boost = 1
  if (strength > 0) {
    const fit = clamp01((traitCloseness(t, look) - CLOSE_WORST) / (CLOSE_BEST - CLOSE_WORST))
    boost = Math.pow(spanFactor(fit), strength)
  }
  if (phase === 'drop') {
    boost *= spanFactor(t.dropFit)
  } else {
    const intent = phase === 'build' ? 1 : clamp01(look.buildIntent)
    if (intent > 0) boost *= Math.pow(spanFactor(t.buildFit), intent)
  }
  return boost < SCENE_BOOST_MIN ? SCENE_BOOST_MIN : boost > SCENE_BOOST_MAX ? SCENE_BOOST_MAX : boost
}

/** The consumer rule: the profile may steer scene choice only when it is valid and the scene family is on. */
export function sceneLookActive(look: LookProfile | undefined): look is LookProfile {
  return look !== undefined && look.valid && look.families.scene
}

// ---------------------------------------------------------------------------------------------------------
// Mode meaning (for the mood-aware `pickVariedMode`)
// ---------------------------------------------------------------------------------------------------------

/**
 * What a scene's mode EXPRESSES, as shares of angular / busy / calm that sum to 1. Only authored where the mode
 * has a legible meaning; a scene or mode with no entry has no preference and keeps today's plain rotation
 * (`limitless`, whose 17 modes are physics effects on a photo and which only its own director cuts to, is
 * handled by that fallback rather than by 17 judgement calls).
 *
 *  - wireframe: `crystal` is an icosahedron (round, many soft facets: calm), `shard` an octahedron (a few hard
 *    spikes: angular), `cage` a subdivided box (a dense orthogonal lattice: busy).
 */
const MODE_MEANING: Readonly<Record<string, Readonly<Record<string, Readonly<{ angular: number; busy: number; calm: number }>>>>> = {
  wireframe: {
    crystal: { angular: 0.1, busy: 0.1, calm: 0.8 },
    shard: { angular: 0.75, busy: 0.15, calm: 0.1 },
    cage: { angular: 0.2, busy: 0.7, calm: 0.1 },
  },
}

/** Modes whose fit is within this of the best are treated as tied (so the deterministic rotation still alternates among them). */
const MODE_TIE_EPSILON = 0.05
/** Weight of the timbre descriptors (`look.harsh` / `look.busy`) against the row's trait targets. */
const DESCRIPTOR_MIX = 0.3

/** Fit (0..1) of one mode to the profile, or `undefined` when the scene / mode has no authored meaning. */
export function modeFit(sceneId: string, mode: string, look: LookProfile): number | undefined {
  const m = MODE_MEANING[sceneId]?.[mode]
  if (!m) return undefined
  const wantAngular = (1 - DESCRIPTOR_MIX) * target(look.traitAngular) + DESCRIPTOR_MIX * target(look.harsh)
  const wantBusy = (1 - DESCRIPTOR_MIX) * target(look.traitBusy) + DESCRIPTOR_MIX * target(look.busy)
  const wantCalm = 1 - Math.max(wantAngular, wantBusy, target(look.traitTempo))
  return m.angular * wantAngular + m.busy * wantBusy + m.calm * wantCalm
}

/**
 * The subset of `choices` (order preserved) whose meaning best matches the profile: angular / harsh -> the
 * angular mode, busy -> the busy mode, calm / soft -> the calm mode; modes within {@link MODE_TIE_EPSILON} of the
 * best stay in, so a near-tie keeps the deterministic rotation. `choices` unchanged when any of them has no
 * authored meaning. Never empty for a non-empty `choices`.
 */
export function preferredModes(sceneId: string, choices: readonly string[], look: LookProfile): readonly string[] {
  if (choices.length < 2) return choices
  const fits: number[] = []
  for (const c of choices) {
    const f = modeFit(sceneId, c, look)
    if (f === undefined) return choices
    fits.push(f)
  }
  const best = Math.max(...fits)
  const kept = choices.filter((_, i) => fits[i] >= best - MODE_TIE_EPSILON)
  return kept.length > 0 ? kept : choices
}

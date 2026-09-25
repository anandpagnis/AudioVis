import type { CharacterPoint, CharacterState } from '../audio/characterTypes'
import { characterAffinity, PICK_SPREAD_SCALE } from '../scenes/character'
import type { SceneDef } from '../scenes'
import { getSceneTraits, sceneBoost, type BoostPhase } from '../scenes/sceneTraits'
import { pickByCharacter } from './characterPick'
import type { LookProfile } from './look/lookRow'

/**
 * Which scene to keep ARMED (picked, mounted, compiled, waiting) and whether the armed one still fits.
 *
 * Pure: no store, no registry, no three. The caller (`armedDirector.ts`) supplies the candidate list and the live
 * signals, so every rule here is unit-testable.
 *
 * ## The three selection metrics
 *  1. MOOD / CHARACTER: `characterAffinity` of the scene to the music's valence / arousal / tension / pulse point,
 *     and the look's trait targets (`sceneBoost`).
 *  2. BPM: the scene's `tempo` trait against the song's measured tempo (`tempoOctaves`, confidence-gated).
 *  3. DSP TREND: a rising trend (confirmed build, fast build flag, a mood on its way to peak, a drop projected soon)
 *     lifts the target point toward a hot scene and swaps the look boost to its DROP flavour; a falling trend
 *     (breakdown, a decaying / melting mood, a calm mood on its way) lowers it toward a calm one; steady leaves it.
 *
 * Then a COST factor: a scene already compiled this session is cheap to arm (a re-mount reuses its program), a heavy
 * scene is discouraged on weaker tiers and in a breakdown. That factor is what keeps constant arming from turning
 * into constant shader compiles.
 */

export type ArmTrend = 'rising' | 'steady' | 'falling'
export type ArmCost = 'low' | 'medium' | 'high'

export interface ArmCandidate {
  id: string
  /** `metadata.performanceCost`. */
  cost: ArmCost
  /** Compiled at least once this session (`sceneStreamer.hasCompiled`). */
  compiled: boolean
}

export interface TrendInput {
  structureValid: boolean
  /** `songSection.isSustain`: a confirmed build (or a drop expected). */
  isSustain: boolean
  isBreakdown: boolean
  /** `songSection.beatsTillDrop` (-1 / 0 = unknown). */
  beatsTillDrop: number
  /** The fast `f.buildUp` flag. */
  buildUp: boolean
  moodBuilding: boolean
  moodDecaying: boolean
  moodMelting: boolean
  /** `mood.state` / `mood.predictedState` / `mood.beatsTillTransition`. */
  moodState: string
  predictedState: string
  beatsTillTransition: number
}

/** Beats before a projected drop from which the trend already reads as rising. */
export const TREND_DROP_HORIZON_BEATS = 16
/** A predicted mood change counts as imminent inside this many beats. */
export const TREND_PREDICT_BEATS = 8

const HOT_STATES: readonly string[] = ['building', 'peak', 'aggressive']
const CALM_STATES: readonly string[] = ['mellow', 'ambient']

/** Rising beats falling: a hot moment coming is the thing the armed scene must be ready for. */
export function armTrend(t: TrendInput): ArmTrend {
  const imminent = t.predictedState !== t.moodState && t.beatsTillTransition >= 0 && t.beatsTillTransition < TREND_PREDICT_BEATS
  const rising =
    (t.structureValid && t.isSustain) ||
    t.buildUp ||
    t.moodBuilding ||
    (t.structureValid && t.beatsTillDrop > 0 && t.beatsTillDrop <= TREND_DROP_HORIZON_BEATS) ||
    (imminent && HOT_STATES.includes(t.predictedState))
  if (rising) return 'rising'
  const falling =
    (t.structureValid && t.isBreakdown) ||
    t.moodDecaying ||
    t.moodMelting ||
    (imminent && CALM_STATES.includes(t.predictedState))
  return falling ? 'falling' : 'steady'
}

/** A rising trend aims at least this hot; a falling one at most this calm. */
export const TREND_RISE_AROUSAL = 0.78
export const TREND_RISE_TENSION = 0.5
export const TREND_FALL_AROUSAL = 0.35
export const TREND_FALL_TENSION = 0.4

/** The point the armed scene should suit: the live character point, pushed by the trend. */
export function targetPoint(p: CharacterPoint, trend: ArmTrend): CharacterPoint {
  if (trend === 'rising') {
    return {
      valence: p.valence,
      arousal: Math.max(p.arousal, TREND_RISE_AROUSAL),
      tension: Math.max(p.tension, TREND_RISE_TENSION),
      pulse: p.pulse,
    }
  }
  if (trend === 'falling') {
    return {
      valence: p.valence,
      arousal: Math.min(p.arousal, TREND_FALL_AROUSAL),
      tension: Math.min(p.tension, TREND_FALL_TENSION),
      pulse: p.pulse,
    }
  }
  return p
}

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)

/** Beat-tracking confidence below which the BPM term does nothing, and above which it counts in full. */
export const BPM_CONF_FLOOR = 0.15
export const BPM_CONF_CEIL = 0.5
/** The BPM factor spans `1 +- BPM_SWING` at full confidence (closest tempo match .. furthest). */
export const BPM_SWING = 0.3

/** The song's tempo on the scenes' 0..1 `tempo` trait scale: 60 BPM -> 0, 120 -> 0.5, 240 -> 1. */
export function bpmTarget01(tempoOctaves: number): number {
  const o = Number.isFinite(tempoOctaves) ? Math.max(-1, Math.min(1, tempoOctaves)) : 0
  return 0.5 + 0.5 * o
}

/** Multiplier on a scene's fit from how well its tempo trait matches the song's tempo. 1 with no trustworthy BPM. */
export function bpmFactor(sceneId: string, tempoOctaves: number, confidence: number): number {
  const gate = clamp01(((Number.isFinite(confidence) ? confidence : 0) - BPM_CONF_FLOOR) / (BPM_CONF_CEIL - BPM_CONF_FLOOR))
  if (gate <= 0) return 1
  const close = 1 - Math.abs(getSceneTraits(sceneId).tempo - bpmTarget01(tempoOctaves)) // 0..1, ~0.4 typical worst
  const f = 1 + BPM_SWING * (2 * clamp01((close - 0.4) / 0.6) - 1) // 0.7 .. 1.3
  return 1 + gate * (f - 1)
}

/** A scene compiled this session is preferred; a heavy one is not, on weaker tiers or in a breakdown. */
export const COST_COMPILED_BONUS = 1.3
export const COST_HEAVY_MID_TIER = 0.55
export const COST_HEAVY_FALLING = 0.4
export const COST_COLD_WEAK_TIER = 0.6

export function costFactor(c: ArmCandidate, tier: number, trend: ArmTrend): number {
  let f = c.compiled ? COST_COMPILED_BONUS : 1
  if (c.cost === 'high') {
    if (tier >= 2) f *= COST_HEAVY_MID_TIER
    if (trend === 'falling') f *= COST_HEAVY_FALLING
  }
  if (!c.compiled && tier >= 3) f *= COST_COLD_WEAK_TIER
  return f
}

/**
 * At tier >= this, ONLY scenes that are already compiled (or cheap) may be armed at all: a first compile is a visible
 * spike on a device that is already struggling, and constant arming must never be what pushes it over.
 */
export const COLD_ARM_MAX_TIER = 2

/** Candidates the tier allows arming. Never empties a list that has a compiled or low-cost member. */
export function armableCandidates(cands: readonly ArmCandidate[], tier: number): ArmCandidate[] {
  if (tier <= COLD_ARM_MAX_TIER) return [...cands]
  return cands.filter((c) => c.compiled || c.cost === 'low')
}

export interface ArmContext {
  /** The live character read (for the picker's seeded, weighted choice). */
  character: CharacterState
  trend: ArmTrend
  /** `f.tempoOctaves` and `f.confidence`. */
  tempoOctaves: number
  bpmConfidence: number
  tier: number
  /** The mood look, only when `sceneLookActive` says it may steer scenes. */
  look: LookProfile | undefined
  /** Scene on screen now: never armed. */
  sceneId: string
  recentIds: readonly string[]
}

export interface ArmScore {
  id: string
  /** aff x lookBoost x bpm x cost. Only ratios between candidates mean anything. */
  fit: number
  aff: number
  lookBoost: number
  bpm: number
  cost: number
}

function boostPhase(trend: ArmTrend): BoostPhase {
  return trend === 'rising' ? 'drop' : 'auto'
}

/** Deterministic fit of one scene in a context (no recency, no randomness). */
export function scoreScene(c: ArmCandidate, ctx: ArmContext): ArmScore {
  const point = targetPoint(ctx.character, ctx.trend)
  const aff = characterAffinity(c.id, point, PICK_SPREAD_SCALE)
  const lookBoost = ctx.look ? sceneBoost(c.id, ctx.look, boostPhase(ctx.trend)) : 1
  const bpm = bpmFactor(c.id, ctx.tempoOctaves, ctx.bpmConfidence)
  const cost = costFactor(c, ctx.tier, ctx.trend)
  return { id: c.id, fit: aff * lookBoost * bpm * cost, aff, lookBoost, bpm, cost }
}

/** Every armable candidate scored, best first, current scene excluded. */
export function rankCandidates(cands: readonly ArmCandidate[], ctx: ArmContext): ArmScore[] {
  return armableCandidates(cands, ctx.tier)
    .filter((c) => c.id !== ctx.sceneId)
    .map((c) => scoreScene(c, ctx))
    .sort((a, b) => b.fit - a.fit || (a.id < b.id ? -1 : 1))
}

/**
 * Does the armed scene still fit? `armed` is its own fit, `best` the best armable candidate's. The caller compares
 * the two with `ARM.refitRatio` (armedChange.ts). An id that is not a candidate scores 0 (so it gets re-picked).
 */
export function armedFit(armedId: string, cands: readonly ArmCandidate[], ctx: ArmContext): { armed: number; best: number } {
  const ranked = rankCandidates(cands, ctx)
  const best = ranked.length > 0 ? ranked[0].fit : 0
  const mine = cands.find((c) => c.id === armedId)
  const armed = mine ? scoreScene(mine, ctx).fit : 0
  return { armed, best: Math.max(best, armed) }
}

/** A short, human-readable reason for the debug overlay, e.g. `rise aff.71 bpm+.12 mood x1.4`. */
export function describeChoice(s: ArmScore, trend: ArmTrend): string {
  const t = trend === 'rising' ? 'rise' : trend === 'falling' ? 'fall' : 'flat'
  const b = s.bpm - 1
  const bpm = `${b >= 0 ? '+' : '-'}${Math.abs(b).toFixed(2).replace(/^0/, '')}`
  return `${t} aff${s.aff.toFixed(2).replace(/^0/, '')} bpm${bpm} look x${s.lookBoost.toFixed(1)} cost x${s.cost.toFixed(1)}`
}

export interface PickInput {
  /** Real scene definitions (the registry's primary-capable, mood-tagged list). */
  scenes: readonly SceneDef[]
  /** Cost / compiled facts by id. A scene missing here reads as cold and medium. */
  facts: ReadonlyMap<string, ArmCandidate>
  ctx: ArmContext
  key: string
  now: number
  exclude?: readonly string[]
  rng?: () => number
}

/**
 * The scene to arm: the character picker's weighted, recency-aware choice over the armable candidates, with the
 * BPM, cost and trend-flavoured look factors folded in as its `boost`. Null when the character read is not ready
 * (the caller then falls back to the mood-label pick, so arming can never leave the show without a scene).
 */
export function pickNextScene(o: PickInput): SceneDef | null {
  const { ctx } = o
  const armable = new Set(
    armableCandidates(
      o.scenes.map((s) => o.facts.get(s.id) ?? { id: s.id, cost: 'medium' as const, compiled: false }),
      ctx.tier,
    ).map((c) => c.id),
  )
  const pool = o.scenes.filter((s) => armable.has(s.id) && s.id !== ctx.sceneId)
  if (pool.length === 0) return null
  // The picker fits the point it is handed: push it by the trend (the same lift/lower `scoreScene` applies).
  const p = targetPoint(ctx.character, ctx.trend)
  const character: CharacterState = { ...ctx.character, valence: p.valence, arousal: p.arousal, tension: p.tension, pulse: p.pulse }
  return pickByCharacter(pool, {
    character,
    key: o.key,
    now: o.now,
    recentIds: ctx.recentIds,
    exclude: [ctx.sceneId, ...(o.exclude ?? [])],
    boost: (scene) => {
      const c = o.facts.get(scene.id) ?? { id: scene.id, cost: 'medium' as const, compiled: false }
      const look = ctx.look ? sceneBoost(scene.id, ctx.look, boostPhase(ctx.trend)) : 1
      return look * bpmFactor(scene.id, ctx.tempoOctaves, ctx.bpmConfidence) * costFactor(c, ctx.tier, ctx.trend)
    },
    rng: o.rng,
  })
}

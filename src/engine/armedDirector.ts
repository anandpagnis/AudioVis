import type { AudioFeatures, MoodState } from '../audio/types'
import { getCharacterCandidates, getPrimaryScenesForMood, pickVariedScene, type SceneDef } from '../scenes'
import { sceneLookActive } from '../scenes/sceneTraits'
import { canAutoSwitch, useStore } from '../store'
import {
  armableCandidates,
  armedFit,
  armTrend,
  describeChoice,
  pickNextScene,
  scoreScene,
  type ArmCandidate,
  type ArmContext,
  type ArmCost,
  type ArmTrend,
} from './armedPick'
import { ARM, commitArmed, createArmedState, type DirectorTrigger } from './armedChange'
import { armOff } from './look/lookFlags'
import { performanceState } from './performanceState'
import { quality } from './quality'
import { sceneStreamer } from './streaming/sceneStreamer'

/**
 * The store- and registry-facing half of the armed scene (`armedChange.ts` is the pure state machine,
 * `armedPick.ts` the pure scoring). One place for everything the directors share:
 *
 *  - the single armed-state instance (`AutoPilot` steps it; `PerformanceDirector` reads it),
 *  - building the live context (mood, BPM, DSP trend, tier, look) the picker and the fit check score against,
 *  - picking the scene to arm, and
 *  - `tryCommitArmed`: how a director that wants a scene change gets the ARMED scene instead of a cold one.
 */

/** `?arm=off`, read once at startup. Off: nothing is ever armed and every director picks a fresh scene as before. */
export const ARM_ENABLED = !armOff()

/** The one armed state. Module-level so `AutoPilot` (which steps it) and `PerformanceDirector` share it. */
export const armedRuntime = { state: createArmedState() }

/** Hand a director's look, only when it may steer scenes (the same gate the rest of the scene decisions use). */
export function activeLook() {
  return sceneLookActive(performanceState.look) ? performanceState.look : undefined
}

export function trendOf(f: AudioFeatures): ArmTrend {
  return armTrend({
    structureValid: f.structureValid,
    isSustain: f.songSection.isSustain,
    isBreakdown: f.songSection.isBreakdown,
    beatsTillDrop: f.songSection.beatsTillDrop,
    buildUp: f.buildUp,
    moodBuilding: f.mood.isBuilding,
    moodDecaying: f.mood.isDecaying,
    moodMelting: f.mood.isMelting,
    moodState: f.mood.state,
    predictedState: f.mood.predictedState,
    beatsTillTransition: f.mood.beatsTillTransition,
  })
}

export function buildArmContext(f: AudioFeatures, sceneId: string, recentIds: readonly string[], trend?: ArmTrend): ArmContext {
  return {
    character: f.character,
    trend: trend ?? trendOf(f),
    tempoOctaves: f.tempoOctaves,
    bpmConfidence: f.confidence,
    tier: quality.tier,
    look: activeLook(),
    sceneId,
    recentIds,
  }
}

function factsFor(scenes: readonly SceneDef[]): Map<string, ArmCandidate> {
  const out = new Map<string, ArmCandidate>()
  for (const sc of scenes) {
    out.set(sc.id, {
      id: sc.id,
      cost: sc.metadata.performanceCost as ArmCost,
      compiled: sceneStreamer.hasCompiled(sc.id),
    })
  }
  return out
}

/**
 * The scene to arm now, from the mood, the BPM and the DSP trend (`armedPick.pickNextScene`). Falls back to the
 * mood-label pick while the character read is not ready, so arming can never leave the show without a scene.
 * `exclude` are ids a previous attempt already had refused.
 */
export function pickArmScene(
  f: AudioFeatures,
  s: ReturnType<typeof useStore.getState>,
  exclude: readonly string[] = [],
  trend?: ArmTrend,
): SceneDef | null {
  const ctx = buildArmContext(f, s.sceneId, s.recentSceneIds, trend)
  const scenes = getCharacterCandidates()
  const facts = factsFor(scenes)
  const picked = pickNextScene({ scenes, facts, ctx, key: f.key, now: f.time, exclude })
  if (picked) return picked
  const mood: MoodState =
    ctx.trend === 'rising' ? 'peak' : ctx.trend === 'falling' ? 'ambient' : f.mood.state === 'silence' ? 'groove' : f.mood.state
  const allowed = new Set(
    armableCandidates(
      getPrimaryScenesForMood(mood).map((sc) => facts.get(sc.id) ?? { id: sc.id, cost: 'medium' as const, compiled: false }),
      ctx.tier,
    ).map((c) => c.id),
  )
  const pool = getPrimaryScenesForMood(mood).filter((sc) => allowed.has(sc.id) && sc.id !== s.sceneId && !exclude.includes(sc.id))
  return pickVariedScene(pool, mood, s.recentSceneIds) ?? null
}

/** Why the scene was chosen, for the overlay: the trend and each factor's contribution. */
export function armReason(f: AudioFeatures, s: ReturnType<typeof useStore.getState>, sceneId: string, trend?: ArmTrend): string {
  const ctx = buildArmContext(f, s.sceneId, s.recentSceneIds, trend)
  const fact = factsFor(getCharacterCandidates()).get(sceneId) ?? { id: sceneId, cost: 'medium' as const, compiled: false }
  return describeChoice(scoreScene(fact, ctx), ctx.trend)
}

/** The armed scene's fit against the best candidate in the CURRENT context. `ok` = it still suits the music. */
export function armedFitNow(
  f: AudioFeatures,
  s: ReturnType<typeof useStore.getState>,
  armedId: string,
  trend?: ArmTrend,
): { armed: number; best: number; ok: boolean } {
  const ctx = buildArmContext(f, s.sceneId, s.recentSceneIds, trend)
  const fit = armedFit(armedId, factsToList(getCharacterCandidates()), ctx)
  return { ...fit, ok: fit.armed > 0 && fit.armed >= ARM.refitRatio * fit.best }
}

function factsToList(scenes: readonly SceneDef[]): ArmCandidate[] {
  return [...factsFor(scenes).values()]
}

/**
 * A director wants a scene change NOW (a confirmed mood change, a section boundary, a build): if the armed scene is
 * still held, still fits the music and (unless `immediate`) the 32-beat dwell has elapsed, release it and report
 * true, so the director skips its own cold pick. False = nothing to commit; the director picks as it always did.
 *
 * Only a release, never a request: the store's hold is what `SceneManager` waits on, so the commit lands on the
 * next downbeat (or at once when `immediate`) with the shader already compiled.
 */
export function tryCommitArmed(
  trigger: DirectorTrigger,
  immediate: boolean,
  f: AudioFeatures,
  trend?: ArmTrend,
): boolean {
  const st = armedRuntime.state
  const a = st.armed
  if (!ARM_ENABLED || a === null) return false
  const s = useStore.getState()
  if (s.heldSceneId !== a.sceneId || s.pendingSceneId !== a.sceneId) return false
  if (!immediate && !canAutoSwitch(s.lastCommitBeat, f.beatIndex)) return false
  if (!armedFitNow(f, s, a.sceneId, trend).ok) return false
  if (!s.releaseHold(immediate)) return false
  commitArmed(st, trigger, f.beatIndex)
  return true
}

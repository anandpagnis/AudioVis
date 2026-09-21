import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { lookOf } from '../audio/characterLook'
import type { AudioFeatures } from '../audio/types'
import { cueState } from './CueTimeline'
import type { LookProfile } from './look/lookRow'
import { performanceState, type ActiveEffect } from './performanceState'
import { quality } from './quality'
import { renderScale } from './renderScale'
import type { ValenceArousal } from './valenceArousal'
import { committedMs } from './frameLoad'
import { admitSlots, slotCostMs } from './slotBudget'
import { getEffectScenes, pickVariedScene, type EffectTrigger, type SceneDef } from '../scenes'
import { useStore } from '../store'

/**
 * Event-triggered visual punctuation.
 *
 * Separate from PerformanceDirector because the two work on different clocks.
 * That director wakes at section and phrase boundaries — far too coarse for a
 * burst that has to land on a transient. This one runs every frame watching for
 * edges, and owns `performanceState.layers.effects` outright.
 *
 * Effect scenes are PINNED at session start by SceneManager, so firing one
 * costs no shader compile — an effect mounts precisely when something is
 * happening, which is the worst possible moment to stall.
 *
 * Content: `getEffectScenes()` returns three scenes (c6) — `shock` (drop),
 * `flare` (sectionChange/buildPeak) and `spark` (transient) — one per trigger
 * family, so `pickVariedScene` below only ever has to choose between
 * candidates that already agree on WHICH kind of moment they are answering.
 * Every path below still early-returns cleanly if that list is ever empty
 * again (a future licence sweep, say), which is what let this machinery ship
 * and be fully tested well before any of the three existed.
 */

/** Only ever one effect on screen at a time. */
const MAX_ACTIVE = 1

let fireKey = 0

/**
 * Rising-edge detection for every trigger.
 *
 * Levels, not events: `f.drop` stays true for 0.6s and `f.buildUp` for much
 * longer, so firing on the raw flag would re-trigger every frame for the whole
 * window. Kept as explicit previous-value state for the same reason AutoPilot
 * tracks `prevDrop` — the edge has to be observed even on frames where the
 * director is otherwise suppressed, or a flag that rose during a manual hold
 * fires the instant the hold lifts.
 */
export class TriggerEdges {
  private prevDrop = false
  private prevBuild = false
  private prevTransient = false

  /** Which triggers fired on THIS frame. Call exactly once per frame. */
  update(f: AudioFeatures): EffectTrigger[] {
    const fired: EffectTrigger[] = []
    if (f.drop && !this.prevDrop) fired.push('drop')
    // A build's PEAK is its last frame, not its first — that is the moment the
    // release lands, and firing at the start would punctuate the wrong thing.
    if (!f.buildUp && this.prevBuild) fired.push('buildPeak')
    // `sectionChange` is already a one-frame pulse, so it needs no edge state.
    if (f.sectionChange) fired.push('sectionChange')
    const transientHit = f.transient > 0.7
    if (transientHit && !this.prevTransient) fired.push('transient')

    this.prevDrop = f.drop
    this.prevBuild = f.buildUp
    this.prevTransient = transientHit
    return fired
  }
}

/**
 * How likely the mood look profile makes an effect scene: `fxShock` / `fxFlare` / `fxSpark` / `fxStrobe` for
 * `shock` / `flare` / `spark` / `strobe` (0..1.5, and ALREADY scaled by the fast layer's intensity gate, so a
 * calm passage of an epic song does not get peak effects). An effect the profile has no field for (a future scene, a
 * test fixture) is unweighted (1); a non-finite value is unweighted too rather than an exclusion; a negative one is 0.
 */
export function effectPropensity(id: string, look: LookProfile): number {
  let v: number
  switch (id) {
    case 'shock':
      v = look.fxShock
      break
    case 'flare':
      v = look.fxFlare
      break
    case 'spark':
      v = look.fxSpark
      break
    case 'strobe':
      v = look.fxStrobe
      break
    default:
      return 1
  }
  return Number.isFinite(v) ? Math.max(0, v) : 1
}

/**
 * Advance the active list: retire what has expired, admit what just fired.
 *
 * Pure and exported for tests. `now` is `features.time`, which restarts at 0 on
 * a new source — handled by the retire pass, since every active effect's
 * `startedAt` then sits in the future and its elapsed time reads negative.
 */
export function advanceEffects(opts: {
  active: readonly ActiveEffect[]
  fired: readonly EffectTrigger[]
  candidates: readonly SceneDef[]
  now: number
  budget: number
  /**
   * Everything the frame has ALREADY committed — the primary, any second
   * primary mid-crossfade, every mounted layer, the live effects, the post
   * chain.
   *
   * Was `primaryUnits`, which is what made this claimant dangerous: it reserved
   * only the subject, so an effect could fire on top of a full three-slot
   * composition believing the frame held one scene. See frameLoad.ts.
   */
  committedMs: number
  /** Quality tier the costs should be priced at. */
  tier: number
  lastFiredAt: Map<string, number>
  mood: Parameters<typeof pickVariedScene>[1]
  recentIds: readonly string[]
  /** Live internal resolution — forwarded to `slotCostMs`; see its own doc. */
  internalMP?: number
  /** Live valence/arousal read — forwarded to `pickVariedScene`. */
  currentVA?: ValenceArousal
  /**
   * The mood look profile, passed ONLY while it is valid and its `scene` family is on. When given, each
   * eligible effect's odds in the weighted pick are multiplied by its propensity ({@link effectPropensity}),
   * and an effect whose propensity is 0 is excluded outright. Everything else — which effects a trigger can
   * fire, cooldowns, durations, the one-at-a-time cap, the budget check — is unchanged. Omitted, the pick is
   * exactly the original.
   */
  look?: LookProfile
}): ActiveEffect[] {
  const {
    active,
    fired,
    candidates,
    now,
    budget,
    committedMs,
    tier,
    lastFiredAt,
    mood,
    recentIds,
    internalMP,
    currentVA,
    look,
  } = opts

  // Retire: expired, or stranded by a source restart that rewound the clock.
  const elapsed = (e: ActiveEffect) => now - e.startedAt
  const kept = active.filter((e) => elapsed(e) >= 0 && elapsed(e) < e.durationSec)
  if (fired.length === 0 || kept.length >= MAX_ACTIVE) return kept as ActiveEffect[]

  const activeIds = new Set(kept.map((e) => e.id))
  const eligible = candidates.filter((scene) => {
    const fx = scene.metadata.effect
    if (!fx) return false
    if (activeIds.has(scene.id)) return false
    if (!fx.triggers.some((t) => fired.includes(t))) return false
    // Cooldowns are per-effect rather than global, so two different effects can
    // both answer one drop while a single effect cannot machine-gun.
    const last = lastFiredAt.get(scene.id)
    if (last !== undefined && fx.cooldownSec && now - last < fx.cooldownSec) return false
    return true
  })
  if (eligible.length === 0) return kept as ActiveEffect[]

  // Mood look weighting, applied through pickVariedScene's own `boost` hook (a per-candidate multiplier on its
  // moodFit x recency x VA weight) so that function — which lives with the scene registry — is untouched. The
  // hook alone cannot EXCLUDE: a lone candidate is returned without being weighed, an all-zero draw falls
  // through to the first candidate, and a roll of exactly 0 lands on a leading zero-weight one. So
  // zero-propensity effects are filtered out first. A lone remaining candidate therefore fires whatever its
  // (non-zero) propensity: a weight can only reorder candidates against each other, not thin a trigger that
  // has just one answer.
  let candidatesForPick = eligible
  let boost: ((scene: SceneDef) => number) | undefined
  if (look) {
    candidatesForPick = eligible.filter((scene) => effectPropensity(scene.id, look) > 0)
    if (candidatesForPick.length === 0) return kept as ActiveEffect[]
    boost = (scene) => effectPropensity(scene.id, look)
  }

  const pick = pickVariedScene(candidatesForPick, mood, recentIds, boost, currentVA)
  if (!pick) return kept as ActiveEffect[]

  // Effects are last in line for budget — the frame still reads without them.
  // `committedMs` already includes the effects currently firing, so nothing
  // is added for `kept` here; double-counting them would make an effect
  // progressively harder to fire the longer the previous one ran.
  const reserved = committedMs
  const ms = slotCostMs(
    pick.id,
    tier,
    'effect',
    pick.metadata.roleScalable,
    pick.metadata.performanceCost,
    internalMP,
  )
  if (admitSlots(budget, reserved, [{ slot: 'effect', ms }]).length === 0) {
    return kept as ActiveEffect[]
  }

  lastFiredAt.set(pick.id, now)
  return [
    ...kept,
    {
      id: pick.id,
      startedAt: now,
      durationSec: pick.metadata.effect!.durationSec,
      key: fireKey++,
    },
  ]
}

export function EffectDirector() {
  const edges = useRef(new TriggerEdges())
  const lastFiredAt = useRef(new Map<string, number>())

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const p = performanceState

    // Edges are consumed every frame regardless of suppression, so a flag that
    // rose while an authored cue was running cannot fire the moment it ends.
    const fired = edges.current.update(f)

    const candidates = getEffectScenes()
    if (candidates.length === 0) {
      if (p.layers.effects.length > 0) p.layers.effects = []
      return
    }

    // Effects deliberately IGNORE the 45s manual hold that suppresses the other
    // directors. Punctuation is not a composition choice: a DJ who picked a
    // scene by hand did not thereby ask for drops to stop being marked. Cue
    // governance is still respected — an authored show owns its own moments.
    const suppressed =
      !s.autoPilot ||
      s.status !== 'running' ||
      f.silence ||
      cueState.governed ||
      performanceState.djCam.active ||
      performanceState.limitless.active

    p.layers.effects = advanceEffects({
      active: p.layers.effects,
      fired: suppressed ? [] : fired,
      candidates,
      now: f.time,
      budget: quality.knobs.frameBudgetMs,
      committedMs: committedMs(),
      tier: quality.tier,
      lastFiredAt: lastFiredAt.current,
      mood: lookOf(f.mood),
      recentIds: s.recentSceneIds,
      internalMP: renderScale.internalMP(renderScale.applied),
      currentVA: { valence: performanceState.valence, arousal: performanceState.arousal },
      look: p.look.valid && p.look.families.scene ? p.look : undefined,
    })
  }, -86) // after CueTimeline (-88) settles governance, before PerformanceDirector (-85)

  return null
}

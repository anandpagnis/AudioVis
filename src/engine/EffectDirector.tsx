import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { AudioFeatures } from '../audio/types'
import { cueState } from './CueTimeline'
import { performanceState, type ActiveEffect } from './performanceState'
import { quality } from './quality'
import { admitSlots, slotCost } from './slotBudget'
import { getEffectScenes, getScene, pickVariedScene, type EffectTrigger, type SceneDef } from '../scenes'
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
 * Inert until effect scenes are authored: `getEffectScenes()` is empty today,
 * so every path below early-returns.
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
  primaryUnits: number
  lastFiredAt: Map<string, number>
  mood: Parameters<typeof pickVariedScene>[1]
  recentIds: readonly string[]
}): ActiveEffect[] {
  const { active, fired, candidates, now, budget, primaryUnits, lastFiredAt, mood, recentIds } = opts

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

  const pick = pickVariedScene(eligible, mood, recentIds)
  if (!pick) return kept as ActiveEffect[]

  // Effects are last in line for budget — the frame still reads without them.
  const reserved =
    primaryUnits +
    kept.reduce((sum, e) => sum + slotCost(getScene(e.id).metadata.performanceCost, 'effect'), 0)
  const units = slotCost(pick.metadata.performanceCost, 'effect', pick.metadata.roleScalable)
  if (admitSlots(budget, reserved, [{ slot: 'effect', units }]).length === 0) {
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
    const suppressed = !s.autoPilot || s.status !== 'running' || f.silence || cueState.governed

    p.layers.effects = advanceEffects({
      active: p.layers.effects,
      fired: suppressed ? [] : fired,
      candidates,
      now: f.time,
      budget: quality.knobs.layerBudget,
      primaryUnits: slotCost(getScene(p.activeScene).metadata.performanceCost, 'primary'),
      lastFiredAt: lastFiredAt.current,
      mood: f.mood.state,
      recentIds: s.recentSceneIds,
    })
  }, -86) // after CueTimeline (-88) settles governance, before PerformanceDirector (-85)

  return null
}

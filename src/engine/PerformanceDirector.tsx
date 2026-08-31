import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { getAudioResponse } from './audioResponse'
import { cueState } from './CueTimeline'
import { frameLoad } from './frameLoad'
import { quality } from './quality'
import { admitSlots, slotCostMs, type SlotRequest } from './slotBudget'
import {
  getCompatibleScenes,
  getPrimaryScenesForMood,
  getScene,
  getScenesForMood,
  pickVariedScene,
  type SceneDef,
  type ScenePerformanceCost,
} from '../scenes'
import { LAYER_ROLES, useStore, type LayerRole } from '../store'

const MANUAL_HOLD_SEC = 45
const PHRASE_HOLD_BEATS = 16 // fallback recompose cadence when no section fires

/**
 * How many layers may sit over the primary at once, by the primary's cost.
 *
 * **This is an art-direction rule, not a performance one**, and the two are
 * deliberately separate. The cost budget in slotBudget.ts asks "can the GPU
 * carry this?" and it answers correctly; it was never asked "does this many
 * things in one frame read as composed?" — and the answer to that turned out to
 * be no. Measured over 40k simulated compositions, 57% filled both accent and
 * overlay, putting three scenes on screen (four mid-crossfade), every one of
 * them blending additively. That is the "overlaying more than two scenes looks
 * tacky" report, and no budget number fixes it: at the boot tier a low-cost
 * primary reserves 1 unit of 6, so two low-cost layers fit trivially and always
 * will.
 *
 * A heavy primary gets one layer rather than two because it has already filled
 * the frame — the layer is punctuation on a busy image, and a second one is
 * just noise over noise.
 */
const MAX_LAYERS_BY_PRIMARY_COST: Record<ScenePerformanceCost, number> = {
  low: 2,
  medium: 2,
  high: 1,
}

/**
 * Compose the layer slots for one decision, within the quality budget.
 *
 * Accent and overlay are no longer mutually exclusive — that was a policy of
 * the old two-slot resolver, not a structural limit. What replaces it is the
 * cost budget: a slot is filled only if its scene fits in what the primary left
 * behind (see slotBudget.ts). Slots that cannot be funded, or whose pool is
 * empty, resolve to null and their existing entry fades out — the same
 * every-slot-written-every-time discipline the old resolver needed, for the
 * same reason (nothing else writes these).
 *
 * `pools` may legitimately be empty for a role. `background` has no registered
 * scenes at all today, and that is a supported steady state, not a failure —
 * with an empty pool this returns exactly the accent/overlay behaviour the
 * two-slot version produced.
 *
 * Exported for the unit test; the component is the only production caller.
 */
export function composeLayers(opts: {
  /** The subject the layers are being composed around — priced, not just capped. */
  primaryId: string
  primaryCost: ScenePerformanceCost
  /** Milliseconds available for everything in this composition. */
  budget: number
  /** Quality tier the costs are priced at. */
  tier: number
  /** Candidate list per slot, best fit first. Empty or absent = leave unfilled. */
  pools: Partial<Record<LayerRole, readonly SceneDef[]>>
  mood: MoodState
  recentIds: readonly string[]
  /** Admission order; lets the busier of accent/overlay get first refusal. */
  priority?: readonly LayerRole[]
}): Record<LayerRole, string | null> {
  const { primaryId, primaryCost, budget, tier, pools, mood, recentIds, priority } = opts
  const picks: Partial<Record<LayerRole, SceneDef>> = {}
  const requests: SlotRequest[] = []

  // A scene may only hold ONE slot in a composition.
  //
  // The pools overlap heavily — `orbs` carries background, accent and overlay
  // between them — so without this the same scene is picked for two slots, and
  // `resolveLayerIds` then drops the later one at mount time for being a
  // duplicate. The composition the director chose and the composition that
  // renders are different, which is the flicker F19 describes: a layer chosen
  // and immediately dropped.
  //
  // Excluded from the POOL rather than filtered afterwards, so the later slot
  // gets a genuine second choice instead of simply losing its turn.
  const taken = new Set<string>()
  for (const role of LAYER_ROLES) {
    const pool = pools[role]?.filter((s) => !taken.has(s.id))
    if (!pool || pool.length === 0) continue
    const pick = pickVariedScene(pool, mood, recentIds)
    if (!pick) continue
    taken.add(pick.id)
    picks[role] = pick
    requests.push({
      slot: role,
      ms: slotCostMs(pick.id, tier, role, pick.metadata.roleScalable, pick.metadata.performanceCost),
    })
  }

  const affordable = admitSlots(
    budget,
    slotCostMs(primaryId, tier, 'primary', false, primaryCost),
    requests,
    priority,
  )

  // Then the editorial cap, applied to what the budget already allowed. Order
  // matters: `admitSlots` returns slots in the caller's priority order, so
  // taking a prefix keeps the most structural / most-wanted layers and drops
  // the tail. Background is exempt — it is the ground the composition sits on,
  // not one of the detail layers stacking over the subject, and it carries a
  // 0.40 gain by default precisely so it reads as behind rather than alongside.
  const cap = MAX_LAYERS_BY_PRIMARY_COST[primaryCost]
  const admitted = new Set<LayerRole>()
  let stacked = 0
  for (const slot of affordable) {
    if (slot === 'effect') continue
    if (slot !== 'background') {
      if (stacked >= cap) continue
      stacked++
    }
    admitted.add(slot)
  }

  return {
    background: admitted.has('background') ? (picks.background?.id ?? null) : null,
    accent: admitted.has('accent') ? (picks.accent?.id ?? null) : null,
    overlay: admitted.has('overlay') ? (picks.overlay?.id ?? null) : null,
  }
}

/**
 * The primary scenes eligible to follow `currentSceneId` in `mood`.
 *
 * Exported for the unit test; the component is the only production caller. It
 * exists as a named function because the thing it must NOT do is subtle: see
 * the call site for why `compatibleWith` deliberately plays no part here.
 */
export function selectPrimaryCandidates(mood: MoodState, currentSceneId: string): SceneDef[] {
  return getPrimaryScenesForMood(mood).filter((scene) => scene.id !== currentSceneId)
}

/**
 * Phrase-level scene composer. A true section change recomposes instantly; when
 * the track offers no section boundary it recomposes at most once per phrase
 * (16 beats). SceneManager handles the exact downbeat commit and crossfade.
 * There is no wall-clock hold — pacing is measured in beats so it tracks the
 * song, not the clock.
 */
export function PerformanceDirector() {
  const lastBoundaryBeat = useRef(-1)
  const lastSwitchBeat = useRef(-Infinity)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    // Note: we do NOT bail on a pending primary switch here. Layer composition
    // must still run while AutoPilot's scene change commits, otherwise the
    // accent/overlay layers (only set here) almost never appear.
    if (!s.autoPilot || s.status !== 'running' || f.silence) return
    if (cueState.governed) return // authored cues own the journey
    if (f.time - s.lastManualAt < MANUAL_HOLD_SEC) return

    // Hold the subject through a confirmed build-up — recomposing mid-riser is
    // exactly the "transitions when it doesn't need to" complaint. The drop
    // itself (`songSection.boundaryChanged` on the build→drop commit) still
    // gets through below.
    if (f.structureValid && f.songSection.isBuild && !f.songSection.boundaryChanged) return

    // With a real structure read, a latched boundary replaces the blind
    // 16-beat timer; without one, the timer is the degraded fallback.
    const latchedBoundary = f.structureValid && f.songSection.boundaryChanged
    const phraseFallback =
      !f.structureValid && f.beat && f.beatInBar === 0 && f.beatIndex > 0 && f.beatIndex % 16 === 0
    const boundary = f.sectionChange || latchedBoundary || phraseFallback
    if (!boundary || f.beatIndex === lastBoundaryBeat.current) return
    lastBoundaryBeat.current = f.beatIndex

    // Real boundaries (section novelty or a latched structural edge) cut
    // immediately; only the blind periodic fallback respects the one-phrase
    // spacing so calm stretches aren't over-recomposed.
    if (
      !f.sectionChange &&
      !latchedBoundary &&
      f.beatIndex - lastSwitchBeat.current < PHRASE_HOLD_BEATS
    )
      return

    const response = getAudioResponse(f)
    const mood = f.mood.predictedState === 'silence' ? f.mood.state : f.mood.predictedState
    const compatible = getCompatibleScenes(s.sceneId)
    const compatibleIds = new Set(compatible.map((c) => c.id))

    // Primary pool is role-safe (getScenesForMood alone is NOT — it also
    // returns accent/overlay-only scenes like `ribbons`, which used to be
    // reachable as a primary pick since `requestScene` has no role check of
    // its own). Layer pool deliberately stays role-agnostic; that's exactly
    // the scenes an accent/overlay slot wants.
    //
    // `compatibleWith` deliberately does NOT filter this pool. It declares
    // which scenes LAYER well together (see getCompatibleScenes' doc and the
    // layer pick below) — it says nothing about which subject should follow
    // which, and using it for succession was a real bug: the four original
    // scenes list only each other, so {wireframe, plasma, dissolve, chrome}
    // formed a closed clique. Once the show entered it, it could never leave,
    // and the six newer primaries (network, pointcloud, inversion, foldpath,
    // torusfold, juliawings) were unreachable through this director entirely —
    // measured 0% over 20k simulated picks, versus ~9% each afterwards.
    // AutoPilot could still stumble into them on a mood change, but this
    // director fires far more often and pulled the show straight back, most
    // often onto `wireframe` (the only primary every scene lists as
    // compatible). That is what "wireframe is always on" actually was.
    // A breakdown wants the show to breathe — no expensive raymarchers, no
    // stacked layers. Only gated when the structure read is real; otherwise the
    // pools are unchanged.
    const inBreakdown = f.structureValid && f.songSection.isBreakdown
    const notHeavy = (scene: SceneDef) => scene.metadata.performanceCost !== 'high'

    const primaryCandidates = inBreakdown
      ? selectPrimaryCandidates(mood, s.sceneId).filter(notHeavy)
      : selectPrimaryCandidates(mood, s.sceneId)

    const layerFits = inBreakdown ? [] : getScenesForMood(mood)
    const layerPool = layerFits.filter((scene) => compatibleIds.has(scene.id))
    const layerCandidates = layerPool.length > 0 ? layerPool : layerFits

    if (primaryCandidates.length === 0 && layerCandidates.length === 0) return

    // Prefer scenes that express the strongest current musical layer — folded
    // into pickVariedScene as a weight boost rather than a hard sort, so it
    // shapes the odds without collapsing back to a deterministic pick.
    const band =
      response.sub > response.bass * 0.9
        ? 'bass'
        : response.high > response.mid
          ? 'high'
          : response.vocal > 0.5
            ? 'vocal'
            : response.energy > 0.6
              ? 'energy'
              : 'mid'
    const bandBoost = (scene: (typeof primaryCandidates)[number]) =>
      scene.metadata.bands.includes(band) ? 1.6 : 1

    // Only pick a new primary when one isn't already mid-commit; otherwise we'd
    // fight AutoPilot's in-flight switch. Either way we (re)compose the layers
    // against whichever primary is landing.
    let primaryId = s.pendingSceneId ?? s.sceneId
    if (!s.pendingSceneId && primaryCandidates.length > 0) {
      const pick = pickVariedScene(primaryCandidates, mood, s.recentSceneIds, bandBoost)
      // Only aim the layers at the new subject if the request was actually
      // ACCEPTED. `requestScene` refuses silently when the subject dwell floor
      // (MIN_SUBJECT_DWELL_BEATS) has not elapsed, and this used to assume it
      // had succeeded — so on every refused request the layers below were
      // composed against a scene that was never going to appear. That picks
      // `compatibleWith` partners for the wrong subject, and can select the
      // scene that IS currently primary, which `resolveLayerIds` then has to
      // null out at render time. A layer chosen and immediately dropped is
      // exactly the flicker that looks like a failed transition.
      if (pick && s.requestScene(pick.id, { auto: true })) primaryId = pick.id
    }

    // Which of accent/overlay the busier material wants. Both slots can now be
    // occupied at once, so this decides which gets FIRST refusal rather than
    // which is the only one allowed.
    const leadRole: LayerRole =
      response.energy > 0.58 || response.dropPulse > 0 ? 'overlay' : 'accent'
    const forRole = (role: LayerRole) =>
      layerCandidates.filter(
        (scene) => scene.id !== primaryId && scene.metadata.roles.includes(role),
      )

    // Background recomposes on SECTION boundaries only, never on the phrase
    // fallback: it is the ground the rest of the composition sits on, and a
    // ground that changes every 16 beats is just a second primary. Holding the
    // previous pick means passing an empty pool, which composeLayers reads as
    // "leave it alone".
    const backgroundPool =
      (f.sectionChange || latchedBoundary) && !inBreakdown ? forRole('background') : []

    const slots = composeLayers({
      primaryId,
      primaryCost: getScene(primaryId).metadata.performanceCost,
      tier: quality.tier,
      // The tier's budget LESS the costs that are present in every frame and
      // were previously invisible to it: the post chain and the feedback pass
      // overlay when enabled. Composing against the raw tier budget meant the
      // layers were funded out of money the post chain had already spent.
      // Floored: since F110 made the fixed costs scale with resolution, a 4K
      // frame at the top tier can reserve more than the whole tier budget. That
      // is a true statement about the frame and the right answer is to admit
      // nothing, not to hand a negative number to the slot arithmetic.
      budget: Math.max(0, quality.knobs.frameBudgetMs - frameLoad.fixed),
      pools: {
        background: backgroundPool,
        [leadRole]: forRole(leadRole),
        [leadRole === 'overlay' ? 'accent' : 'overlay']: forRole(
          leadRole === 'overlay' ? 'accent' : 'overlay',
        ),
      },
      mood,
      recentIds: s.recentSceneIds,
      // Background stays most-structural-first; the busier of the two detail
      // slots takes precedence over the quieter one under a tight budget.
      priority: ['background', leadRole, leadRole === 'overlay' ? 'accent' : 'overlay'],
    })
    // Background is preserved across non-section recomposes; the other two are
    // always written, since nothing else clears them.
    if (f.sectionChange || latchedBoundary) s.setLayer('background', slots.background, { auto: true })
    s.setLayer('accent', slots.accent, { auto: true })
    s.setLayer('overlay', slots.overlay, { auto: true })
    lastSwitchBeat.current = f.beatIndex
  }, -85)

  return null
}

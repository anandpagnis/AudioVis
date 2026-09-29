import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { isPhraseEdge } from '../audio/structure/downbeat'
import type { MoodState } from '../audio/types'
import { tryCommitArmed } from './armedDirector'
import { getAudioResponse } from './audioResponse'
import { cueState } from './CueTimeline'
import { frameLoad } from './frameLoad'
import { performanceState } from './performanceState'
import { quality } from './quality'
import { renderScale } from './renderScale'
import type { ValenceArousal } from './valenceArousal'
import { admitSlots, slotCostMs, type SlotRequest } from './slotBudget'
import {
  getCharacterCandidates,
  getCompatibleScenes,
  getPrimaryScenesForMood,
  getScene,
  getScenesForMood,
  pickVariedScene,
  sceneOwnsFrame,
  type SceneDef,
  type ScenePerformanceCost,
} from '../scenes'
import { sceneBoost, sceneLookActive } from '../scenes/sceneTraits'
import { LAYER_ROLES, manualHoldActive, useStore, type LayerRole } from '../store'
import { pickByCharacter } from './characterPick'
import { DIRECTOR_ON } from './show/directorFlags'
import { LAYERS_CUT, LAYERS_NONE, showRuntime } from './show/showRuntime'

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
  /** Live internal resolution — forwarded to `slotCostMs`; see its own doc. */
  internalMP?: number
  /** Live valence/arousal read — forwarded to `pickVariedScene`; see its own
   *  doc on why this sharpens the discrete `mood` fit rather than replacing it. */
  currentVA?: ValenceArousal
  /** Character-driven pick for one layer pool; return null to use the mood-label pick. */
  pickLayer?: (pool: readonly SceneDef[]) => SceneDef | null
}): Record<LayerRole, string | null> {
  const { primaryId, primaryCost, budget, tier, pools, mood, recentIds, priority, internalMP, currentVA, pickLayer } =
    opts
  const picks: Partial<Record<LayerRole, SceneDef>> = {}
  const requests: SlotRequest[] = []

  // A scene may only hold ONE slot in a composition.
  //
  // The pools overlap heavily — `plasma` and `ribbons` each carry accent and
  // overlay — so without this the same scene is picked for two slots, and
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
    const pick = pickLayer?.(pool) ?? pickVariedScene(pool, mood, recentIds, undefined, currentVA)
    if (!pick) continue
    taken.add(pick.id)
    picks[role] = pick
    requests.push({
      slot: role,
      ms: slotCostMs(
        pick.id,
        tier,
        role,
        pick.metadata.roleScalable,
        pick.metadata.performanceCost,
        internalMP,
      ),
    })
  }

  const affordable = admitSlots(
    budget,
    slotCostMs(primaryId, tier, 'primary', false, primaryCost, internalMP),
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
 * The candidate pool for ONE layer role: mood-fitting, eligible for `role`,
 * not the current subject — preferring scenes `compatibleWith` the subject,
 * falling back to the full role-eligible pool only when THIS role's own
 * compatible subset is empty.
 *
 * Exported for the unit test; the component (`forRole`, its call site) is the
 * only production caller. Named and extracted because the fallback decision
 * has to be made per role, and getting that wrong is exactly the bug this
 * function exists to prevent: computing one global compatible-vs-fallback
 * pool ACROSS every role (the previous shape) meant a mood whose fitting
 * scenes included even one primary-only compatible id — common, since most
 * scenes are primary-only — silently starved whichever role's own compatible
 * candidates ran out first. No scene anywhere lists `malachite`, `nebula`,
 * `dustfield` or `hold` in `compatibleWith` (`hold` declares `[]`), so any
 * subject whose compatible set was non-empty but entirely primary-only (e.g.
 * `network`, `orbs`) got `[]` for background forever, never reaching
 * `layerFits`.
 */
export function layerPoolForRole(
  role: LayerRole,
  layerFits: readonly SceneDef[],
  primaryId: string,
  compatibleIds: ReadonlySet<string>,
): SceneDef[] {
  const fitsForRole = layerFits.filter(
    (scene) => scene.id !== primaryId && scene.metadata.roles.includes(role),
  )
  const compatibleForRole = fitsForRole.filter((scene) => compatibleIds.has(scene.id))
  return compatibleForRole.length > 0 ? compatibleForRole : fitsForRole
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
    if (performanceState.djCam.active) return // a DJ-cam cutaway owns the frame
    if (performanceState.limitless.active) return // a Limitless cutaway owns the frame
    if (manualHoldActive(s.lastManualAt, MANUAL_HOLD_SEC)) return

    // Hold the subject through a confirmed build-up — recomposing mid-riser is
    // exactly the "transitions when it doesn't need to" complaint. The drop
    // itself (`songSection.boundaryChanged` on the build→drop commit) still
    // gets through below.
    //
    // `isSustain`, not `isBuild`: SectionTracker.ts sets
    // `s.dropExpected = buildConfirmed` and `s.isSustain = s.isBuild ||
    // s.dropExpected`, so today the two fields are identical every frame and
    // this is a behavior-preserving no-op — but `isSustain`'s own doc on
    // SongSectionMomentum defines it as "hold discretionary transitions",
    // which is this call site's own intent, not something `isBuild` alone
    // ever promised. Should `dropExpected` gain a source independent of
    // `buildConfirmed`, this keeps holding for the right reason. Same fix
    // applied at AutoPilot.tsx:360, for the identical reason.
    // (Under the show director the hold is the director's own decision: it simply asks for no recompose mid-riser.)
    if (!DIRECTOR_ON && f.structureValid && f.songSection.isSustain && !f.songSection.boundaryChanged) return

    // With a real structure read, a latched boundary replaces the blind
    // 16-beat timer; without one, the timer is the degraded fallback.
    const latchedBoundary = f.structureValid && f.songSection.boundaryChanged
    // `isPhraseEdge` = first beat of every 4th bar (`bar` counts from the estimated downbeat). The old
    // `beatIndex % 16 === 0` test is only equal to this while the downbeat offset is 0; with an adopted
    // offset it could never be true together with `beatInBar === 0`, silently killing this fallback.
    const phraseFallback = !f.structureValid && isPhraseEdge(f.beat, f.beatInBar, f.bar)
    // Under the show director (default) `f.sectionChange`, the latched boundary and the blind 16-beat phrase no longer
    // recompose anything on their own: the layers change only when the director asks (a MICRO for accent / overlay,
    // a CUT for the background too), through `showRuntime.layers`. `?director=legacy` keeps the three signals.
    const boundary = DIRECTOR_ON ? showRuntime.layers !== LAYERS_NONE : f.sectionChange || latchedBoundary || phraseFallback
    // A section-scale recompose (the background too): a section signal, or under the director a CUT.
    const sectionBoundary = DIRECTOR_ON ? showRuntime.layers === LAYERS_CUT : f.sectionChange || latchedBoundary
    if (!boundary || f.beatIndex === lastBoundaryBeat.current) return
    lastBoundaryBeat.current = f.beatIndex

    // Real boundaries (section novelty or a latched structural edge) cut
    // immediately; only the blind periodic fallback respects the one-phrase
    // spacing so calm stretches aren't over-recomposed.
    if (
      !DIRECTOR_ON &&
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

    // Under the show director this hook never picks the primary (an empty list skips the pick below): the director's
    // CUT does, and this hook only recomposes the layers around whichever primary is landing.
    const primaryCandidates: SceneDef[] = DIRECTOR_ON
      ? []
      : inBreakdown
        ? selectPrimaryCandidates(mood, s.sceneId).filter(notHeavy)
        : selectPrimaryCandidates(mood, s.sceneId)

    const layerFits = inBreakdown ? [] : getScenesForMood(mood)

    if (!DIRECTOR_ON && primaryCandidates.length === 0 && layerFits.length === 0) return

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
    // With a valid mood-driven look whose scene family is on, the character pick also leans on the look's trait
    // targets (`sceneBoost`, which already folds in `buildIntent`), multiplied into the band boost. Otherwise
    // (and for the mood-label fallback below) the band boost alone, exactly as before.
    const look = performanceState.look
    const characterBoost = sceneLookActive(look)
      ? (scene: (typeof primaryCandidates)[number]) => bandBoost(scene) * sceneBoost(scene, look)
      : bandBoost

    // Only pick a new primary when one isn't already mid-commit; otherwise we'd
    // fight AutoPilot's in-flight switch. Either way we (re)compose the layers
    // against whichever primary is landing.
    // A HELD (armed) pending scene is not landing yet: until it is released the current scene is still the subject
    // the layers must sit on. A boundary is exactly the moment to cut to it (already picked from the music and
    // compiled, armedDirector.ts); only when it no longer fits does a fresh, cold pick replace it (`requestScene`
    // clears the hold).
    const heldPending = s.heldSceneId !== null && s.heldSceneId === s.pendingSceneId
    let primaryId = s.pendingSceneId && !heldPending ? s.pendingSceneId : s.sceneId
    const armedTaken = heldPending && tryCommitArmed('boundary', false, f)
    if (armedTaken) primaryId = s.heldSceneId as string
    if (!armedTaken && (!s.pendingSceneId || heldPending) && primaryCandidates.length > 0) {
      // Character-driven pick over every primary-capable scene (not just this mood label's pool,
      // which overlaps the others ~90%); null until the character read is ready, then the
      // original mood-label pick runs unchanged.
      const characterPool = getCharacterCandidates().filter(
        (sc) => sc.id !== s.sceneId && (!inBreakdown || notHeavy(sc)),
      )
      const pick =
        pickByCharacter(characterPool, {
          character: f.character,
          key: f.key,
          now: f.time,
          recentIds: s.recentSceneIds,
          exclude: [s.sceneId],
          boost: characterBoost,
        }) ??
        pickVariedScene(primaryCandidates, mood, s.recentSceneIds, bandBoost, {
          valence: performanceState.valence,
          arousal: performanceState.arousal,
        })
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
    // See `layerPoolForRole`'s own doc for the bug this fixes — the fallback
    // to the full mood-fit pool now happens per role, not once globally.
    //
    // A subject that owns the frame (`ownsFrame`) takes no layers: every pool is
    // empty, so the composition writes null into each slot and the store agrees
    // with what renders (PerformanceStateBridge holds them null regardless).
    const owned = sceneOwnsFrame(primaryId)
    const forRole = (role: LayerRole) =>
      owned ? [] : layerPoolForRole(role, layerFits, primaryId, compatibleIds)

    // Background recomposes on SECTION boundaries only, never on the phrase
    // fallback: it is the ground the rest of the composition sits on, and a
    // ground that changes every 16 beats is just a second primary. Holding the
    // previous pick means passing an empty pool, which composeLayers reads as
    // "leave it alone".
    const backgroundPool = sectionBoundary && !inBreakdown ? forRole('background') : []

    const slots = composeLayers({
      primaryId,
      primaryCost: getScene(primaryId).metadata.performanceCost,
      tier: quality.tier,
      // Price every candidate at what the frame is actually rendering, not
      // what its tier implies alone — see slotCostMs's own doc.
      internalMP: renderScale.internalMP(renderScale.applied),
      // Sharpens the layer pools' discrete mood fit the same way it does for
      // the primary above — see pickVariedScene's own doc.
      currentVA: { valence: performanceState.valence, arousal: performanceState.arousal },
      pickLayer: (pool) =>
        pickByCharacter(pool, {
          character: f.character,
          key: f.key,
          now: f.time,
          recentIds: s.recentSceneIds,
        }),
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
    if (sectionBoundary) s.setLayer('background', slots.background, { auto: true })
    s.setLayer('accent', slots.accent, { auto: true })
    s.setLayer('overlay', slots.overlay, { auto: true })
    lastSwitchBeat.current = f.beatIndex
  }, -85)

  return null
}

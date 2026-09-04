import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { cueState } from './CueTimeline'
import { performanceState } from './performanceState'
import { quality } from './quality'
import { ISF_FILTER_MS, remainingMs } from './frameLoad'
import { TIER_BUDGET_MS } from './slotBudget'
import { TriggerEdges } from './EffectDirector'
import {
  FILTER_COOLDOWN_SEC,
  FILTER_MOOD_STYLES,
  filterUnusableReason,
  ISF_AUTOFIRE_ENABLED,
  ISF_FILTERS,
  isFilterSelectable,
} from './isfFilterRoster'
import { effectEnvelope } from '../scenes/effectEnvelope'
import type { EffectTrigger } from '../scenes'
import { useStore } from '../store'

/**
 * The WRITER side of `performanceState.filter`: an event-triggered flourish
 * that picks an ISF post-processing filter and eases it in and back out,
 * exactly the way `EffectDirector` picks and times an effect scene. See that
 * component's own header for the fuller case for a separate per-frame
 * director rather than folding this into `PerformanceDirector`'s
 * section/phrase-scale clock — a filter has to land on the same transients
 * an effect scene does, which is a faster clock than mood or phrase changes.
 *
 * `PostFXChain` is the executor on the other side of the seam: it reads
 * `performanceState.filter` and calls `IsfFilterPass.setFilter()` /
 * `.setMix()` with no further smoothing, per that field's own doc comment.
 * That is why every value this director writes is already the FINAL shaped
 * number — `mix` is `effectEnvelope` applied to elapsed-over-duration, not a
 * target for someone downstream to ease toward.
 *
 * ## One filter, one budget claimant — simpler than EffectDirector
 *
 * `EffectDirector` competes for one of several composition SLOTS
 * (background/accent/overlay/effect) via `admitSlots`, because a scene can
 * legitimately occupy any of several roles. A filter has no such choice:
 * there is exactly one `IsfFilterPass`, permanently mounted, with one fixed
 * reservation (`ISF_FILTER_MS`, frameLoad.ts). So admission here is a direct
 * headroom check — `remainingMs(TIER_BUDGET_MS[tier]) >= ISF_FILTER_MS` —
 * rather than a slot competition. This works as a pre-admission check
 * specifically because `performanceState.filter.id` is still whatever it
 * currently was (null when idle) at the moment it runs: `committedMs()`
 * does not yet include the filter about to be selected, the same "check
 * before you commit" logic `advanceEffects` already relies on for
 * `admitSlots`.
 *
 * For the identical reason, cooldown is tracked with a SINGLE shared clock
 * rather than `EffectDirector`'s per-scene `Map` — `MAX_ACTIVE` is
 * effectively 1 here too (one `IsfFilterPass`), so "per scene" and "global"
 * cooldown collapse into the same thing, and a single number is simpler than
 * a one-entry map for no loss of meaning.
 *
 * ## Suppression
 *
 * Same posture as `EffectDirector`: filters are punctuation, not composition,
 * so they ignore the manual 45s hold (a human picking a scene by hand did not
 * thereby ask for the show to stop marking its own moments) but respect
 * `cueState.governed` (an authored show owns its own moments) and `f.silence`
 * (matches `FILTER_MOOD_STYLES.silence === []` — near-silence is not a moment
 * to punctuate). While suppressed, an ALREADY-active flourish is left to
 * finish naturally rather than cut — same "fade, don't snap" posture as
 * everywhere else in this codebase — only the START of a new one is refused.
 *
 * ## Manual picks
 *
 * `store.pendingFilterId` is the one-shot channel a human uses to fire a
 * filter by hand: `requestFilter(id)` sets it, this director reads it on its
 * next frame and calls `clearFilterRequest()`. It has to work that way
 * precisely because this component OWNS `performanceState.filter` — it
 * rewrites that field every frame and nulls it on every frame no flourish is
 * live — so a UI writing `p.filter` directly would be stomped one frame
 * later. Routing a manual request THROUGH the director is the same seam
 * `pendingSceneId` gives `SceneManager` for a hand-picked scene.
 *
 * What a manual pick bypasses (trigger edge, cooldown, suppression, budget)
 * and why is argued at the top of `advanceFilter`.
 *
 * ## Mount priority: -84
 *
 * Grepped every `useFrame(..., N)` priority in `src/engine` before picking
 * this: SceneManager -100, PerformanceStateBridge -95, AutoPilot -90,
 * CueTimeline -88, EffectDirector -86, PerformanceDirector -85,
 * CameraDirector -80 (then the execute band: scenes at 0, PostFXChain at 1,
 * ExposureSampler/ScreenshotCapture at 2). This sits at -84: after
 * EffectDirector (-86), matching the brief's own reasoning that `committedMs`
 * should reflect this frame's just-decided effects before a filter is
 * admitted against it — and after PerformanceDirector (-85), since nothing
 * that director writes (`visualTension`, `animationIntensity`, camera-facing
 * fields) affects filter admission or picking, so there is no reason to race
 * it. Still comfortably inside the "decide" band, ahead of CameraDirector
 * (-80) and everything in "execute" — see Stage.tsx's header for why that
 * boundary matters: only "decide" may write `performanceState`.
 */

/** Total flourish lifetime: attack + hold + release, in seconds.
 *
 * Sized against `scenes/index.ts`'s three effect-scene durations — 1.2s
 * (transient), 1.8s (sectionChange/buildPeak), 4.0s (drop) — the same
 * "musical, not momentary" magnitude `effectLifecycle.test.ts` pins (every
 * effect scene's `durationSec` is required to be >1s and <8s). A filter
 * flourish sits at the upper end of that range on purpose:
 * `FILTER_COOLDOWN_SEC`'s own doc comment already establishes a filter as "a
 * sustained full-frame treatment — closer in weight to the drop flourish
 * than to a quick transient hit," and duration should track the same
 * editorial weight. 3.5s reads as a real treatment (long enough to actually
 * be seen and recognised as a texture change) while staying clearly under
 * the 15s cooldown, so the flourish is always long gone before another one
 * could plausibly be admitted.
 */
export const FILTER_FLOURISH_DURATION_SEC = 3.5

/**
 * One live filter flourish, tracked internally by `FilterDirector` only.
 *
 * Deliberately NOT the shape stored in `performanceState.filter` — that
 * field holds just `{ id, mix }`, the final already-eased value the executor
 * reads. This is the director's own bookkeeping for computing that value
 * frame to frame, the same role `EffectDirector`'s `ActiveEffect.startedAt`/
 * `durationSec` play for effect scenes (those happen to live on
 * `performanceState.layers.effects` because `SceneManager` also needs to
 * read the list; nothing downstream needs a filter's lifecycle, only its
 * current `id`/`mix`, so this stays local).
 */
export interface ActiveFilter {
  id: string
  /** Engine time (`features.time`) the flourish began. */
  startedAt: number
  /** Copied from {@link FILTER_FLOURISH_DURATION_SEC} at fire time. */
  durationSec: number
}

/**
 * Choose a filter for the mood, rotating through its preference list and
 * excluding both disabled filters and the most-recently-fired id.
 *
 * Modeled directly on `transitions.ts`'s `pickTransitionStyle`: same
 * rotation math (`pool[Math.abs(rotation) % pool.length]`), same anti-repeat
 * shape (drop `lastId` from the pool only when an alternative remains, so a
 * mood with exactly one selectable filter can still repeat it rather than
 * picking nothing), same deterministic-not-random reasoning — a recorded
 * show has to replay identically, which a `Math.random()` pick could never
 * guarantee.
 *
 * Not literally calling `pickTransitionStyle` itself: that function is typed
 * and hard-wired to `transitions.ts`'s own `TransitionStyle` union and its
 * own `MOOD_STYLES` table, and carries boundary-type/section-change logic
 * (`DROP_STYLE`/`BREAKDOWN_STYLE`) that has no filter equivalent — a filter
 * flourish is chosen by mood alone, the same trigger-and-cooldown gate
 * already decided WHETHER to fire before this is ever called. Reproducing
 * its rotation arithmetic directly (rather than generalising it into a
 * shared helper neither existing call site asked for) keeps this a small,
 * self-contained pick function with no coupling to the transition module's
 * unrelated concerns.
 *
 * Returns `null` when the mood's preferred list is empty after filtering —
 * `silence` maps to `[]` in `FILTER_MOOD_STYLES` on purpose (see that
 * table's own doc comment) — and the caller must treat that as "nothing to
 * fire," not retry with a fallback list.
 */
export function pickFilter(mood: MoodState, lastId: string | null, rotation: number): string | null {
  const preferred = FILTER_MOOD_STYLES[mood].filter(isFilterSelectable)
  if (preferred.length === 0) return null
  const fresh = preferred.filter((id) => id !== lastId)
  const pool = fresh.length > 0 ? fresh : preferred
  return pool[Math.abs(rotation) % pool.length]
}

/**
 * Advance the single filter flourish: retire it if expired or stranded by a
 * clock rewind, otherwise admit a new one if nothing is currently active,
 * something fired this frame, the shared cooldown has elapsed, and the
 * budget has headroom.
 *
 * Pure and exported for tests, mirroring `advanceEffects`'s shape in
 * `EffectDirector.tsx` — retire-then-admit in one pass — but simplified for
 * a single always-mounted pass rather than a competitive multi-slot budget;
 * see this module's header for why `admitSlots` does not apply here.
 *
 * `manualId` short-circuits all of that — see the block comment on it below.
 *
 * `headroomMs` is `remainingMs(TIER_BUDGET_MS[tier])` computed by the
 * caller, not read from the `frameLoad` singleton in here — same reason
 * `advanceEffects` takes `committedMs` as a plain number rather than calling
 * `committedMs()` itself: a pure function that took its budget from a global
 * would need that global mocked for every test. Injecting the already-computed
 * number keeps this testable with nothing but plain arguments.
 */
export function advanceFilter(opts: {
  active: ActiveFilter | null
  fired: readonly EffectTrigger[]
  now: number
  /** `remainingMs(TIER_BUDGET_MS[tier])`, computed by the caller. */
  headroomMs: number
  lastFiredAt: number
  mood: MoodState
  lastId: string | null
  rotation: number
  /**
   * A filter the user asked for by hand this frame (`store.pendingFilterId`),
   * null on all but a handful of frames. Optional so every existing caller and
   * test keeps its current meaning: absent reads as "no manual request".
   */
  manualId?: string | null
}): ActiveFilter | null {
  const { active, fired, now, headroomMs, lastFiredAt, mood, lastId, rotation, manualId } = opts

  // ---- Manual pick: handled first, ahead of even the retire pass. ----
  //
  // Ahead of the retire/keep-alive branch below on purpose, so a second pick
  // REPLACES a live flourish (new id, fresh `startedAt`) instead of being
  // swallowed by "one is already running". A chip that visibly does nothing
  // when clicked reads as broken, and a person clicking again is the clearest
  // possible statement that they want the new one now.
  if (manualId) {
    // Validated against the roster rather than trusted: `pendingFilterId` is a
    // bare string crossing a store seam, so it can be stale (an id that left
    // the roster between a render and this frame) or simply wrong. An unknown
    // id falls through to the autonomous path below, which leaves any live
    // flourish untouched — a bad request is a no-op, never a cut. The CALLER
    // clears the request either way, so a bad id can never wedge the queue.
    //
    // Membership in `ISF_FILTERS`, deliberately NOT `isFilterSelectable`:
    // `DISABLED_FILTERS` governs AUTONOMOUS rotation — what `pickFilter` may
    // choose on its own — not what a human may explicitly ask for. Same
    // posture as the HUD's existing transition-style chips, which render
    // disabled styles greyed out but still clickable. So `Color Invert` can be
    // fired by hand even though `pickFilter` will never select it.
    // `filterUnusableReason` is checked even though this is the MANUAL path,
    // and it is the one gate here that a person does not outrank. Everything
    // else this branch bypasses is pacing — how often the show may punctuate
    // itself — and a person asking for a filter is a good reason to ignore
    // pacing. An unusable filter is not paced, it is broken on this platform
    // (see UNUSABLE_FILTERS), so honouring the request would just be running
    // the bug on demand. Both pickers already render these un-clickable; this
    // is the choke point that makes that true rather than merely displayed.
    if (ISF_FILTERS.some((f) => f.id === manualId) && !filterUnusableReason(manualId)) {
      // Note what is NOT consulted here: whether a trigger edge fired,
      // `FILTER_COOLDOWN_SEC`, the suppression gate (the caller simply never
      // routes suppression into `manualId`), and `headroomMs`.
      //
      // The precedent is explicit in `store.ts`'s `requestScene`: "Manual picks
      // are exempt (the user asked for it)" — and the same sentence exempts a
      // hand pick from `setLayer`'s dwell floor. This codebase already treats a
      // deliberate human action as outranking the machinery that PACES the
      // autonomous show, and trigger-edge/cooldown/suppression are exactly that
      // machinery: they exist so the director does not over-fire on its own,
      // not to tell a person they may not see a filter they asked for.
      //
      // The budget bypass is the one part of this a future reader will rightly
      // question, so, explicitly: a manual fire is a BOUNDED, user-initiated,
      // one-shot ~3.5s cost with no repeat path — it can only happen as fast as
      // someone can click, and it retires itself. That is categorically unlike
      // the autonomous branch below, which is evaluated every single frame and
      // would re-fire indefinitely if its own headroom check were dropped —
      // which is exactly why that check stays there. Worst case here is one
      // flourish overshooting the frame budget for 3.5s, with the quality tier
      // reacting as it always does; that is the right trade against a control
      // that silently refuses to do anything on a loaded frame.
      return { id: manualId, startedAt: now, durationSec: FILTER_FLOURISH_DURATION_SEC }
    }
  }

  // Retire: expired, or stranded by a source restart that rewound the clock
  // (features.time back to 0 leaves startedAt in the future, same failure
  // EffectDirector's own retire pass guards against).
  if (active) {
    const elapsed = now - active.startedAt
    if (elapsed >= 0 && elapsed < active.durationSec) return active
  }

  if (fired.length === 0) return null
  if (now - lastFiredAt < FILTER_COOLDOWN_SEC) return null
  if (headroomMs < ISF_FILTER_MS) return null

  const id = pickFilter(mood, lastId, rotation)
  if (!id) return null

  return { id, startedAt: now, durationSec: FILTER_FLOURISH_DURATION_SEC }
}

export function FilterDirector() {
  const edges = useRef(new TriggerEdges())
  const active = useRef<ActiveFilter | null>(null)
  // Single shared clock — see the header for why this is one number rather
  // than EffectDirector's per-scene Map.
  const lastFiredAt = useRef(-Infinity)
  const lastId = useRef<string | null>(null)
  const rotation = useRef(0)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const p = performanceState

    // Edges are consumed every frame regardless of suppression, so a flag
    // that rose while an authored cue was running cannot fire the moment it
    // ends — identical reasoning to EffectDirector's own edge handling.
    const fired = edges.current.update(f)

    // Read and consume in the same frame, valid or not: `advanceFilter` refuses
    // an unknown id, and leaving a bad one in the store would re-offer it on
    // every subsequent frame forever.
    const manualId = s.pendingFilterId
    if (manualId !== null) s.clearFilterRequest()

    // Same posture as EffectDirector: ignores the manual 45s hold (punctuation
    // is not a composition choice) but respects cue governance and silence.
    //
    // `ISF_AUTOFIRE_ENABLED` folds in here rather than anywhere else on
    // purpose: this term only zeroes `fired`, so switching autofire off stops
    // the director CHOOSING one while leaving both the manual path
    // (`manualId`, passed independently below) and the natural finish of an
    // already-live flourish untouched. See that constant's own doc.
    const suppressed =
      !ISF_AUTOFIRE_ENABLED ||
      !s.autoPilot ||
      s.status !== 'running' ||
      f.silence ||
      cueState.governed

    const next = advanceFilter({
      active: active.current,
      fired: suppressed ? [] : fired,
      now: f.time,
      headroomMs: remainingMs(TIER_BUDGET_MS[quality.tier]),
      lastFiredAt: lastFiredAt.current,
      mood: f.mood.state,
      lastId: lastId.current,
      rotation: rotation.current,
      manualId,
    })

    // Runs for a manual fire exactly as for an autonomous one — a hand pick
    // still stamps `lastFiredAt`/`lastId`/`rotation`, so the anti-repeat
    // rotation and the cooldown stay coherent afterwards and the next
    // autonomous pick does not simply repeat what was just fired by hand.
    //
    // A new flourish just started iff the id changed from what was active
    // (covers both "was idle, now firing" and "re-fired the same id" is
    // impossible since pickFilter excludes lastId whenever an alternative
    // exists — but even a same-id repeat after a full cooldown is still a
    // genuinely NEW flourish, distinguished by `startedAt` changing).
    if (next && next !== active.current) {
      lastFiredAt.current = next.startedAt
      lastId.current = next.id
      rotation.current++
    }
    active.current = next

    // Mutated in place rather than reassigned — `performanceState.ts`'s own
    // header calls out that the hot path allocates nothing (same reason
    // `p.mirror.twist`/`p.mirror.slice` are field-assigned in
    // PerformanceStateBridge.tsx rather than `p.mirror = {...}`), and this
    // runs every frame a flourish is live, not just on state transitions.
    if (next) {
      const elapsed = f.time - next.startedAt
      p.filter.id = next.id
      p.filter.mix = effectEnvelope(elapsed / next.durationSec)
    } else if (p.filter.id !== null) {
      p.filter.id = null
      p.filter.mix = 0
    }
  }, -84) // after EffectDirector (-86) and PerformanceDirector (-85); see header

  return null
}

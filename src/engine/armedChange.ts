/**
 * The ARMED drop scene: keep the scene a drop will cut to already picked, mounted and compiled (held, hidden,
 * uncommitted) before the drop arrives, and release it the instant the drop is confirmed.
 *
 * ## Why
 *
 * Today the drop scene is picked AT the drop (`AutoPilot`'s `dropEdge` path), so a scene that is cold this
 * session pays pick -> chunk load -> shader compile inside `SceneManager`'s 0.35 s grace, then commits cold and
 * stalls on the drop. The old 1-3-beat "pre-arm" tried to fix that but is usually REFUSED by the 32-beat dwell
 * floor (the confirmed-build switch stamps it) and cannot warm anything in 1-3 beats. A build gives 15-30 s of
 * warning; this uses it.
 *
 * ## The model
 *
 * One record, `ArmedRecord`, plus a small edge tracker (`ArmedState`), advanced once per frame by the pure
 * `stepArmed`, which returns what the caller must DO (`arm` a scene, `confirm` it, `disarm` it). This file has no
 * React, three, or store imports: the caller (`AutoPilot.tsx`) supplies the live inputs and performs the store
 * calls, exactly like `buildSwitch.ts`.
 *
 * The scene is held through the store's existing single pending slot (`pendingSceneId`, `MAX_PENDING = 1`) with
 * `heldSceneId` set: `SceneManager` still mounts and compiles it, but `resolveCommit` will not commit it while it
 * is held. The slot is therefore occupied for the length of the hold; that is bounded (`ARM.expiryBeats`) and
 * every way out is a disarm reason below. Other automatic switches are already held off through a confirmed
 * build (`AutoPilot`'s `inSustain`), so the slot was idle anyway.
 *
 * ## Arm
 * Once per build, while a CONFIRMED build is sustained (`structureValid && songSection.isSustain`; the fast
 * `f.buildUp` heuristic alone is not enough, it only counts through `SectionTracker`), when: the feature is on
 * (`?arm` not off), automation is not suppressed (manual hold, cue-governed, DJ-cam / Limitless cutaway,
 * autopilot off), not silent, `quality.tier <= ARM.maxTier`, nothing is pending, and this is not the build's
 * rising-edge frame (that frame belongs to `shouldSwitchOnBuild`, which must get first claim on the slot). The
 * 32-beat dwell floor is NOT checked here: a drop already bypasses it today, and the arm is only a hold.
 *
 * ## Confirm
 *  - `f.drop` rising edge: commit NOW as a hard cut (the drop path is `immediate` today; unchanged). Accepted at
 *    any time, even right after arming, since it is the ground-truth signal.
 *  - The projected drop beat (`beatsTillDrop`, re-projected every beat) reached, less `predictLeadBeats`, with
 *    the build still sustained, the arm at least `minHoldBeats` old, not silent, AND the 32-beat dwell elapsed
 *    (the dwell is enforced HERE, at confirm): commit on the next downbeat as a normal crossfade (`immediate`
 *    false: an unconfirmed guess must not hard-cut). This catches drops the DSP misses. It then suppresses the
 *    normal drop pick for `dropSuppressBeats` so a late real drop does not switch a second time.
 *
 * ## Disarm
 * `off` (flag), `suppressed`, `tier` (> maxTier), `superseded` (someone else replaced or committed the pending
 * scene, or the current scene became the armed one), `expired` (`expiryBeats`), `fizzle` (the build ended for
 * `fizzleGraceBeats` without a drop), `reset` (the beat counter went backwards: a new source).
 *
 * Re-arming needs a NEW build: `attempted` is only cleared once the build has ended.
 */

export const ARM = {
  /** Hold at most this many beats (~16 s at 120 BPM), then give the pending slot back. */
  expiryBeats: 32,
  /** The predicted-beat confirm is not accepted until the arm is this old. (A real drop is always accepted.) */
  minHoldBeats: 2,
  /** Release this many beats before the projected drop so the downbeat gate can land ON it. */
  predictLeadBeats: 1,
  /** A build must stay ended this many beats before the hold is given up: absorbs a one-beat flicker. */
  fizzleGraceBeats: 2,
  /** Arm only at quality tiers 0..maxTier; holding a second scene is the first thing to shed under load. */
  maxTier: 2,
  /** After a predicted commit, the normal drop pick is suppressed for this many beats. */
  dropSuppressBeats: 8,
} as const

export type ConfirmTrigger = 'drop' | 'predicted'
export type DisarmReason = 'off' | 'suppressed' | 'tier' | 'superseded' | 'expired' | 'fizzle' | 'reset'

/** What is currently armed. `gate` is always `hold` in phase 1 (held until confirmed). */
export interface ArmedRecord {
  sceneId: string
  /** The mode chosen for the armed scene (set in the store at arm time), or null. Debug only. */
  mode: string | null
  armedAtBeat: number
  expiresAtBeat: number
  /** Projected drop beat, -1 while unknown. Updated every beat from `beatsTillDrop`. */
  expectedBeat: number
  gate: 'hold'
  trigger: 'build'
}

export interface ArmedState {
  armed: ArmedRecord | null
  /** This build has had its arm attempt (placed or refused). Cleared once the build has ended. */
  attempted: boolean
  /** Beat the build was first seen ended while armed, -1 while it is sustained. */
  lostSustainAt: number
  /** The normal drop pick is suppressed while `beat < this` (after a predicted commit). */
  suppressDropPickUntil: number
  /** Newest beat seen, to detect a new source (beat counter restarting). */
  lastBeat: number
  /** Human-readable last outcome for the debug overlay, e.g. `drop@b140`, `fizzle@b120`, `refused@b99`. */
  lastOutcome: string
}

export function createArmedState(): ArmedState {
  return {
    armed: null,
    attempted: false,
    lostSustainAt: -1,
    suppressDropPickUntil: Number.NEGATIVE_INFINITY,
    lastBeat: Number.NEGATIVE_INFINITY,
    lastOutcome: '-',
  }
}

/** Everything `stepArmed` needs from the live app, one frame's worth. */
export interface ArmedInput {
  /** `?arm` is not off. */
  enabled: boolean
  /** Automation is not allowed to act: autopilot off / not running / cue-governed / cutaway / manual hold. */
  suppressed: boolean
  /** `f.silence`. Blocks arming and the predicted confirm (never a real drop). */
  silent: boolean
  /** `quality.tier`. */
  tier: number
  /** `f.beatIndex`. */
  beat: number
  /** `f.structureValid && f.songSection.isSustain`: a confirmed build is running. */
  sustain: boolean
  /** Rising edge of `sustain` this frame (from `observeBuild`). */
  buildEdge: boolean
  /** `f.drop` rising edge this frame. */
  dropEdge: boolean
  /** `f.songSection.beatsTillDrop` (-1 / 0 / NaN = unknown). */
  beatsTillDrop: number
  /** The store's pending scene, if any. */
  pendingSceneId: string | null
  /** The store's held scene id, if any. */
  heldSceneId: string | null
  /** The scene currently on screen. */
  sceneId: string
  /** `canAutoSwitch(lastCommitBeat, beat)`: the 32-beat dwell has elapsed. */
  canDwell: boolean
}

export type ArmedAction =
  | { type: 'none' }
  | { type: 'arm' }
  | { type: 'confirm'; trigger: ConfirmTrigger; immediate: boolean }
  | { type: 'disarm'; reason: DisarmReason }

const NONE: ArmedAction = { type: 'none' }

function validBeatsTillDrop(b: number): boolean {
  return Number.isFinite(b) && b > 0
}

function disarm(st: ArmedState, reason: DisarmReason, beat: number): ArmedAction {
  st.armed = null
  st.lostSustainAt = -1
  st.lastOutcome = `${reason}@b${beat}`
  return { type: 'disarm', reason }
}

/**
 * The caller placed the scene in the store: record it. Call ONLY after `armScene` accepted. Stamps the projected
 * drop beat when one is known.
 */
export function armPlaced(
  st: ArmedState,
  sceneId: string,
  mode: string | null,
  beat: number,
  beatsTillDrop: number,
): void {
  st.armed = {
    sceneId,
    mode,
    armedAtBeat: beat,
    expiresAtBeat: beat + ARM.expiryBeats,
    expectedBeat: validBeatsTillDrop(beatsTillDrop) ? beat + beatsTillDrop : -1,
    gate: 'hold',
    trigger: 'build',
  }
  st.lostSustainAt = -1
  st.lastOutcome = `armed@b${beat}`
}

/** The caller could not place any scene (every pick refused, or no candidate). The build's attempt stays spent. */
export function armRefused(st: ArmedState, beat: number): void {
  st.lastOutcome = `refused@b${beat}`
}

/** Should the NORMAL drop pick be skipped at this beat (a predicted commit just answered this drop)? */
export function dropPickSuppressed(st: ArmedState, beat: number): boolean {
  return beat < st.suppressDropPickUntil && beat >= st.suppressDropPickUntil - ARM.dropSuppressBeats
}

/**
 * Advance one frame. Mutates `st`; returns the single thing the caller must do. Call it EVERY frame, before
 * AutoPilot's early returns (like `observeBuild`), so an edge that lands while automation is suppressed is
 * consumed rather than firing late.
 *
 * After a `confirm` the record is already cleared here (the caller releases the store's hold); after a `disarm`
 * likewise (the caller clears the store's hold and, when it is still ours, the pending scene). An `arm` is a
 * request: the caller picks a scene and reports back through `armPlaced` / `armRefused`.
 */
export function stepArmed(st: ArmedState, i: ArmedInput): ArmedAction {
  // A new source restarts the beat counter: nothing from the old track may leak (a stale suppression window would
  // otherwise silence the normal drop pick for thousands of beats).
  if (i.beat < st.lastBeat) {
    const was = st.armed
    st.armed = null
    st.attempted = false
    st.lostSustainAt = -1
    st.suppressDropPickUntil = Number.NEGATIVE_INFINITY
    st.lastBeat = i.beat
    st.lastOutcome = `reset@b${i.beat}`
    if (was) return { type: 'disarm', reason: 'reset' }
  }
  st.lastBeat = i.beat

  const a = st.armed
  if (a === null) {
    // The build ended: the next one may be attempted.
    if (!i.sustain) st.attempted = false
    if (!i.enabled || i.suppressed || i.silent || i.tier > ARM.maxTier) return NONE
    if (st.attempted || !i.sustain || i.buildEdge || i.dropEdge) return NONE
    if (i.pendingSceneId !== null) return NONE
    st.attempted = true
    return { type: 'arm' }
  }

  // --- Armed: is it still valid? ---------------------------------------------------------------------------
  let reason: DisarmReason | null = null
  if (!i.enabled) reason = 'off'
  else if (i.suppressed) reason = 'suppressed'
  else if (i.tier > ARM.maxTier) reason = 'tier'
  else if (i.pendingSceneId !== a.sceneId || i.heldSceneId !== a.sceneId || i.sceneId === a.sceneId) {
    reason = 'superseded'
  } else if (i.beat >= a.expiresAtBeat) reason = 'expired'
  if (reason !== null) return disarm(st, reason, i.beat)

  // --- A real drop is the confirmation: cut to the armed scene now. ----------------------------------------
  if (i.dropEdge) {
    st.armed = null
    st.lostSustainAt = -1
    st.lastOutcome = `drop@b${i.beat}`
    return { type: 'confirm', trigger: 'drop', immediate: true }
  }

  // --- The build ended without a drop (after a short grace): give the slot back. ---------------------------
  if (i.sustain) {
    st.lostSustainAt = -1
  } else {
    if (st.lostSustainAt < 0) st.lostSustainAt = i.beat
    if (i.beat - st.lostSustainAt >= ARM.fizzleGraceBeats) return disarm(st, 'fizzle', i.beat)
  }

  // --- Predicted drop: the DSP is late or blind, the build's own projection says now. ----------------------
  if (validBeatsTillDrop(i.beatsTillDrop)) a.expectedBeat = i.beat + i.beatsTillDrop
  if (
    i.sustain &&
    !i.silent &&
    a.expectedBeat >= 0 &&
    i.beat >= a.expectedBeat - ARM.predictLeadBeats &&
    i.beat - a.armedAtBeat >= ARM.minHoldBeats &&
    i.canDwell
  ) {
    st.armed = null
    st.lostSustainAt = -1
    st.suppressDropPickUntil = i.beat + ARM.dropSuppressBeats
    st.lastOutcome = `predicted@b${i.beat}`
    return { type: 'confirm', trigger: 'predicted', immediate: false }
  }
  return NONE
}

/**
 * The armed state as the debug overlay reads it. Written by `AutoPilot` each frame (a reference and a string,
 * no allocation); `?lookdebug` prints it. Same singleton-probe pattern as `lookDebugProbe`.
 */
export const armedProbe: { armed: ArmedRecord | null; lastOutcome: string } = {
  armed: null,
  lastOutcome: '-',
}

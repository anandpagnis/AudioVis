/**
 * The ARMED next scene: keep the scene the show will cut to next already picked, mounted and compiled (held, hidden,
 * uncommitted) at ALL times, and release it the instant something confirms a change.
 *
 * ## Why this replaced the build-only arm
 *
 * Phase 1 armed once per CONFIRMED build (`structureValid && isSustain`) and only below quality tier 3. The user's
 * sessions read tier 3-4 and the structure detector rarely confirms a build, so it never engaged. The show also
 * still picked a COLD scene at every decision (mood change, phrase boundary, drop), which is where the lag was:
 * pick -> chunk load -> shader compile -> warm frames -> downbeat wait. Now there is always a next scene waiting
 * (`armedPick.ts` chooses it from the mood, the BPM and the DSP trend), and every director prefers committing it.
 *
 * ## The model
 *
 * One record, `ArmedRecord`, plus an edge/energy tracker (`ArmedState`), advanced once per frame by the pure
 * `stepArmed`, which returns what the caller must DO (`arm` a scene, `confirm` it, `disarm` it). No React, three,
 * or store imports: `armedDirector.ts` supplies the live inputs and performs the store calls.
 *
 * The scene is held through the store's single pending slot (`pendingSceneId`, `MAX_PENDING = 1`) with
 * `heldSceneId` set: `SceneManager` still mounts and compiles it, but `resolveCommit` will not commit it while it
 * is held. The slot is therefore occupied almost all the time; that is deliberate. A director that wants a
 * DIFFERENT scene simply requests it (`requestScene` replaces the pending scene and clears the hold).
 *
 * ## Arm (idle => arm)
 * Whenever nothing is pending and automation is allowed (autopilot running, no manual hold / cue / cutaway, not
 * silent, `quality.tier <= ARM.maxTier`, no transition running), and at least `ARM.armAfterCommitBeats` after the
 * last commit and `ARM.repickMinBeats` after the last arm. The caller picks the scene and reports `armPlaced` /
 * `armRefused`. A refused arm retries after `ARM.refusedRetryBeats`.
 *
 * ## Refresh
 * Every `ARM.fitCheckEveryBeats` beats (and on a build's rising edge) the caller scores the armed scene against the
 * best candidate in the CURRENT context. If it has fallen below `ARM.refitRatio` of the best, and it has been held
 * at least `ARM.repickMinBeats`, it is disarmed (`refit`) and the next frame arms a better one. The rate limit is
 * the point: each new arm can cost a shader compile.
 *
 * ## Confirm (release the hold)
 *  - `f.drop` rising edge: hard cut NOW (unchanged: a drop already bypasses the dwell). Any time.
 *  - Everything else needs the 32-beat dwell to have elapsed, the arm to be `ARM.minHoldBeats` old and no silence,
 *    and lands as a normal beat-locked crossfade:
 *      section  a latched section boundary (`songSection.boundaryChanged`);
 *      phrase   a strong fast change (`f.sectionChange`, strength >= `phraseStrong`) at once, or one at
 *               `phraseMinStrength` followed by a phrase edge within `phraseLatchBeats`;
 *      energy   a sustained energy step (fast average vs slow, `energyStep` for `energyStepBeats` beats);
 *      predicted the projected drop beat, one beat early, with the build still sustained;
 *      age      the scene on screen has run `maxAgeBeats` and a phrase edge arrives (the show never stagnates).
 *  - Mood changes and section-boundary requests come from the directors (`AutoPilot`, `PerformanceDirector`), which
 *    call `commitArmed` through `armedDirector.tryCommitArmed` when the armed scene still fits.
 *
 * ## Disarm
 * `off` (flag), `suppressed`, `tier` (> maxTier), `superseded` (someone replaced or committed the pending scene, or
 * the current scene became the armed one), `released` (a director released it: not an error, no store action),
 * `expired` (`expiryBeats`), `refit`, `reset` (the beat counter went backwards: a new source).
 */

export const ARM = {
  /** Arm at quality tiers 0..maxTier. Tier 4 (survival) never holds a second scene. The user's sessions read 3-4. */
  maxTier: 3,
  /** Hold at most this many beats (~48 s at 120 BPM), then give the slot back and re-arm fresh. */
  expiryBeats: 96,
  /** The dwell-gated confirms are not accepted until the arm is this old. (A real drop always is.) */
  minHoldBeats: 2,
  /** Release this many beats before the projected drop so the downbeat gate can land ON it. */
  predictLeadBeats: 1,
  /** After a `predicted` commit the ordinary drop pick is suppressed for this many beats. */
  dropSuppressBeats: 8,
  /** Do not arm within this many beats of the last commit (a crossfade / warm-up is still running). */
  armAfterCommitBeats: 6,
  /** At most one arm per this many beats. Each arm can cost a shader compile. */
  repickMinBeats: 16,
  /** After a refused arm (nothing pickable), retry after this many beats. */
  refusedRetryBeats: 8,
  /** How often the armed scene's fit is re-scored. */
  fitCheckEveryBeats: 4,
  /** Re-pick when the armed scene's fit falls below this share of the best candidate's. */
  refitRatio: 0.45,
  /** Commit the armed scene at the next phrase edge once the scene on screen has run this many beats. */
  maxAgeBeats: 48,
  /** A fast change at least this strong is remembered, and confirms at the next phrase edge... */
  phraseMinStrength: 0.6,
  /** ...within this many beats; */
  phraseLatchBeats: 6,
  /** and one at least this strong confirms at once. */
  phraseStrong: 0.9,
  /** Energy step: |fast - slow| beyond this, held this many beats. */
  energyStep: 0.22,
  energyStepBeats: 2,
} as const

export type ConfirmTrigger = 'drop' | 'predicted' | 'section' | 'phrase' | 'energy' | 'age'
/** Triggers an external director can commit with (armedDirector.tryCommitArmed). */
export type DirectorTrigger = 'mood' | 'boundary' | 'build' | 'stale'
export type DisarmReason = 'off' | 'suppressed' | 'tier' | 'superseded' | 'released' | 'expired' | 'refit' | 'reset'

/** What is currently armed. `gate` is always `hold` (held until confirmed). */
export interface ArmedRecord {
  sceneId: string
  /** The mode chosen for the armed scene (set in the store at arm time), or null. Debug only. */
  mode: string | null
  armedAtBeat: number
  expiresAtBeat: number
  /** Projected drop beat, -1 while unknown. Updated every beat from `beatsTillDrop`. */
  expectedBeat: number
  gate: 'hold'
  /** What made the arm happen: an idle arm, or one placed while a build was running. */
  trigger: 'idle' | 'build'
  /** Why this scene (trend / affinity / bpm / look / cost), for the debug overlay. */
  reason: string
}

export interface ArmedState {
  armed: ArmedRecord | null
  /** Beat of the last arm attempt (placed or refused), for the re-pick rate limit. */
  lastArmBeat: number
  /** The armed scene's fit is next re-scored at this beat. */
  nextFitCheckBeat: number
  /** Last scored fit (debug). */
  lastFitArmed: number
  lastFitBest: number
  /** Beat a strong-enough fast change was last seen, -Infinity = none. */
  phraseChangeBeat: number
  /** The normal drop pick is suppressed while `beat < this` (after a predicted commit). */
  suppressDropPickUntil: number
  /** Newest beat seen, to detect a beat change and a new source (beat counter restarting). */
  lastBeat: number
  /** Energy tracker: fast / slow averages and the run of beats beyond the step threshold. */
  eFast: number
  eSlow: number
  stepRun: number
  eSeeded: boolean
  /** Human-readable last outcome for the debug overlay, e.g. `drop@b140`, `refit@b120`, `refused@b99`. */
  lastOutcome: string
}

export function createArmedState(): ArmedState {
  return {
    armed: null,
    lastArmBeat: Number.NEGATIVE_INFINITY,
    nextFitCheckBeat: Number.NEGATIVE_INFINITY,
    lastFitArmed: 0,
    lastFitBest: 0,
    phraseChangeBeat: Number.NEGATIVE_INFINITY,
    suppressDropPickUntil: Number.NEGATIVE_INFINITY,
    lastBeat: Number.NEGATIVE_INFINITY,
    eFast: 0,
    eSlow: 0,
    stepRun: 0,
    eSeeded: false,
    lastOutcome: '-',
  }
}

/** Everything `stepArmed` needs from the live app, one frame's worth. */
export interface ArmedInput {
  /** `?arm` is not off. */
  enabled: boolean
  /** Automation is not allowed to act: autopilot off / not running / cue-governed / cutaway / manual hold. */
  suppressed: boolean
  /** `f.silence`. Blocks arming and every confirm except a real drop. */
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
  /** The store's `lastCommitBeat` (-Infinity before the first commit). */
  lastCommitBeat: number
  /** `f.structureValid && f.songSection.boundaryChanged`: a latched section boundary landed this frame. */
  sectionEdge: boolean
  /** `f.sectionChange ? f.sectionChangeStrength : 0`: the fast change this frame. */
  phraseStrength: number
  /** `isPhraseEdge(f.beat, f.beatInBar, f.bar)`: this frame is the first beat of a 4-bar phrase. */
  phraseEdge: boolean
  /** `f.energy`, 0..1. */
  energy: number
  /** A crossfade / transition is running: never arm into it (two heavy scenes at once). */
  transitionActive: boolean
  /** The armed scene's fit vs the best, or null when no check is due (see `fitCheckDue`). */
  fit: { armed: number; best: number } | null
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
  reason = '',
  trigger: 'idle' | 'build' = 'idle',
): void {
  st.armed = {
    sceneId,
    mode,
    armedAtBeat: beat,
    expiresAtBeat: beat + ARM.expiryBeats,
    expectedBeat: validBeatsTillDrop(beatsTillDrop) ? beat + beatsTillDrop : -1,
    gate: 'hold',
    trigger,
    reason,
  }
  st.lastArmBeat = beat
  st.nextFitCheckBeat = beat + ARM.fitCheckEveryBeats
  st.lastOutcome = `armed@b${beat}`
}

/** The caller could not place any scene (every pick refused, or no candidate). Retries after `refusedRetryBeats`. */
export function armRefused(st: ArmedState, beat: number): void {
  st.lastArmBeat = beat - ARM.repickMinBeats + ARM.refusedRetryBeats
  st.lastOutcome = `refused@b${beat}`
}

/**
 * A director released the armed scene (mood change, section boundary, build): forget it. The store's hold is
 * released by the caller; this only records the outcome so the next arm follows the normal rate limits.
 */
export function commitArmed(st: ArmedState, trigger: ConfirmTrigger | DirectorTrigger, beat: number): void {
  st.armed = null
  st.lastOutcome = `${trigger}@b${beat}`
}

/** Should the NORMAL drop pick be skipped at this beat (a predicted commit just answered this drop)? */
export function dropPickSuppressed(st: ArmedState, beat: number): boolean {
  return beat < st.suppressDropPickUntil && beat >= st.suppressDropPickUntil - ARM.dropSuppressBeats
}

/** Is the armed scene's fit due to be re-scored? `force` (a build's rising edge) checks now. */
export function fitCheckDue(st: ArmedState, beat: number, force = false): boolean {
  return st.armed !== null && (force || beat >= st.nextFitCheckBeat)
}

/** Fast / slow energy averages per beat, and the run of beats beyond the step threshold. */
function trackEnergy(st: ArmedState, energy: number): void {
  const e = Number.isFinite(energy) ? Math.min(1, Math.max(0, energy)) : 0
  if (!st.eSeeded) {
    st.eFast = e
    st.eSlow = e
    st.eSeeded = true
    st.stepRun = 0
    return
  }
  st.eFast += (e - st.eFast) * 0.39 // ~2-beat time constant per beat
  st.eSlow += (e - st.eSlow) * 0.06 // ~16-beat time constant per beat
  const d = st.eFast - st.eSlow
  st.stepRun = Math.abs(d) > ARM.energyStep ? st.stepRun + 1 : 0
}

function resetTracking(st: ArmedState): void {
  st.armed = null
  st.lastArmBeat = Number.NEGATIVE_INFINITY
  st.nextFitCheckBeat = Number.NEGATIVE_INFINITY
  st.phraseChangeBeat = Number.NEGATIVE_INFINITY
  st.suppressDropPickUntil = Number.NEGATIVE_INFINITY
  st.eSeeded = false
  st.stepRun = 0
}

/**
 * Advance one frame. Mutates `st`; returns the single thing the caller must do. Call it EVERY frame, before
 * AutoPilot's early returns (like `observeBuild`), so an edge that lands while automation is suppressed is
 * consumed rather than firing late.
 *
 * After a `confirm` the record is already cleared here (the caller releases the store's hold); after a `disarm`
 * likewise (the caller clears the store's hold and, when it is still ours, the pending scene; `released` needs no
 * store action). An `arm` is a request: the caller picks a scene and reports back through `armPlaced` / `armRefused`.
 */
export function stepArmed(st: ArmedState, i: ArmedInput): ArmedAction {
  // A new source restarts the beat counter: nothing from the old track may leak (a stale suppression window would
  // otherwise silence the normal drop pick for thousands of beats).
  if (i.beat < st.lastBeat) {
    const was = st.armed
    resetTracking(st)
    st.lastBeat = i.beat
    st.lastOutcome = `reset@b${i.beat}`
    if (was) return { type: 'disarm', reason: 'reset' }
  }
  const newBeat = i.beat !== st.lastBeat
  st.lastBeat = i.beat
  if (newBeat && !i.silent) trackEnergy(st, i.energy)
  if (i.phraseStrength >= ARM.phraseMinStrength) st.phraseChangeBeat = i.beat

  const a = st.armed
  if (a === null) {
    if (!i.enabled || i.suppressed || i.silent || i.tier > ARM.maxTier) return NONE
    if (i.transitionActive || i.buildEdge || i.dropEdge) return NONE
    if (i.pendingSceneId !== null) return NONE
    if (i.beat - i.lastCommitBeat < ARM.armAfterCommitBeats) return NONE
    if (i.beat - st.lastArmBeat < ARM.repickMinBeats) return NONE
    st.lastArmBeat = i.beat
    return { type: 'arm' }
  }

  // --- Armed: is it still valid? ---------------------------------------------------------------------------
  // A director released the hold itself (the scene is still pending, no longer held): not an error.
  if (i.pendingSceneId === a.sceneId && i.heldSceneId === null) {
    st.armed = null
    st.lastOutcome = `released@b${i.beat}`
    return { type: 'disarm', reason: 'released' }
  }
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
    st.lastOutcome = `drop@b${i.beat}`
    return { type: 'confirm', trigger: 'drop', immediate: true }
  }

  // --- The armed scene no longer suits the music: give the slot back so a better one is armed. -----------
  if (i.fit !== null) {
    st.nextFitCheckBeat = i.beat + ARM.fitCheckEveryBeats
    st.lastFitArmed = i.fit.armed
    st.lastFitBest = i.fit.best
    const stale = i.beat - a.armedAtBeat >= ARM.repickMinBeats
    if (stale && !i.transitionActive && (!(i.fit.armed > 0) || i.fit.armed < ARM.refitRatio * i.fit.best)) {
      return disarm(st, 'refit', i.beat)
    }
  }

  // --- Dwell-gated confirms: a normal beat-locked crossfade. ------------------------------------------------
  if (validBeatsTillDrop(i.beatsTillDrop)) a.expectedBeat = i.beat + i.beatsTillDrop
  const eligible = i.canDwell && !i.silent && i.beat - a.armedAtBeat >= ARM.minHoldBeats
  if (!eligible) return NONE

  let trigger: ConfirmTrigger | null = null
  if (i.sectionEdge) trigger = 'section'
  else if (i.phraseStrength >= ARM.phraseStrong) trigger = 'phrase'
  else if (i.phraseEdge && i.beat - st.phraseChangeBeat <= ARM.phraseLatchBeats) trigger = 'phrase'
  else if (st.stepRun >= ARM.energyStepBeats && newBeat) trigger = 'energy'
  else if (i.sustain && a.expectedBeat >= 0 && i.beat >= a.expectedBeat - ARM.predictLeadBeats) trigger = 'predicted'
  else if (i.phraseEdge && i.beat - i.lastCommitBeat >= ARM.maxAgeBeats) trigger = 'age'
  if (trigger === null) return NONE

  st.armed = null
  st.stepRun = 0
  st.phraseChangeBeat = Number.NEGATIVE_INFINITY
  if (trigger === 'predicted') st.suppressDropPickUntil = i.beat + ARM.dropSuppressBeats
  st.lastOutcome = `${trigger}@b${i.beat}`
  return { type: 'confirm', trigger, immediate: false }
}

/**
 * The armed state as the debug overlay reads it. Written by `AutoPilot` each frame (a reference and a string,
 * no allocation); `?lookdebug` prints it. Same singleton-probe pattern as `lookDebugProbe`.
 */
export const armedProbe: { armed: ArmedRecord | null; lastOutcome: string; fit: string } = {
  armed: null,
  lastOutcome: '-',
  fit: '',
}

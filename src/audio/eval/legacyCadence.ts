/**
 * LEGACY scene-change MODEL (phase 0C). NOT the running code, and not a reimplementation to be shipped.
 *
 * A pure, deterministic replay of the trigger arithmetic that decides WHEN the primary scene changes today, fed by a
 * `CadenceTrace` (the per-frame detector outputs `runTrack` recorded from real audio). Its only job is to quantify
 * the complaint ("it just keeps changing scenes and misses the actual changes") before any behaviour change: how
 * often does the primary scene change, which trigger causes each change, and how does each change relate to the
 * detector's own events.
 *
 * What it mirrors, in the order a frame runs (`useFrame` priorities: AudioEngine -100, AutoPilot -90,
 * PerformanceDirector -85, SceneManager after them):
 *
 *  1. `AutoPilot.tsx` (~400-915): the armed-scene step, then the trigger cascade: drop (bypasses the dwell) >
 *     imminent predicted transition > committed mood change (confidence >= 0.5 and ambiguity <= 0.6, latched until
 *     it clears) > character shift (12 s gap) > the 25 s stale timer; all held through a confirmed build
 *     (`isSustain`); the confirmed-build one-shot switch; the drop pre-arm (only with the armed scene off).
 *  2. `PerformanceDirector.tsx` (~215-434): boundary = `f.sectionChange || latched boundary || phrase fallback`;
 *     `lastBoundaryBeat` is consumed BEFORE the request (an edge refused by the dwell is lost, never retried);
 *     `sectionChange` / a latched boundary skip the 16-beat spacing, the blind phrase fallback does not.
 *  3. `store.ts` `requestScene`: the 32-beat `MIN_SUBJECT_DWELL_BEATS` since the last COMMIT for every automatic
 *     non-immediate request (a request replaces the single pending slot; a drop is `immediate` and skips it).
 *  4. `armedChange.ts` `stepArmed` (frozen copy below): the scene is armed idle 6 beats after a commit and released
 *     by `drop` / `section` / `phrase` / `energy` / `predicted` / `age` (a phrase edge once the scene on screen has
 *     run 48 beats), each gated by the dwell except a drop.
 *  5. `SceneManager.tsx` `resolveCommit`: a released or requested scene commits on `f.beat && f.beatInBar === 0`,
 *     immediately when the grid is untrusted (`confidence <= 0.25` or silent) or the request is `immediate`, else
 *     after the 2.5 s backstop.
 *
 * DELIBERATE SIMPLIFICATIONS (each one can move the numbers; see also the calibration report's caveats):
 *  - Scene identity is abstract: every pick "succeeds" and is a scene different from the current one. The
 *    registry, the character picker, `canHoldPrimary`, `recentSceneIds` and pool exhaustion are not modelled, so a
 *    request the dwell allows is always accepted.
 *  - The armed scene ALWAYS "fits" the music (`armedFitNow(...).ok` is true; no `refit` disarm, no fit re-scoring).
 *    Real refits give the slot back and re-arm >= 16 beats later, which the model never does, so armed commits are
 *    slightly over-represented. `quality.tier <= ARM.maxTier` (3) is assumed; pass `armed: false` for `?arm=off`.
 *  - Shader-warm waits are ignored (`incomingWarm` always true), and `transitionActive` (a crossfade running) is
 *    always false, so an arm is never delayed by a crossfade and a commit is never delayed by a compile.
 *  - Manual holds, cue governance, DJ-cam / Limitless cutaways (which clear `pendingSceneId` and pre-empt both
 *    directors) are absent: the model is a pure autopilot run. Each of those makes the real show change LESS often
 *    than modelled, never more.
 *  - The build one-shot assumes the scene look is active and the current scene is a poor build scene
 *    (`buildFit < 0.5`), i.e. it fires on every rising edge of a confirmed build when the dwell allows. Option
 *    `buildSwitch: false` removes it.
 *  - Palette, mode, layer and effect decisions do not change the primary scene and are not modelled. PerformanceDirector's
 *    breakdown pool restriction is ignored (it filters candidates, it does not block a change).
 *  - Continuous trace columns are quantised to ~0.4% (`cadenceTrace.ts`); the thresholds compared here are far
 *    coarser. `f.time` is `i / 60`, the audio-clock frame time `runTrack` uses.
 *  - Trigger constants are FROZEN copies (see `LEGACY`): this is the baseline the new director is measured against,
 *    so it must not drift when `armedChange.ts` / `AutoPilot.tsx` change. `legacyCadence.test.ts` pins the copied
 *    numbers to the source files while the legacy blocks still exist.
 *
 * Where the model can mislead: it inherits every error of the recorded detector outputs (a noisy `sectionChange`
 * makes noisy "events"), it assumes the beat counter is honest (tempo halving/doubling changes the bar length used
 * for intervals, though not the seconds), and the character/mood reads are replayed from the offline harness, whose
 * Essentia-only inputs are absent exactly as in the commercial build.
 */
import { Q10, Q8, STRENGTH_SCALE, type CadenceTrace } from './cadenceTrace'

/** Frozen copies of the legacy trigger constants (source and line noted; pinned by the test). */
export const LEGACY = {
  /** store.ts `MIN_SUBJECT_DWELL_BEATS` */
  dwellBeats: 32,
  /** AutoPilot.tsx `STALE_TARGET_SEC` */
  staleSec: 25,
  /** PerformanceDirector.tsx `PHRASE_HOLD_BEATS` */
  phraseHoldBeats: 16,
  /** autoPilotGates.ts */
  moodChangeMinConfidence: 0.5,
  moodChangeMaxAmbiguity: 0.6,
  moodPredictMinConfidence: 0.65,
  /** AutoPilot.tsx: an imminent predicted transition is < this many beats away */
  imminentBeats: 4,
  /** characterShift.ts `CHARACTER_SHIFT_MIN_GAP_SEC` */
  characterShiftMinGapSec: 12,
  /** buildSwitch.ts `BUILD_SWITCH.minBeatsTillDrop` */
  buildMinBeatsTillDrop: 12,
  /** AutoPilot.tsx: a pre-arm is abandoned this many beats after it was made */
  preArmAbandonBeats: 24,
  /** AutoPilot.tsx: drop pre-arm window (beats before the projected drop) */
  preArmMinBeats: 1,
  preArmMaxBeats: 3,
  /** SceneManager.tsx `resolveCommit`: the grid is trusted above this confidence */
  gridTrustConfidence: 0.25,
  /** SceneManager.tsx `resolveCommit`: backstop wait (s) */
  commitBackstopSec: 2.5,
  /** armedChange.ts `ARM` (copy) */
  ARM: {
    maxTier: 3,
    expiryBeats: 96,
    minHoldBeats: 2,
    predictLeadBeats: 1,
    dropSuppressBeats: 8,
    armAfterCommitBeats: 6,
    repickMinBeats: 16,
    refusedRetryBeats: 8,
    fitCheckEveryBeats: 4,
    refitRatio: 0.45,
    maxAgeBeats: 48,
    phraseMinStrength: 0.6,
    phraseLatchBeats: 6,
    phraseStrong: 0.9,
    energyStep: 0.22,
    energyStepBeats: 2,
  },
} as const

export type LegacyTrigger =
  | 'drop'
  | 'sectionChange'
  | 'latchedBoundary'
  | 'phraseFallback'
  | 'mood'
  | 'moodPredicted'
  | 'character'
  | 'stale'
  | 'buildSwitch'
  | 'dropPreArm'
  | 'armed:drop'
  | 'armed:section'
  | 'armed:phrase'
  | 'armed:energy'
  | 'armed:predicted'
  | 'armed:age'

/**
 * How the trigger relates to a detector edge:
 *  - `event`: fires on the frame of a fresh detector edge (a drop, a `sectionChange`, a latched boundary, a build's
 *    rising edge, a strong fast change, an imminent predicted transition, a mood change on the frame it committed,
 *    a sustained energy step).
 *  - `latched`: a condition carried past the frame it was seen: a mood change or character shift that fired later
 *    than its edge, a weaker fast change that waited for a phrase edge.
 *  - `level`: fires from elapsed time / age, not from any change: the 25 s stale timer, the armed scene's 48-beat age
 *    trigger, PerformanceDirector's blind 16-beat phrase fallback.
 */
export type TriggerKind = 'event' | 'latched' | 'level'

export interface LegacyOptions {
  /** The armed next scene is on (`?arm` not off and `quality.tier <= 3`). Default true. */
  armed?: boolean
  /** Subject dwell in beats. Default 32. */
  dwellBeats?: number
  /** The confirmed-build one-shot scene switch exists. Default true. */
  buildSwitch?: boolean
  /** Character shifts can trigger (needs a trace stepped with `character`). Default true. */
  characterShift?: boolean
  /** `trace`: grid trusted when `confidence > 0.25 && !silence` (as SceneManager). `always`: the downbeat wait always
   *  applies. `never`: every commit is immediate. Default `trace`. */
  gridTrust?: 'trace' | 'always' | 'never'
  /** Stale-timer period in seconds. Default 25. */
  staleSec?: number
  /** `f.drop` edges trigger (and bypass the dwell). Default true. False is a SENSITIVITY run that removes the
   *  drop path entirely, to show the dwell / first-opportunity cadence of everything else in isolation. */
  drops?: boolean
}

export interface LegacyRequest {
  frame: number
  beat: number
  timeSec: number
  trigger: LegacyTrigger
  kind: TriggerKind
  /** `armed`: released the armed scene; `cold`: a fresh pick through `requestScene`. */
  via: 'armed' | 'cold'
  immediate: boolean
  /** `refusedDwell`: `requestScene` declined it because the subject had not dwelt 32 beats since the last commit. */
  outcome: 'accepted' | 'refusedDwell'
}

export interface LegacyCommit {
  frame: number
  beat: number
  timeSec: number
  trigger: LegacyTrigger
  kind: TriggerKind
  via: 'armed' | 'cold'
  immediate: boolean
  requestFrame: number
  requestBeat: number
  /** Seconds between the request/release and the commit (the downbeat wait). */
  waitSec: number
}

export type EdgeOutcome =
  /** Led to a request or an armed release by this edge's own path. */
  | 'requested'
  /** An armed release (`stepArmed` confirm) happened on this very frame. */
  | 'armedConfirm'
  /** Another trigger (mood, drop, build...) already requested a scene earlier this frame. */
  | 'otherTrigger'
  /** Refused by the 32-beat dwell: the edge was consumed and discarded. */
  | 'dwell'
  /** A non-held request was already in flight (single pending slot). */
  | 'pending'
  /** Another boundary on the same beat had already been consumed. */
  | 'sameBeat'
  /** Held through a confirmed build (`isSustain`). */
  | 'buildHold'
  | 'silence'

export interface EdgeRecord {
  kind: 'sectionChange' | 'boundary'
  frame: number
  beat: number
  timeSec: number
  /** `sectionChangeStrength` for a `sectionChange` edge (0 for a boundary). */
  strength: number
  /** The 32-beat dwell had not elapsed when the edge landed. */
  inDwell: boolean
  outcome: EdgeOutcome
}

export interface LegacyResult {
  requests: LegacyRequest[]
  commits: LegacyCommit[]
  edges: EdgeRecord[]
  /** Armed scenes placed. */
  arms: number
  options: Required<LegacyOptions>
}

// --- Frozen copy of armedChange.ts `stepArmed` (fit = null: the armed scene always fits) --------------------

interface ArmedRec {
  sceneId: string
  armedAtBeat: number
  expiresAtBeat: number
  expectedBeat: number
}

interface ArmedState {
  armed: ArmedRec | null
  lastArmBeat: number
  phraseChangeBeat: number
  suppressDropPickUntil: number
  lastBeat: number
  eFast: number
  eSlow: number
  stepRun: number
  eSeeded: boolean
}

interface ArmedInput {
  enabled: boolean
  silent: boolean
  beat: number
  buildEdge: boolean
  dropEdge: boolean
  sustain: boolean
  beatsTillDrop: number
  pendingSceneId: string | null
  heldSceneId: string | null
  sceneId: string
  canDwell: boolean
  lastCommitBeat: number
  sectionEdge: boolean
  phraseStrength: number
  phraseEdge: boolean
  energy: number
}

type ArmedAction =
  | { type: 'none' }
  | { type: 'arm' }
  | { type: 'confirm'; trigger: 'drop' | 'predicted' | 'section' | 'phrase' | 'energy' | 'age'; immediate: boolean; kind: TriggerKind }
  | { type: 'disarm'; reason: string }

const NONE: ArmedAction = { type: 'none' }
const A = LEGACY.ARM

function createArmedState(): ArmedState {
  return {
    armed: null,
    lastArmBeat: Number.NEGATIVE_INFINITY,
    phraseChangeBeat: Number.NEGATIVE_INFINITY,
    suppressDropPickUntil: Number.NEGATIVE_INFINITY,
    lastBeat: Number.NEGATIVE_INFINITY,
    eFast: 0,
    eSlow: 0,
    stepRun: 0,
    eSeeded: false,
  }
}

const validBeatsTillDrop = (b: number): boolean => Number.isFinite(b) && b > 0

function trackEnergy(st: ArmedState, energy: number): void {
  const e = Number.isFinite(energy) ? Math.min(1, Math.max(0, energy)) : 0
  if (!st.eSeeded) {
    st.eFast = e
    st.eSlow = e
    st.eSeeded = true
    st.stepRun = 0
    return
  }
  st.eFast += (e - st.eFast) * 0.39
  st.eSlow += (e - st.eSlow) * 0.06
  const d = st.eFast - st.eSlow
  st.stepRun = Math.abs(d) > A.energyStep ? st.stepRun + 1 : 0
}

function stepArmed(st: ArmedState, i: ArmedInput): ArmedAction {
  const newBeat = i.beat !== st.lastBeat
  st.lastBeat = i.beat
  if (newBeat && !i.silent) trackEnergy(st, i.energy)
  if (i.phraseStrength >= A.phraseMinStrength) st.phraseChangeBeat = i.beat

  const a = st.armed
  if (a === null) {
    if (!i.enabled || i.silent) return NONE
    if (i.buildEdge || i.dropEdge) return NONE
    if (i.pendingSceneId !== null) return NONE
    if (i.beat - i.lastCommitBeat < A.armAfterCommitBeats) return NONE
    if (i.beat - st.lastArmBeat < A.repickMinBeats) return NONE
    st.lastArmBeat = i.beat
    return { type: 'arm' }
  }

  if (i.pendingSceneId === a.sceneId && i.heldSceneId === null) {
    st.armed = null
    return { type: 'disarm', reason: 'released' }
  }
  let reason: string | null = null
  if (!i.enabled) reason = 'off'
  else if (i.pendingSceneId !== a.sceneId || i.heldSceneId !== a.sceneId || i.sceneId === a.sceneId) reason = 'superseded'
  else if (i.beat >= a.expiresAtBeat) reason = 'expired'
  if (reason !== null) {
    st.armed = null
    return { type: 'disarm', reason }
  }

  if (i.dropEdge) {
    st.armed = null
    return { type: 'confirm', trigger: 'drop', immediate: true, kind: 'event' }
  }

  if (validBeatsTillDrop(i.beatsTillDrop)) a.expectedBeat = i.beat + i.beatsTillDrop
  const eligible = i.canDwell && !i.silent && i.beat - a.armedAtBeat >= A.minHoldBeats
  if (!eligible) return NONE

  let trigger: 'predicted' | 'section' | 'phrase' | 'energy' | 'age' | null = null
  let kind: TriggerKind = 'event'
  if (i.sectionEdge) trigger = 'section'
  else if (i.phraseStrength >= A.phraseStrong) trigger = 'phrase'
  else if (i.phraseEdge && i.beat - st.phraseChangeBeat <= A.phraseLatchBeats) {
    trigger = 'phrase'
    kind = 'latched'
  } else if (st.stepRun >= A.energyStepBeats && newBeat) trigger = 'energy'
  else if (i.sustain && a.expectedBeat >= 0 && i.beat >= a.expectedBeat - A.predictLeadBeats) trigger = 'predicted'
  else if (i.phraseEdge && i.beat - i.lastCommitBeat >= A.maxAgeBeats) {
    trigger = 'age'
    kind = 'level'
  }
  if (trigger === null) return NONE

  st.armed = null
  st.stepRun = 0
  st.phraseChangeBeat = Number.NEGATIVE_INFINITY
  if (trigger === 'predicted') st.suppressDropPickUntil = i.beat + A.dropSuppressBeats
  return { type: 'confirm', trigger, immediate: false, kind }
}

const dropPickSuppressed = (st: ArmedState, beat: number): boolean =>
  beat < st.suppressDropPickUntil && beat >= st.suppressDropPickUntil - A.dropSuppressBeats

/** PerformanceDirector / armedChange: first beat of every 4th bar. (`isPhraseEdge` in `structure/downbeat.ts`.) */
const isPhraseEdge = (beat: boolean, beatInBar: number, bar: number): boolean =>
  beat && Math.floor(beatInBar) === 0 && bar > 0 && bar % 4 === 0

// --- The model ------------------------------------------------------------------------------------------------

interface Pending {
  id: string
  held: boolean
  immediate: boolean
  requestFrame: number
  requestBeat: number
  sinceSec: number
  trigger: LegacyTrigger
  kind: TriggerKind
  via: 'armed' | 'cold'
}

export function resolveOptions(o: LegacyOptions = {}): Required<LegacyOptions> {
  return {
    armed: o.armed ?? true,
    dwellBeats: o.dwellBeats ?? LEGACY.dwellBeats,
    buildSwitch: o.buildSwitch ?? true,
    characterShift: o.characterShift ?? true,
    gridTrust: o.gridTrust ?? 'trace',
    staleSec: o.staleSec ?? LEGACY.staleSec,
    drops: o.drops ?? true,
  }
}

/**
 * Replay the legacy scene-change decisions over `trace`. Pure and deterministic: the same trace and options always
 * give the same result.
 */
export function simulateLegacy(trace: CadenceTrace, options: LegacyOptions = {}): LegacyResult {
  const o = resolveOptions(options)
  const c = trace.cols
  const n = trace.n
  const dt = 1 / trace.frameRate

  const requests: LegacyRequest[] = []
  const commits: LegacyCommit[] = []
  const edges: EdgeRecord[] = []
  let arms = 0

  // Store state.
  let sceneId = 'scene#0'
  let seq = 0
  let lastCommitBeat = Number.NEGATIVE_INFINITY
  let pending: Pending | null = null
  const armed = createArmedState()

  // AutoPilot refs.
  let handledChange = -1
  let pendingChange = -1
  let prefetched = -1
  let prevDrop = false
  let lastAutoTriggerAt = Number.NEGATIVE_INFINITY
  let preArmed = false
  let preArmBeat = Number.NEGATIVE_INFINITY
  let charLast = -1
  let charPending = false
  let buildPrevSustain = false
  let buildFired = false
  // PerformanceDirector refs.
  let lastBoundaryBeat = -1
  let lastSwitchBeat = Number.NEGATIVE_INFINITY

  const canAuto = (beat: number): boolean => {
    const el = beat - lastCommitBeat
    return el < 0 || el >= o.dwellBeats
  }

  for (let i = 0; i < n; i++) {
    const now = i * dt
    const beat = c.beatIndex[i]
    const isBeat = c.beat[i] === 1
    const beatInBar = c.beatInBar[i]
    const bar = c.bar[i]
    const silence = c.silence[i] === 1
    const valid = c.structureValid[i] === 1
    const sustain = valid && c.isSustain[i] === 1
    const boundaryChanged = c.boundaryChanged[i] === 1
    const sectionChange = c.sectionChange[i] === 1
    const strength = c.sectionChangeStrength[i] / STRENGTH_SCALE
    const btd = c.beatsTillDrop10[i] / Q10
    const dwellOk = canAuto(beat)

    // Edge bookkeeping for this frame (the outcome is filled in below).
    let acted = false // some request was accepted / an armed scene released this frame
    let armedConfirmThisFrame = false
    let edgeOutcome: EdgeOutcome | null = null

    const record = (
      trigger: LegacyTrigger,
      kind: TriggerKind,
      via: 'armed' | 'cold',
      immediate: boolean,
      outcome: LegacyRequest['outcome'],
    ): void => {
      requests.push({ frame: i, beat, timeSec: now, trigger, kind, via, immediate, outcome })
    }

    /** `requestScene(pick, { auto: true, immediate })`: refused by the dwell unless immediate; replaces the pending slot. */
    const coldRequest = (trigger: LegacyTrigger, kind: TriggerKind, immediate: boolean): boolean => {
      const ok = immediate || canAuto(beat)
      record(trigger, kind, 'cold', immediate, ok ? 'accepted' : 'refusedDwell')
      if (ok) {
        pending = {
          id: `cold#${++seq}`,
          held: false,
          immediate,
          requestFrame: i,
          requestBeat: beat,
          sinceSec: now,
          trigger,
          kind,
          via: 'cold',
        }
        acted = true
      }
      return ok
    }

    /** `armedDirector.tryCommitArmed`: release the armed scene instead of a cold pick (the fit is assumed ok). */
    const tryCommitArmed = (trigger: LegacyTrigger, kind: TriggerKind): boolean => {
      const a = armed.armed
      if (!o.armed || a === null) return false
      const p: Pending | null = pending
      if (p === null || !p.held || p.id !== a.sceneId) return false
      if (!canAuto(beat)) return false
      p.held = false
      p.immediate = false
      p.requestFrame = i
      p.requestBeat = beat
      p.sinceSec = now
      p.trigger = trigger
      p.kind = kind
      p.via = 'armed'
      armed.armed = null
      record(trigger, kind, 'armed', false, 'accepted')
      acted = true
      return true
    }

    // ================================ AutoPilot ================================
    autopilot: {
      const dropNow = o.drops && c.drop[i] === 1
      const dropEdge = dropNow && !prevDrop
      prevDrop = dropNow
      const buildEdge = sustain && !buildPrevSustain
      if (!sustain) buildFired = false
      buildPrevSustain = sustain

      // CharacterShiftTrigger.observe (before the early returns).
      if (o.characterShift) {
        const cp = c.charPrimary[i]
        if (cp < 0) {
          charLast = -1
          charPending = false
        } else {
          if (charLast >= 0 && cp !== charLast) charPending = true
          charLast = cp
        }
      }

      // --- Armed next scene (before the early returns) ---
      let armedConfirmedDrop = false
      {
        const heldId = pending !== null && pending.held ? pending.id : null
        const action = stepArmed(armed, {
          enabled: o.armed,
          silent: silence,
          beat,
          buildEdge,
          dropEdge,
          sustain,
          beatsTillDrop: btd,
          pendingSceneId: pending !== null ? pending.id : null,
          heldSceneId: heldId,
          sceneId,
          canDwell: dwellOk,
          lastCommitBeat,
          sectionEdge: valid && boundaryChanged,
          phraseStrength: sectionChange ? strength : 0,
          phraseEdge: isPhraseEdge(isBeat, beatInBar, bar),
          energy: c.energy[i] / Q8,
        })
        if (action.type === 'disarm') {
          // `disarmScene`: drops a hold on the pending scene (and the scene with it).
          if (action.reason !== 'released' && pending !== null && pending.held) pending = null
        } else if (action.type === 'confirm') {
          const p: Pending | null = pending
          if (p !== null && p.held) {
            p.held = false
            p.immediate = action.immediate
            p.requestFrame = i
            p.requestBeat = beat
            p.sinceSec = now
            const trig = `armed:${action.trigger}` as LegacyTrigger
            p.trigger = trig
            p.kind = action.kind
            p.via = 'armed'
            record(trig, action.kind, 'armed', action.immediate, 'accepted')
            acted = true
            armedConfirmThisFrame = true
            armedConfirmedDrop = action.trigger === 'drop'
          }
        } else if (action.type === 'arm') {
          // `armScene`: mount + hold a scene in the (empty) pending slot.
          pending = {
            id: `arm#${++seq}`,
            held: true,
            immediate: false,
            requestFrame: i,
            requestBeat: beat,
            sinceSec: now,
            trigger: 'armed:age',
            kind: 'level',
            via: 'armed',
          }
          armed.armed = {
            sceneId: pending.id,
            armedAtBeat: beat,
            expiresAtBeat: beat + A.expiryBeats,
            expectedBeat: validBeatsTillDrop(btd) ? beat + btd : -1,
          }
          armed.lastArmBeat = beat
          arms++
        }
      }

      if (silence) break autopilot
      if (lastAutoTriggerAt === Number.NEGATIVE_INFINITY) lastAutoTriggerAt = now

      if (preArmed && beat - preArmBeat > LEGACY.preArmAbandonBeats) preArmed = false
      const preArmedThisDrop = dropEdge && (preArmed || armedConfirmedDrop || dropPickSuppressed(armed, beat))
      if (dropEdge) preArmed = false

      let target: { trigger: LegacyTrigger; kind: TriggerKind } | null = null
      const moodState = c.moodState[i]
      const predicted = c.predictedState[i]
      const moodConf = c.moodConfidence[i] / Q8
      const moodAmb = c.moodAmbiguity[i] / Q8
      const btt = c.beatsTillTransition10[i] / Q10
      if (dropEdge && !preArmedThisDrop) {
        target = { trigger: 'drop', kind: 'event' }
        prefetched = -1
      } else if (dropEdge) {
        prefetched = -1
      } else {
        if (c.moodChanged[i] === 1) pendingChange = c.moodChangeCount[i]
        const imminent =
          predicted !== moodState &&
          btt >= 0 &&
          btt < LEGACY.imminentBeats &&
          moodConf > LEGACY.moodPredictMinConfidence
        if (sustain) {
          // hold: no discretionary target while the riser runs
        } else if (imminent && prefetched !== predicted) {
          target = { trigger: 'moodPredicted', kind: 'event' }
          prefetched = predicted
        } else if (
          pendingChange !== handledChange &&
          moodConf >= LEGACY.moodChangeMinConfidence &&
          moodAmb <= LEGACY.moodChangeMaxAmbiguity
        ) {
          handledChange = pendingChange
          target = { trigger: 'mood', kind: c.moodChanged[i] === 1 ? 'event' : 'latched' }
          prefetched = -1
        } else if (
          o.characterShift &&
          charPending &&
          now - lastAutoTriggerAt >= LEGACY.characterShiftMinGapSec
        ) {
          charPending = false
          target = { trigger: 'character', kind: 'latched' }
          prefetched = -1
        } else if (now - lastAutoTriggerAt >= o.staleSec) {
          target = { trigger: 'stale', kind: 'level' }
          prefetched = -1
        }
      }
      if (target !== null) {
        lastAutoTriggerAt = now
        charPending = false
      }

      // --- Confirmed-build one-shot scene switch ---
      if (
        o.buildSwitch &&
        buildEdge &&
        !dropEdge &&
        !buildFired &&
        dwellOk &&
        !(pending !== null && !pending.held) &&
        (!(btd > 0) || btd >= LEGACY.buildMinBeatsTillDrop)
      ) {
        buildFired = true
        if (tryCommitArmed('buildSwitch', 'event') || coldRequest('buildSwitch', 'event', false)) {
          lastAutoTriggerAt = now
          charPending = false
          break autopilot
        }
      }

      // --- Drop pre-arm (only with the armed scene off) ---
      if (
        !o.armed &&
        sustain &&
        !preArmed &&
        pending === null &&
        btd >= LEGACY.preArmMinBeats &&
        btd <= LEGACY.preArmMaxBeats
      ) {
        if (coldRequest('dropPreArm', 'event', false)) {
          preArmed = true
          preArmBeat = beat
        }
        break autopilot
      }

      if (target === null) break autopilot
      // Never replace a switch already in flight, unless it is a drop.
      if (pending !== null && !pending.held && !dropEdge) break autopilot
      // Prefer the armed scene.
      if (!dropEdge && tryCommitArmed(target.trigger, target.kind)) break autopilot
      coldRequest(target.trigger, target.kind, dropEdge)
    }

    // ================================ PerformanceDirector ================================
    director: {
      const boundaryEdge = sectionChange || (valid && boundaryChanged)
      if (silence) {
        if (boundaryEdge) edgeOutcome = 'silence'
        break director
      }
      if (valid && c.isSustain[i] === 1 && !boundaryChanged) {
        if (boundaryEdge) edgeOutcome = 'buildHold'
        break director
      }
      const latched = valid && boundaryChanged
      const phraseFallback = !valid && isPhraseEdge(isBeat, beatInBar, bar)
      const boundary = sectionChange || latched || phraseFallback
      if (!boundary) break director
      if (beat === lastBoundaryBeat) {
        if (boundaryEdge) edgeOutcome = 'sameBeat'
        break director
      }
      lastBoundaryBeat = beat
      if (!sectionChange && !latched && beat - lastSwitchBeat < LEGACY.phraseHoldBeats) break director

      const trigger: LegacyTrigger = sectionChange ? 'sectionChange' : latched ? 'latchedBoundary' : 'phraseFallback'
      const kind: TriggerKind = phraseFallback && !sectionChange && !latched ? 'level' : 'event'
      const heldPending = pending !== null && pending.held
      const armedTaken = heldPending && tryCommitArmed(trigger, kind)
      let outcome: EdgeOutcome
      if (armedTaken) {
        outcome = 'requested'
      } else if (pending === null || heldPending) {
        outcome = coldRequest(trigger, kind, false) ? 'requested' : 'dwell'
      } else {
        outcome = armedConfirmThisFrame ? 'armedConfirm' : acted ? 'otherTrigger' : 'pending'
      }
      if (boundaryEdge) edgeOutcome = outcome
      lastSwitchBeat = beat
    }

    // ================================ SceneManager ================================
    if (pending !== null && !pending.held) {
      const p: Pending = pending
      const waited = now - p.sinceSec
      const trusted =
        o.gridTrust === 'always'
          ? true
          : o.gridTrust === 'never'
            ? false
            : c.confidence[i] / Q8 > LEGACY.gridTrustConfidence && !silence
      const onDownbeat = isBeat && beatInBar === 0
      if (!trusted || onDownbeat || p.immediate || waited > LEGACY.commitBackstopSec) {
        commits.push({
          frame: i,
          beat,
          timeSec: now,
          trigger: p.trigger,
          kind: p.kind,
          via: p.via,
          immediate: p.immediate,
          requestFrame: p.requestFrame,
          requestBeat: p.requestBeat,
          waitSec: waited,
        })
        sceneId = p.id
        lastCommitBeat = beat
        pending = null
      }
    }

    // Edge records (after the frame so the dwell status is the one the edge arrived under).
    if (sectionChange) {
      edges.push({
        kind: 'sectionChange',
        frame: i,
        beat,
        timeSec: now,
        strength,
        inDwell: !dwellOk,
        outcome: edgeOutcome ?? (armedConfirmThisFrame ? 'armedConfirm' : 'sameBeat'),
      })
    }
    if (valid && boundaryChanged) {
      edges.push({
        kind: 'boundary',
        frame: i,
        beat,
        timeSec: now,
        strength: 0,
        inDwell: !dwellOk,
        outcome: edgeOutcome ?? (armedConfirmThisFrame ? 'armedConfirm' : 'sameBeat'),
      })
    }
  }

  return { requests, commits, edges, arms, options: o }
}

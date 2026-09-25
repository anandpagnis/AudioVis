import type { EventType, SectionEvent } from '../../audio/events/types'
import {
  SHOW,
  barsBetween,
  barsToCeiling,
  ceilingReached,
  effectiveThreshold,
  eventScore,
  minCutBars,
} from './showPolicy'

/**
 * The show director: ONE pure decision, `step(state, input) -> action`, that owns WHEN the visuals change.
 *
 * No React, store, three or audio-engine imports: `showAdapter.tsx` gathers the live inputs and performs the action
 * through the existing machinery; the tests drive this module directly with synthetic event streams. See
 * `showPolicy.ts` for the constants and the reasoning (score S, age threshold T(a), pressure, refractory, ceiling).
 *
 * Three outcomes, not two: `HOLD` (staying put is a decision, logged with its reason and numbers), `MICRO` (a
 * proportionate tweak: palette, mode, layer or effect) and `CUT` (a new scene, committed on the next bar line; a drop
 * is an immediate hard cut).
 *
 * Through a confirmed build (`input.inBuild`) every discretionary change is held (`build-hold`) and the ceiling waits,
 * exactly as the old directors held the look until the drop; a drop is the one thing that still cuts.
 *
 * Allocation-light: `step` reads one reused input object and returns ONE reused action object (`state.out`), valid
 * until the next `step` on the same state; copy what you need. All per-source memory is in fixed typed arrays.
 */

export type ShowActionKind = 'HOLD' | 'MICRO' | 'CUT'
/** What a MICRO varies. The adapter falls back (mode -> layer) when the scene has nothing to vary. */
export type MicroKind = 'mode' | 'layer' | 'palette' | 'effect'

export interface ShowAction {
  kind: ShowActionKind
  /** Short constant-string reason, e.g. `weak`, `min-age`, `below-T`, `refractory`, `event`, `drop-fast`, `forced-best`. */
  reason: string
  /** The score of the event acted on (0 for an idle frame). */
  S: number
  /** T_eff: the effective threshold used (age threshold minus pressure). */
  T: number
  /** Scene age in tempo-robust bars. */
  age: number
  /** Pressure 0..1. */
  pressure: number
  /** `SectionEvent.id` acted on, -1 when the decision was not about an event. */
  eventId: number
  eventType: EventType | ''
  /** MICRO only: what to vary; null otherwise. */
  micro: MicroKind | null
  /** CUT only: a drop's hard cut, landing now rather than on the next bar line. */
  immediate: boolean
  /** CUT only: the forced-change ceiling made this cut, not an event's own score. */
  forced: boolean
  /** CUT only: the armed scene still fits (a hint; the adapter re-verifies with the real fit check). */
  useArmed: boolean
  /** True when an event (or the ceiling) was actually decided, false for an idle frame (not counted in the stats). */
  evaluated: boolean
}

/** One frame's worth of live input. The adapter reuses ONE of these and mutates its fields. */
export interface ShowInput {
  /** `f.beatIndex` and `f.time`. A clock going backwards is a new source: the state resets. */
  beat: number
  time: number
  /** `f.bpm`, only to express the forced-ceiling ETA in bars for the overlay (non-finite reads as 120). */
  bpm: number
  /** The beat and audio time the scene now on screen was committed (the store's `lastCommitBeat`). */
  sceneStartBeat: number
  sceneStartTime: number
  /** At most one event per call; null on a frame with none (the ceiling and the pressure still advance). */
  event: SectionEvent | null
  /**
   * A cut requested on THIS frame lands on the coming bar line: where a forced cut with no candidate event goes. The
   * adapter passes the last beat of a bar (`f.beat && f.beatInBar === 3`), not the downbeat frame itself: SceneManager
   * checks for a pending scene before the directors run, so a request made ON the downbeat frame would wait a whole
   * further bar for the next one.
   */
  barLine: boolean
  inBreakdown: boolean
  /** A confirmed build is running (`songSection.isSustain`). */
  inBuild: boolean
  /** One-frame pressure edges: a committed mood change, a character shift, a predicted transition going imminent. */
  moodChanged: boolean
  characterShift: boolean
  moodPredicted: boolean
  /** A rising trend (build, mood heading to peak, drop projected soon): level, refreshed while true. */
  trendRising: boolean
}

export interface ShowStats {
  hold: number
  micro: number
  cut: number
  /** Of the cuts, how many were forced by the ceiling. */
  forced: number
}

const RING = 8
const BUMPS = 4
const BUMP_MOOD = 0
const BUMP_CHARACTER = 1
const BUMP_TREND = 2
const BUMP_PREDICTED = 3
const NEVER = Number.NEGATIVE_INFINITY

export interface ShowState {
  lastBeat: number
  lastTime: number
  /** Fallback scene start (the first step after a reset) while the input's own is unknown. */
  baseBeat: number
  baseTime: number
  lastCutBeat: number
  lastCutTime: number
  lastMicroBeat: number
  lastMicroTime: number
  /** Decaying pressure bumps: value and stamp per source (mood, character, trend, predicted). */
  bumpV: Float64Array
  bumpBeat: Float64Array
  bumpTime: Float64Array
  /** Ring of the last events' scores (0 = empty slot): the best S of the last 4 bars for the forced cut. */
  ringS: Float64Array
  ringBeat: Float64Array
  ringTime: Float64Array
  ringPos: number
  /** The last build seen (a `buildStart` event, or a build running) and the last change/breakdown event. */
  lastBuildBeat: number
  lastBuildTime: number
  lastChangeBeat: number
  /** Rotation for MICRO picks when an event has no per-channel feats. */
  microRot: number
  /** The armed scene still fits the music (the adapter keeps this current); copied into `CUT.useArmed`. */
  armedFitOk: boolean
  stats: ShowStats
  /** The last frame's numbers, for the overlay (valid even on an idle frame). */
  age: number
  pressure: number
  threshold: number
  etaBars: number
  out: ShowAction
}

function makeAction(): ShowAction {
  return {
    kind: 'HOLD',
    reason: 'idle',
    S: 0,
    T: 0,
    age: 0,
    pressure: 0,
    eventId: -1,
    eventType: '',
    micro: null,
    immediate: false,
    forced: false,
    useArmed: false,
    evaluated: false,
  }
}

export function createShowState(): ShowState {
  const st: ShowState = {
    lastBeat: NEVER,
    lastTime: NEVER,
    baseBeat: NaN,
    baseTime: NaN,
    lastCutBeat: NEVER,
    lastCutTime: NEVER,
    lastMicroBeat: NEVER,
    lastMicroTime: NEVER,
    bumpV: new Float64Array(BUMPS),
    bumpBeat: new Float64Array(BUMPS),
    bumpTime: new Float64Array(BUMPS),
    ringS: new Float64Array(RING),
    ringBeat: new Float64Array(RING),
    ringTime: new Float64Array(RING),
    ringPos: 0,
    lastBuildBeat: NEVER,
    lastBuildTime: NEVER,
    lastChangeBeat: NEVER,
    microRot: 0,
    armedFitOk: false,
    stats: { hold: 0, micro: 0, cut: 0, forced: 0 },
    age: 0,
    pressure: 0,
    threshold: 0,
    etaBars: 0,
    out: makeAction(),
  }
  return st
}

/** Forget everything (a new source restarted the clocks). Keeps the stats and the rotation. */
export function resetShow(st: ShowState): void {
  st.lastBeat = NEVER
  st.lastTime = NEVER
  st.baseBeat = NaN
  st.baseTime = NaN
  st.lastCutBeat = NEVER
  st.lastCutTime = NEVER
  st.lastMicroBeat = NEVER
  st.lastMicroTime = NEVER
  st.bumpV.fill(0)
  st.ringS.fill(0)
  st.ringPos = 0
  st.lastBuildBeat = NEVER
  st.lastBuildTime = NEVER
  st.lastChangeBeat = NEVER
  st.armedFitOk = false
}

/**
 * The adapter's report on a CUT it was asked to perform. A refused request (the scene was the current one, the
 * store refused the id, something else was mid-commit) must not leave the refractory running as if the show had
 * changed: it is shortened so the director retries in about two beats, on the next event or the ceiling.
 */
export function ackCut(st: ShowState, accepted: boolean, beat: number, time: number): void {
  if (accepted) return
  const retry = SHOW.refractoryBars * SHOW.beatsPerBar - 2
  st.lastCutBeat = beat - retry
  st.lastCutTime = time - retry * (SHOW.barSecMin / SHOW.beatsPerBar)
}

function bump(st: ShowState, k: number, v: number, beat: number, time: number): void {
  st.bumpV[k] = v
  st.bumpBeat[k] = beat
  st.bumpTime[k] = time
}

/** P = the max of the sources' bumps, each decaying linearly to 0 over `pressureDecayBars` bars. */
export function pressureAt(st: ShowState, beat: number, time: number): number {
  let p = 0
  for (let k = 0; k < BUMPS; k++) {
    const v = st.bumpV[k]
    if (v <= 0) continue
    const f = 1 - barsBetween(st.bumpBeat[k], st.bumpTime[k], beat, time) / SHOW.pressureDecayBars
    if (f > 0 && v * f > p) p = v * f
  }
  return p > 1 ? 1 : p
}

/** The best score among events seen in the last `bestWindowBars` bars (0 when none). */
function bestRecent(st: ShowState, beat: number, time: number): number {
  let best = 0
  for (let k = 0; k < RING; k++) {
    const s = st.ringS[k]
    if (s <= best) continue
    if (barsBetween(st.ringBeat[k], st.ringTime[k], beat, time) <= SHOW.bestWindowBars) best = s
  }
  return best
}

function hasFeats(f: SectionEvent['feats'] | undefined): boolean {
  if (!f) return false
  return (
    (Math.abs(f.level) || 0) + (Math.abs(f.low) || 0) + (Math.abs(f.timbre) || 0) + (Math.abs(f.harmony) || 0) + (Math.abs(f.rhythm) || 0) > 0
  )
}

const ROTATION: readonly MicroKind[] = ['palette', 'layer', 'mode', 'effect']

/**
 * WHAT a MICRO varies, from the event. A change in timbre varies the mode or the layers (alternating), a harmonic
 * change the palette, a rhythmic one an effect; level / low-end changes recompose the layers / punctuate with an
 * effect. An event with no per-channel feats (the legacy source) rotates through palette, layer, mode, effect.
 */
export function pickMicro(st: ShowState, ev: SectionEvent): MicroKind {
  if (ev.type === 'fill') return 'effect'
  const f = ev.feats
  if (hasFeats(f)) {
    const t = Math.abs(f.timbre) || 0
    const h = Math.abs(f.harmony) || 0
    const r = Math.abs(f.rhythm) || 0
    const lv = Math.abs(f.level) || 0
    const lo = Math.abs(f.low) || 0
    const top = Math.max(t, h, r, lv, lo)
    if (top === t) return st.microRot++ % 2 === 0 ? 'mode' : 'layer'
    if (top === h) return 'palette'
    if (top === r) return 'effect'
    if (top === lv) return 'layer'
    return 'effect'
  }
  return ROTATION[st.microRot++ % ROTATION.length]
}

/** Fill the shared output object. */
function emit(
  out: ShowAction,
  kind: ShowActionKind,
  reason: string,
  S: number,
  T: number,
  age: number,
  pressure: number,
  ev: SectionEvent | null,
  evaluated: boolean,
): ShowAction {
  out.kind = kind
  out.reason = reason
  out.S = S
  out.T = T
  out.age = age
  out.pressure = pressure
  out.eventId = ev ? ev.id : -1
  out.eventType = ev ? ev.type : ''
  out.micro = null
  out.immediate = false
  out.forced = false
  out.useArmed = false
  out.evaluated = evaluated
  return out
}

/**
 * Advance the director by one call. Mutates `st`; returns `st.out`, filled with what the caller must do. Call it every
 * frame (with `event: null` when there is none) so pressure decays and the forced ceiling can fire; on a frame with
 * several events call it once per event.
 */
export function step(st: ShowState, i: ShowInput): ShowAction {
  const out = st.out
  const beat = i.beat
  const time = i.time

  // A new source restarts the beat counter and the audio clock: nothing from the old track may leak.
  if (beat < st.lastBeat || time < st.lastTime) resetShow(st)
  st.lastBeat = beat
  st.lastTime = time
  if (Number.isNaN(st.baseBeat)) {
    st.baseBeat = beat
    st.baseTime = time
  }

  // Where the scene on screen started: the store's stamp, or the show's own first step before any commit.
  const startKnown =
    Number.isFinite(i.sceneStartBeat) && Number.isFinite(i.sceneStartTime) && i.sceneStartBeat <= beat && i.sceneStartTime <= time
  const startBeat = startKnown ? i.sceneStartBeat : st.baseBeat
  const startTime = startKnown ? i.sceneStartTime : st.baseTime

  // --- Pressure sources and build memory (level and edge signals; they only ever lower the bar) -----------------
  if (i.moodChanged) bump(st, BUMP_MOOD, SHOW.bumpMood, beat, time)
  if (i.characterShift) bump(st, BUMP_CHARACTER, SHOW.bumpCharacter, beat, time)
  if (i.moodPredicted) bump(st, BUMP_PREDICTED, SHOW.bumpPredicted, beat, time)
  if (i.trendRising) bump(st, BUMP_TREND, SHOW.bumpTrend, beat, time)
  if (i.inBuild) {
    st.lastBuildBeat = beat
    st.lastBuildTime = time
  }

  const age = barsBetween(startBeat, startTime, beat, time)
  const pressure = pressureAt(st, beat, time)
  const T = effectiveThreshold(age, pressure)
  const rawBeats = beat - startBeat
  const rawSec = time - startTime
  const refractory = barsBetween(st.lastCutBeat, st.lastCutTime, beat, time) < SHOW.refractoryBars
  const microReady = barsBetween(st.lastMicroBeat, st.lastMicroTime, beat, time) >= SHOW.microCooldownBars
  st.age = age
  st.pressure = pressure
  st.threshold = T
  st.etaBars = barsToCeiling(rawBeats, rawSec, i.bpm, i.inBreakdown)

  const ev = i.event
  let evaluated = false
  emit(out, 'HOLD', 'idle', 0, T, age, pressure, null, false)

  // --- Decide the event ---------------------------------------------------------------------------------------
  if (ev !== null) {
    evaluated = true
    const S = eventScore(ev.type, ev.strength, ev.confidence)
    // Remember it for the forced cut's "best event of the last 4 bars".
    if (S > 0) {
      const k = st.ringPos
      st.ringS[k] = S
      st.ringBeat[k] = beat
      st.ringTime[k] = time
      st.ringPos = (k + 1) % RING
    }
    emit(out, 'HOLD', 'weak', S, T, age, pressure, ev, true)

    if (ev.type === 'buildStart') {
      // A riser starting: arms and applies pressure, never cuts (weight 0).
      st.lastBuildBeat = beat
      st.lastBuildTime = time
      bump(st, BUMP_TREND, SHOW.bumpTrend, beat, time)
      out.reason = 'build-start'
    } else if (ev.type === 'gain') {
      out.reason = 'gain'
    } else if (ev.type === 'fill') {
      // Punctuation only: a fill is worth an effect when it is clear, never a scene change.
      const raw = (Number.isFinite(ev.strength) ? Math.min(1, Math.max(0, ev.strength)) : 0) * (Number.isFinite(ev.confidence) ? Math.min(1, Math.max(0, ev.confidence)) : 0)
      if (raw >= SHOW.microMinS && microReady && !refractory) {
        out.kind = 'MICRO'
        out.reason = 'fill'
        out.micro = 'effect'
      } else out.reason = 'fill-weak'
    } else {
      if (ev.type === 'change' || ev.type === 'breakdown') {
        if (S > 0) st.lastChangeBeat = beat
      }
      decideWeighted(st, i, ev, S, T, age, out, refractory, microReady)
    }
  }

  // --- The forced-change ceiling: min(32 bars, 60 s) on screen (48 / 90 s in a breakdown) ------------------------
  if (out.kind !== 'CUT' && !refractory && !i.inBuild && ceilingReached(rawBeats, rawSec, i.inBreakdown)) {
    const best = bestRecent(st, beat, time)
    if (best >= SHOW.microMinS) {
      emit(out, 'CUT', 'forced-best', best, T, age, pressure, ev, true)
      out.forced = true
      evaluated = true
    } else if (i.barLine) {
      emit(out, 'CUT', 'forced-bar', 0, T, age, pressure, ev, true)
      out.forced = true
      evaluated = true
    } else if (!evaluated) {
      out.reason = 'forced-wait'
    }
  }

  // --- Bookkeeping for what was decided -----------------------------------------------------------------------
  if (out.kind === 'CUT') {
    st.lastCutBeat = beat
    st.lastCutTime = time
    st.ringS.fill(0) // the events that led here are spent
    out.useArmed = st.armedFitOk
    st.stats.cut++
    if (out.forced) st.stats.forced++
  } else if (out.kind === 'MICRO') {
    st.lastMicroBeat = beat
    st.lastMicroTime = time
    st.stats.micro++
  } else if (evaluated) {
    st.stats.hold++
  }
  return out
}

/** The weighted event types (drop / change / breakdown): the S >= T_eff decision. Writes the verdict into `out`. */
function decideWeighted(
  st: ShowState,
  i: ShowInput,
  ev: SectionEvent,
  S: number,
  T: number,
  age: number,
  out: ShowAction,
  refractory: boolean,
  microReady: boolean,
): void {
  if (S < SHOW.microMinS) return // 'weak'
  if (refractory) {
    out.reason = 'refractory'
    return
  }
  const isDrop = ev.type === 'drop'
  // Through a confirmed build the look stays put until the drop (the old directors' rule, kept): every discretionary
  // change is held, tweaks included. The drop itself is the exception, and the ceiling waits for the build to end.
  if (i.inBuild && !isDrop) {
    out.reason = 'build-hold'
    return
  }
  const buildRecent =
    i.inBuild || barsBetween(st.lastBuildBeat, st.lastBuildTime, i.beat, i.time) <= SHOW.buildMemoryBars
  const corroborated =
    ev.corroborated === true || (i.beat - st.lastChangeBeat >= 0 && i.beat - st.lastChangeBeat <= SHOW.corroborateBeats)
  const minBars = minCutBars(i.inBreakdown)

  // Drop gating: a false drop is the only dwell bypass in the legacy show. A drop this young needs a build behind
  // it or a second signal; without either it is a tweak, not a scene change.
  if (isDrop && age < SHOW.dropFastMinBars && !buildRecent && !corroborated) {
    micro(st, out, ev, microReady, 'drop-gated')
    return
  }
  const dropFast = isDrop && S >= SHOW.dropFastMinS && age >= SHOW.dropFastMinBars
  if (dropFast || (age >= minBars && S >= T)) {
    out.kind = 'CUT'
    out.reason = dropFast ? 'drop-fast' : 'event'
    out.immediate = isDrop
    return
  }
  const why = age < minBars ? (i.inBreakdown && age >= SHOW.minCutBars ? 'breakdown-min' : 'min-age') : 'below-T'
  micro(st, out, ev, microReady, why)
}

function micro(st: ShowState, out: ShowAction, ev: SectionEvent, microReady: boolean, reason: string): void {
  if (!microReady) {
    out.reason = 'micro-cooldown'
    return
  }
  out.kind = 'MICRO'
  out.reason = reason
  out.micro = pickMicro(st, ev)
}

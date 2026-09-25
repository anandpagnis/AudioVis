/**
 * DIRECTOR REPLAY (lane W2-B): the REAL pure show director (`engine/show/showDirector.ts` `step`) replayed over a cached
 * per-frame `CadenceTrace`, so the new show's scene-change cadence can be scored on the SAME real tracks, by the same
 * metrics (`cadenceMetrics.ts`), as the legacy model (`legacyCadence.ts` `simulateLegacy`).
 *
 * What is REAL here: `stepLegacyEvents` (the shipped mapping from `f.sectionChange` / `songSection` / `f.drop` /
 * `isSustain` to `SectionEvent`s) and `step` (the shipped director), run on the recorded detector outputs exactly as
 * `showAdapter.tsx` feeds them. What is MODELLED (as in `legacyCadence.ts`; read its header for the shared caveats):
 * the adapter's input derivation and the store / SceneManager commit path.
 *
 * Mirrored from `showAdapter.tsx` (`useFrame` at priority -92):
 *  - the legacy event mapper sees EVERY frame (edges are consumed even in silence); the director is stepped only while
 *    the adapter would not bail out (the trace has silence; manual holds, cues and cutaways are absent, as in the
 *    legacy model), once per event delivered on the frame, or once with `event: null`;
 *  - `barLine = f.beat && f.beatInBar === 3` (the last beat of a bar); `inBreakdown` / `inBuild` need `structureValid`;
 *    `moodChanged` is the committed mood change gated by confidence >= 0.5 and ambiguity <= 0.6;
 *    `moodPredicted` is a predicted transition < 4 beats away with confidence > 0.65; `characterShift` is the latched
 *    change of the character's primary between two valid reads (`CharacterShiftTrigger`; its 12 s gap is not applied
 *    because the adapter passes `lastTriggerAt = -Infinity`); `trendRising` is `armTrend(...) === 'rising'` refreshed
 *    on beat frames (the mood's `isBuilding` / `isDecaying` / `isMelting` flags are not in the trace: read as false, so
 *    the trend is slightly under-reported, which can only make the modelled pressure smaller);
 *  - `sceneStartBeat` is the store's `lastCommitBeat` (-Infinity until the first commit), `sceneStartTime` the audio time
 *    of the first frame / of the last commit.
 *
 * A CUT (`performCut`): a non-immediate CUT while a scene is still landing is refused ("busy": `ackCut(false)`); anything
 * else is accepted as the single pending scene (a drop replaces it). The pending scene then commits the way
 * SceneManager's `resolveCommit` does, checked at the START of each frame (SceneManager runs at -100, before the
 * directors): on a downbeat (`f.beat && f.beatInBar === 0`), immediately for a drop, immediately when the grid is
 * untrusted (`confidence <= 0.25`), else after the 2.5 s backstop. So a request made on the last beat of a bar lands on
 * the next downbeat, a request on a downbeat frame waits a whole bar, and a drop lands on the next frame.
 *
 * The output is a `LegacyResult`-shaped object (commits carry `trigger` = `<eventType>:<reason>`, e.g. `drop:drop-fast`,
 * `change:event`, `forced:forced-bar`), so `cadenceOfTrack` / `aggregateCadence` score both shows identically, plus the
 * director's own decision log. `edges` is empty (the dwell does not exist here).
 *
 * Pure and deterministic. Offline-evaluation tooling: nothing in the shipped app imports it.
 */
import type { EventType, SectionEvent } from '../events/types'
import { createLegacyEventState, stepLegacyEvents, type LegacyInput } from '../events/legacyEvents'
import {
  ackCut,
  createShowState,
  step,
  type ShowAction,
  type ShowActionKind,
  type ShowInput,
} from '../../engine/show/showDirector'
import { beatTimes, alignTimes, seededRng } from './cadenceMetrics'
import { Q10, Q8, STRENGTH_SCALE, type CadenceTrace } from './cadenceTrace'
import {
  LEGACY as LEGACY_TRIGGERS,
  resolveOptions,
  type LegacyCommit,
  type LegacyRequest,
  type LegacyResult,
  type LegacyTrigger,
} from './legacyCadence'

export interface DirectorReplayOptions {
  /** `trace`: grid trusted when `confidence > 0.25 && !silence` (as SceneManager). `always`: the downbeat wait always applies. */
  gridTrust?: 'trace' | 'always'
  /** Feed character shifts as pressure (needs a trace stepped with `character`). Default true. */
  characterShift?: boolean
  /** Feed the mood / trend pressure sources. Default true. */
  pressure?: boolean
}

/** One evaluated director decision (an event, or a forced cut with no event). */
export interface DirectorDecision {
  frame: number
  timeSec: number
  beat: number
  eventId: number
  eventType: EventType | ''
  corroborated: boolean
  kind: ShowActionKind
  reason: string
  S: number
  T: number
  age: number
  /** Drop credibility 0..1 the director applied (1 for a non-drop). */
  credibility: number
  forced: boolean
  immediate: boolean
  /** A CUT that the adapter model refused (a scene was already landing). */
  refused: boolean
}

export interface DropOutcomes {
  /** Distinct drop events (by id; the LAST delivery's type decides). */
  events: number
  /** Their best outcome: a CUT dominates a MICRO dominates a HOLD. */
  cut: number
  micro: number
  hold: number
}

export interface DirectorReplayResult extends LegacyResult {
  decisions: DirectorDecision[]
  /** The director's own counters at the end of the track. */
  stats: { hold: number; micro: number; cut: number; forced: number }
  drops: DropOutcomes
  /** Distinct events by final type (`change`, `drop`, ...). */
  eventsByType: Record<EventType, number>
}

/** Copy of `armedPick.ts` `armTrend`'s rising test (that module pulls in the scene registry): see the header. */
const TREND_DROP_HORIZON_BEATS = 16
const TREND_PREDICT_BEATS = 8
const HOT_STATES: readonly string[] = ['building', 'peak', 'aggressive']
function trendRising(
  valid: boolean,
  isSustain: boolean,
  buildUp: boolean,
  beatsTillDrop: number,
  moodState: string,
  predictedState: string,
  beatsTillTransition: number,
): boolean {
  const imminent = predictedState !== moodState && beatsTillTransition >= 0 && beatsTillTransition < TREND_PREDICT_BEATS
  return (
    (valid && isSustain) ||
    buildUp ||
    (valid && beatsTillDrop > 0 && beatsTillDrop <= TREND_DROP_HORIZON_BEATS) ||
    (imminent && HOT_STATES.includes(predictedState))
  )
}

interface PendingScene {
  sinceSec: number
  requestFrame: number
  requestBeat: number
  immediate: boolean
  trigger: string
  forced: boolean
}

const RANK: Record<ShowActionKind, number> = { HOLD: 0, MICRO: 1, CUT: 2 }

/** Replay the real director over `trace`. Deterministic: the same trace and options always give the same result. */
export function simulateDirector(trace: CadenceTrace, options: DirectorReplayOptions = {}): DirectorReplayResult {
  const gridTrust = options.gridTrust ?? 'trace'
  const useCharacter = options.characterShift ?? true
  const usePressure = options.pressure ?? true
  const c = trace.cols
  const n = trace.n
  const dt = 1 / trace.frameRate
  const sections = trace.enums.sections
  const moods = trace.enums.moods

  const show = createShowState()
  const legacy = createLegacyEventState()
  const li: LegacyInput = {
    time: 0,
    beat: 0,
    bpm: 120,
    sectionChange: false,
    sectionChangeStrength: 0,
    drop: false,
    buildUp: false,
    structureValid: false,
    boundaryChanged: false,
    section: '',
    previousSection: '',
    sectionConfidence: 0,
    beatsInSection: 0,
    isSustain: false,
  }
  const inp: ShowInput = {
    beat: 0,
    time: 0,
    bpm: 120,
    sceneStartBeat: Number.NEGATIVE_INFINITY,
    sceneStartTime: Number.NEGATIVE_INFINITY,
    event: null,
    barLine: false,
    inBreakdown: false,
    inBuild: false,
    moodChanged: false,
    characterShift: false,
    moodPredicted: false,
    trendRising: false,
  }
  const events: SectionEvent[] = []

  const requests: LegacyRequest[] = []
  const commits: LegacyCommit[] = []
  const decisions: DirectorDecision[] = []
  const finalType = new Map<number, EventType>()
  const bestOutcome = new Map<number, ShowActionKind>()

  let pending: PendingScene | null = null
  let lastCommitBeat = Number.NEGATIVE_INFINITY
  let sceneStartTime = Number.NEGATIVE_INFINITY
  let charLast = -1
  let charPending = false
  let trend = false

  for (let i = 0; i < n; i++) {
    const now = i * dt
    const beat = c.beatIndex[i]
    const isBeat = c.beat[i] === 1
    const beatInBar = c.beatInBar[i]
    const silence = c.silence[i] === 1
    const valid = c.structureValid[i] === 1
    const sustain = valid && c.isSustain[i] === 1

    // --- SceneManager (priority -100): a pending scene commits before the directors of this frame ---
    if (pending !== null) {
      const p: PendingScene = pending
      const waited = now - p.sinceSec
      const trusted = gridTrust === 'always' ? true : c.confidence[i] / Q8 > LEGACY_TRIGGERS.gridTrustConfidence && !silence
      if (!trusted || (isBeat && beatInBar === 0) || p.immediate || waited > LEGACY_TRIGGERS.commitBackstopSec) {
        commits.push({
          frame: i,
          beat,
          timeSec: now,
          trigger: p.trigger as LegacyTrigger,
          kind: p.forced ? 'level' : 'event',
          via: 'cold',
          immediate: p.immediate,
          requestFrame: p.requestFrame,
          requestBeat: p.requestBeat,
          waitSec: waited,
        })
        lastCommitBeat = beat
        sceneStartTime = now
        pending = null
      }
    }

    // --- The adapter's per-frame trackers (they see every frame, even a silent one) ---
    li.time = now
    li.beat = beat
    li.bpm = c.bpm10[i] / 10
    li.sectionChange = c.sectionChange[i] === 1
    li.sectionChangeStrength = c.sectionChangeStrength[i] / STRENGTH_SCALE
    li.drop = c.drop[i] === 1
    li.buildUp = c.buildUp[i] === 1
    li.structureValid = valid
    li.boundaryChanged = c.boundaryChanged[i] === 1
    li.section = sections[c.section[i]] ?? ''
    li.previousSection = sections[c.previousSection[i]] ?? ''
    li.sectionConfidence = c.sectionConfidence[i] / Q8
    li.beatsInSection = c.beatsInSection[i]
    li.isSustain = c.isSustain[i] === 1
    events.length = 0
    stepLegacyEvents(legacy, li, events)

    // CharacterShiftTrigger.observe + take(now, -Infinity): a latched change of the primary between two valid reads.
    let characterShift = false
    if (useCharacter) {
      const cp = c.charPrimary[i]
      if (cp < 0) {
        charLast = -1
        charPending = false
      } else {
        if (charLast >= 0 && cp !== charLast) charPending = true
        charLast = cp
      }
      if (charPending) {
        charPending = false
        characterShift = true
      }
    }
    const btd = c.beatsTillDrop10[i] / Q10
    const btt = c.beatsTillTransition10[i] / Q10
    if (isBeat) {
      trend = trendRising(valid, c.isSustain[i] === 1, c.buildUp[i] === 1, btd, moods[c.moodState[i]] ?? '', moods[c.predictedState[i]] ?? '', btt)
    }

    if (silence) continue // the adapter's bail-out (its edges were consumed above)

    // --- The director's inputs ---
    const moodConf = c.moodConfidence[i] / Q8
    const moodAmb = c.moodAmbiguity[i] / Q8
    inp.beat = beat
    inp.time = now
    inp.bpm = c.bpm10[i] / 10
    inp.sceneStartBeat = lastCommitBeat
    inp.sceneStartTime = sceneStartTime === Number.NEGATIVE_INFINITY ? 0 : sceneStartTime
    inp.barLine = isBeat && beatInBar === 3
    inp.inBreakdown = valid && c.isBreakdown[i] === 1
    inp.inBuild = sustain
    inp.moodChanged =
      usePressure &&
      c.moodChanged[i] === 1 &&
      moodConf >= LEGACY_TRIGGERS.moodChangeMinConfidence &&
      moodAmb <= LEGACY_TRIGGERS.moodChangeMaxAmbiguity
    inp.moodPredicted =
      usePressure &&
      c.predictedState[i] !== c.moodState[i] &&
      btt >= 0 &&
      btt < LEGACY_TRIGGERS.imminentBeats &&
      moodConf > LEGACY_TRIGGERS.moodPredictMinConfidence
    inp.characterShift = usePressure && characterShift
    inp.trendRising = usePressure && trend

    const cnt = events.length
    for (let k = 0; k < Math.max(1, cnt); k++) {
      const ev = k < cnt ? events[k] : null
      inp.event = ev
      const a: ShowAction = step(show, inp)
      let refused = false
      if (a.kind === 'CUT') {
        if (!a.immediate && pending !== null) {
          ackCut(show, false, beat, now) // 'busy': a scene is already landing
          refused = true
          requests.push({ frame: i, beat, timeSec: now, trigger: `${a.eventType || 'none'}:busy` as LegacyTrigger, kind: 'event', via: 'cold', immediate: false, outcome: 'refusedDwell' })
        } else {
          const trigger = a.forced ? `forced:${a.reason}` : `${a.eventType || 'none'}:${a.reason}`
          pending = { sinceSec: now, requestFrame: i, requestBeat: beat, immediate: a.immediate, trigger, forced: a.forced }
          requests.push({ frame: i, beat, timeSec: now, trigger: trigger as LegacyTrigger, kind: a.forced ? 'level' : 'event', via: 'cold', immediate: a.immediate, outcome: 'accepted' })
        }
      }
      if (a.evaluated) {
        decisions.push({
          frame: i,
          timeSec: now,
          beat,
          eventId: a.eventId,
          eventType: a.eventType,
          corroborated: ev !== null && ev.corroborated === true,
          kind: a.kind,
          reason: a.reason,
          S: a.S,
          T: a.T,
          age: a.age,
          credibility: a.credibility,
          forced: a.forced,
          immediate: a.immediate,
          refused,
        })
        if (a.eventId >= 0 && ev !== null) {
          finalType.set(a.eventId, ev.type)
          const prev = bestOutcome.get(a.eventId)
          const kind: ShowActionKind = refused ? 'HOLD' : a.kind
          if (prev === undefined || RANK[kind] > RANK[prev]) bestOutcome.set(a.eventId, kind)
        }
      }
    }
    inp.event = null
  }

  const drops: DropOutcomes = { events: 0, cut: 0, micro: 0, hold: 0 }
  const eventsByType: Record<EventType, number> = { change: 0, drop: 0, buildStart: 0, breakdown: 0, fill: 0, gain: 0 }
  for (const [id, ty] of finalType) {
    eventsByType[ty]++
    if (ty !== 'drop') continue
    drops.events++
    const o = bestOutcome.get(id) ?? 'HOLD'
    if (o === 'CUT') drops.cut++
    else if (o === 'MICRO') drops.micro++
    else drops.hold++
  }
  return {
    requests,
    commits,
    edges: [],
    arms: 0,
    options: resolveOptions({}),
    decisions,
    stats: { ...show.stats },
    drops,
    eventsByType,
  }
}

// --- Alignment of cuts to the STRUCTURAL detector events (not f.drop) vs a random-phase control -----------------

export interface StructuralAlignment {
  /** Commits scored (all of them, startup included). */
  commits: number
  /** Structural events on the track: sectionChange edges + latched boundaries + analyser boundaries. */
  events: number
  /** |commit - nearest structural event| samples (s), real and chance (K circular shifts pooled). */
  real: number[]
  chance: number[]
}

/**
 * How near are the scene changes to the STRUCTURE detectors' events (`f.sectionChange`, the latched boundary, the
 * analyser's boundaries; NOT `f.drop`, which a drop-triggered cut satisfies by construction)? With a random-phase
 * control (the same commit times circularly shifted), because the fast `sectionChange` flag fires often enough that
 * any commit lands near one by chance.
 */
export function structuralAlignment(
  trace: CadenceTrace,
  commitTimes: readonly number[],
  opts: { chanceCopies?: number; seed?: number } = {},
): StructuralAlignment {
  const copies = opts.chanceCopies ?? 20
  const rng = seededRng((opts.seed ?? 1) * 2654435761)
  const { cols, n, frameRate } = trace
  const dt = 1 / frameRate
  const evs: number[] = []
  let prevSc = 0
  let prevB = 0
  for (let i = 0; i < n; i++) {
    const sc = cols.sectionChange[i] !== 0 ? 1 : 0
    const bd = cols.boundaryChanged[i] !== 0 && cols.structureValid[i] !== 0 ? 1 : 0
    if (sc === 1 && prevSc === 0) evs.push(i * dt)
    if (bd === 1 && prevB === 0) evs.push(i * dt)
    prevSc = sc
    prevB = bd
  }
  const bt = beatTimes(trace)
  for (const ab of trace.analyserBoundaries) {
    const t = bt.get(Math.round(ab.beat))
    if (t !== undefined) evs.push(t)
  }
  evs.sort((a, b) => a - b)
  const duration = n * dt
  const real = commitTimes.length && evs.length ? alignTimes(commitTimes, evs).abs : []
  const chance: number[] = []
  if (commitTimes.length && evs.length && duration > 0) {
    for (let k = 0; k < copies; k++) {
      const off = rng() * duration
      chance.push(...alignTimes(commitTimes.map((t) => (t + off) % duration), evs).abs)
    }
  }
  return { commits: commitTimes.length, events: evs.length, real, chance }
}

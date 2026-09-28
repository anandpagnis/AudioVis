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
 * `change:event`; there is no timer, so every trigger is an event), so `cadenceOfTrack` / `aggregateCadence` score both shows identically, plus the
 * director's own decision log. `edges` is empty (the dwell does not exist here).
 *
 * Pure and deterministic. Offline-evaluation tooling: nothing in the shipped app imports it.
 */
import type { EventType, SectionEvent } from '../events/types'
import { EventLayer, type EventLayerConfig } from '../events/EventLayer'
import { maskLegacyInputForV2, mergeLiveWithLegacy } from '../events/eventMux'
import { createLegacyEventState, stepLegacyEvents, type LegacyInput } from '../events/legacyEvents'
import {
  ackCut,
  createShowState,
  step,
  type ShowAction,
  type ShowActionKind,
  type ShowInput,
} from '../../engine/show/showDirector'
import { isCommitBarLine } from '../../engine/show/commitBarLine'
import { beatTimes, alignTimes, seededRng } from './cadenceMetrics'
import { Q10, Q8, STRENGTH_SCALE, type CadenceTrace } from './cadenceTrace'
import { copyEvent, type EventCellRecord } from './eventReplay'
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
  /**
   * `?events=v2`: the live event layer's stream (see {@link prepareLiveStream}). The legacy mapper is masked and merged
   * exactly as `showAdapter.tsx` does (`eventMux.ts`: only its drop / buildStart events survive, the live change / fill /
   * gain / breakdown events are appended), and the CUT alignment (`barLine`) uses the anchored grid while it is
   * confident. Absent: the legacy event source, bit-identical to before this option existed.
   */
  live?: LiveStream
  /**
   * Where SceneManager commits a pending non-drop scene. `legacy` (default): `f.beat && f.beatInBar === 0`. `anchored`
   * (needs `live`): `isCommitBarLine`, the anchored grid's bar line while it is confident, else the same fallback.
   */
  commitGrid?: 'legacy' | 'anchored'
  /** Replay only the first `endSec` seconds of the trace (the cached event cells may cover less than the trace). */
  endSec?: number
}

/**
 * The live event layer's output over one trace, placed on trace FRAMES so `simulateDirector` can deliver each event on the
 * frame the engine would have (the analyser closes a beat cell on a beat frame and `EventLayer.push` runs inside the same
 * engine update, before any director).
 */
export interface LiveStream {
  /** Frame -> the events the layer delivered on that frame (copies). */
  byFrame: Map<number, SectionEvent[]>
  /** Every event with the frame it was delivered on, in order. */
  events: Array<{ frame: number; event: SectionEvent }>
  /** Per frame: beats to the next bar line of the anchored grid on a BEAT frame (0 = this beat is one), -1 = not confident or not a beat frame. */
  toLine: Int8Array
  /** Cells placed on a trace frame whose beat index agrees with the trace's / placed with a disagreeing beat / not placeable. */
  cells: { matched: number; mismatched: number; unplaced: number }
  /** Last trace frame that a cell was delivered on (the stream says nothing after it). */
  lastFrame: number
}

/** `scripts/calibrate/events-cache.calib.ts` stamps a cell at (window start + FFT_SIZE / sampleRate): undo that to find the frame. */
export const EVENT_CELL_FFT_SIZE = 2048

/**
 * Run a fresh `EventLayer` over the recorded beat `cells` of a track, frame by frame against `trace`, and record what it
 * delivered and where its anchored bar grid put the bar lines. `cells` are the cached `EventCellRecord`s (times already
 * shifted onto the audio clock), `sampleRate` the run's. Pure and deterministic.
 */
export function prepareLiveStream(
  trace: CadenceTrace,
  cells: readonly EventCellRecord[],
  sampleRate: number,
  cfg: Partial<EventLayerConfig> = {},
): LiveStream {
  const { cols, n, frameRate } = trace
  const off = EVENT_CELL_FFT_SIZE / sampleRate
  const layer = new EventLayer(cfg)
  const byFrame = new Map<number, SectionEvent[]>()
  const events: Array<{ frame: number; event: SectionEvent }> = []
  const toLine = new Int8Array(n).fill(-1)
  const stats = { matched: 0, mismatched: 0, unplaced: 0 }

  // Place every cell on a frame: the frame whose window start is the cell's time, nudged (+-3 frames) to the one that
  // carries the same beat index when the clocks differ by a frame.
  const placed: Array<{ frame: number; r: EventCellRecord }> = []
  for (const r of cells) {
    const f0 = Math.round((r.time - off) * frameRate)
    if (f0 < 0 || f0 >= n) {
      stats.unplaced++
      continue
    }
    let f = f0
    if (cols.beatIndex[f0] === r.beat) stats.matched++
    else {
      let hit = -1
      for (let d = 1; d <= 3 && hit < 0; d++) {
        if (f0 - d >= 0 && cols.beatIndex[f0 - d] === r.beat) hit = f0 - d
        else if (f0 + d < n && cols.beatIndex[f0 + d] === r.beat) hit = f0 + d
      }
      if (hit >= 0) {
        f = hit
        stats.matched++
      } else stats.mismatched++
    }
    placed.push({ frame: f, r })
  }
  placed.sort((a, b) => a.frame - b.frame)

  let k = 0
  let lastFrame = -1
  for (let i = 0; i < n; i++) {
    while (k < placed.length && placed[k].frame <= i) {
      const { frame, r } = placed[k++]
      const out = layer.push(r.cell, r.beat, r.time, r.bpm, { locked: r.locked, offset: r.offset })
      lastFrame = frame
      for (const e of out) {
        const ev = copyEvent(e)
        events.push({ frame, event: ev })
        const list = byFrame.get(frame)
        if (list) list.push(ev)
        else byFrame.set(frame, [ev])
      }
    }
    if (cols.beat[i] === 1) toLine[i] = layer.beatsToBarLine(cols.beatIndex[i])
  }
  return { byFrame, events, toLine, cells: stats, lastFrame }
}

/** One evaluated director decision (an event; a frame with none is not a decision). */
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
  immediate: boolean
  /** A CUT that the adapter model refused (a scene was already landing). */
  refused: boolean
}

export interface EventOutcomes {
  /** Distinct events (by id; the LAST delivery's type decides). */
  events: number
  /** Their best outcome over all deliveries: a CUT dominates a MICRO dominates a HOLD. */
  cut: number
  micro: number
  hold: number
}

export interface ReleaseDropOutcomes extends EventOutcomes {
  /** Of the cuts, how many were the fast lane (`drop-fast`: an immediate hard cut). */
  fast: number
  /** Of the HOLDs, how many were held by the 4-bar refractory (a scene had just been cut: not a lost drop). */
  refractory: number
}

/** How many beats before a drop edge a build / breakdown may have run for it to count as a RELEASE (4 bars). */
export const RELEASE_LOOKBACK_BEATS = 16

export interface DirectorReplayResult extends LegacyResult {
  decisions: DirectorDecision[]
  /** The director's own counters at the end of the track. */
  stats: { hold: number; micro: number; cut: number }
  /** What became of the distinct events of each final type. */
  outcomes: Record<EventType, EventOutcomes>
  /** `outcomes.drop`: the drop events (kept as a shorthand). */
  drops: EventOutcomes
  /**
   * The drops with a build (`isSustain` / `buildUp`) or a breakdown running, or ended within
   * {@link RELEASE_LOOKBACK_BEATS} beats, judged from the TRACE (independently of the director's own memory): the
   * releases that must keep their fast hard-cut lane.
   */
  releaseDrops: ReleaseDropOutcomes
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
}

const RANK: Record<ShowActionKind, number> = { HOLD: 0, MICRO: 1, CUT: 2 }
const NO_LIVE: readonly SectionEvent[] = []

/** Replay the real director over `trace`. Deterministic: the same trace and options always give the same result. */
export function simulateDirector(trace: CadenceTrace, options: DirectorReplayOptions = {}): DirectorReplayResult {
  const gridTrust = options.gridTrust ?? 'trace'
  const useCharacter = options.characterShift ?? true
  const usePressure = options.pressure ?? true
  const c = trace.cols
  const n = options.endSec === undefined ? trace.n : Math.max(0, Math.min(trace.n, Math.floor(options.endSec * trace.frameRate)))
  const dt = 1 / trace.frameRate
  const sections = trace.enums.sections
  const moods = trace.enums.moods
  const live = options.live ?? null
  const anchoredCommit = live !== null && options.commitGrid === 'anchored'
  // `isCommitBarLine`'s grid for this frame: the live stream's per-frame answer of `beatsToBarLine`.
  let frameToLine = -1
  const commitGrid = { beatsToBarLine: (): number => frameToLine }
  const commitFrame = { beat: false, beatInBar: 0, beatIndex: 0 }

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
  const releaseId = new Set<number>()
  const fastId = new Set<number>()
  const refractoryId = new Set<number>()
  let lastBuildBeat = Number.NEGATIVE_INFINITY
  let lastBreakdownBeat = Number.NEGATIVE_INFINITY

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
    if (sustain || c.buildUp[i] === 1) lastBuildBeat = beat
    if (valid && c.isBreakdown[i] === 1) lastBreakdownBeat = beat

    // --- SceneManager (priority -100): a pending scene commits before the directors of this frame ---
    if (pending !== null) {
      const p: PendingScene = pending
      const waited = now - p.sinceSec
      const trusted = gridTrust === 'always' ? true : c.confidence[i] / Q8 > LEGACY_TRIGGERS.gridTrustConfidence && !silence
      let onDownbeat = isBeat && beatInBar === 0
      if (anchoredCommit) {
        frameToLine = (live as LiveStream).toLine[i]
        commitFrame.beat = isBeat
        commitFrame.beatInBar = beatInBar
        commitFrame.beatIndex = beat
        onDownbeat = isCommitBarLine(commitFrame, commitGrid)
      }
      if (!trusted || onDownbeat || p.immediate || waited > LEGACY_TRIGGERS.commitBackstopSec) {
        commits.push({
          frame: i,
          beat,
          timeSec: now,
          trigger: p.trigger as LegacyTrigger,
          kind: 'event',
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
    li.inBreakdown = valid && c.isBreakdown[i] === 1
    // `?events=v2`: the legacy mapping is still stepped (its drop / build state must not freeze) but is not fed the
    // sectionChange / non-drop boundary signals, and the live events are merged after its own (see `eventMux.ts`).
    if (live !== null) maskLegacyInputForV2(li)
    events.length = 0
    stepLegacyEvents(legacy, li, events)
    if (live !== null) mergeLiveWithLegacy(events, live.byFrame.get(i) ?? NO_LIVE)

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
    inp.sceneStartBeat = lastCommitBeat
    inp.sceneStartTime = sceneStartTime === Number.NEGATIVE_INFINITY ? 0 : sceneStartTime
    // (v2: the anchored grid's last beat of a bar while it is confident, as the adapter does)
    let barLine = isBeat && beatInBar === 3
    if (live !== null && isBeat) {
      const toLine = live.toLine[i]
      if (toLine >= 0) barLine = toLine === 1
    }
    inp.barLine = barLine
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
          const trigger = `${a.eventType || 'none'}:${a.reason}`
          pending = { sinceSec: now, requestFrame: i, requestBeat: beat, immediate: a.immediate, trigger }
          requests.push({ frame: i, beat, timeSec: now, trigger: trigger as LegacyTrigger, kind: 'event', via: 'cold', immediate: a.immediate, outcome: 'accepted' })
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
          immediate: a.immediate,
          refused,
        })
        if (a.eventId >= 0 && ev !== null) {
          finalType.set(a.eventId, ev.type)
          if (
            ev.type === 'drop' &&
            !releaseId.has(a.eventId) &&
            (beat - lastBuildBeat <= RELEASE_LOOKBACK_BEATS || beat - lastBreakdownBeat <= RELEASE_LOOKBACK_BEATS)
          ) {
            releaseId.add(a.eventId)
          }
          if (a.kind === 'CUT' && !refused && a.reason === 'drop-fast') fastId.add(a.eventId)
          if (a.reason === 'refractory') refractoryId.add(a.eventId)
          const prev = bestOutcome.get(a.eventId)
          const kind: ShowActionKind = refused ? 'HOLD' : a.kind
          if (prev === undefined || RANK[kind] > RANK[prev]) bestOutcome.set(a.eventId, kind)
        }
      }
    }
    inp.event = null
  }

  const blank = (): EventOutcomes => ({ events: 0, cut: 0, micro: 0, hold: 0 })
  const outcomes: Record<EventType, EventOutcomes> = {
    change: blank(),
    drop: blank(),
    buildStart: blank(),
    breakdown: blank(),
    fill: blank(),
    gain: blank(),
  }
  const releaseDrops: ReleaseDropOutcomes = { ...blank(), fast: 0, refractory: 0 }
  const tally = (o: EventOutcomes, k: ShowActionKind): void => {
    o.events++
    if (k === 'CUT') o.cut++
    else if (k === 'MICRO') o.micro++
    else o.hold++
  }
  for (const [id, ty] of finalType) {
    const k = bestOutcome.get(id) ?? 'HOLD'
    tally(outcomes[ty], k)
    if (ty === 'drop' && releaseId.has(id)) {
      tally(releaseDrops, k)
      if (fastId.has(id)) releaseDrops.fast++
      if (k === 'HOLD' && refractoryId.has(id)) releaseDrops.refractory++
    }
  }
  return {
    requests,
    commits,
    edges: [],
    arms: 0,
    options: resolveOptions({}),
    decisions,
    stats: { ...show.stats },
    outcomes,
    drops: outcomes.drop,
    releaseDrops,
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

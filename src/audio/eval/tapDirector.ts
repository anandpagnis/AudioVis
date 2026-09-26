/**
 * The REAL show director (`engine/show/showDirector.ts` `step`) replayed on a tapped song's cells, so the CUTs and MICROs a
 * change to the event layer or to the director's mapping would produce can be scored against the taps (M mark = a scene
 * cut is right, N mark = a MICRO is right), without the audio.
 *
 * What is REAL: `EventLayer` (from the cells), `stepLegacyEvents` + `maskLegacyInputForV2` + `mergeLiveWithLegacy` (fed from the
 * legacy edges the log recorded: `sectionChange` with its strength, `drop`, the build / breakdown flags), and the director.
 * What is MODELLED: the adapter's input derivation (no mood / character pressure, the log has only their changes), and the
 * commit path (a CUT lands on the next bar line of the anchored grid in v2 / the arbitrary `beatInBar === 0` in legacy, a
 * drop-fast cut immediately, at most `maxWaitCells` later). Pure and deterministic; offline tooling only.
 *
 * All times are song-relative (`t - firstT`).
 */
import type { SectionEvent } from '../events/types'
import { EventLayer, type EventLayerConfig } from '../events/EventLayer'
import { maskLegacyInputForV2, mergeLiveWithLegacy } from '../events/eventMux'
import { createLegacyEventState, stepLegacyEvents, type LegacyInput } from '../events/legacyEvents'
import { createShowState, step, type ShowAction, type ShowInput } from '../../engine/show/showDirector'
import { copyEvent } from './eventReplay'
import type { TapSong } from './tapEval'

export interface DirectorSimOptions {
  /** `v2`: the live layer + the mux (`?events=v2`); `legacy`: the legacy mapping alone (`?events=legacy`). */
  events: 'v2' | 'legacy'
  layer?: Partial<EventLayerConfig>
  /** A CUT that is not immediate lands on the next bar line, at most this many cells later. */
  maxWaitCells?: number
}

export interface SimDecision {
  t: number
  type: string
  kind: ShowAction['kind']
  reason: string
  S: number
  T: number
  age: number
  strength: number
  confidence: number
  source: string
}

export interface DirectorSimResult {
  decisions: SimDecision[]
  /** Times the scenes changed (cut decided; landing time for non-immediate ones). */
  cuts: number[]
  /** Decision times of the CUTs (before the bar-line wait) and of the MICROs. */
  cutDecided: number[]
  micros: number[]
  /** Events delivered to the director (all types) for inspection. */
  events: Array<{ t: number; type: string; strength: number; confidence: number; source: string }>
}

interface Flags {
  build: Array<[number, boolean]>
  breakdown: Array<[number, boolean]>
}

function flagAt(list: ReadonlyArray<[number, boolean]>, t: number): boolean {
  let on = false
  for (const [ft, v] of list) {
    if (ft > t) break
    on = v
  }
  return on
}

export function simulateDirectorOnSong(song: TapSong, opt: DirectorSimOptions): DirectorSimResult {
  const v2 = opt.events === 'v2'
  const maxWait = opt.maxWaitCells ?? 6
  const layer = new EventLayer(opt.layer ?? {})
  const legacy = createLegacyEventState()
  const show = createShowState()
  const log = song.log
  const rel = (t: number): number => t - song.firstT
  const edges = (kind: string): Array<{ t: number; strength: number }> =>
    log.events.filter((e) => e.kind === kind).map((e) => ({ t: rel(e.t), strength: typeof e.data.strength === 'number' ? e.data.strength : 0 }))
  const dropEdges = edges('drop')
  const scEdges = edges('sectionChange')
  const flags: Flags = { build: [], breakdown: [] }
  for (const e of log.events) {
    if (e.kind === 'isBuild') flags.build.push([rel(e.t), e.data.on !== false])
    if (e.kind === 'isBreakdown') flags.breakdown.push([rel(e.t), e.data.on !== false])
  }
  let di = 0
  let si = 0

  const li: LegacyInput = {
    time: 0,
    beat: 0,
    bpm: 120,
    sectionChange: false,
    sectionChangeStrength: 0,
    drop: false,
    buildUp: false,
    structureValid: true,
    boundaryChanged: false,
    section: '',
    previousSection: '',
    sectionConfidence: 0.6,
    beatsInSection: 0,
    isSustain: false,
    inBreakdown: false,
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
  const out: DirectorSimResult = { decisions: [], cuts: [], cutDecided: [], micros: [], events: [] }
  // (in an object: the closure below assigns it, and TypeScript would narrow a plain `let` to null in the loop)
  const cut: { pending: { waited: number; immediate: boolean } | null } = { pending: null }
  let sceneBeat = Number.NEGATIVE_INFINITY
  let sceneTime = Number.NEGATIVE_INFINITY
  let prevT = -Infinity
  const events: SectionEvent[] = []

  for (const r of song.cells) {
    const t = rel(r.time)
    const live = layer.push(r.cell, r.beat, r.time, r.bpm, { locked: r.locked, offset: r.offset })
    const liveCopies = live.map((e) => {
      const c = copyEvent(e)
      c.boundaryTime -= song.firstT
      c.detectedAtTime -= song.firstT
      return c
    })
    // legacy signals seen since the previous cell
    let drop = false
    while (di < dropEdges.length && dropEdges[di].t <= t) {
      if (dropEdges[di].t > prevT) drop = true
      di++
    }
    let sc = false
    let scStrength = 0
    while (si < scEdges.length && scEdges[si].t <= t) {
      if (scEdges[si].t > prevT) {
        sc = true
        scStrength = Math.max(scStrength, scEdges[si].strength)
      }
      si++
    }
    prevT = t
    const inBuild = flagAt(flags.build, t)
    const inBreakdown = flagAt(flags.breakdown, t)
    li.time = t
    li.beat = r.beat
    li.bpm = r.bpm > 0 ? r.bpm : 120
    li.sectionChange = sc
    li.sectionChangeStrength = scStrength
    li.drop = drop
    li.isSustain = inBuild
    li.inBreakdown = inBreakdown
    li.boundaryChanged = false
    events.length = 0
    // v2: the mapper is still stepped every frame (its drop / build state must not freeze) but without the signals v2 replaces
    if (v2) maskLegacyInputForV2(li)
    stepLegacyEvents(legacy, li, events)
    if (v2) mergeLiveWithLegacy(events, liveCopies)

    const beatInBar = (((r.beat - r.offset) % 4) + 4) % 4
    const toLine = v2 ? layer.beatsToBarLine(r.beat) : -1
    let barLine = beatInBar === 3
    if (v2 && toLine >= 0) barLine = toLine === 1
    const isCommitLine = v2 && toLine >= 0 ? toLine === 0 : beatInBar === 0

    // a pending non-immediate cut lands on the next bar line
    if (cut.pending !== null) {
      cut.pending.waited++
      if (cut.pending.immediate || isCommitLine || cut.pending.waited >= maxWait) {
        sceneBeat = r.beat
        sceneTime = t
        out.cuts.push(t)
        cut.pending = null
      }
    }

    inp.beat = r.beat
    inp.time = t
    inp.sceneStartBeat = sceneBeat
    inp.sceneStartTime = sceneTime
    inp.barLine = barLine
    inp.inBreakdown = inBreakdown
    inp.inBuild = inBuild
    const act = (ev: SectionEvent | null): void => {
      inp.event = ev
      const a = step(show, inp)
      if (ev !== null) {
        out.decisions.push({
          t,
          type: ev.type,
          kind: a.kind,
          reason: a.reason,
          S: a.S,
          T: a.T,
          age: a.age,
          strength: ev.strength,
          confidence: ev.confidence,
          source: ev.source,
        })
        out.events.push({ t, type: ev.type, strength: ev.strength, confidence: ev.confidence, source: ev.source })
      }
      if (a.kind === 'CUT' && cut.pending === null) {
        out.cutDecided.push(t)
        cut.pending = { waited: 0, immediate: a.immediate }
        if (a.immediate) {
          sceneBeat = r.beat
          sceneTime = t
          out.cuts.push(t)
          cut.pending = null
        }
      } else if (a.kind === 'MICRO') out.micros.push(t)
    }
    if (events.length === 0) act(null)
    else for (const ev of events) act(ev)
  }
  return out
}

import type { EventType, SectionEvent } from './types'

/**
 * Maps TODAY's structure signals onto `SectionEvent`s, so the show director works before the new bar-synchronous
 * detector exists (`?events=legacy` stays available once it does). Pure and free of the audio engine: the adapter
 * copies the few fields it needs into a {@link LegacyInput} each frame.
 *
 * ## The signals and how each becomes an event
 *  - `f.sectionChange` (one frame, PhraseDetector: only on a downbeat, novelty above 0.45): type `change`.
 *      strength   = clamp01((novelty - 0.40) / 0.80). Measured `sectionChangeStrength` percentiles: p10 0.48,
 *                   p50 0.64, p90 1.11, so a median event maps to 0.30 (a tweak: it never clears the director's
 *                   floor of T = 0.35), p90 to 0.89 (a real change) and novelty >= 1.2 to 1.0.
 *      confidence = 0.95, constant: PhraseDetector emits only above its 0.45 threshold and on a downbeat and gives no
 *                   probability, so "this happened" is near-certain and the SIZE lives in the strength. Chosen with the
 *                   cadence simulation (`show/__tests__/cadenceSim.ts`): 0.85 left too many real changes below the
 *                   age threshold (hit rate 0.70), 0.95 answers 0.8-0.86 of them within a bar at a 12-bar median.
 *  - `songSection.boundaryChanged` (one frame, the latched analyser section): `change`, or `breakdown` when the new
 *    section is a breakdown, or `drop` when it commits the drop latch, or `buildStart` when it commits a build (a
 *    build is a riser beginning, not a scene change). A settle back to a plain section right after a drop is NOT a
 *    boundary (the drop already produced its event) and is skipped.
 *      strength   = a documented constant per kind (0.75 / 0.80 / 1.0 / 0.6): the analyser's per-boundary novelty is
 *                   dropped before the tracker sees it (`structureProtocol.ts`, `boundaries: number[]`), so it cannot
 *                   be recovered here without touching `src/audio`.
 *      confidence = `songSection.sectionConfidence` (0.60 at the first boundary, 0.90 from the third), which is the
 *                   only honest evidence the tracker exposes.
 *      boundaryBeat = beat - beatsInSection: the analyser learns of a boundary ~4-6 beats late, and the tracker dates
 *                   the section from the aged boundary, so this recovers where it really began.
 *  - `f.drop` rising edge: `drop`, strength 1, confidence 0.70, or 0.90 when a build was running (or ended within
 *    {@link LEGACY.buildLookbackBeats} beats): S = 1.25 * 1 * conf = 0.875 alone, 1.125 after a build. Only the second
 *    clears the director's drop fast lane (S >= 1.0): a drop with no build behind it is treated as a candidate change,
 *    not a hard cut (false drops are the only dwell bypass in the legacy show).
 *  - the rising edge of a confirmed build (`songSection.isSustain`, or the fast `f.buildUp`): `buildStart`, strength
 *    0.6, confidence 0.8. Weight 0 in the director: it arms and adds pressure, never cuts.
 *
 * ## No double counting
 * The same physical change is usually reported by more than one signal (a drop plus the analyser's drop boundary plus
 * PhraseDetector). Signals within {@link LEGACY.mergeBeats} beats of an event already emitted MERGE into it: the event
 * is re-delivered with the SAME `id`, the strongest strength, the dominant type (drop > breakdown > change >
 * buildStart), confidence lifted by {@link LEGACY.corroborationBonus} and `corroborated = true`. Events are never
 * delayed to wait for a partner: the first signal is delivered at once (a drop must be immediate), and the merge
 * arrives as an amendment. Consumers act at most once per `id`.
 */

export const LEGACY = {
  /** Novelty -> strength: 0 at `sectionFloor`, 1 at `sectionCeil`. */
  sectionFloor: 0.4,
  sectionCeil: 1.2,
  sectionConfidence: 0.95,
  /** Strength of a latched-analyser boundary, by what it committed. */
  boundaryChange: 0.75,
  boundaryBreakdown: 0.8,
  boundaryDrop: 1.0,
  boundaryBuild: 0.6,
  dropStrength: 1.0,
  dropConfidence: 0.7,
  dropBuildConfidence: 0.9,
  buildStrength: 0.6,
  buildConfidence: 0.8,
  /** A build that ended this many beats ago still counts as "a build was running" for a drop. */
  buildLookbackBeats: 8,
  /** Signals this many beats apart are one physical change. */
  mergeBeats: 2,
  corroborationBonus: 0.1,
} as const

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** `f.sectionChangeStrength` (PhraseDetector novelty) -> event strength 0..1. */
export function sectionStrength(novelty: number): number {
  return clamp01((novelty - LEGACY.sectionFloor) / (LEGACY.sectionCeil - LEGACY.sectionFloor))
}

/** The fields of one frame the mapper reads (all from `audioEngine.features`). */
export interface LegacyInput {
  time: number
  /** `f.beatIndex`. */
  beat: number
  bpm: number
  sectionChange: boolean
  sectionChangeStrength: number
  drop: boolean
  buildUp: boolean
  structureValid: boolean
  boundaryChanged: boolean
  /** `songSection.section` and `.previousSection` ('' | intro | build | drop | breakdown | section | outro). */
  section: string
  previousSection: string
  sectionConfidence: number
  beatsInSection: number
  /** `songSection.isSustain`: a confirmed build (or drop expected). */
  isSustain: boolean
}

export interface LegacyEventState {
  nextId: number
  lastBeat: number
  prevDrop: boolean
  prevBuildUp: boolean
  prevSustain: boolean
  /** Beat a build was last running (`isSustain` or `buildUp`), -Infinity = never. */
  lastBuildBeat: number
  /** The event last delivered, open to merging for `mergeBeats`; `openId < 0` = none. */
  openId: number
  openType: EventType
  openStrength: number
  openConfidence: number
  openBeat: number
  openBoundaryBeat: number
  openCorroborated: boolean
}

export function createLegacyEventState(): LegacyEventState {
  return {
    nextId: 1,
    lastBeat: Number.NEGATIVE_INFINITY,
    prevDrop: false,
    prevBuildUp: false,
    prevSustain: false,
    lastBuildBeat: Number.NEGATIVE_INFINITY,
    openId: -1,
    openType: 'change',
    openStrength: 0,
    openConfidence: 0,
    openBeat: Number.NEGATIVE_INFINITY,
    openBoundaryBeat: 0,
    openCorroborated: false,
  }
}

const PRECEDENCE: Record<EventType, number> = { drop: 5, breakdown: 4, change: 3, buildStart: 2, fill: 1, gain: 0 }

/** Fold one signal into the open event (merge, then it is re-delivered) or start a new one. */
function signal(
  st: LegacyEventState,
  beat: number,
  type: EventType,
  strength: number,
  confidence: number,
  boundaryBeat: number,
): void {
  const near = st.openId >= 0 && beat >= st.openBeat && beat - st.openBeat <= LEGACY.mergeBeats
  if (near) {
    if (PRECEDENCE[type] > PRECEDENCE[st.openType]) st.openType = type
    st.openStrength = Math.max(st.openStrength, strength)
    st.openConfidence = Math.min(1, Math.max(st.openConfidence, confidence) + LEGACY.corroborationBonus)
    st.openBoundaryBeat = Math.min(st.openBoundaryBeat, boundaryBeat)
    st.openCorroborated = true
    return
  }
  st.openId = st.nextId++
  st.openType = type
  st.openStrength = strength
  st.openConfidence = confidence
  st.openBeat = beat
  st.openBoundaryBeat = boundaryBeat
  st.openCorroborated = false
}

/**
 * Advance one frame; pushes the events to (re)deliver onto `out` (which the caller empties first) and returns how
 * many. Allocation only when an event is delivered. Non-finite inputs are read as "no signal" / zero, never thrown on.
 */
export function stepLegacyEvents(st: LegacyEventState, i: LegacyInput, out: SectionEvent[]): number {
  const beat = Number.isFinite(i.beat) ? i.beat : 0
  const time = Number.isFinite(i.time) ? i.time : 0
  // A new source restarts the beat counter: nothing from the old track may leak (a stale open event would swallow
  // the first real signal, a stale edge state would fire one).
  if (beat < st.lastBeat) {
    st.openId = -1
    st.prevDrop = false
    st.prevBuildUp = false
    st.prevSustain = false
    st.lastBuildBeat = Number.NEGATIVE_INFINITY
  }
  st.lastBeat = beat

  const sustain = i.structureValid && i.isSustain
  const dropEdge = i.drop && !st.prevDrop
  const buildUpEdge = i.buildUp && !st.prevBuildUp
  const sustainEdge = sustain && !st.prevSustain
  st.prevDrop = i.drop
  st.prevBuildUp = i.buildUp
  st.prevSustain = sustain

  // Was a build running (or just ended)? Read BEFORE this frame's own signals so a drop's edge sees the build behind it.
  const buildBehind = sustain || i.buildUp || beat - st.lastBuildBeat <= LEGACY.buildLookbackBeats
  if (sustain || i.buildUp) st.lastBuildBeat = beat

  let touched = false

  if (i.sectionChange) {
    const s = sectionStrength(i.sectionChangeStrength)
    if (s > 0) {
      signal(st, beat, 'change', s, LEGACY.sectionConfidence, beat)
      touched = true
    }
  }

  if (i.structureValid && i.boundaryChanged) {
    const conf = clamp01(i.sectionConfidence)
    const back = Math.min(16, Math.max(0, Number.isFinite(i.beatsInSection) ? i.beatsInSection : 0))
    const boundaryBeat = beat - back
    if (i.section === 'drop') {
      signal(st, beat, 'drop', LEGACY.boundaryDrop, conf, boundaryBeat)
      touched = true
    } else if (i.section === 'breakdown') {
      signal(st, beat, 'breakdown', LEGACY.boundaryBreakdown, conf, boundaryBeat)
      touched = true
    } else if (i.section === 'build') {
      signal(st, beat, 'buildStart', LEGACY.boundaryBuild, conf, boundaryBeat)
      touched = true
    } else if (i.previousSection !== 'drop') {
      // (a plain section right after a drop is the tracker's post-drop settle, not a musical boundary)
      signal(st, beat, 'change', LEGACY.boundaryChange, conf, boundaryBeat)
      touched = true
    }
  }

  if (dropEdge) {
    signal(st, beat, 'drop', LEGACY.dropStrength, buildBehind ? LEGACY.dropBuildConfidence : LEGACY.dropConfidence, beat)
    touched = true
  }

  if (sustainEdge || buildUpEdge) {
    signal(st, beat, 'buildStart', LEGACY.buildStrength, LEGACY.buildConfidence, beat)
    touched = true
  }

  if (!touched) return 0
  const spb = Number.isFinite(i.bpm) && i.bpm > 0 ? 60 / i.bpm : 0.5
  const detectedBeat = st.openBeat
  out.push({
    id: st.openId,
    type: st.openType,
    strength: st.openStrength,
    confidence: st.openConfidence,
    boundaryBeat: st.openBoundaryBeat,
    boundaryTime: time - (beat - st.openBoundaryBeat) * spb,
    detectedAtBeat: detectedBeat,
    detectedAtTime: time - (beat - detectedBeat) * spb,
    source: 'legacy',
    phase: ((Math.round(st.openBoundaryBeat) % 4) + 4) % 4,
    feats: { level: 0, low: 0, timbre: 0, harmony: 0, rhythm: 0 },
    corroborated: st.openCorroborated,
  })
  return 1
}

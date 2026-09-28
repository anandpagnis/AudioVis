/**
 * The MIRROR rack's decision gate: WHEN the mirror may engage, disengage or reshape. Pure (no React, three or store
 * imports), advanced once per frame by `PerformanceStateBridge`, which owns the actual look (`mirrorFromProfile` /
 * `mirrorForSection`) and the fade.
 *
 * ## Why this exists (the flicker)
 *
 * The bridge used to re-roll the mirror on EVERY `f.sectionChange` (a one-frame novelty flag that can fire several
 * times a phrase) and every phrase edge, and `shouldRepickMirror` let `sectionChange`, `moodMoved` (the primary of 14
 * moods changing) and `stale` bypass every minimum hold. Each re-roll was a fresh coin flip (`mirrorSeed++`) at the
 * mood's `mirrorEngage`, so a fold that had just engaged could be rolled to OFF a beat later, then back ON, and an
 * engaged fold re-rolled to a different segment count snapped visibly. The fold read as turning on and off at random.
 *
 * ## The rules
 *
 *  - A decision is only ever taken ON A BEAT, and only when the dwell has cleared: an engaged mirror holds at least
 *    `minOnBeats`, an off mirror rests at least `minOffBeats`, and no two changes are closer than `minChangeBeats`.
 *    Nothing bypasses this: not a section change, not a mood change, not a drop.
 *  - What WANTS a decision: a SECTION boundary (the committed `songSection.changeCount` when the structure read is
 *    valid; otherwise a debounced fast phrase-change event), remembered as `pending` until the dwell clears; or the
 *    staleness backstop at a phrase edge (`maxOnBeats` since the last decision while engaged, `maxOffBeats` while off,
 *    so an effect can still ARRIVE in a passage with no section boundary at all).
 *  - The choice is deterministic per (section, mood): the seed is a function of the section counter, the mood and how
 *    many times this section has already been re-decided, so a recorded set replays and the same section does not
 *    flip repeatedly. The mood does not TRIGGER a decision (it only seeds one), so a primary mood flapping between
 *    two neighbours cannot flicker the fold.
 *
 * The bridge calls {@link commitMirrorDecision} with what it actually chose, which is what starts the dwell clocks.
 */

export const MIRROR_GATE = {
  /** An engaged mirror holds at least this many beats (~16 s at 120 BPM) before anything may change it. */
  minOnBeats: 32,
  /** A disengaged mirror rests at least this many beats before it may engage again. */
  minOffBeats: 16,
  /** No two changes (on, off, reshape) are ever closer than this. */
  minChangeBeats: 16,
  /** An engaged mirror is re-decided at the next phrase edge once this many beats have passed since the last decision. */
  maxOnBeats: 64,
  /** A disengaged mirror is re-decided at a phrase edge once this many beats have passed since the last decision. */
  maxOffBeats: 32,
  /** Fast phrase-change events closer than this many beats count as ONE section boundary (structure read invalid). */
  sectionDebounceBeats: 16,
  /** Cap on the per-section re-decision counter that is folded into the seed. */
  redecideCap: 7,
} as const

/**
 * A RESHAPE (a different mode or segment count while engaged, or an engage while the previous fold is still fading
 * out) never snaps: the fold fades out on its old shape, and the new one is installed only once the mix is below this.
 */
export const MIRROR_SWAP_MIX = 0.08

export interface MirrorGateState {
  /** The last COMMITTED decision engaged the mirror (`mode !== 'off'`). */
  engaged: boolean
  /** Beat of the last change (engage, disengage or reshape); -Infinity = never. */
  lastChangeBeat: number
  /** Beat of the last decision of any kind (even one that changed nothing); -Infinity = never. */
  lastDecisionBeat: number
  /** Our own section counter (feeds the seed). */
  sections: number
  /** Decisions taken inside the current section (feeds the seed, capped). */
  redecides: number
  /** The committed-section counter last seen from the tracker (structure read valid). */
  lastSectionCount: number
  /** Beat of the last fast phrase-change event counted as a boundary. */
  lastFastBeat: number
  /** A section boundary is waiting for the dwell to clear. */
  pending: boolean
  /** Newest beat seen: a smaller one means a new source / a rewound counter. */
  lastBeat: number
}

export function createMirrorGate(): MirrorGateState {
  return {
    engaged: false,
    lastChangeBeat: Number.NEGATIVE_INFINITY,
    lastDecisionBeat: Number.NEGATIVE_INFINITY,
    sections: 0,
    redecides: 0,
    lastSectionCount: -1,
    lastFastBeat: Number.NEGATIVE_INFINITY,
    pending: false,
    lastBeat: Number.NEGATIVE_INFINITY,
  }
}

/** Everything one frame tells the gate. */
export interface MirrorGateInput {
  /** `f.beatIndex`. */
  beat: number
  /** `f.beat`: this frame is a beat crossing. Decisions are taken only here. */
  beatEdge: boolean
  /** `isPhraseEdge(...)`: the staleness backstop is only evaluated here. */
  phraseEdge: boolean
  /** `f.sectionChange`: the fast, noisy phrase-novelty flag (used only while the structure read is invalid). */
  fastSectionChange: boolean
  /** `f.structureValid`. */
  structureValid: boolean
  /** `f.songSection.changeCount`: committed section boundaries so far. */
  sectionCount: number
  /** A small stable integer for the current mood (the profile's primary, or the legacy state). */
  moodKey: number
}

export type MirrorGateAction = { decide: false } | { decide: true; seed: number }

const NO_DECISION: MirrorGateAction = { decide: false }

function finite(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback
}

/** The deterministic seed for a decision: a pure function of (section, mood, re-decision index). Never negative. */
export function mirrorSeedFor(section: number, moodKey: number, redecide: number): number {
  const s = Math.max(0, Math.trunc(finite(section, 0)))
  const m = Math.max(0, Math.trunc(finite(moodKey, 0)))
  const r = Math.min(MIRROR_GATE.redecideCap, Math.max(0, Math.trunc(finite(redecide, 0))))
  return (s * 64 + m) * (MIRROR_GATE.redecideCap + 1) + r
}

/** Has the dwell cleared, i.e. may ANY change happen at `beat`? */
export function mirrorDwellCleared(st: MirrorGateState, beat: number): boolean {
  const since = beat - st.lastChangeBeat
  const need = Math.max(MIRROR_GATE.minChangeBeats, st.engaged ? MIRROR_GATE.minOnBeats : MIRROR_GATE.minOffBeats)
  return since >= need
}

/** Reset to a fresh gate (a new source, or a rewound beat counter). Nothing from the old track may leak. */
export function resetMirrorGate(st: MirrorGateState): void {
  Object.assign(st, createMirrorGate())
}

/**
 * Advance one frame. Mutates `st`. Returns `{ decide: true, seed }` on the frame the caller should take a mirror
 * decision (and then report it with {@link commitMirrorDecision}); otherwise `{ decide: false }`.
 */
export function stepMirrorGate(st: MirrorGateState, i: MirrorGateInput): MirrorGateAction {
  const beat = i.beat
  if (!Number.isFinite(beat)) return NO_DECISION
  if (beat < st.lastBeat) resetMirrorGate(st)
  st.lastBeat = beat

  // --- Section boundaries: counted every frame (they must not be missed while the dwell blocks a decision). ----
  if (i.structureValid) {
    const count = finite(i.sectionCount, st.lastSectionCount)
    if (st.lastSectionCount < 0) {
      st.lastSectionCount = count // the first valid read is a baseline, not a boundary
    } else if (count !== st.lastSectionCount) {
      st.lastSectionCount = count
      st.sections++
      st.redecides = 0
      st.pending = true
    }
  } else {
    st.lastSectionCount = -1 // re-baseline when the structure read (re)appears
    if (i.fastSectionChange && beat - st.lastFastBeat >= MIRROR_GATE.sectionDebounceBeats) {
      st.lastFastBeat = beat
      st.sections++
      st.redecides = 0
      st.pending = true
    }
  }

  // --- Decisions happen on beats only, and only when the dwell has cleared. --------------------------------------
  if (!i.beatEdge || !mirrorDwellCleared(st, beat)) return NO_DECISION

  // Decisions themselves are rate-limited too: a same-state decision changes nothing, so the dwell alone would let
  // a stream of section boundaries re-roll the fold (and ratchet its habituation) on every beat once the hold cleared.
  const sinceDecision = beat - st.lastDecisionBeat
  if (sinceDecision < MIRROR_GATE.minChangeBeats) return NO_DECISION
  const stale =
    i.phraseEdge && sinceDecision >= (st.engaged ? MIRROR_GATE.maxOnBeats : MIRROR_GATE.maxOffBeats)
  if (!st.pending && !stale) return NO_DECISION

  return { decide: true, seed: mirrorSeedFor(st.sections, i.moodKey, st.redecides) }
}

/** The two fields of a mirror look that decide whether a change of look is a RESHAPE. */
export interface MirrorShape {
  mode: string
  segments: number
}

/** How to install a freshly chosen look. */
export interface MirrorInstallPlan<T extends MirrorShape> {
  /** What the eased target should be NOW (`off` while a reshape dips: `mix` fades the old shape out). */
  target: T
  /** The look to install once the fold has faded out, or null. */
  pending: T | null
  /** An already-engaged fold got a different shape (mode or segment count). */
  reshaped: boolean
}

/**
 * Decide how a chosen look is installed. `prev` is the look in force (the pending one when a reshape is already
 * waiting), `chosen` the new one, `off` the inert look, `mix` the fold's CURRENT visibility.
 *
 *  - chosen is off: install it (the fold fades out through `mix`; its shape is held while it does).
 *  - an engaged fold gets a different mode / segment count, or an engage arrives while the last fold is still
 *    visibly fading: dip. Target `off` now, the new look pending until `mix` is below {@link MIRROR_SWAP_MIX}.
 *  - anything else (fresh engage from nothing, or the same shape with new twist / spin): install directly; the
 *    continuous half eases.
 */
export function planMirrorInstall<T extends MirrorShape>(prev: T, chosen: T, off: T, mix: number): MirrorInstallPlan<T> {
  const engaged = chosen.mode !== 'off'
  const reshaped = engaged && prev.mode !== 'off' && (prev.mode !== chosen.mode || prev.segments !== chosen.segments)
  const stillFading = engaged && prev.mode === 'off' && finite(mix, 0) >= MIRROR_SWAP_MIX
  if (reshaped || stillFading) return { target: off, pending: chosen, reshaped }
  return { target: chosen, pending: null, reshaped: false }
}

/** May a pending reshape be installed now? Once the old fold is nearly gone, or an excluded scene zeroed it. */
export function mirrorSwapReady(mix: number, suppressed: boolean): boolean {
  return suppressed || finite(mix, 0) < MIRROR_SWAP_MIX
}

/**
 * Report what the bridge chose for the decision {@link stepMirrorGate} asked for. `engaged` is whether the chosen
 * mirror is on; `reshaped` is whether an already-engaged mirror got a different shape (mode or segment count).
 * Starts the dwell clocks: only a real CHANGE (on <-> off, or a reshape) restarts the hold, but every decision
 * restarts the staleness clock and clears `pending`.
 */
export function commitMirrorDecision(st: MirrorGateState, engaged: boolean, reshaped: boolean, beat: number): void {
  const b = finite(beat, st.lastBeat)
  st.pending = false
  st.lastDecisionBeat = b
  st.redecides = Math.min(MIRROR_GATE.redecideCap, st.redecides + 1)
  if (engaged !== st.engaged || (engaged && reshaped)) st.lastChangeBeat = b
  st.engaged = engaged
}

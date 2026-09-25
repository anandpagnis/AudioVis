/**
 * The music-event vocabulary: WHAT happened in the music, kept apart from what the show does about it.
 *
 * Producers (today `legacyEvents.ts`, which maps the old `sectionChange` / `songSection` / `drop` signals; later the
 * bar-synchronous live detector) emit `SectionEvent`s; the pure show director (`engine/show/showDirector.ts`) is the
 * only consumer that decides WHEN the visuals change. Types only: no runtime code, no imports.
 *
 * ## Delivery contract
 *  - Times and beats are on the running beat counter (`AudioFeatures.beatIndex`) and the audio clock
 *    (`AudioFeatures.time`); `boundaryBeat` / `boundaryTime` are where the change musically BEGAN (bar-aligned when the
 *    source knows the grid, and possibly in the past), `detectedAt*` is when the source knew.
 *  - A source may RE-DELIVER an event with the same `id` and revised (never smaller) fields, when a second signal for
 *    the same physical change arrives within a couple of beats (merging, not double-counting). A consumer treats the
 *    last delivery per `id` as authoritative and must not act twice on one `id`.
 */

/**
 *  - `change`     a section/feature change (verse -> chorus, timbre or harmony shift).
 *  - `drop`       the release after a build / breakdown: bass returns.
 *  - `buildStart` a riser begins. Arms and applies pressure; never cuts by itself.
 *  - `breakdown`  the music strips back (entering a breakdown).
 *  - `fill`       a drum fill / transient flourish. Punctuation only.
 *  - `gain`       a uniform level shift (volume knob): suppressed, never a scene change.
 */
export type EventType = 'change' | 'drop' | 'buildStart' | 'breakdown' | 'fill' | 'gain'

/** Per-channel contributions to the change score (z-scores), used to pick WHAT to vary. All 0 = not reported. */
export interface EventFeats {
  level: number
  low: number
  timbre: number
  harmony: number
  rhythm: number
}

export interface SectionEvent {
  id: number
  type: EventType
  /** 0..1, calibrated so that a typical real section change is ~0.6 and a big one approaches 1. */
  strength: number
  /** 0..1, how sure the source is that this is a real event. */
  confidence: number
  /** Where the change musically begins, on the beat counter and the audio clock (may be in the future for plans). */
  boundaryBeat: number
  boundaryTime: number
  /** When the source knew. */
  detectedAtBeat: number
  detectedAtTime: number
  source: 'live' | 'plan' | 'legacy'
  /** Phase of `boundaryBeat` on the source's bar grid (0..3, 0 = the bar line). */
  phase: number
  feats: EventFeats
  /** Return to earlier material: the beat it resembles and how closely (0..1). */
  sim?: { boundaryBeat: number; similarity: number }
  /**
   * OPTIONAL addition beyond the plan's model: a second, independent signal reported this same change within a
   * couple of beats (set by the source when it merges them). Lets the director trust a drop it would otherwise gate.
   */
  corroborated?: boolean
}

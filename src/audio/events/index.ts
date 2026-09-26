/**
 * The live event layer (`?events=v2`). See `EventLayer.ts` for the design; this barrel is what the engine and the show
 * adapter import.
 */
export { RAW_CHANNELS, RAW_DB_FLOOR, RawTap, linToDb } from './rawTap'
export { BarGrid, DEFAULT_BAR_GRID, type BarGridConfig, type BeatPrior } from './barGrid'
export { ChangeScorer, DEFAULT_SCORER, type Candidate, type ScorerConfig } from './changeScorer'
export {
  DEFAULT_EVENT_LAYER,
  EventLayer,
  STRENGTH_ANCHORS,
  strengthOf,
  type DownbeatHint,
  type EventLayerConfig,
  type EventLayerStats,
} from './EventLayer'
export type { EventFeats, EventType, SectionEvent } from './types'
export { MUX, keepLegacyDrop, maskLegacyInputForV2, mergeLiveWithLegacy } from './eventMux'
export { DEFAULT_GAP_DROP, GapDropDetector, type GapDropConfig, type GapDropFire } from './gapDrop'
export { DEFAULT_PHRASE_PRIOR, PhrasePrior, type PhraseEstimate, type PhrasePriorConfig } from './phrasePrior'

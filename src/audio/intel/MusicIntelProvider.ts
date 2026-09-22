import type { BpmEstimator } from '../BpmEstimator'
import type { EssentiaStatus } from '../essentia/EssentiaBridge'
import type { StructureRaw } from '../essentia/structureProtocol'
import type { StructureStatus } from '../essentia/StructureBridge'
import type { VoiceStatus } from '../essentia/VoiceBridge'
import type { AudioFeatures } from '../types'

/**
 * The seam between `AudioEngine` and the heavyweight "music intelligence"
 * analysers: model tempo / beat-grid hints, musical key + scale, song
 * structure, and the voice / mood tags.
 *
 * Why it exists (licensing): the only implementation today wraps Essentia.js,
 * which is AGPL-3.0, and the MusiCNN weights it feeds are CC BY-NC-SA 4.0 -
 * neither can ship in a commercial build. `AudioEngine` therefore talks to this
 * interface only, and the concrete provider is chosen once by
 * `createMusicIntelProvider()` (./index.ts) behind the `VITE_ENABLE_ESSENTIA`
 * build flag. With the flag off the Essentia code is not merely disabled but
 * never bundled.
 *
 * The interface mirrors, one for one, what `AudioEngine` did against the three
 * bridges before this seam existed - the method boundaries are the original
 * call sites, so the per-frame ordering (rhythm -> voice -> ... -> structure)
 * is unchanged. Every method must be safe to call in any order, never throw,
 * and be allocation-free on the per-frame path except when dispatching a job.
 *
 * A provider only ever WRITES these `AudioFeatures` fields, and only when it
 * has a fresh read; otherwise they keep the `createEmptyFeatures()` defaults:
 *   tempo/beat-grid  -> `bpm.setModelTempo(...)` (a hint, not `f.bpm` directly)
 *                       and `f.danceability`
 *   key + scale      -> `f.key`, `f.scale`, `f.keyConfidence` (otherwise the
 *                       clean-room `ChromaKeyEstimator` in AudioEngine fills them)
 *   voice + mood     -> `f.vocalPresence`, `f.moods`, `f.moodsValid === false`
 *   structure        -> returns a `StructureRaw` (consumed by `SectionTracker`);
 *                       `f.structureValid` stays false without one
 */
export interface MusicIntelProvider {
  /** Stable identifier, for logs and the debug overlay. */
  readonly id: 'null' | 'essentia'

  /**
   * True when this provider can produce reads. `false` means every read is a
   * permanent no-op and consumers must rely on their built-in fallbacks
   * (`f.moodsValid === false`, `f.structureValid === false`; key/scale come
   * from the clean-room estimator).
   */
  readonly enabled: boolean

  /**
   * Live status objects of the underlying analysers, for the debug/analytics
   * panels; `null` when `enabled` is false. The objects are mutated in place
   * (never replaced), so a reference can be held and polled.
   */
  readonly status: MusicIntelStatus | null

  /**
   * Tap PCM off the freshly built audio graph and start the analysers.
   * Fire-and-forget: resolves once the tap is wired, never rejects, and a
   * failure just leaves the built-in estimators in charge.
   */
  attach(ctx: AudioContext, source: AudioNode): Promise<void>

  /** Drop buffered PCM and any pending / in-flight job (source change or stop). */
  detach(): void

  /**
   * Tempo / beat-grid hints + key + danceability: drain any finished read onto
   * `f` / the estimator, then schedule the next job. Call before
   * `bpm.update()` so this frame's grid already reflects a fresh read.
   */
  updateRhythm(f: AudioFeatures, bpm: BpmEstimator): void

  /** Voice / mood tags: drain any finished read onto `f`, schedule the next. */
  updateVoice(f: AudioFeatures): void

  /** A section boundary passed - the key may have changed; re-read it soon. */
  requestKey(): void

  /**
   * Song structure. Returns the freshly-arrived segmentation on the frame it
   * lands, else `null` (the common case). `SectionTracker` latches it.
   */
  updateStructure(f: AudioFeatures): StructureRaw | null
}

export interface MusicIntelStatus {
  rhythm: EssentiaStatus
  voice: VoiceStatus
  structure: StructureStatus
}

/**
 * Provider used whenever the Essentia build flag is off (the default, and the
 * only option in a commercial build). Everything is a no-op; the features keep
 * their idle defaults and the built-in estimators run alone.
 */
export class NullProvider implements MusicIntelProvider {
  readonly id = 'null' as const
  readonly enabled = false
  readonly status = null

  attach(): Promise<void> {
    return Promise.resolve()
  }

  detach(): void {}

  updateRhythm(): void {}

  updateVoice(): void {}

  requestKey(): void {}

  updateStructure(): StructureRaw | null {
    return null
  }
}

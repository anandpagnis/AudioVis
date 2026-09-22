import type { BpmEstimator } from '../BpmEstimator'
import { essentiaBridge } from '../essentia/EssentiaBridge'
import { structureBridge } from '../essentia/StructureBridge'
import { voiceBridge } from '../essentia/VoiceBridge'
import type { StructureRaw } from '../essentia/structureProtocol'
import type { AudioFeatures } from '../types'
import type { MusicIntelProvider, MusicIntelStatus } from './MusicIntelProvider'

/**
 * Essentia.js + MusiCNN implementation of `MusicIntelProvider`.
 *
 * LICENCE: essentia.js is AGPL-3.0 and the MusiCNN weights in `public/models`
 * are CC BY-NC-SA 4.0. This module - and therefore the three workers below,
 * which are the only importers of essentia.js - must never be reachable from a
 * commercial build. It is loaded exclusively through the dynamic `import()` in
 * `./index.ts`, gated on `VITE_ENABLE_ESSENTIA`; keep it that way (no static
 * import of this file anywhere). `scripts/check-dist-licences.mjs` enforces it.
 *
 * Behaviour is deliberately identical to the pre-provider `AudioEngine`: this is
 * a thin delegate over the existing bridge singletons, no re-tuning.
 *
 * The `new Worker(new URL(...))` calls live HERE (not in the bridges) because
 * Vite bundles a worker at exactly that expression; the bridges are imported
 * statically by the debug panels and must stay worker-free.
 */

const rhythmWorker = () =>
  new Worker(new URL('../essentia/essentia.worker.ts', import.meta.url), { type: 'module' })
const voiceWorker = () =>
  new Worker(new URL('../essentia/voice.worker.ts', import.meta.url), { type: 'module' })
const structureWorker = () =>
  new Worker(new URL('../essentia/structure.worker.ts', import.meta.url), { type: 'module' })

export class EssentiaProvider implements MusicIntelProvider {
  readonly id = 'essentia' as const
  readonly enabled = true
  readonly status: MusicIntelStatus = {
    rhythm: essentiaBridge.status,
    voice: voiceBridge.status,
    structure: structureBridge.status,
  }

  constructor() {
    essentiaBridge.setWorkerFactory(rhythmWorker)
    voiceBridge.setWorkerFactory(voiceWorker)
    structureBridge.setWorkerFactory(structureWorker)
  }

  attach(ctx: AudioContext, source: AudioNode): Promise<void> {
    return essentiaBridge.attach(ctx, source)
  }

  detach(): void {
    essentiaBridge.detach()
  }

  updateRhythm(f: AudioFeatures, bpm: BpmEstimator): void {
    essentiaBridge.update(f, bpm)
  }

  updateVoice(f: AudioFeatures): void {
    voiceBridge.update(f)
  }

  requestKey(): void {
    essentiaBridge.requestKey()
  }

  updateStructure(f: AudioFeatures): StructureRaw | null {
    return structureBridge.update(f)
  }
}

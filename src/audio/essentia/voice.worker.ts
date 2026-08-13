/// <reference lib="webworker" />
/**
 * Voice / mood classification worker: MusiCNN embeddings + five tiny heads.
 *
 * Separate from the rhythm worker on purpose. That one self-throttles from its
 * own measured job time, so sharing a queue would let a ~450 ms classification
 * inflate the tempo cadence and stall the beat grid.
 *
 * Backend is WASM, never WebGL: in a worker WebGL means OffscreenCanvas
 * contending with the render thread for the GPU that has to hold 60 fps.
 * Classification runs at a section cadence, so CPU inference is a cheap trade.
 *
 * Everything here fails soft — a missing model directory or an unsupported
 * backend reports an error and the feature simply stays at its default.
 */
import * as tf from '@tensorflow/tfjs-core'
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import '@tensorflow/tfjs-backend-wasm'
import type { MoodScores, VoiceRequest, VoiceResponse } from './voiceProtocol'

// MusiCNN's declared input rate — NOT the 44.1 kHz the Essentia DSP
// algorithms assume. Feeding it 44.1 k silently degrades every prediction.
const MODEL_SR = 16000
const FRAME = 512
const HOP = 256
const PATCH_FRAMES = 187 // ~3.0 s of audio per inference
const MEL_BANDS = 96

/**
 * Softmax decision boundary for "this patch contains voice".
 *
 * 0.5 is the head's own boundary and measured cleanly on the labelled set:
 * silence 0.26, white noise 0.16, percussion-only 0.21 all sit well below it,
 * while vocal tracks reach 0.95-1.00 on their vocal patches.
 */
const VOICE_THRESHOLD = 0.5

const MODEL_BASE = '/models'
const EMBEDDING_MODEL = 'msd-musicnn-1'
/** The embeddings node. `model/Sigmoid` is MusiCNN's own 50-tag autotagging
 * output and is NOT what the heads consume. */
const EMBEDDING_NODE = 'model/dense/BiasAdd'
const HEAD_NODE = 'model/Softmax'

/**
 * Heads, with the index of the POSITIVE class taken from each model's own
 * metadata.
 *
 * These are not consistent, and getting one wrong silently inverts the signal
 * with no error anywhere: `mood_happy` is [happy, non_happy] (positive at 0)
 * but `mood_party` is [non_party, party] (positive at 1). Verified against the
 * `classes` array in each published .json — do not "tidy" these to a constant.
 */
const HEADS = [
  { key: 'voice', dir: 'voice_instrumental-msd-musicnn-1', classes: ['instrumental', 'voice'], positive: 1 },
  { key: 'happy', dir: 'mood_happy-msd-musicnn-1', classes: ['happy', 'non_happy'], positive: 0 },
  { key: 'aggressive', dir: 'mood_aggressive-msd-musicnn-1', classes: ['aggressive', 'not_aggressive'], positive: 0 },
  { key: 'party', dir: 'mood_party-msd-musicnn-1', classes: ['non_party', 'party'], positive: 1 },
  { key: 'relaxed', dir: 'mood_relaxed-msd-musicnn-1', classes: ['non_relaxed', 'relaxed'], positive: 1 },
] as const

type HeadKey = (typeof HEADS)[number]['key']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EssentiaInstance = any

let essentia: EssentiaInstance = null
let embedder: GraphModel | null = null
const heads = new Map<HeadKey, GraphModel>()
let loading: Promise<void> | null = null
let missing = false

async function loadAll(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      // Essentia WASM supplies TensorflowInputMusiCNN — the exact mel
      // parametrisation the model was trained on. Reimplementing it in JS
      // would be a silent accuracy regression, so we pay for a second
      // instance here rather than share the rhythm worker's.
      const [wasmMod, coreMod] = await Promise.all([
        import('essentia.js/dist/essentia-wasm.es.js'),
        import('essentia.js/dist/essentia.js-core.es.js'),
      ])
      const wasmExport = wasmMod.EssentiaWASM ?? wasmMod.default
      const wasm = typeof wasmExport === 'function' ? await wasmExport() : wasmExport
      const EssentiaCtor = coreMod.default ?? coreMod.Essentia
      essentia = new EssentiaCtor(wasm)

      setWasmPaths('/tfjs/')
      await tf.setBackend('wasm')
      await tf.ready()

      embedder = await loadGraphModel(`${MODEL_BASE}/${EMBEDDING_MODEL}/model.json`)
      for (const h of HEADS) {
        heads.set(h.key, await loadGraphModel(`${MODEL_BASE}/${h.dir}/model.json`))
      }
    })().catch((err) => {
      // A 404 means the weights were never fetched (they are gitignored).
      // Flag it so the bridge stops asking instead of retrying every section.
      const msg = err instanceof Error ? err.message : String(err)
      if (/404|not found|failed to fetch/i.test(msg)) missing = true
      loading = null
      throw err
    })
  }
  return loading
}

/** Linear resample to MusiCNN's 16 kHz. */
function resample(pcm: Float32Array, fromRate: number): Float32Array {
  if (fromRate === MODEL_SR) return pcm
  const outLen = Math.floor((pcm.length * MODEL_SR) / fromRate)
  const out = new Float32Array(outLen)
  const step = fromRate / MODEL_SR
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(pcm.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac
  }
  return out
}

/** One 187x96 log-mel patch, flattened. */
function melPatch(sig: Float32Array, patchIndex: number): Float32Array {
  const flat = new Float32Array(PATCH_FRAMES * MEL_BANDS)
  for (let i = 0; i < PATCH_FRAMES; i++) {
    const start = (patchIndex * PATCH_FRAMES + i) * HOP
    const v = essentia.arrayToVector(sig.subarray(start, start + FRAME))
    try {
      const r = essentia.TensorflowInputMusiCNN(v)
      const bands: Float32Array = essentia.vectorToArray(r.bands)
      flat.set(bands.subarray(0, MEL_BANDS), i * MEL_BANDS)
      r.bands?.delete?.()
    } finally {
      v?.delete?.()
    }
  }
  return flat
}

function classify(patch: Float32Array): Record<HeadKey, number> {
  const x = tf.tensor(patch, [1, PATCH_FRAMES, MEL_BANDS])
  // Placeholder_1 is MusiCNN's batch-norm is_training flag. Omitting it fails
  // outright with "Input tensor count mismatch"; it must be false.
  const training = tf.scalar(false, 'bool')
  const emb = embedder!.execute(
    { 'model/Placeholder': x, 'model/Placeholder_1': training },
    EMBEDDING_NODE,
  ) as tf.Tensor
  const out = {} as Record<HeadKey, number>
  for (const h of HEADS) {
    const model = heads.get(h.key)
    if (!model) {
      out[h.key] = 0
      continue
    }
    const probs = model.execute(emb, HEAD_NODE) as tf.Tensor
    const data = probs.dataSync()
    out[h.key] = data[h.positive]
    probs.dispose()
  }
  x.dispose()
  training.dispose()
  emb.dispose()
  return out
}

self.onmessage = async (e: MessageEvent<VoiceRequest>) => {
  const req = e.data
  try {
    await loadAll()
    const sig = resample(req.pcm, req.sampleRate)
    const nFrames = Math.floor((sig.length - FRAME) / HOP) + 1
    const nPatches = Math.floor(nFrames / PATCH_FRAMES)
    if (nPatches < 1) throw new Error('window shorter than one patch')

    const tMel = performance.now()
    const patches: Float32Array[] = []
    for (let p = 0; p < nPatches; p++) patches.push(melPatch(sig, p))
    const melMs = performance.now() - tMel

    const tInf = performance.now()
    const results = patches.map(classify)
    const inferMs = performance.now() - tInf

    const probs = results.map((r) => r.voice)
    // Fraction over threshold, never a mean: vocals enter and leave, so a
    // track with a 30 s instrumental intro averages down to "instrumental"
    // even when it is plainly a vocal track. Measured directly — averaging
    // scored 5/8 on the labelled set where this scores 7/8.
    const voiceFraction = probs.filter((p) => p > VOICE_THRESHOLD).length / probs.length
    const mean = (k: HeadKey) => results.reduce((a, r) => a + r[k], 0) / results.length
    const moods: MoodScores = {
      // Moods ARE sustained character rather than intermittent events, so the
      // mean is the right aggregation here — the opposite of voice above.
      happy: mean('happy'),
      aggressive: mean('aggressive'),
      party: mean('party'),
      relaxed: mean('relaxed'),
    }

    const out: VoiceResponse = {
      id: req.id,
      type: 'voice',
      voiceFraction,
      patchProbs: probs,
      moods,
      melMs,
      inferMs,
    }
    self.postMessage(out)
  } catch (err) {
    const out: VoiceResponse = {
      id: req.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      missing,
    }
    self.postMessage(out)
  }
}

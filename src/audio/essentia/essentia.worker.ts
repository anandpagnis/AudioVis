/// <reference lib="webworker" />
/**
 * Dedicated worker hosting the Essentia WASM core. The WASM (~2.5 MB) loads
 * lazily on the first job, entirely off the render thread; the main bundle
 * never imports essentia.js. See protocol.ts for the message contract.
 */
import type { EssentiaRequest, EssentiaResponse, RhythmMethod } from './protocol'

const ESSENTIA_SR = 44100 // RhythmExtractor2013 hard-assumes 44.1 kHz
/** Essentia documents the multifeature confidence scale as 0..5.32. */
const CONFIDENCE_RAW_MAX = 5.32
/**
 * Default beat-tracking method.
 *
 * Measured on synthetic click tracks (12 s windows, 82/96/120/140 BPM):
 * degara and multifeature agree to within 0.1 BPM on every case, but degara
 * costs ~190 ms against multifeature's ~950 ms. Multifeature's only advantage
 * is that it reports a confidence — and that confidence turned out to be
 * poorly calibrated for our purpose: 12 s of pure white noise scored 3.83/5.32
 * (≈0.72 "confident") with a meaningless 126 BPM. So we take the cheap method
 * and let BpmEstimator's own grid-fit/hitScore measure supply reliability,
 * which does collapse on non-rhythmic input.
 */
const DEFAULT_METHOD: RhythmMethod = 'degara'

// The Essentia JS API is untyped upstream; keep the escape hatch local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EssentiaInstance = any

let essentia: EssentiaInstance = null
let loading: Promise<void> | null = null
const method: RhythmMethod = DEFAULT_METHOD

function loadEssentia(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const [wasmMod, coreMod] = await Promise.all([
        import('essentia.js/dist/essentia-wasm.es.js'),
        import('essentia.js/dist/essentia.js-core.es.js'),
      ])
      const wasmExport = wasmMod.EssentiaWASM ?? wasmMod.default
      // The web builds ship both factory-function and pre-initialized shapes.
      const wasm = typeof wasmExport === 'function' ? await wasmExport() : wasmExport
      const EssentiaCtor = coreMod.default ?? coreMod.Essentia
      essentia = new EssentiaCtor(wasm)
    })()
  }
  return loading
}

/** Linear resample — adequate for rhythm features, avoids shipping a DSP lib. */
function resampleTo441(pcm: Float32Array, fromRate: number): Float32Array {
  if (fromRate === ESSENTIA_SR) return pcm
  const outLen = Math.floor((pcm.length * ESSENTIA_SR) / fromRate)
  const out = new Float32Array(outLen)
  const step = fromRate / ESSENTIA_SR
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(pcm.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac
  }
  return out
}

function analyzeRhythm(pcm: Float32Array, sampleRate: number, useMethod: RhythmMethod) {
  const signal = resampleTo441(pcm, sampleRate)
  const vector = essentia.arrayToVector(signal)
  try {
    const t0 = performance.now()
    const res = essentia.RhythmExtractor2013(vector, 208, useMethod, 40)
    const ms = performance.now() - t0
    const bpm: number = res.bpm
    const confidence01 =
      useMethod === 'multifeature'
        ? Math.max(0, Math.min(1, res.confidence / CONFIDENCE_RAW_MAX))
        : 0
    // VectorFloat outputs are WASM-heap objects — free them or leak the heap.
    res.ticks?.delete?.()
    res.estimates?.delete?.()
    res.bpmIntervals?.delete?.()
    return { bpm, confidence01, ms }
  } finally {
    vector?.delete?.()
  }
}

function analyzeKey(pcm: Float32Array, sampleRate: number) {
  const signal = resampleTo441(pcm, sampleRate)
  const vector = essentia.arrayToVector(signal)
  try {
    const t0 = performance.now()
    // All-default parameters except the sample rate we just resampled to.
    // `strength` is the correlation of the winning profile, already 0..1.
    const res = essentia.KeyExtractor(
      vector,
      true, // averageDetuningCorrection
      4096, // frameSize
      4096, // hopSize
      12, // hpcpSize
      3500, // maxFrequency
      60, // maximumSpectralPeaks
      25, // minFrequency
      0.2, // pcpThreshold
      'bgate', // profileType
      ESSENTIA_SR,
    )
    return {
      key: String(res.key ?? ''),
      scale: String(res.scale ?? ''),
      strength: Number(res.strength ?? 0),
      ms: performance.now() - t0,
    }
  } finally {
    vector?.delete?.()
  }
}

function analyzeDanceability(pcm: Float32Array, sampleRate: number) {
  const signal = resampleTo441(pcm, sampleRate)
  const vector = essentia.arrayToVector(signal)
  try {
    const t0 = performance.now()
    // Defaults: maxTau 8800 ms, minTau 310 ms — so the window must be ≥ ~8.8 s
    // for the longest segment length to be measurable at all. The bridge only
    // ever sends full 12 s windows.
    const res = essentia.Danceability(vector, 8800, 310, ESSENTIA_SR, 1.1)
    const ms = performance.now() - t0
    const danceability = Number(res.danceability ?? 0)
    res.dfa?.delete?.() // DFA exponent vector lives on the WASM heap
    return { danceability, ms }
  } finally {
    vector?.delete?.()
  }
}

self.onmessage = async (e: MessageEvent<EssentiaRequest>) => {
  const req = e.data
  try {
    await loadEssentia()
    let out: EssentiaResponse
    if (req.type === 'rhythm' || req.type === 'rhythm-hq') {
      const useMethod: RhythmMethod = req.type === 'rhythm-hq' ? 'multifeature' : method
      const { bpm, confidence01, ms } = analyzeRhythm(req.pcm, req.sampleRate, useMethod)
      out = { id: req.id, type: 'rhythm', bpm, confidence01, method: useMethod, ms }
    } else if (req.type === 'key') {
      const { key, scale, strength, ms } = analyzeKey(req.pcm, req.sampleRate)
      out = { id: req.id, type: 'key', key, scale, strength, ms }
    } else {
      const { danceability, ms } = analyzeDanceability(req.pcm, req.sampleRate)
      out = { id: req.id, type: 'danceability', danceability, ms }
    }
    self.postMessage(out)
  } catch (err) {
    const out: EssentiaResponse = {
      id: req.id,
      type: 'error',
      job: req.type ?? 'unknown',
      message: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(out)
  }
}

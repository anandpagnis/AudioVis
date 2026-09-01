/// <reference lib="webworker" />
/**
 * Song-structure worker: beat-synchronous HPCP + MFCC + scalar features →
 * `structureDsp` self-similarity segmentation + riser read.
 *
 * Essentia WASM only — NO tf. A second essentia instance (like
 * `voice.worker.ts`'s), so a ~10-30 ms segmentation can never delay the beat
 * grid. Fails soft: WASM load failure reports `{missing:true}` and the bridge
 * disables permanently; the built-in `PhraseDetector` / `f.sectionChange` keep
 * running.
 *
 * The O(n²) SSM is bounded by folding raw ~4 Hz frames into BEAT cells
 * (≤ ~320 of them for a 120 s window), so the matrices stay ~100 k cells.
 */
import { segment, riserScore, type BeatCell } from './structureDsp'
import type { StructureRequest, StructureResponse, StructureSegment } from './structureProtocol'
import { resample as sincResample } from './resample'

const ESSENTIA_SR = 22050 // enough harmonic content for HPCP, half the data of 44.1k
const FRAME = 4096
const HOP = Math.round(ESSENTIA_SR * 0.25) // ~4 raw frames/s, folded into beats
const MFCC_COEFFS = 13
const HPCP_SIZE = 12

// The Essentia JS API is untyped upstream.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EssentiaInstance = any
let essentia: EssentiaInstance = null
let loading: Promise<void> | null = null
let missing = false

function loadEssentia(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const [wasmMod, coreMod] = await Promise.all([
        import('essentia.js/dist/essentia-wasm.es.js'),
        import('essentia.js/dist/essentia.js-core.es.js'),
      ])
      const wasmExport = wasmMod.EssentiaWASM ?? wasmMod.default
      const wasm = typeof wasmExport === 'function' ? await wasmExport() : wasmExport
      const EssentiaCtor = coreMod.default ?? coreMod.Essentia
      essentia = new EssentiaCtor(wasm)
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (/404|not found|failed to fetch|import/i.test(msg)) missing = true
      loading = null
      throw err
    })
  }
  return loading
}

/**
 * Resample the capture-rate window to 22.05 kHz. Kaiser-windowed-sinc polyphase
 * (see `resample.ts`); the old 2-tap linear version aliased content above
 * 11 kHz back into the MFCC / HPCP range the segmenter reads. This is the
 * longest window (120 s) so it is also the priciest resample — ~139 taps per
 * output — but it runs once per structure job and StructureBridge's cadence
 * self-tunes off the measured job cost. Returns `pcm` untouched at 22.05 k.
 */
function resample(pcm: Float32Array, fromRate: number): Float32Array {
  return sincResample(pcm, fromRate, ESSENTIA_SR)
}

interface RawFrame {
  hpcp: number[]
  mfcc: number[]
  centroid: number
  flatness: number
  flux: number
  logRms: number
  air: number
  sub: number
  bass: number
}

/**
 * One windowed frame → the raw feature bundle plus its linear magnitude
 * spectrum (the caller feeds it back as `prevSpec` for the next frame's flux).
 */
function analyzeFrame(
  sig: Float32Array,
  start: number,
  prevSpec: Float32Array | null,
): { frame: RawFrame; spec: Float32Array } {
  const slice = sig.subarray(start, start + FRAME)
  const frameVec = essentia.arrayToVector(slice)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let windowed: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spec: any = null
  try {
    windowed = essentia.Windowing(frameVec, true, FRAME, 'hann')
    spec = essentia.Spectrum(windowed.frame)
    const specArr: Float32Array = essentia.vectorToArray(spec.spectrum).slice()

    const mfccRes = essentia.MFCC(
      spec.spectrum,
      0,
      11000,
      FRAME,
      MFCC_COEFFS + 1,
      40,
      0,
      ESSENTIA_SR,
    )
    const mfccAll: Float32Array = essentia.vectorToArray(mfccRes.mfcc)
    mfccRes.bands?.delete?.()
    mfccRes.mfcc?.delete?.()

    const peaks = essentia.SpectralPeaks(spec.spectrum, 0, 5000, 60, 40, 'frequency', ESSENTIA_SR)
    const hpcpRes = essentia.HPCP(
      peaks.frequencies,
      peaks.magnitudes,
      true,
      500,
      0,
      HPCP_SIZE,
      'unitMax',
      440,
      ESSENTIA_SR,
    )
    const hpcpArr: Float32Array = essentia.vectorToArray(hpcpRes.hpcp)
    peaks.frequencies?.delete?.()
    peaks.magnitudes?.delete?.()
    hpcpRes.hpcp?.delete?.()

    const centroidRes = essentia.Centroid(spec.spectrum, ESSENTIA_SR / 2)
    const flatnessRes = essentia.Flatness(spec.spectrum)

    // Scalars straight off the linear magnitude spectrum.
    const nb = specArr.length
    const binHz = ESSENTIA_SR / 2 / nb
    let sumAll = 0
    let sub = 0
    let bass = 0
    let air = 0
    let flux = 0
    for (let i = 1; i < nb; i++) {
      const m = specArr[i]
      sumAll += m
      const hz = i * binHz
      if (hz < 80) sub += m
      else if (hz < 160) bass += m
      else if (hz > 8000) air += m
      if (prevSpec && i < prevSpec.length) {
        const d = m - prevSpec[i]
        if (d > 0) flux += d
      }
    }
    const meanMag = sumAll / nb

    return {
      frame: {
        hpcp: Array.from(hpcpArr),
        mfcc: Array.from(mfccAll.subarray(1, MFCC_COEFFS + 1)),
        centroid: Math.min(1, (centroidRes.centroid ?? 0) / (ESSENTIA_SR / 4)),
        flatness: Math.min(1, flatnessRes.flatness ?? 0),
        flux: Math.min(1, flux * 4),
        logRms: Math.min(1, Math.max(0, Math.log10(1 + 9 * meanMag))),
        air: Math.min(1, (air / nb) * 40),
        sub: Math.min(1, (sub / nb) * 40),
        bass: Math.min(1, (bass / nb) * 40),
      },
      spec: specArr,
    }
  } finally {
    frameVec?.delete?.()
    windowed?.frame?.delete?.()
    spec?.spectrum?.delete?.()
  }
}

/** Fold raw frames into beat cells using the request's beat grid. */
function foldToBeats(frames: RawFrame[], req: StructureRequest): BeatCell[] {
  const sig = frames.length
  if (sig === 0) return []
  const secPerBeat = 60 / Math.max(40, Math.min(220, req.bpm))
  const framesPerSec = ESSENTIA_SR / HOP
  const totalSec = sig / framesPerSec
  // Newest frame is at absolute fractional beat (endBeatIndex + endBeatProgress).
  const endFracBeat = req.endBeatIndex + req.endBeatProgress
  const startFracBeat = endFracBeat - totalSec / secPerBeat

  const buckets = new Map<number, RawFrame[]>()
  for (let i = 0; i < sig; i++) {
    const fracBeat = startFracBeat + i / framesPerSec / secPerBeat
    const beat = Math.floor(fracBeat)
    if (!buckets.has(beat)) buckets.set(beat, [])
    buckets.get(beat)!.push(frames[i])
  }
  const beats = [...buckets.keys()].sort((a, b) => a - b)
  const cells: BeatCell[] = []
  for (const beat of beats) {
    const fs = buckets.get(beat)!
    const avg = (pick: (f: RawFrame) => number) => fs.reduce((s, f) => s + pick(f), 0) / fs.length
    const avgVec = (pick: (f: RawFrame) => number[], len: number) => {
      const out = new Array(len).fill(0)
      for (const f of fs) {
        const v = pick(f)
        for (let d = 0; d < len; d++) out[d] += (v[d] ?? 0) / fs.length
      }
      return out
    }
    cells.push({
      beat,
      hpcp: avgVec((f) => f.hpcp, HPCP_SIZE),
      mfcc: avgVec((f) => f.mfcc, MFCC_COEFFS),
      logRms: avg((f) => f.logRms),
      centroid: avg((f) => f.centroid),
      flux: avg((f) => f.flux),
      flatness: avg((f) => f.flatness),
      air: avg((f) => f.air),
      sub: avg((f) => f.sub),
      bass: avg((f) => f.bass),
    })
  }
  return cells
}

self.onmessage = async (e: MessageEvent<StructureRequest>) => {
  const req = e.data
  try {
    await loadEssentia()
    const t0 = performance.now()
    const sig = resample(req.pcm, req.sampleRate)
    const frames: RawFrame[] = []
    let prev: Float32Array | null = null
    for (let start = 0; start + FRAME <= sig.length; start += HOP) {
      const { frame, spec } = analyzeFrame(sig, start, prev)
      frames.push(frame)
      prev = spec
    }

    const cells = foldToBeats(frames, req)
    const { novelty, boundaries, segments: segs } = segment(cells)
    const build = riserScore(cells, -1)
    const costMs = performance.now() - t0

    const segments: StructureSegment[] = segs
    const out: StructureResponse = {
      id: req.id,
      type: 'structure',
      atBeat: req.endBeatIndex,
      novelty: novelty.map((v) => Math.round(v * 1000) / 1000),
      boundaries: boundaries.map((b) => b.beat),
      segments,
      build,
      costMs,
    }
    self.postMessage(out)
  } catch (err) {
    const out: StructureResponse = {
      id: req.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      missing,
    }
    self.postMessage(out)
  }
}

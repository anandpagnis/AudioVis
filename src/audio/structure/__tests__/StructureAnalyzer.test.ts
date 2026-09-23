import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioEngine } from '../../AudioEngine'
import { createEmptyFeatures, type AudioFeatures } from '../../types'
import { quality } from '../../../engine/quality'
import { FIRST_JOB_DELAY_SEC, MIN_HISTORY_SEC, StructureAnalyzer } from '../StructureAnalyzer'

const SAMPLE_RATE = 44100

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** A plausible dB-scale low-frequency spectrum (mirrors AudioEngine's 8192-point `lowFreqDb`
 *  shape) with enough structure for `ChromaKeyEstimator`'s peak picker to find real peaks. */
function makeLowFreqDb(n = 4096): Float32Array {
  const arr = new Float32Array(n)
  for (let i = 0; i < n; i++) arr[i] = -70 + 25 * Math.sin(i * 0.013) - (i / n) * 15
  return arr
}

/** A plausible linear 0..1 magnitude spectrum (mirrors `f.spectrum`'s shape). */
function makeSpectrum(n = 1024): Float32Array {
  const arr = new Float32Array(n)
  for (let i = 0; i < n; i++) arr[i] = clamp01(0.5 * Math.exp(-i / 220) + 0.05 * Math.sin(i * 0.3))
  return arr
}

/** A reasonable, non-silent synthetic frame — override whatever a test cares about. `silence`
 *  defaults to `true` in `createEmptyFeatures()` (the idle/no-audio state), so every test that wants
 *  the analyzer to actually do anything must flip it, which this does. */
function baseFeatures(): AudioFeatures {
  const f = createEmptyFeatures()
  f.silence = false
  f.spectrum = makeSpectrum()
  f.loudness = 0.5
  f.centroid = 0.4
  f.flux = 0.2
  f.spectralFlatness = 0.3
  f.air = 0.2
  f.sub = 0.4
  f.bass = 0.4
  f.mid = 0.4
  f.high = 0.2
  return f
}

describe('StructureAnalyzer disabled (?structure=off)', () => {
  it('never accumulates and always returns null, across many varied frames', () => {
    const analyzer = new StructureAnalyzer({ disabled: true })
    const lowFreqDb = makeLowFreqDb()
    const before = JSON.stringify(analyzer.status)
    let t = 0
    for (let i = 0; i < 500; i++) {
      const f = baseFeatures()
      f.time = t
      f.delta = 1 / 60
      f.beat = i % 30 === 0
      f.beatIndex = Math.floor(i / 30)
      f.silence = i % 50 === 0
      f.bpm = 80 + (i % 100)
      expect(analyzer.update(f, lowFreqDb, SAMPLE_RATE)).toBeNull()
      t += f.delta
    }
    // Cheap proxy for "did no accumulation work": the mutated-in-place status object never moved
    // off its constructed defaults (historyBeats/runs/etc. all stay 0).
    expect(JSON.stringify(analyzer.status)).toBe(before)
    expect(analyzer.status.enabled).toBe(false)
    expect(analyzer.status.historyBeats).toBe(0)
    expect(analyzer.status.runs).toBe(0)
  })
})

describe('StructureAnalyzer enabled', () => {
  it('folds one BeatCell per f.beat and eventually returns a non-null StructureRaw with segments.length >= 1', () => {
    const analyzer = new StructureAnalyzer()
    const lowFreqDb = makeLowFreqDb()
    const secPerBeat = 0.5 // 120 BPM
    let raw = null as ReturnType<StructureAnalyzer['update']>
    let lastBeatIndex = -1
    for (let i = 0; i < 400 && !raw; i++) {
      const f = baseFeatures()
      f.time = i * secPerBeat
      f.delta = secPerBeat
      f.beat = true
      f.beatIndex = i
      f.percussion.hihat.trigger = i % 2 === 0
      f.percussion.snare.trigger = i % 8 === 4
      lastBeatIndex = i
      raw = analyzer.update(f, lowFreqDb, SAMPLE_RATE)
    }
    expect(raw).not.toBeNull()
    expect(raw!.segments.length).toBeGreaterThanOrEqual(1)
    // atBeat is the beatIndex the analyzed window ended on.
    expect(raw!.atBeat).toBe(lastBeatIndex)
    expect(analyzer.status.runs).toBe(1)
    expect(analyzer.status.historyBeats).toBeGreaterThan(0)
    expect(Number.isFinite(raw!.costMs)).toBe(true)
  })

  it('accumulates every frame, not just on f.beat (a per-frame-only call sequence still produces a valid cell)', () => {
    // Drive several non-beat frames between each beat, the way AudioEngine's real render loop does
    // (many renders per beat, one of which has f.beat === true) — confirms the fold isn't silently
    // relying on being called exactly once per beat.
    const analyzer = new StructureAnalyzer()
    const lowFreqDb = makeLowFreqDb()
    const secPerBeat = 0.5
    const framesPerBeat = 8
    let raw = null as ReturnType<StructureAnalyzer['update']>
    let beatIndex = 0
    let t = 0
    for (let i = 0; i < 400 * framesPerBeat && !raw; i++) {
      const f = baseFeatures()
      const isBeat = i % framesPerBeat === 0 && i > 0
      if (isBeat) beatIndex++
      f.time = t
      f.delta = secPerBeat / framesPerBeat
      f.beat = isBeat
      f.beatIndex = beatIndex
      raw = analyzer.update(f, lowFreqDb, SAMPLE_RATE)
      t += f.delta
    }
    expect(raw).not.toBeNull()
    expect(raw!.segments.length).toBeGreaterThanOrEqual(1)
  })

  it('never throws across a long, varied synthetic run (including silence, garbage-ish deltas, empty spectra)', () => {
    const analyzer = new StructureAnalyzer()
    const lowFreqDb = makeLowFreqDb()
    let seed = 987654321
    const rand = () => {
      // Deterministic xorshift-ish LCG — reproducible, no external dependency.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    expect(() => {
      let t = 0
      let beatIndex = 0
      for (let i = 0; i < 3000; i++) {
        const f = createEmptyFeatures()
        f.spectrum = makeSpectrum()
        for (let k = 0; k < f.spectrum.length; k++) f.spectrum[k] = rand()
        const isBeat = rand() < 0.1
        if (isBeat) beatIndex++
        f.time = t
        f.delta = rand() < 0.02 ? 0 : 1 / 60 + rand() * 0.02 // occasional zero-delta frame
        f.beat = isBeat
        f.beatIndex = beatIndex
        f.silence = rand() < 0.15
        f.loudness = rand()
        f.centroid = rand()
        f.flux = rand()
        f.spectralFlatness = rand()
        f.air = rand()
        f.sub = rand()
        f.bass = rand()
        f.mid = rand()
        f.high = rand()
        f.percussion.hihat.trigger = rand() < 0.3
        f.percussion.snare.trigger = rand() < 0.1
        analyzer.update(f, lowFreqDb, SAMPLE_RATE)
        t += f.delta
      }
    }).not.toThrow()
  })

  it('never throws on NaN/negative delta, a zero sample rate, or an empty spectrum/lowFreqDb', () => {
    const analyzer = new StructureAnalyzer()
    const f = baseFeatures()
    const emptyLow = new Float32Array(0)
    f.spectrum = new Float32Array(0)
    for (const delta of [NaN, -1, 0, Infinity]) {
      f.delta = delta
      expect(() => analyzer.update(f, emptyLow, SAMPLE_RATE)).not.toThrow()
    }
    expect(() => analyzer.update(f, emptyLow, 0)).not.toThrow()
    expect(() => analyzer.update(f, emptyLow, -1)).not.toThrow()
  })
})

describe('warm-up constants vs. essentia/StructureBridge', () => {
  it('MIN_HISTORY_SEC / FIRST_JOB_DELAY_SEC are meaningfully smaller than StructureBridge\'s', () => {
    // StructureBridge's own MIN_HISTORY_SEC (30) / FIRST_JOB_DELAY_SEC (8) are private, unexported
    // module constants (`src/audio/essentia/StructureBridge.ts`), and that file is permanently
    // Essentia-path-only per the plan — not to be touched to export them. Hardcoded here from a
    // direct read of that file rather than imported.
    const STRUCTURE_BRIDGE_MIN_HISTORY_SEC = 30
    const STRUCTURE_BRIDGE_FIRST_JOB_DELAY_SEC = 8
    expect(MIN_HISTORY_SEC).toBeLessThan(STRUCTURE_BRIDGE_MIN_HISTORY_SEC)
    expect(FIRST_JOB_DELAY_SEC).toBeLessThan(STRUCTURE_BRIDGE_FIRST_JOB_DELAY_SEC)
  })
})

describe('batch cadence lengthens as quality.tier rises', () => {
  const originalTier = quality.tier

  afterEach(() => {
    quality.tier = originalTier
  })

  it('the same post-warm-up window yields a second batch at tier 0 but not at tier 4', () => {
    const secPerBeat = 0.5
    const lowFreqDb = makeLowFreqDb()

    function warmUpToFirstBatch(analyzer: StructureAnalyzer): number {
      let i = 0
      let raw = null as ReturnType<StructureAnalyzer['update']>
      for (; i < 400 && !raw; i++) {
        const f = baseFeatures()
        f.time = i * secPerBeat
        f.delta = secPerBeat
        f.beat = true
        f.beatIndex = i
        raw = analyzer.update(f, lowFreqDb, SAMPLE_RATE)
      }
      expect(raw).not.toBeNull()
      return i - 1 // last i consumed (0-indexed loop increments past the winning call)
    }

    function secondBatchWithin(analyzer: StructureAnalyzer, fromBeat: number, beats: number): boolean {
      let raw = null as ReturnType<StructureAnalyzer['update']>
      for (let j = fromBeat + 1; j <= fromBeat + beats && !raw; j++) {
        const f = baseFeatures()
        f.time = j * secPerBeat
        f.delta = secPerBeat
        f.beat = true
        f.beatIndex = j
        raw = analyzer.update(f, lowFreqDb, SAMPLE_RATE)
      }
      return raw !== null
    }

    // Base cadence (CADENCE_SEC) is 15s when batch cost is negligible, as it is here. 40 beats at
    // 120 BPM is 20s — comfortably past 15s (tier 0, multiplier 1x) but well short of 45s (tier 4,
    // multiplier 3x).
    quality.tier = 0
    const lowTierAnalyzer = new StructureAnalyzer()
    const lowLast = warmUpToFirstBatch(lowTierAnalyzer)
    expect(secondBatchWithin(lowTierAnalyzer, lowLast, 40)).toBe(true)

    quality.tier = 4
    const highTierAnalyzer = new StructureAnalyzer()
    const highLast = warmUpToFirstBatch(highTierAnalyzer)
    expect(secondBatchWithin(highTierAnalyzer, highLast, 40)).toBe(false)
  })
})

describe('AudioEngine integration', () => {
  it('audioEngine owns a StructureAnalyzer instance', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    expect(engine.structureAnalyzer).toBeInstanceOf(StructureAnalyzer)
  })

  it('a module instance constructed under ?structure=off wires a permanently disabled analyzer', async () => {
    vi.resetModules()
    vi.stubGlobal('location', { search: '?structure=off' })
    try {
      const mod = await import('../../AudioEngine')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const freshEngine = mod.audioEngine as any
      const lowFreqDb = makeLowFreqDb()
      const before = JSON.stringify(freshEngine.structureAnalyzer.status)
      for (let i = 0; i < 50; i++) {
        const f = baseFeatures()
        f.time = i * 0.5
        f.delta = 0.5
        f.beat = true
        f.beatIndex = i
        expect(freshEngine.structureAnalyzer.update(f, lowFreqDb, SAMPLE_RATE)).toBeNull()
      }
      expect(JSON.stringify(freshEngine.structureAnalyzer.status)).toBe(before)
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  /**
   * No test anywhere in this repo mocks a full Web Audio graph (`AudioEngine.update()`'s real
   * per-frame path requires a live `AudioContext`/`AnalyserNode`; the only branch that runs without
   * one is the idle/no-graph path, which bypasses `intel`/`structureAnalyzer` entirely and calls
   * `sectionTracker.update(f, null)` directly). Following `audioEngineNoIntel.test.ts`'s own
   * established idiom — reaching past TS-only privacy to drive AudioEngine's internal pieces
   * directly (that file calls the private `detectStructure` directly) — this reproduces the EXACT
   * fallback expression `AudioEngine.update()` itself evaluates at its one integration line,
   * `intel.updateStructure(f) ?? structureAnalyzer.update(f, lowFreqDb, sampleRate)`, against the
   * real singleton's real `intel` (a `NullProvider` in this build, confirmed by
   * `audioEngineNoIntel.test.ts`) and real `sectionTracker`, without needing a real audio graph.
   */
  it('f.structureValid eventually goes true, driven the same way AudioEngine.update() itself would fuse the two sources', async () => {
    await new Promise((r) => setTimeout(r, 0)) // let the async provider factory settle (-> NullProvider)
    audioEngine.stop()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = audioEngine as any
    expect(engine.intel.id).toBe('null')
    const f = audioEngine.features
    expect(f.structureValid).toBe(false)
    const lowFreqDb = makeLowFreqDb()
    const secPerBeat = 0.5
    for (let i = 0; i < 200 && !f.structureValid; i++) {
      f.time = i * secPerBeat
      f.delta = secPerBeat
      f.silence = false
      f.spectrum = makeSpectrum()
      f.loudness = 0.5
      f.centroid = 0.4
      f.flux = 0.2
      f.spectralFlatness = 0.3
      f.air = 0.2
      f.sub = 0.4
      f.bass = 0.4
      f.mid = 0.4
      f.high = 0.2
      f.beat = true
      f.beatIndex = i
      f.percussion.hihat.trigger = i % 2 === 0
      const raw = engine.intel.updateStructure(f) ?? engine.structureAnalyzer.update(f, lowFreqDb, SAMPLE_RATE)
      engine.sectionTracker.update(f, raw)
    }
    expect(f.structureValid).toBe(true)
    audioEngine.stop()
  })
})

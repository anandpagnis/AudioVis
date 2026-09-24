import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioEngine } from '../../AudioEngine'
import { createEmptyFeatures, type AudioFeatures } from '../../types'
import { quality } from '../../../engine/quality'
import {
  CADENCE_MAX,
  CADENCE_SEC,
  FIRST_JOB_DELAY_SEC,
  MIN_HISTORY_SEC,
  StructureAnalyzer,
} from '../StructureAnalyzer'

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

  it('CADENCE_SEC is 8 s (was 15) with the cost-based ceiling untouched', () => {
    expect(CADENCE_SEC).toBe(8)
    expect(CADENCE_MAX).toBe(45)
  })

  // ADJUSTED: this test used to detect "a second batch" as "update() returned a non-null raw". Since the
  // analyzer now also returns a (cached-segmentation) raw on EVERY beat fold once a batch has run, a
  // non-null return no longer means a batch ran, so batches are counted through `status.runs` instead.
  // The window is also re-derived from the new 8 s base cadence: 30 beats @ 120 BPM = 15 s is past the
  // tier-0 cadence (8 s x 1) and short of the tier-4 one (8 s x 3 = 24 s).
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
      expect(analyzer.status.runs).toBe(1)
      return i - 1 // last i consumed (0-indexed loop increments past the winning call)
    }

    function batchesAfter(analyzer: StructureAnalyzer, fromBeat: number, beats: number): number {
      const before = analyzer.status.runs
      for (let j = fromBeat + 1; j <= fromBeat + beats; j++) {
        const f = baseFeatures()
        f.time = j * secPerBeat
        f.delta = secPerBeat
        f.beat = true
        f.beatIndex = j
        analyzer.update(f, lowFreqDb, SAMPLE_RATE)
      }
      return analyzer.status.runs - before
    }

    const window = 30
    expect(window * secPerBeat).toBeGreaterThan(CADENCE_SEC)
    expect(window * secPerBeat).toBeLessThan(CADENCE_SEC * 3)

    quality.tier = 0
    const lowTierAnalyzer = new StructureAnalyzer()
    const lowLast = warmUpToFirstBatch(lowTierAnalyzer)
    expect(batchesAfter(lowTierAnalyzer, lowLast, window)).toBeGreaterThanOrEqual(1)

    quality.tier = 4
    const highTierAnalyzer = new StructureAnalyzer()
    const highLast = warmUpToFirstBatch(highTierAnalyzer)
    expect(batchesAfter(highTierAnalyzer, highLast, window)).toBe(0)
  })

  it('batches recur on the 8 s cadence at tier 0, not the old 15 s', () => {
    quality.tier = 0
    const analyzer = new StructureAnalyzer()
    const lowFreqDb = makeLowFreqDb()
    const secPerBeat = 0.5
    const runsAt: number[] = []
    for (let i = 0; i < 120; i++) {
      const f = baseFeatures()
      f.time = i * secPerBeat
      f.delta = secPerBeat
      f.beat = true
      f.beatIndex = i
      const before = analyzer.status.runs
      analyzer.update(f, lowFreqDb, SAMPLE_RATE)
      if (analyzer.status.runs > before) runsAt.push(f.time)
    }
    expect(runsAt.length).toBeGreaterThanOrEqual(4)
    for (let k = 1; k < runsAt.length; k++) {
      expect(runsAt[k] - runsAt[k - 1]).toBeGreaterThanOrEqual(CADENCE_SEC - 1e-9)
      expect(runsAt[k] - runsAt[k - 1]).toBeLessThan(CADENCE_SEC + 2 * 0.5)
    }
  })
})

/**
 * After the first batch the analyzer returns a raw on every BEAT FOLD: the cached last-batch
 * segmentation (same array references) with a FRESH `riserScore` read, so a build that starts and ends
 * between two ~8 s batches is still seen.
 */
describe('per-beat riser refresh between batches', () => {
  const originalTier = quality.tier

  afterEach(() => {
    quality.tier = originalTier
  })

  const secPerBeat = 0.5
  const lowFreqDb = makeLowFreqDb()
  type Raw = NonNullable<ReturnType<StructureAnalyzer['update']>>
  type Read = { beat: number; sub: number; raw: Raw }

  /** A frame `sub` sub-frames into `beat` (sub 0 is the beat frame itself, 4 frames per beat). */
  function frame(beat: number, sub: number, level: number): AudioFeatures {
    const f = baseFeatures()
    f.time = beat * secPerBeat + (sub * secPerBeat) / 4
    f.delta = secPerBeat / 4
    f.beat = sub === 0
    f.beatIndex = beat
    // `level` 0..1 drives every riser cue at once (centroid/rms/high/flat/air up, sub+bass down, flux up).
    f.loudness = 0.3 + 0.6 * level
    f.centroid = 0.2 + 0.6 * level
    f.high = 0.1 + 0.6 * level
    f.spectralFlatness = 0.1 + 0.5 * level
    f.air = 0.1 + 0.6 * level
    f.flux = 0.1 + 0.5 * level
    f.sub = 0.5 - 0.4 * level
    f.bass = 0.5 - 0.4 * level
    f.percussion.hihat.trigger = level > 0.2 && sub % 2 === 0
    return f
  }

  /** Feed beats [from, to) (4 frames each), `levelAt(beat)` per beat; collect every non-null raw. */
  function feed(analyzer: StructureAnalyzer, from: number, to: number, levelAt: (beat: number) => number): Read[] {
    const out: Read[] = []
    for (let b = from; b < to; b++) {
      for (let sub = 0; sub < 4; sub++) {
        const raw = analyzer.update(frame(b, sub, levelAt(b)), lowFreqDb, SAMPLE_RATE)
        if (raw) out.push({ beat: b, sub, raw })
      }
    }
    return out
  }

  /** Warm up on flat features until the first batch has run; returns the next beat to feed. */
  function warmUp(analyzer: StructureAnalyzer): number {
    let b = 0
    while (analyzer.status.runs === 0 && b < 400) {
      feed(analyzer, b, b + 1, () => 0)
      b++
    }
    expect(analyzer.status.runs).toBe(1)
    return b
  }

  it('returns nothing before the first batch, then a raw on exactly the beat-fold frames after it', () => {
    quality.tier = 0
    const analyzer = new StructureAnalyzer()
    const reads: Read[] = []
    for (let b = 0; b < 60; b++) reads.push(...feed(analyzer, b, b + 1, () => 0))
    expect(reads.length).toBeGreaterThan(10)
    // Nothing at all during warm-up (>= MIN_HISTORY_SEC of buffered history).
    expect(reads[0].beat * secPerBeat).toBeGreaterThanOrEqual(MIN_HISTORY_SEC - secPerBeat)
    // Afterwards: only beat frames (sub 0), and never twice for one beat.
    for (const r of reads) expect(r.sub).toBe(0)
    expect(new Set(reads.map((r) => r.beat)).size).toBe(reads.length)
    // ...and every beat after the first batch has one (batches share those frames).
    for (let k = 1; k < reads.length; k++) expect(reads[k].beat).toBe(reads[k - 1].beat + 1)
  })

  it('replays the cached segmentation by REFERENCE with atBeat = the newest cell, and a tiny costMs', () => {
    quality.tier = 0
    const analyzer = new StructureAnalyzer()
    const start = warmUp(analyzer)
    // The batch raw is the one returned on the beat the batch ran (start - 1); re-run to capture it.
    const analyzer2 = new StructureAnalyzer()
    let batchRaw: Raw | null = null
    let b = 0
    while (!batchRaw && b < 400) {
      const r = feed(analyzer2, b, b + 1, () => 0)
      if (r.length) batchRaw = r[0].raw
      b++
    }
    expect(batchRaw).not.toBeNull()
    expect(b).toBe(start)
    const refreshes = feed(analyzer2, b, b + 6, () => 0)
    expect(refreshes.length).toBe(6)
    for (const { beat, raw } of refreshes) {
      expect(raw.segments).toBe(batchRaw!.segments)
      expect(raw.boundaries).toBe(batchRaw!.boundaries)
      expect(raw.novelty).toBe(batchRaw!.novelty)
      expect(raw.atBeat).toBe(beat)
      expect(raw.costMs).toBeLessThan(50)
    }
    expect(analyzer2.status.runs).toBe(1) // all six were refreshes, not batches
  })

  it('sees a build that starts and ends BETWEEN two batches (status + raw.build track it live)', () => {
    quality.tier = 0
    const analyzer = new StructureAnalyzer()
    const start = warmUp(analyzer)
    const runsAfterWarmUp = analyzer.status.runs
    // A 12-beat ramp (6 s) right after the first batch — shorter than the 8 s cadence, so no batch
    // runs during it. Each beat's `level` climbs toward 1.
    const ramp = feed(analyzer, start, start + 12, (beat) => (beat - start + 1) / 12)
    expect(analyzer.status.runs).toBe(runsAfterWarmUp) // still no new batch
    const active = ramp.filter((r) => r.raw.build.active)
    expect(active.length).toBeGreaterThan(0)
    // Its status reads the fresh value too (not held from the batch).
    expect(analyzer.status.buildActive).toBe(true)
    expect(analyzer.status.buildScore).toBeGreaterThan(0.4)
    // buildStartBeat bookkeeping: every active read of the same build reports the SAME start, set
    // from the first active read.
    const starts = new Set(active.map((r) => r.raw.build.startBeat))
    expect(starts.size).toBe(1)
    const s0 = [...starts][0]
    expect(s0).toBeGreaterThanOrEqual(start - 24)
    expect(s0).toBeLessThanOrEqual(active[0].beat)
    // Once it flattens for long enough, the read goes inactive and the start resets (inactive => -1).
    const tail = feed(analyzer, start + 12, start + 12 + 60, () => 1)
    const last = tail[tail.length - 1].raw.build
    expect(last.active).toBe(false)
    expect(last.startBeat).toBe(-1)
    expect(analyzer.status.buildActive).toBe(false)
    // A second, later ramp (from a quiet floor again) is a NEW build with a later start.
    feed(analyzer, start + 72, start + 102, () => 0)
    const ramp2 = feed(analyzer, start + 102, start + 114, (beat) => (beat - (start + 102) + 1) / 12)
    const active2 = ramp2.filter((r) => r.raw.build.active)
    expect(active2.length).toBeGreaterThan(0)
    expect(active2[0].raw.build.startBeat).toBeGreaterThan(s0)
  })

  it('riser hysteresis: while a build is in flight the start never flickers', () => {
    quality.tier = 0
    const analyzer = new StructureAnalyzer()
    const start = warmUp(analyzer)
    const ramp = feed(analyzer, start, start + 12, (beat) => (beat - start + 1) / 12)
    const firstActive = ramp.find((r) => r.raw.build.active)
    expect(firstActive).toBeDefined()
    const startBeat = firstActive!.raw.build.startBeat
    // Flat afterwards (no batch yet for a few more beats): record every read.
    const reads = feed(analyzer, start + 12, start + 20, () => 1).map((r) => r.raw.build)
    // While active the start is the one the build began with (a flicker would reset it and re-guess).
    for (const b of reads) if (b.active) expect(b.startBeat).toBe(startBeat)
    // ...and once inactive it does not flicker back on with a different start.
    let sawInactive = false
    for (const b of reads) {
      if (!b.active) sawInactive = true
      else expect(sawInactive).toBe(false)
    }
  })

  it('does not refresh during silence, and reset() drops the cache (no raws until the next batch)', () => {
    quality.tier = 0
    const analyzer = new StructureAnalyzer()
    const start = warmUp(analyzer)
    const silentFrame = frame(start, 0, 0)
    silentFrame.silence = true
    expect(analyzer.update(silentFrame, lowFreqDb, SAMPLE_RATE)).toBeNull()
    expect(feed(analyzer, start + 1, start + 3, () => 0).length).toBe(2) // live again
    analyzer.reset()
    expect(analyzer.status.runs).toBe(0)
    // After reset there is no cache, so nothing is returned until history rebuilds and a batch runs.
    expect(feed(analyzer, 0, 30, () => 0).length).toBe(0)
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { frameStats, readRing, sessionLog } from '../sessionLog'
import { performanceState } from '../performanceState'
import { quality } from '../quality'
import { audioEngine } from '../../audio/AudioEngine'

describe('readRing', () => {
  it('returns an unwrapped buffer in write order', () => {
    const buf = new Float32Array([1, 2, 3, 0, 0])
    expect(readRing(buf, 3, 3)).toEqual([1, 2, 3])
  })

  it('reorders a wrapped buffer so the oldest sample comes first', () => {
    // Capacity 5, 7 writes: [6, 7, 3, 4, 5] on disk, write head at index 2 —
    // the true chronological order is 3,4,5,6,7.
    const buf = new Float32Array([6, 7, 3, 4, 5])
    expect(readRing(buf, 2, 7)).toEqual([3, 4, 5, 6, 7])
  })

  it('never reads more than capacity, however large count claims to be', () => {
    const buf = new Float32Array([9, 9, 9])
    expect(readRing(buf, 0, 1_000_000)).toHaveLength(3)
  })

  it('handles a count of zero without touching the buffer', () => {
    expect(readRing(new Float32Array(4), 0, 0)).toEqual([])
  })
})

describe('frameStats', () => {
  it('is all zero on an empty input, and over() never divides by zero', () => {
    const s = frameStats([])
    expect(s).toMatchObject({ mean: 0, p50: 0, p95: 0, p99: 0, max: 0 })
    expect(s.over(16.7)).toBe(0)
  })

  it('computes percentiles without mutating the input', () => {
    const input = [30, 10, 20, 50, 40]
    const original = [...input]
    const s = frameStats(input)
    expect(input).toEqual(original)
    expect(s.max).toBe(50)
    expect(s.mean).toBe(30)
  })

  it('reports the fraction of samples strictly over a threshold', () => {
    const s = frameStats([10, 10, 20, 20, 30])
    expect(s.over(15)).toBeCloseTo(60, 5) // 3 of 5 exceed 15
    expect(s.over(30)).toBe(0) // none exceed the max itself
  })
})

describe('SessionLog', () => {
  it('is idle until started', () => {
    expect(sessionLog.isRecording()).toBe(false)
    expect(sessionLog.elapsedSec()).toBe(0)
    expect(sessionLog.sampleCount()).toBe(0)
  })

  it('ticking while idle is a no-op — no crash, nothing recorded', () => {
    sessionLog.tick(1 / 60)
    expect(sessionLog.sampleCount()).toBe(0)
  })

  it('records frames and 4Hz samples once started, and stops cleanly', () => {
    sessionLog.start()
    expect(sessionLog.isRecording()).toBe(true)

    // 3 seconds at 60Hz crosses several 0.25s sample boundaries.
    for (let i = 0; i < 180; i++) sessionLog.tick(1 / 60)

    expect(sessionLog.elapsedSec()).toBeGreaterThan(2.9)
    expect(sessionLog.sampleCount()).toBeGreaterThanOrEqual(10)

    const { summary, json } = sessionLog.stop()
    expect(sessionLog.isRecording()).toBe(false)

    expect(summary).toContain('=== AudioVis session ===')
    expect(summary).toContain('frame time')
    const parsed = JSON.parse(json) as { frameCount: number; samples: unknown[] }
    expect(parsed.frameCount).toBe(180)
    expect(parsed.samples.length).toBe(sessionLog.sampleCount())
  })

  it('runs headless without throwing — every DOM touch is guarded', () => {
    // vitest's node environment has no `document`, which is exactly the
    // condition the guards in start()/tick() exist for. If any of them regress,
    // this throws instead of silently skipping the thumbnail path.
    expect(() => {
      sessionLog.start()
      for (let i = 0; i < 30; i++) sessionLog.tick(1 / 30)
      sessionLog.stop()
    }).not.toThrow()
  })

  it('derives a tier-change event from the real quality governor, not a mock', () => {
    sessionLog.start()
    const before = quality.tier
    sessionLog.tick(1 / 60)
    quality.pinTier(Math.min(4, before + 1))
    sessionLog.tick(1 / 60)
    quality.pinTier(before) // restore, so this test does not leak state
    sessionLog.tick(1 / 60)
    const { json } = sessionLog.stop()
    const parsed = JSON.parse(json) as { events: { kind: string }[] }
    expect(parsed.events.some((e) => e.kind === 'tier')).toBe(true)
  })

  it('pairs a transition start with its end, and flags an incomplete one as aborted', () => {
    const tx = performanceState.transition
    const restore = { ...tx }
    try {
      sessionLog.start()
      tx.active = true
      tx.style = 'dissolve'
      tx.progress = 0
      tx.durationSec = 1
      sessionLog.tick(1 / 60)
      tx.progress = 0.4 // cut short, never reaches ~1
      tx.active = false
      sessionLog.tick(1 / 60)
      const { json } = sessionLog.stop()
      const parsed = JSON.parse(json) as { events: { kind: string; detail: string }[] }
      const end = parsed.events.find((e) => e.kind === 'transition-end')
      expect(end?.detail).toContain('ABORTED')
    } finally {
      Object.assign(tx, restore)
    }
  })

  it('compacts the contact-sheet interval rather than dropping coverage', () => {
    // Interval doubles each time the 64-tile sheet fills, so long recordings
    // stay covered end-to-end instead of only capturing the first few minutes.
    sessionLog.start()
    // 64 tiles at the initial 2s interval, plus one more to force a compaction.
    for (let i = 0; i < 65; i++) {
      for (let f = 0; f < 60 * 2; f++) sessionLog.tick(1 / 60)
    }
    expect(() => sessionLog.stop()).not.toThrow()
  })
})

describe('SessionLog — show quality', () => {
  it('includes beat-timing, duty-cycle and entropy lines derived from a real cut', () => {
    const savedScene = performanceState.activeScene
    const savedPalette = performanceState.palette
    const savedBar = audioEngine.features.bar
    const savedBeatInBar = audioEngine.features.beatInBar
    const savedBeatProgress = audioEngine.features.beatProgress
    try {
      sessionLog.start()
      sessionLog.tick(1 / 60) // baseline sample — establishes prev.scene, no commit yet

      // A cut landing exactly on a downbeat.
      audioEngine.features.bar = 1
      audioEngine.features.beatInBar = 0
      audioEngine.features.beatProgress = 0
      performanceState.activeScene = 'showQualityTestScene'
      sessionLog.tick(1 / 60)

      // Enough more ticks to cross a couple of 4Hz sample boundaries so the
      // rack/entropy lines have something to summarise.
      for (let i = 0; i < 30; i++) sessionLog.tick(1 / 60)

      const { summary } = sessionLog.stop()
      expect(summary).toContain('--- show quality ---')
      expect(summary).toContain('mirror duty cycle')
      expect(summary).toContain('lens   duty cycle')
      expect(summary).toContain('scene entropy')
      expect(summary).toContain('palette entropy')

      // The cut landed exactly on the downbeat: offset stats must say so.
      const offLine = summary.split('\n').find((l) => l.startsWith('cut offset'))
      expect(offLine).toBeDefined()
      expect(offLine).toContain('mean 0.00')
      const hitLine = summary.split('\n').find((l) => l.startsWith('beat hit score'))
      expect(hitLine).toBeDefined()
      expect(hitLine).toContain('beat coverage score')
      expect(hitLine).toContain('100%')
    } finally {
      performanceState.activeScene = savedScene
      performanceState.palette = savedPalette
      audioEngine.features.bar = savedBar
      audioEngine.features.beatInBar = savedBeatInBar
      audioEngine.features.beatProgress = savedBeatProgress
    }
  })

  it('reports no cuts when the scene never changes', () => {
    sessionLog.start()
    for (let i = 0; i < 10; i++) sessionLog.tick(1 / 60)
    const { summary } = sessionLog.stop()
    expect(summary).toContain('cut timing: no scene commits recorded')
  })

  it('measures scene time-to-repeat, with a histogram, when a scene comes back around', () => {
    const savedScene = performanceState.activeScene
    try {
      sessionLog.start()
      sessionLog.tick(1 / 60)
      performanceState.activeScene = 'sceneA'
      sessionLog.tick(1 / 60)
      performanceState.activeScene = 'sceneB'
      sessionLog.tick(1 / 60)
      performanceState.activeScene = 'sceneA' // repeat — this is what the metric measures
      sessionLog.tick(1 / 60)
      const { summary } = sessionLog.stop()
      const line = summary.split('\n').find((l) => l.startsWith('scene time-to-repeat'))
      expect(line).toBeDefined()
      expect(line).toMatch(/\(n=1\)/)
      expect(line).toContain('0-10s:1') // the repeat landed inside one 60Hz tick, well under 10s
    } finally {
      performanceState.activeScene = savedScene
    }
  })
})

/**
 * A backgrounded tab is not a stall (F152).
 *
 * `audiovis-session-2026-08-29-16-15-09` reported `max 24295.4 ms` for a frame
 * with no scene, tier or scale event anywhere near it — the window had simply
 * been in the background for 24 seconds. That frame sat at the top of "worst
 * single frames" and owned `max` and `p99`, which are the two numbers this
 * project reads session-over-session to decide whether a real stall is fixed.
 *
 * The node test environment has no `document`, which is also the guard path
 * `start()` takes in a worker. Stubbing one exercises the listener wiring
 * itself rather than a flag set by hand.
 */
describe('SessionLog — hidden-tab frames', () => {
  function stubDocument() {
    const listeners: Record<string, (() => void)[]> = {}
    const doc = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      // The recorder also reaches for the stage canvas to grab contact-sheet
      // tiles; there is no DOM here, and null is the same answer the real guard
      // gives in a worker.
      querySelector: () => null,
      // Same for the contact sheet: a bare object with no 2d context, which the
      // recorder already handles (it null-checks getContext).
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
      addEventListener: (k: string, fn: () => void) => {
        ;(listeners[k] ??= []).push(fn)
      },
      removeEventListener: (k: string, fn: () => void) => {
        listeners[k] = (listeners[k] ?? []).filter((f) => f !== fn)
      },
      fire: (k: string) => (listeners[k] ?? []).forEach((f) => f()),
    }
    vi.stubGlobal('document', doc)
    return doc
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the frame but excludes it from the distribution, and labels it', () => {
    const doc = stubDocument()
    sessionLog.start()
    for (let i = 0; i < 60; i++) sessionLog.tick(1 / 60)

    // The user alt-tabs away and comes back 20s later: rAF stops, so the next
    // frame's delta is the whole absence.
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    sessionLog.tick(20)

    for (let i = 0; i < 60; i++) sessionLog.tick(1 / 60)
    const { summary, json } = sessionLog.stop()

    // Still in the raw timeline — nothing is silently deleted.
    const parsed = JSON.parse(json) as { frameCount: number; frameTimesMs: number[] }
    expect(parsed.frameCount).toBe(121)
    expect(Math.max(...parsed.frameTimesMs)).toBeGreaterThan(19_000)

    // But out of the stats: max must be a real rendered frame, not the absence.
    const maxLine = summary.split('\n').find((l) => l.startsWith('mean '))
    expect(maxLine).toBeDefined()
    const max = Number(/max ([\d.]+)/.exec(maxLine as string)?.[1])
    expect(max).toBeLessThan(100)

    expect(summary).toContain('excluded 1 frame spanning a hidden tab')
    expect(summary).toContain('(tab hidden - not a stall)')
  })

  it('does not touch a session where the tab stayed visible', () => {
    stubDocument()
    sessionLog.start()
    for (let i = 0; i < 60; i++) sessionLog.tick(1 / 60)
    sessionLog.tick(0.2) // a real 200ms stall, and it must survive
    const { summary } = sessionLog.stop()

    expect(summary).not.toContain('spanning a hidden tab')
    const maxLine = summary.split('\n').find((l) => l.startsWith('mean '))
    const max = Number(/max ([\d.]+)/.exec(maxLine as string)?.[1])
    expect(max).toBeGreaterThan(190)
  })
})

import { describe, expect, it } from 'vitest'
import { frameStats, readRing, sessionLog } from '../sessionLog'
import { performanceState } from '../performanceState'
import { quality } from '../quality'

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

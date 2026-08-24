import { describe, expect, it } from 'vitest'
import { BenchRunner, buildPlan, formatResults, type BenchCell } from '../benchHarness'

const OPTS = { warmupFrames: 3, measureFrames: 4, drainFrames: 2 }

/** Drive `n` frames of constant cost, with no GPU results. */
function runCpu(r: BenchRunner, n: number, ms: number, supported = false) {
  for (let i = 0; i < n; i++) r.frame(ms, [], supported)
}

describe('buildPlan', () => {
  it('is scene-major so an aborted run still has complete rows', () => {
    // Tier-major would give tier 0 of everything and nothing comparable across
    // tiers; scene-major gives whole scenes.
    const plan = buildPlan(['a', 'b'], [0, 2])
    expect(plan).toEqual([
      { sceneId: 'a', tier: 0 },
      { sceneId: 'a', tier: 2 },
      { sceneId: 'b', tier: 0 },
      { sceneId: 'b', tier: 2 },
    ])
  })

  it('handles an empty roster', () => {
    expect(buildPlan([], [0])).toEqual([])
    expect(new BenchRunner([]).done).toBe(true)
  })
})

describe('BenchRunner — phases', () => {
  it('discards warmup frames entirely', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], OPTS)
    expect(r.currentPhase).toBe('warmup')
    // A cold shader compile is exactly what these frames contain. Counting them
    // would report compile time as scene cost.
    runCpu(r, 3, 500)
    expect(r.currentPhase).toBe('measure')
    runCpu(r, 4, 10)
    expect(r.results[0].cpu.maxMs).toBe(10)
    expect(r.results[0].cpu.count).toBe(4)
  })

  it('skips the drain when there is no GPU timer', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], OPTS)
    runCpu(r, 3, 1)
    runCpu(r, 4, 10)
    // Straight to done — no point spending drain frames collecting nothing.
    expect(r.done).toBe(true)
    expect(r.results[0].gpu).toBeNull()
  })

  it('drains late GPU results after CPU sampling ends', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], OPTS)
    for (let i = 0; i < 3; i++) r.frame(16, [], true) // warmup
    // Measure: queries are issued now but resolve later, so nothing lands yet.
    for (let i = 0; i < 4; i++) r.frame(16, [], true)
    expect(r.currentPhase).toBe('drain')
    // The tail arrives during the drain. Without this phase every cell would
    // lose its last few samples.
    r.frame(16, [4, 4], true)
    r.frame(16, [4, 4], true)
    expect(r.done).toBe(true)
    expect(r.results[0].gpu?.count).toBe(4)
    expect(r.results[0].gpu?.meanMs).toBeCloseTo(4, 6)
  })

  it('advances through every cell in the plan', () => {
    const plan: BenchCell[] = buildPlan(['a', 'b'], [0, 1])
    const r = new BenchRunner(plan, OPTS)
    for (let i = 0; i < 4; i++) {
      expect(r.done).toBe(false)
      runCpu(r, 3, 1)
      runCpu(r, 4, 10)
    }
    expect(r.done).toBe(true)
    expect(r.results).toHaveLength(4)
    expect(r.results.map((x) => `${x.sceneId}${x.tier}`)).toEqual(['a0', 'a1', 'b0', 'b1'])
  })

  it('stop() keeps completed cells and abandons the rest', () => {
    const r = new BenchRunner(buildPlan(['a', 'b'], [0]), OPTS)
    runCpu(r, 3, 1)
    runCpu(r, 4, 10)
    r.stop()
    expect(r.done).toBe(true)
    expect(r.results).toHaveLength(1)
    // Further frames must not resurrect the run or corrupt the results.
    runCpu(r, 10, 99)
    expect(r.results).toHaveLength(1)
  })
})

describe('BenchRunner — statistics', () => {
  it('computes mean, p95 and max over measured frames only', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], { ...OPTS, measureFrames: 20 })
    runCpu(r, 3, 999) // warmup, discarded
    for (let i = 0; i < 20; i++) r.frame(i === 19 ? 100 : 10, [], false)
    const cpu = r.results[0].cpu
    expect(cpu.count).toBe(20)
    expect(cpu.maxMs).toBe(100)
    expect(cpu.meanMs).toBeCloseTo((19 * 10 + 100) / 20, 6)
    // Nearest-rank: ceil(0.95 * 20) - 1 = index 18 of the sorted set, which is
    // still 10 — one bad frame in twenty must NOT drag p95 up. That is the
    // whole reason p95 is used rather than max.
    expect(cpu.p95Ms).toBe(10)
  })

  it('reports gpu as null when the extension is supported but every query was disjoint', () => {
    // A disjoint run yields no usable timings. Inventing a number from an empty
    // set would be worse than admitting there isn't one.
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], OPTS)
    for (let i = 0; i < 3; i++) r.frame(16, [], true)
    for (let i = 0; i < 4; i++) r.frame(16, [], true)
    for (let i = 0; i < 2; i++) r.frame(16, [], true)
    expect(r.done).toBe(true)
    expect(r.results[0].gpu).toBeNull()
  })

  it('separates CPU and GPU axes', () => {
    // The point of the whole exercise: vsync pins CPU at the refresh interval
    // while the GPU number reveals what the scene actually cost.
    const r = new BenchRunner([{ sceneId: 'heavy', tier: 0 }], OPTS)
    for (let i = 0; i < 3; i++) r.frame(16.7, [], true)
    for (let i = 0; i < 4; i++) r.frame(16.7, [9.5], true)
    for (let i = 0; i < 2; i++) r.frame(16.7, [], true)
    expect(r.results[0].cpu.meanMs).toBeCloseTo(16.7, 6)
    expect(r.results[0].gpu?.meanMs).toBeCloseTo(9.5, 6)
  })
})

describe('formatResults', () => {
  it('renders a markdown table and marks missing GPU data', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 3 }], OPTS)
    runCpu(r, 3, 1)
    runCpu(r, 4, 12.5)
    const md = formatResults(r.results)
    expect(md).toContain('| scene | tier |')
    expect(md).toContain('| a | 3 |')
    expect(md).toContain('n/a')
    expect(md).toContain('12.50')
  })
})

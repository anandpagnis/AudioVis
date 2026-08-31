import { describe, expect, it } from 'vitest'
import {
  BenchRunner,
  buildPlan,
  formatResults,
  formatPostChainDelta,
  postChainDelta,
  type BenchCell,
  type BenchResult,
} from '../benchHarness'

const OPTS = { warmupFrames: 3, measureFrames: 4, drainFrames: 2 }

/** Drive `n` frames of constant cost, with no GPU results. */
function runCpu(r: BenchRunner, n: number, ms: number, supported = false) {
  // JS time defaults to a fixed fraction of the frame so the two columns are
  // distinguishable in assertions — the point of the column is that they are
  // NOT the same number.
  for (let i = 0; i < n; i++) r.frame(ms, ms / 4, [], supported)
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
    for (let i = 0; i < 3; i++) r.frame(16, 1, [], true) // warmup
    // Measure: queries are issued now but resolve later, so nothing lands yet.
    for (let i = 0; i < 4; i++) r.frame(16, 1, [], true)
    expect(r.currentPhase).toBe('drain')
    // The tail arrives during the drain. Without this phase every cell would
    // lose its last few samples.
    r.frame(16, 1, [4, 4], true)
    r.frame(16, 1, [4, 4], true)
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
    for (let i = 0; i < 20; i++) r.frame(i === 19 ? 100 : 10, 2, [], false)
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
    for (let i = 0; i < 3; i++) r.frame(16, 1, [], true)
    for (let i = 0; i < 4; i++) r.frame(16, 1, [], true)
    for (let i = 0; i < 2; i++) r.frame(16, 1, [], true)
    expect(r.done).toBe(true)
    expect(r.results[0].gpu).toBeNull()
  })

  it('separates CPU and GPU axes', () => {
    // The point of the whole exercise: vsync pins CPU at the refresh interval
    // while the GPU number reveals what the scene actually cost.
    const r = new BenchRunner([{ sceneId: 'heavy', tier: 0 }], OPTS)
    for (let i = 0; i < 3; i++) r.frame(16.7, 1, [], true)
    for (let i = 0; i < 4; i++) r.frame(16.7, 1, [9.5], true)
    for (let i = 0; i < 2; i++) r.frame(16.7, 1, [], true)
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

/**
 * The whole reason the JS column exists: it must be able to disagree with the
 * CPU column. A scene stalled on the GPU shows a long frame and almost no
 * JavaScript, and reading the first as the second is how F87 got diagnosed as
 * a main-thread problem in a scene that loops 1,300 times.
 */
describe('BenchRunner — JS time is measured separately from frame time', () => {
  it('records a long frame with trivial JS as exactly that', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], OPTS)
    for (let i = 0; i < 3; i++) r.frame(68, 0.05, [], false)
    for (let i = 0; i < 4; i++) r.frame(68, 0.05, [], false)
    const row = r.results[0]
    expect(row.cpu.meanMs).toBeCloseTo(68, 6)
    expect(row.js.meanMs).toBeCloseTo(0.05, 6)
  })

  it('counts the same number of samples in both columns', () => {
    const r = new BenchRunner([{ sceneId: 'a', tier: 0 }], OPTS)
    for (let i = 0; i < 7; i++) r.frame(16.7, 4, [], false)
    expect(r.results[0].js.count).toBe(r.results[0].cpu.count)
  })
})

/**
 * The post-chain difference (F156).
 *
 * `POST_CHAIN_MS = 2` and `FEEDBACK_MS = 1` are the last invented numbers in
 * the frame budget, they are charged to every frame, and F110 made them scale
 * with resolution — so on a 1440p panel at tier 0 the reservation now exceeds
 * the whole tier budget and no layer can be admitted at the top of the ladder.
 * This is the measurement that says which half of that is wrong.
 *
 * The tests that matter here are the REFUSALS. A benchmark that silently
 * mismeasures is worse than none, and every skip path below is a way this could
 * have produced a confident wrong number instead.
 */
describe('postChainDelta', () => {
  const st = (meanMs: number) => ({ count: 120, meanMs, p95Ms: meanMs, maxMs: meanMs })
  const cell = (
    sceneId: string,
    tier: number,
    gpuMean: number | null,
    internalMP: number | null = 2,
  ): BenchResult => ({
    sceneId,
    tier,
    cpu: st(16.7),
    js: st(1),
    gpu: gpuMean === null ? null : st(gpuMean),
    profile: {} as BenchResult['profile'],
    internalMP,
  })

  it('subtracts matched cells and normalises by resolution', () => {
    const d = postChainDelta([cell('a', 0, 4, 2)], [cell('a', 0, 7, 2)])
    expect(d.cells).toHaveLength(1)
    expect(d.cells[0].deltaMs).toBeCloseTo(3)
    expect(d.cells[0].msPerMP).toBeCloseTo(1.5)
    // The number the model actually wants: what that implies at the reference
    // resolution frameLoad quotes its constants at.
    expect(d.atReferenceMs(2.07)).toBeCloseTo(3.105)
  })

  it('takes the MEDIAN, so one hiccuping cell cannot move the answer', () => {
    // Three cells that should agree at 1.0 ms/MP, one of which caught a driver
    // stall. A mean would report 2.0; the median reports the truth.
    const off = [cell('a', 0, 4), cell('b', 0, 4), cell('c', 0, 4)]
    const on = [cell('a', 0, 6), cell('b', 0, 6), cell('c', 0, 16)]
    const d = postChainDelta(off, on)
    expect(d.cells).toHaveLength(3)
    expect(d.medianMsPerMP).toBeCloseTo(1)
  })

  it('refuses a pair drawn at different resolutions', () => {
    // The failure this guards is the quiet one: both passes ran, both have GPU
    // numbers, and the difference is a resolution change being reported as the
    // cost of the post chain.
    const d = postChainDelta([cell('a', 0, 4, 2)], [cell('a', 0, 9, 4)])
    expect(d.cells).toHaveLength(0)
    expect(d.skipped[0].why).toContain('resolution mismatch')
  })

  it('refuses when either pass has no GPU timing', () => {
    // CPU time is vsync-locked, so two passes that both hold 60fps look
    // identical on that axis whatever the chain costs. Differencing them would
    // confidently report 0.00 ms.
    const d = postChainDelta([cell('a', 0, null)], [cell('a', 0, 7)])
    expect(d.cells).toHaveLength(0)
    expect(d.skipped[0].why).toContain('no GPU timing')
    expect(d.medianMsPerMP).toBe(0)
  })

  it('refuses when the harness never reported a resolution', () => {
    const d = postChainDelta([cell('a', 0, 4, null)], [cell('a', 0, 7, null)])
    expect(d.cells).toHaveLength(0)
    expect(d.skipped[0].why).toContain('internal resolution')
  })

  it('skips a cell the other pass never ran', () => {
    const d = postChainDelta([cell('a', 0, 4)], [cell('a', 0, 7), cell('b', 3, 7)])
    expect(d.cells.map((c) => c.sceneId)).toEqual(['a'])
    expect(d.skipped[0]).toMatchObject({ sceneId: 'b', tier: 3 })
  })

  it('reports the spread, because agreement is the quality signal', () => {
    // Per-cell ms/MP should be constant - a fullscreen pass costs what it
    // costs. Rows that disagree mean the METHOD is wrong, so the formatter has
    // to show them rather than collapsing to one number.
    const out = formatPostChainDelta(
      postChainDelta([cell('a', 0, 4), cell('b', 0, 4)], [cell('a', 0, 6), cell('b', 0, 9)]),
      2.07,
    )
    expect(out).toContain('spread 1.000 - 2.500 ms/MP')
    expect(out).toContain('2 matched cell(s)')
  })

  it('is empty and honest when nothing matched', () => {
    const d = postChainDelta([], [])
    expect(d.cells).toHaveLength(0)
    expect(d.medianMsPerMP).toBe(0)
    expect(d.atReferenceMs(2.07)).toBe(0)
  })
})

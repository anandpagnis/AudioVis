import { describe, expect, it } from 'vitest'
import METER_SRC from '../FpsMeter.tsx?raw'
import QUALITY_SRC from '../../engine/quality.ts?raw'
import { TIER_BUDGET_MS } from '../../engine/slotBudget'

/**
 * Pins the always-on frame meter (F186, F187).
 *
 * ## Why these are source-string checks
 *
 * Same convention and same reason as `filterTrigger.test.ts` and
 * `credits.test.ts`: this suite runs `environment: 'node'` with no jsdom and no
 * testing-library, so there is no DOM to mount into. Worse for this component
 * specifically, importing it for real pulls `PerfMonitor.tsx` and therefore
 * `@react-three/fiber` and the whole store into a node process, to assert that
 * a `textContent` write is guarded by an `if`.
 *
 * The two assertions that are NOT source strings are the ones that matter most
 * and are genuinely checkable — the ladder length and the demote ratio this
 * file copies out of `quality.ts`. Both are real cross-file couplings that fail
 * silently rather than loudly.
 *
 * ## What is being defended
 *
 * A live session ran 36 fps / 27.6 ms mean / 66.8 ms p95, pinned at the floor
 * tier, while this meter read `1.7/6.5 ms` and did not colour it. Two separate
 * failures produced that: the load readout equates "the model fits" with "the
 * machine is fine", and `perf.gpuMs` — the one measurement that separates
 * GPU-bound from CPU-bound — was being taken and shown only in the heavyweight
 * panels. Each check below corresponds to a way that state could come back.
 */

/** Assignments to `.textContent` / `.className` inside the tick. */
const DOM_WRITES = /\.(?:textContent|className) =/g
/** The `x !== lastX` guard each of those writes must sit behind. */
const DIFF_GUARDS = /!== last[A-Z]/g

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length

describe('FpsMeter — cross-file couplings', () => {
  /**
   * The floor tier is `TIER_BUDGET_MS.length - 1`, which is only correct
   * because `quality.ts` builds exactly one rung per entry of that array. It
   * does not export `TIERS` or its length, so the meter cannot ask; it derives.
   *
   * If a sixth budget were added without a sixth rung (or the reverse), the
   * derivation would be off by one and the floor marker would simply never
   * fire again — no error, no failing render, just the F187 state quietly
   * becoming invisible a second time. That is precisely the kind of regression
   * a test has to catch, because review will not.
   */
  it('derives the floor tier from a ladder that is still the same length as quality.ts\'s', () => {
    const rungs = count(QUALITY_SRC, /frameBudgetMs: TIER_BUDGET_MS\[/g)
    expect(rungs).toBe(TIER_BUDGET_MS.length)
    expect(METER_SRC).toContain('TIER_BUDGET_MS.length - 1')
  })

  /**
   * `STARVE_MEAN_RATIO` is a hand-copy of `quality.ts`'s
   * `STEP_DOWN_MEAN_RATIO`, which is not exported. The copy is the point — the
   * marker means "the governor would demote right now if it had anywhere to
   * go", and it only means that while the two numbers agree.
   */
  it('mirrors the governor\'s own demote ratio', () => {
    const governor = /STEP_DOWN_MEAN_RATIO = ([0-9.]+)/.exec(QUALITY_SRC)?.[1]
    const meter = /STARVE_MEAN_RATIO = ([0-9.]+)/.exec(METER_SRC)?.[1]
    expect(governor).toBeDefined()
    expect(meter).toBe(governor)
  })

  /** The meter must not have needed to open quality.ts to learn any of this. */
  it('reads quality.ts only through its existing public surface', () => {
    for (const member of ['quality.knobs', 'quality.refreshIntervalMs']) {
      expect(METER_SRC).toContain(member)
    }
    expect(METER_SRC).not.toMatch(/import\s*\{[^}]*\bTIERS\b/)
  })
})

describe('FpsMeter — measured GPU time (F186)', () => {
  it('shows perf.gpuMs beside the frame time', () => {
    expect(METER_SRC).toContain('perf.gpuMs')
    expect(METER_SRC).toMatch(/gpuRef/)
  })

  /**
   * Without `EXT_disjoint_timer_query_webgl2`, `perf.gpuMs` is frozen at
   * whatever it last held — 0 if it never measured. Formatting that would print
   * a fabricated `gpu 0.0`, which is worse than printing nothing: a reader
   * comparing it against a 27 ms frame would conclude the GPU is idle and the
   * cost is all CPU, which is a conclusion the machine never supplied evidence
   * for. The unavailable branch must therefore be a literal, not a number.
   */
  it('says n/a rather than formatting a frozen gpuMs when the timer is absent', () => {
    expect(METER_SRC).toMatch(/!perf\.gpuTimerAvailable\s*\r?\n?\s*\?\s*'gpu n\/a'/)
    // …and the only `toFixed` on gpuMs is downstream of that guard.
    const guard = METER_SRC.indexOf('!perf.gpuTimerAvailable')
    expect(guard).toBeGreaterThan(-1)
    expect(METER_SRC.indexOf('perf.gpuMs.toFixed')).toBeGreaterThan(guard)
  })
})

describe('FpsMeter — floor starvation (F187)', () => {
  /**
   * `used > budget` alone was the whole alarm, and at the floor tier with a
   * small modelled cost it is satisfied while the show drops half its frames.
   * The class must depend on the measured state too.
   */
  it('no longer colours the load readout on the model alone', () => {
    expect(METER_SRC).toMatch(/const loadClass = used > budget \|\| starved/)
  })

  /**
   * The two alarms are different claims and have to stay distinguishable on
   * screen: `8.2/6.5ms` red is the model admitting it is overcommitted,
   * `1.7/6.5ms · FLOOR` red is the model insisting it fits while the machine
   * drowns. Collapsing them back into one indistinguishable red would restore
   * half of F187.
   */
  it('marks the starved state in the text, not only in the colour', () => {
    expect(METER_SRC).toMatch(/starved \? ' · FLOOR' : ''/)
  })

  /**
   * The trigger is the tier being at the floor AND the measured mean missing
   * the measured refresh interval — not the modelled cost, which is the number
   * that was lying.
   */
  it('triggers on measured frame time against the measured refresh interval', () => {
    expect(METER_SRC).toMatch(/perf\.ms > quality\.refreshIntervalMs \* STARVE_MEAN_RATIO/)
    expect(METER_SRC).toMatch(/perf\.tier >= FLOOR_TIER/)
  })

  /**
   * `perf.p95` is the deliberately UNFILTERED sampler (transitions, DPR
   * resizes, compiles included) over a 10 s window, while the governor steps on
   * a filtered figure. ORing it into this predicate would light `FLOOR` for ten
   * seconds after any single crossfade hitch, and a marker that fires on every
   * transition is one the reader learns to ignore.
   */
  it('keeps the unfiltered p95 out of the starvation predicate', () => {
    const line = /const overloaded = .*/.exec(METER_SRC)?.[0] ?? ''
    expect(line).not.toContain('p95')
    expect(METER_SRC).toContain('STARVE_SAMPLES')
  })

  /**
   * A crossfade draws both primaries at full cost for about a second, which the
   * governor deliberately discounts rather than reading as an emergency. The
   * counter has to do the same or the marker fires on ordinary transitions:
   * simulated against the real EMA, a 1.5 s crossfade on a machine that is
   * COPING flashes it for ~0.6 s without this, and 0 times with it. Holding
   * rather than resetting matters in the other direction — a show transitioning
   * every 4 s would otherwise keep erasing the evidence on a machine that
   * really is drowning.
   */
  it('holds the starvation counter while a second primary is drawing', () => {
    expect(METER_SRC).toMatch(/if \(frameLoad\.incoming === 0\)/)
  })

  /**
   * The load text is made of the MODELLED costs, and at the floor those sit
   * perfectly still while the frame rots — `1.7/6.5 ms` held steady through the
   * whole 36 fps session. A className write nested inside the text diff would
   * therefore be skipped in exactly the state it exists to report.
   */
  it('diffs the load className independently of the load text', () => {
    expect(METER_SRC).toMatch(/loadClass !== lastLoadClass/)
  })
})

describe('FpsMeter — cost discipline', () => {
  /**
   * The file's own standing rule: "it would be absurd for the frame-cost meter
   * to be a frame-cost problem." Two fields were added to it; none of that may
   * arrive as React state or as per-frame work. F188 is the live example of a
   * readout that became a material part of the cost it reports.
   */
  it('stays throttled, stateless and single-rAF', () => {
    expect(METER_SRC).not.toMatch(/\buseState\b/)
    expect(METER_SRC).toContain('if (now - lastAt < INTERVAL_MS) return')
    expect(count(METER_SRC, /requestAnimationFrame\(/g)).toBe(2)
  })

  /** Every DOM write, old and new, sits behind its own diff. */
  it('diffs every DOM write', () => {
    const writes = count(METER_SRC, DOM_WRITES)
    expect(writes).toBeGreaterThanOrEqual(8)
    expect(count(METER_SRC, DIFF_GUARDS)).toBe(writes)
  })
})

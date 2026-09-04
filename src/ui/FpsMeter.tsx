import { useEffect, useRef } from 'react'
import { perf } from '../engine/PerfMonitor'
import { committedMs, frameLoad } from '../engine/frameLoad'
import { quality } from '../engine/quality'
import { TIER_BUDGET_MS } from '../engine/slotBudget'

/**
 * Standalone frame-time readout: fps, mean ms, GPU ms, p95 ms, quality tier.
 *
 * Separate from `DebugPanel` (which also prints fps) on purpose. That panel is
 * a 280×154 canvas redrawn every frame with a spectrum, band meters, beat
 * markers and mood telemetry — opening all of it to watch the frame rate
 * measurably changes the thing you are trying to measure. This is five numbers
 * of text.
 *
 * ## Why p95 is here and not just fps
 *
 * `perf.fps` is derived from an EMA, and an EMA structurally cannot show a
 * stall: with α = 0.05 a single 200 ms hitch lifts the mean by about 9 ms and
 * decays out within a second. A show can read a steady "60 fps" while visibly
 * stuttering once a second. `perf.p95` is the 95th percentile of raw frame
 * times over the last 10 s — the number that catches exactly that, and the
 * second axis the quality governor now steps on (see quality.ts).
 *
 * So the pair is the point: **fps tells you how fast it is, p95 tells you
 * whether it is smooth**, and this project's standing rule is that the second
 * one matters more.
 *
 * `tier` is shown alongside because a good-looking frame time at tier 4 means
 * something very different from the same number at tier 0 — the governor may
 * simply have already thrown away most of the visual quality to get there.
 *
 * ## Why measured GPU time is here (F186)
 *
 * The budget breakdown below is a MODEL: a table of bench-machine costs tapered
 * by tier. `perf.ms` is a MEASUREMENT. When they disagree — a live session ran
 * 27.6 ms mean while the model read `1.7/6.5 ms` — the model cannot tell you
 * which half of the frame it is missing, because it has no device-speed term
 * and does not price the post chain, the exposure readback or the per-frame
 * DSP at all.
 *
 * `perf.gpuMs` is the one number that splits that. It is a real
 * `EXT_disjoint_timer_query_webgl2` result, so `gpu` next to `ms` reads
 * directly as GPU-bound (the two converge) versus CPU-bound (a large gap:
 * JS, driver dispatch, vsync wait). It was already being measured and its only
 * consumers were `DebugPanel`, `sessionLog` and the offline bench — the number
 * that settles the argument was not next to the two numbers having it.
 *
 * ## Why `FLOOR` is here (F187)
 *
 * The load readout used to go red on `used > budget` and nothing else. At the
 * floor tier with a small modelled cost that comparison is *satisfied* while
 * the machine drops half its frames, so the single most alarming state in the
 * engine rendered as fine. `used > budget` and "the machine is keeping up" are
 * different claims and this readout was making the first one look like the
 * second; `FLOOR` is the second claim, stated separately.
 *
 * Follows the same DOM discipline as `BpmReadout`: throttled, and every write
 * diffed against the last one. It would be absurd for the frame-cost meter to
 * be a frame-cost problem.
 */

/** Refresh rate. Fast enough to feel live, slow enough to be readable. */
const HZ = 5
const INTERVAL_MS = 1000 / HZ

/**
 * p95 thresholds for the colour band, in ms. These mirror quality.ts's
 * `P95_STEP_UP_MS` / `P95_STEP_DOWN_MS`, so the readout turns amber at the
 * point the governor stops being willing to climb, and red at the point it
 * actively sheds load. The colour is telling you what the governor is about
 * to do.
 */
const P95_GOOD_MS = 22
const P95_BAD_MS = 34

/**
 * The bottom rung of the quality ladder — the tier with nothing below it.
 *
 * Derived rather than written as `4`, and derived from here rather than from
 * `quality.ts`, which owns the ladder but exports neither `TIERS` nor its
 * length. `slotBudget.ts` calls `TIER_BUDGET_MS` "**the single ladder**" and
 * `quality.ts` builds exactly one tier per entry of it (one
 * `frameBudgetMs: TIER_BUDGET_MS[n]` per rung), so the two lengths are the same
 * number by construction. That coupling is pinned in `fpsMeter.test.ts`, because
 * the failure mode if it ever broke is silent: a sixth rung added on one side
 * only would leave this readout permanently unable to fire.
 *
 * `quality.ts` is deliberately not touched to get this. It is the
 * highest-incident file in the repo and a readout is not a good enough reason
 * to open it.
 */
const FLOOR_TIER = TIER_BUDGET_MS.length - 1

/**
 * Mean frame time past which the governor sheds a tier, as a multiple of the
 * MEASURED display interval — quality.ts's own `STEP_DOWN_MEAN_RATIO`, which it
 * does not export, mirrored here for the same reason the p95 band above is.
 *
 * Ratio-of-refresh rather than absolute ms on purpose: 18.3 ms is late on a
 * 60 Hz panel and catastrophic on a 144 Hz one, and `quality.refreshIntervalMs`
 * is a measurement of the actual display.
 *
 * ## Why the mean and not p95
 *
 * The governor's `overloaded` is `mean > r * 1.1 || p95 > r * 1.5`, and only
 * the first half is reproducible here. `perf.ms` is `ema.current`, the exact
 * value handed to `quality.tick`. `perf.p95` is NOT: it is the deliberately
 * **unfiltered** display sampler, which includes scene transitions, DPR resizes
 * and shader compiles, while the governor reads the filtered
 * `frameSampler`-derived figure (`PerfMonitor.tsx:160-164, 418, 488` — the two
 * must not be the same value). Worse, that window is 10 s wide, so ORing it in
 * would pin `FLOOR` on for ten seconds after any single transition hitch. A
 * marker that lights on every crossfade teaches the reader to ignore it, which
 * costs more than the state it was added to show.
 */
const STARVE_MEAN_RATIO = 1.1

/**
 * Consecutive 5 Hz samples the starved condition must hold before it is shown —
 * one second.
 *
 * The EMA is smoothed but not immune: a single 200 ms hitch lifts it by ~9 ms
 * and decays out within about a second (see the header), which at the floor tier
 * is enough to clear the ratio for a sample or two. Requiring it to survive the
 * decay separates a hitch from a machine that is genuinely under water — the
 * session in F186 held it for the entire session. It clears on the first sample
 * that recovers; slow to alarm, immediate to stand down.
 *
 * Simulated against the real EMA (α = 0.05 per frame, sampled at 5 Hz): a
 * sustained 27.6 ms at the floor shows the marker for 46 of 51 samples, while a
 * single 200 ms hitch and a machine coping at 16.2 ms both show it zero times.
 */
const STARVE_SAMPLES = HZ

export function FpsMeter() {
  const fpsRef = useRef<HTMLSpanElement>(null)
  const msRef = useRef<HTMLSpanElement>(null)
  const gpuRef = useRef<HTMLSpanElement>(null)
  const p95Ref = useRef<HTMLSpanElement>(null)
  const tierRef = useRef<HTMLSpanElement>(null)
  const loadRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    let lastAt = 0
    let lastFps = ''
    let lastMs = ''
    let lastGpu = ''
    let lastP95 = ''
    let lastTier = ''
    let lastBand = ''
    let lastLoad = ''
    let lastLoadClass = ''
    /** Consecutive samples {@link STARVE_SAMPLES} is counting. */
    let starvedFor = 0

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < INTERVAL_MS) return
      lastAt = now

      const fps = perf.fps.toFixed(0)
      if (fps !== lastFps && fpsRef.current) {
        lastFps = fps
        fpsRef.current.textContent = fps
      }

      const ms = perf.ms.toFixed(1)
      if (ms !== lastMs && msRef.current) {
        lastMs = ms
        msRef.current.textContent = `${ms}ms`
      }

      // Measured GPU time, deliberately adjacent to the measured frame time it
      // is a component of: the GAP between them is everything else the frame
      // pays for, and reading the two side by side is the whole diagnostic.
      //
      // Three states, all of them honest. Without the timer extension `gpuMs`
      // stays frozen at whatever it last was — 0 if it never measured — so
      // printing `0.0` there would invent a measurement, and printing the last
      // value would date one. `n/a` says the machine cannot answer; `—` says it
      // can and the first query has not landed yet (results lag 1-3 frames).
      const gpu = !perf.gpuTimerAvailable
        ? 'gpu n/a'
        : perf.gpuMs > 0
          ? `gpu ${perf.gpuMs.toFixed(1)}`
          : 'gpu —'
      if (gpu !== lastGpu && gpuRef.current) {
        lastGpu = gpu
        gpuRef.current.textContent = gpu
      }

      const p95 = perf.p95.toFixed(1)
      const band = perf.p95 > P95_BAD_MS ? 'bad' : perf.p95 > P95_GOOD_MS ? 'warn' : 'good'
      if (p95Ref.current) {
        if (p95 !== lastP95) {
          lastP95 = p95
          p95Ref.current.textContent = `p95 ${p95}`
        }
        // className is a style invalidation too, so it gets the same diff.
        if (band !== lastBand) {
          lastBand = band
          p95Ref.current.className = `fps-p95 ${band}`
        }
      }

      // `T2` normally; `T3›2` while the render scale is still trailing the
      // logical tier. The complexity knobs change the instant the tier does —
      // only the DPR resize waits, deliberately (see RENDER_SCALE_HOLD_SEC in
      // PerfMonitor), and without this the meter would look stuck on the old
      // tier for three seconds while the frame was already getting cheaper.
      const tier =
        perf.appliedTier === perf.tier
          ? `T${perf.tier}`
          : `T${perf.appliedTier}›${perf.tier}`
      if (tier !== lastTier && tierRef.current) {
        lastTier = tier
        tierRef.current.textContent = tier
      }

      // Floor starvation (F187): the ladder is on its bottom rung and the frame
      // is STILL late. Both of the governor's demote branches are gated on
      // `tier < TIERS.length - 1`, so at the floor it does not demote into a
      // no-op — it never reaches the branch, and its entire response to a frame
      // running 1.66x the display interval is to re-arm the climb clock. No
      // log, no counter, no callback. This is the only place that says so.
      //
      // `perf.tier` rather than `quality.tier` (they are the same number —
      // `PerfMonitor.tsx:384` — but this is the one printed as `T4` two lines
      // up, so the marker can never contradict the tier beside it).
      const overloaded = perf.ms > quality.refreshIntervalMs * STARVE_MEAN_RATIO
      // The counter HOLDS rather than counts while a second primary is drawing
      // (`frameLoad.incoming` — a crossfade, or a candidate still warming). A
      // crossfade renders both scenes at full cost for about a second, so its
      // extra cost is expected rather than evidence, and the governor discounts
      // complexity for the duration precisely so it does not read as an
      // emergency. Measured: without this, a 1.5 s crossfade on a machine that
      // is COPING still flashes the marker for ~0.6 s, because the EMA stays
      // lifted after the overlap ends — chasing that with a longer gate needs
      // ~3 s and makes the real alarm sluggish. Holding rather than resetting
      // is deliberate: a show transitioning every few seconds would otherwise
      // keep erasing the evidence on a machine that really is drowning (it
      // still reports for 89 of 101 samples with a crossfade every 4 s).
      if (frameLoad.incoming === 0) {
        starvedFor = perf.tier >= FLOOR_TIER && overloaded ? starvedFor + 1 : 0
      }
      const starved = starvedFor >= STARVE_SAMPLES

      // Budget breakdown: subject + crossfade overlap + layers + effects +
      // fixed, against the tier's total capacity. This is the readout that
      // shows whether the budget is seeing the WHOLE frame — for a long time it
      // was not, and each claimant reserved against its own partial view of it
      // (see frameLoad.ts). Red once committed exceeds capacity.
      //
      // Milliseconds, one decimal. The currency used to be an abstract unit and
      // printed as an integer; now every term is a measured cost and floats
      // would otherwise render as `0.30000000000000004`.
      //
      // `· FLOOR` is appended rather than colour-coded separately because the
      // two alarms are different claims and have to stay tellable apart:
      // `8.2/6.5ms` red is "the model knows it is overcommitted", while
      // `1.7/6.5ms · FLOOR` red is "the model says this fits and the machine is
      // drowning anyway" — which is the more serious of the two and the one
      // that used to render as fine.
      const budget = quality.knobs.frameBudgetMs
      const used = committedMs()
      const d = (n: number) => n.toFixed(1)
      const load =
        `${d(frameLoad.primary)}+${d(frameLoad.incoming)}+${d(frameLoad.layers)}` +
        `+${d(frameLoad.effects)}+${d(frameLoad.fixed)} = ${d(used)}/${d(budget)}ms` +
        (starved ? ' · FLOOR' : '')
      if (load !== lastLoad && loadRef.current) {
        lastLoad = load
        loadRef.current.textContent = load
      }
      // Diffed on its own rather than nested inside the text diff above, and
      // that is load-bearing rather than tidiness: the modelled costs are what
      // this text is made of, and at the floor they sit PERFECTLY STILL while
      // the frame rots (F186's session held `1.7/6.5 ms` at 36 fps). A class
      // write reached only when the text changes would be skipped in exactly
      // the state it exists to report.
      const loadClass = used > budget || starved ? 'bad' : ''
      if (loadClass !== lastLoadClass && loadRef.current) {
        lastLoadClass = loadClass
        loadRef.current.className = `fps-load ${loadClass}`
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className="fps-meter glass"
      title="fps · mean frame time · measured GPU time (n/a without EXT_disjoint_timer_query_webgl2) · p95 frame time (unfiltered — includes scene transitions) · quality tier (applied›logical while the render scale catches up)"
    >
      <span ref={fpsRef} className="fps-value">
        —
      </span>
      <span className="fps-unit">fps</span>
      <span ref={msRef} className="fps-ms">
        —
      </span>
      <span
        ref={gpuRef}
        className="fps-ms"
        title="measured GPU execution time (EXT_disjoint_timer_query_webgl2), lagging 1-3 frames. Against mean frame time: converging means GPU-bound, a wide gap means the cost is JS / driver dispatch / vsync wait. `n/a` means this GPU or browser has no timer extension"
      >
        gpu —
      </span>
      <span ref={p95Ref} className="fps-p95 good">
        p95 —
      </span>
      <span ref={tierRef} className="fps-tier">
        T—
      </span>
      <span
        ref={loadRef}
        className="fps-load"
        title="frame budget: primary + crossfade overlap + layers + effects + fixed (post chain, AI overlay) = committed / tier capacity. Red when committed exceeds capacity. `· FLOOR` is the other, worse alarm: the governor is on the bottom rung with nothing left to shed and the frame is still missing the display interval — i.e. this budget fits and is not the story"
      >
        —
      </span>
    </div>
  )
}

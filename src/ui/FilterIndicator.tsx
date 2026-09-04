import { useEffect, useRef } from 'react'
import { performanceState } from '../engine/performanceState'

/**
 * Live readout of the ISF filter currently firing, and how wet it is.
 *
 * `FilterDirector` fires a ~3.5 s filter flourish autonomously on musical
 * events, and the HUD's `ISF filters` chips fire one by hand. Both land in the
 * same place — `performanceState.filter` — and until now neither was visible:
 * the picture changed and nothing said which of nine filters had done it, or
 * whether what you were looking at was the ramp up, the hold, or the tail.
 * This is that missing half. The chips are the input; this is the confirmation.
 *
 * ## Same DOM discipline as `FpsMeter`, for the same reason
 *
 * `FpsMeter`'s header states the rule this component inherits: *"It would be
 * absurd for the frame-cost meter to be a frame-cost problem."* An indicator
 * that watches a post-processing effect is in exactly that position — it is on
 * screen precisely when the frame is at its most expensive (the flourish is
 * running, so `IsfFilterPass` is mounted and drawing), so a re-render storm
 * here would land on the worst frames of the show and be blamed on the filter.
 *
 * So: one `requestAnimationFrame` loop, throttled, writing through `useRef`
 * DOM handles, with **every write diffed against the last value**. No
 * `useState`, and therefore no React render after mount. The loop runs while
 * idle too — the early return below is a subtraction and a compare, far
 * cheaper than mounting and unmounting a component on every flourish.
 *
 * ## Why it reads the singleton instead of subscribing
 *
 * `performanceState` is a mutable singleton by design (see its header's
 * "single-writer, mutable-by-design" note) — the director layer writes it in
 * place once per frame and allocates nothing. There is no subscription to take
 * and nothing would fire if there were. Polling it on a timer is the correct
 * and only way to read it, the same way `FpsMeter` polls `perf`.
 */

/**
 * Refresh rate.
 *
 * Higher than `FpsMeter`'s `HZ = 5`, deliberately, because this readout has a
 * moving BAR and that one has settling numbers. The `mix` envelope ramps up and
 * back down over the whole ~3.5 s flourish, so 5 Hz would draw the entire
 * gesture in ~17 steps and the bar would visibly staircase; 15 Hz gives ~52,
 * a step every 67 ms, which reads as continuous motion. Going past that buys
 * nothing a viewer can see and starts approaching per-frame cost — at 15 Hz
 * this does work on one frame in four, and on the other three it does a
 * timestamp compare and returns.
 */
const HZ = 15
const INTERVAL_MS = 1000 / HZ

export function FilterIndicator() {
  const rootRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  const fillRef = useRef<HTMLSpanElement>(null)
  const mixRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    let lastAt = 0
    let lastHidden: boolean | null = null
    let lastName = ''
    let lastPct = -1

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < INTERVAL_MS) return
      lastAt = now

      // Read fresh every tick: the director mutates this object in place, so
      // holding a reference across ticks would be reading a value that is
      // already stale by definition.
      const { id, mix } = performanceState.filter

      // Idle is the common case — no filter is firing for most of a show — so
      // the indicator takes no screen space at rest. `hidden` is an attribute
      // write and therefore a style invalidation, so it gets the same diff
      // every other write here gets.
      const hide = id === null
      if (hide !== lastHidden && rootRef.current) {
        lastHidden = hide
        rootRef.current.hidden = hide
      }
      if (hide) return

      if (id !== lastName && nameRef.current) {
        lastName = id
        nameRef.current.textContent = id
      }

      // Quantised to whole percent before the diff: `mix` is an eased envelope
      // and changes in the 1e-4 range on every single tick, so diffing the raw
      // float would write on literally every tick and defeat the point. One
      // percent is also the finest step a ~70px bar can actually show.
      const pct = Math.round(Math.max(0, Math.min(1, mix)) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        // `transform`, not `width`: scaling composites, width reflows the bar's
        // box 15 times a second for no visual difference.
        if (fillRef.current) fillRef.current.style.transform = `scaleX(${pct / 100})`
        if (mixRef.current) mixRef.current.textContent = `${pct}%`
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      ref={rootRef}
      className="filter-indicator glass"
      hidden
      title="ISF filter currently firing, and its wet/dry mix — fired by the filter director, or by hand from the HUD's ISF filters chips"
    >
      <span className="filter-indicator-label">filter</span>
      <span ref={nameRef} className="filter-indicator-name">
        —
      </span>
      <span className="filter-indicator-bar">
        <span ref={fillRef} className="filter-indicator-fill" />
      </span>
      <span ref={mixRef} className="filter-indicator-mix">
        0%
      </span>
    </div>
  )
}

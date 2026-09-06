import { useEffect, useRef } from 'react'
import { isLensActive, isMirrorActive, lensStyleName } from '../engine/opticalRack'
import { performanceState } from '../engine/performanceState'

/**
 * Live readout of the post-fx chain — everything `FilterIndicator` does NOT
 * already cover.
 *
 * `FilterIndicator` is the existing live "which effect + dial" readout, but
 * it only ever watches `performanceState.filter` (the ISF filter). Bloom,
 * chromatic aberration, vignette, fog, feedback trails, the mirror/lens
 * optical racks, and which effect-scene flourish (shock/flare/spark) is
 * currently firing had no live readout at all — the picture changed and
 * nothing on screen said which of these systems did it or by how much. This
 * is that missing half, deliberately scoped to NOT duplicate the filter row:
 * toggle this on and the ISF filter is still `FilterIndicator`'s job alone,
 * bottom-left.
 *
 * ## Same DOM discipline as `FilterIndicator`/`FpsMeter`, for the same reason
 *
 * This panel is on screen precisely when the post-fx chain is doing the most
 * work — a build tightening the vignette, a drop blowing out bloom, the
 * mirror rack actually drawing — so it sits in exactly the spot a naive
 * implementation would land its own cost on the frame it is reporting on.
 * One `requestAnimationFrame` loop, throttled, every DOM write through a
 * `useRef` handle and diffed against the last value before it touches
 * anything. No `useState` after mount, so no React render once this mounts.
 *
 * ## Why it reads the singleton instead of subscribing
 *
 * `performanceState` is a mutable singleton, written in place once per frame
 * by the director layer (`PerformanceStateBridge`, `EffectDirector`) — see
 * its own header's "single-writer, mutable-by-design" note. There is nothing
 * to subscribe to; polling it on a timer, the same way `FilterIndicator` and
 * `FpsMeter` do, is the correct and only way to read it.
 */

/**
 * Refresh rate, matching `FilterIndicator`'s own (see that file's comment for
 * the reasoning) — these are moving bars, not settling numbers, and 15 Hz is
 * fast enough to read as continuous motion without approaching per-frame cost.
 */
const HZ = 15
const INTERVAL_MS = 1000 / HZ

/** Below this a bar is visually indistinguishable from empty — the row hides
 *  rather than showing a bar nobody could see move. */
const OFF = 0.01

/**
 * Quantise `raw/max` to a whole percent and paint it into `fillEl`/`valueEl`
 * if it changed. Pure and reusable across every 0..max dial row below, same
 * reason `beatsPosition`/`advanceEffects` elsewhere in this codebase pull the
 * decision out of the component instead of inlining it five times.
 */
function paintBar(
  fillEl: HTMLSpanElement | null,
  valueEl: HTMLSpanElement | null,
  raw: number,
  max: number,
  lastPct: number,
): number {
  const pct = Math.round(Math.max(0, Math.min(1, raw / max)) * 100)
  if (pct === lastPct) return pct
  // `transform`, not `width` — scaling composites, width reflows.
  if (fillEl) fillEl.style.transform = `scaleX(${pct / 100})`
  if (valueEl) valueEl.textContent = `${pct}%`
  return pct
}

/** Paint a row's `hidden` attribute if it changed. */
function paintHidden(rootEl: HTMLDivElement | null, hide: boolean, lastHidden: boolean | null): boolean {
  if (hide !== lastHidden && rootEl) rootEl.hidden = hide
  return hide
}

export function PostFxMeter() {
  const bloomFillRef = useRef<HTMLSpanElement>(null)
  const bloomValueRef = useRef<HTMLSpanElement>(null)

  const glitchRootRef = useRef<HTMLDivElement>(null)
  const glitchFillRef = useRef<HTMLSpanElement>(null)
  const glitchValueRef = useRef<HTMLSpanElement>(null)

  const vignetteFillRef = useRef<HTMLSpanElement>(null)
  const vignetteValueRef = useRef<HTMLSpanElement>(null)

  const fogRootRef = useRef<HTMLDivElement>(null)
  const fogFillRef = useRef<HTMLSpanElement>(null)
  const fogValueRef = useRef<HTMLSpanElement>(null)

  const trailsRootRef = useRef<HTMLDivElement>(null)
  const trailsFillRef = useRef<HTMLSpanElement>(null)
  const trailsValueRef = useRef<HTMLSpanElement>(null)

  const mirrorRootRef = useRef<HTMLDivElement>(null)
  const mirrorLabelRef = useRef<HTMLSpanElement>(null)

  const lensRootRef = useRef<HTMLDivElement>(null)
  const lensLabelRef = useRef<HTMLSpanElement>(null)
  const lensFillRef = useRef<HTMLSpanElement>(null)

  const effectsRootRef = useRef<HTMLDivElement>(null)
  const effectsListRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    let lastAt = 0

    let lastBloomPct = -1
    let lastGlitchHidden: boolean | null = null
    let lastGlitchPct = -1
    let lastVignettePct = -1
    let lastFogHidden: boolean | null = null
    let lastFogPct = -1
    let lastTrailsHidden: boolean | null = null
    let lastTrailsPct = -1
    let lastMirrorHidden: boolean | null = null
    let lastMirrorText = ''
    let lastLensHidden: boolean | null = null
    let lastLensText = ''
    let lastLensPct = -1
    let lastEffectsHidden: boolean | null = null
    let lastEffectsText = ''

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastAt < INTERVAL_MS) return
      lastAt = now

      // Bloom and vignette have no "off" state (see performanceState.ts's own
      // doc: "there's no on/off, only magnitude"), so they always show.
      lastBloomPct = paintBar(bloomFillRef.current, bloomValueRef.current, performanceState.bloom, 2, lastBloomPct)
      lastVignettePct = paintBar(
        vignetteFillRef.current,
        vignetteValueRef.current,
        performanceState.vignette,
        1,
        lastVignettePct,
      )

      // Chromatic aberration, fog and trails genuinely do nothing at/near 0
      // (trails: the feedback pass is skipped outright), so those rows hide.
      const glitchHide = performanceState.glitch < OFF
      lastGlitchHidden = paintHidden(glitchRootRef.current, glitchHide, lastGlitchHidden)
      if (!glitchHide) {
        lastGlitchPct = paintBar(glitchFillRef.current, glitchValueRef.current, performanceState.glitch, 1, lastGlitchPct)
      }

      const fogHide = performanceState.fog < OFF
      lastFogHidden = paintHidden(fogRootRef.current, fogHide, lastFogHidden)
      if (!fogHide) {
        lastFogPct = paintBar(fogFillRef.current, fogValueRef.current, performanceState.fog, 1, lastFogPct)
      }

      const trailsHide = performanceState.trails < OFF
      lastTrailsHidden = paintHidden(trailsRootRef.current, trailsHide, lastTrailsHidden)
      if (!trailsHide) {
        lastTrailsPct = paintBar(
          trailsFillRef.current,
          trailsValueRef.current,
          performanceState.trails,
          1,
          lastTrailsPct,
        )
      }

      // Mirror: segments/tiles are pictures, not an intensity (see
      // MirrorRackState's own doc), so this is a summary line rather than a
      // bar — reuses the engine's own activity test rather than re-deriving
      // one from the raw fields.
      const mirror = performanceState.mirror
      const mirrorHide = !isMirrorActive(mirror)
      lastMirrorHidden = paintHidden(mirrorRootRef.current, mirrorHide, lastMirrorHidden)
      if (!mirrorHide) {
        // Rounded defensively: `segments` is a count that always snaps rather
        // than eases (see PerformanceStateBridge's own "5.5 segments is not a
        // look halfway between 4 and 8" note), but nothing enforces that at
        // the type level, so this guards against ever rendering "3.0000001-fold".
        const text = `${Math.round(mirror.segments)}-fold · spin ${mirror.spin.toFixed(2)}`
        if (text !== lastMirrorText) {
          lastMirrorText = text
          if (mirrorLabelRef.current) mirrorLabelRef.current.textContent = text
        }
      }

      // Lens: named material + amount bar, gated the same way.
      const lens = performanceState.lens
      const lensHide = !isLensActive(lens)
      lastLensHidden = paintHidden(lensRootRef.current, lensHide, lastLensHidden)
      if (!lensHide) {
        const name = lensStyleName(lens.style)
        if (name !== lastLensText) {
          lastLensText = name
          if (lensLabelRef.current) lensLabelRef.current.textContent = name
        }
        lastLensPct = paintBar(lensFillRef.current, null, lens.amount, 1, lastLensPct)
      }

      // Active effect-scene flourishes (shock/flare/spark, ...) — the
      // read-only equivalent of Console's EffectGroup chip highlighting.
      const effects = performanceState.layers.effects
      const effectsHide = effects.length === 0
      lastEffectsHidden = paintHidden(effectsRootRef.current, effectsHide, lastEffectsHidden)
      if (!effectsHide) {
        const text = effects.map((e) => e.id).join(', ')
        if (text !== lastEffectsText) {
          lastEffectsText = text
          if (effectsListRef.current) effectsListRef.current.textContent = text
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      className="postfx-meter glass"
      title="Live post-fx readout — bloom / CA / vignette / fog / trails / mirror / lens / active flourishes. The ISF filter has its own indicator, bottom-left."
    >
      <div className="postfx-row">
        <span className="postfx-label">bloom</span>
        <span className="postfx-bar">
          <span ref={bloomFillRef} className="postfx-fill" />
        </span>
        <span ref={bloomValueRef} className="postfx-value">
          0%
        </span>
      </div>
      <div ref={glitchRootRef} className="postfx-row" hidden>
        <span className="postfx-label">CA</span>
        <span className="postfx-bar">
          <span ref={glitchFillRef} className="postfx-fill" />
        </span>
        <span ref={glitchValueRef} className="postfx-value">
          0%
        </span>
      </div>
      <div className="postfx-row">
        <span className="postfx-label">vignette</span>
        <span className="postfx-bar">
          <span ref={vignetteFillRef} className="postfx-fill" />
        </span>
        <span ref={vignetteValueRef} className="postfx-value">
          0%
        </span>
      </div>
      <div ref={fogRootRef} className="postfx-row" hidden>
        <span className="postfx-label">fog</span>
        <span className="postfx-bar">
          <span ref={fogFillRef} className="postfx-fill" />
        </span>
        <span ref={fogValueRef} className="postfx-value">
          0%
        </span>
      </div>
      <div ref={trailsRootRef} className="postfx-row" hidden>
        <span className="postfx-label">trails</span>
        <span className="postfx-bar">
          <span ref={trailsFillRef} className="postfx-fill" />
        </span>
        <span ref={trailsValueRef} className="postfx-value">
          0%
        </span>
      </div>
      <div ref={mirrorRootRef} className="postfx-row" hidden>
        <span className="postfx-label">mirror</span>
        <span ref={mirrorLabelRef} className="postfx-summary">
          —
        </span>
      </div>
      <div ref={lensRootRef} className="postfx-row" hidden>
        <span className="postfx-label">lens</span>
        <span ref={lensLabelRef} className="postfx-summary postfx-summary-name">
          —
        </span>
        <span className="postfx-bar">
          <span ref={lensFillRef} className="postfx-fill" />
        </span>
      </div>
      <div ref={effectsRootRef} className="postfx-row" hidden>
        <span className="postfx-label">fx</span>
        <span ref={effectsListRef} className="postfx-summary">
          —
        </span>
      </div>
    </div>
  )
}

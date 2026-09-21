import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { performanceState } from '../engine/performanceState'
import { lookDebugEnabled } from '../engine/look/lookFlags'
import {
  formatLookDebug,
  LOOK_DEBUG_INTERVAL_MS,
  lookDebugProbe,
  type LookDebugSnapshot,
} from '../engine/look/lookDebug'

/**
 * The look overlay (`?lookdebug`): the mood profile and the values it produced, as monospace text in the
 * output window's top-left corner. Renders nothing at all without the flag (the flag is read once, at mount).
 *
 * DOM discipline follows `FpsMeter` / `BpmReadout`: no React state and no per-frame work. A ~4 Hz interval
 * reads the live singletons (`performanceState`, `audioEngine.features`, the grade probe `PostFXChain`
 * publishes), formats them (`look/lookDebug.ts`, tested) and writes `textContent` on one `<pre>`. It never
 * takes pointer events and sits above the canvas, so it cannot interfere with the show or with a recording of
 * the window it is in (it IS part of that window: turn it off with the flag before a capture).
 */

const STYLE: CSSProperties = {
  position: 'fixed',
  top: 8,
  left: 8,
  zIndex: 2147483000,
  margin: 0,
  padding: '6px 8px',
  font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: '#d7f7c8',
  background: 'rgba(0, 0, 0, 0.62)',
  border: '1px solid rgba(215, 247, 200, 0.25)',
  borderRadius: 3,
  whiteSpace: 'pre',
  pointerEvents: 'none',
  userSelect: 'none',
}

/** One snapshot of the live state. Allocates a little, four times a second, which is the point of the interval. */
function snapshot(): LookDebugSnapshot {
  const p = performanceState
  const c = audioEngine.features.character
  return {
    look: p.look,
    character: { valid: c.valid, confidence: c.confidence },
    applied: {
      bloom: p.bloom,
      glitch: p.glitch,
      vignette: p.vignette,
      fog: p.fog,
      trails: p.trails,
      echo: p.echo,
      lensStyle: p.lens.style,
      lensAmount: p.lens.amount,
      mirrorSegments: p.mirror.segments,
      mirrorTwist: p.mirror.twist,
      mirrorSpin: p.mirror.spin,
      mirrorMix: p.mirror.mix ?? 1,
      cameraMode: p.cameraMode,
      transitionStyle: p.transitionStyle,
    },
    grade: lookDebugProbe,
  }
}

export function LookDebug() {
  const enabled = useMemo(() => lookDebugEnabled(), [])
  const ref = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      const el = ref.current
      if (el) el.textContent = formatLookDebug(snapshot()).join('\n')
    }
    tick()
    const id = window.setInterval(tick, LOOK_DEBUG_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [enabled])

  if (!enabled) return null
  return <pre ref={ref} style={STYLE} aria-hidden="true" />
}

import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'

/**
 * Live BPM / beat display. Updates the DOM directly on rAF — no React
 * re-renders at 60 fps.
 *
 * ## Why this is throttled and diffed
 *
 * This is now the only always-on per-frame DOM surface in the app, so it
 * inherits the cost problem that got the full-viewport tactical overlay
 * removed: work on the main thread, every frame, competing with the render
 * loop's own rAF for the same budget.
 *
 * Two rules keep it cheap.
 *
 * 1. **Text and width update at {@link TEXT_HZ}, not per frame.** A tempo
 *    readout that changes 60 times a second is not more informative than one
 *    that changes 10 times a second — it is just less readable. Every write
 *    here is a style/layout invalidation, and `textContent` on a number that
 *    did not change costs exactly as much as one that did.
 *
 * 2. **Nothing is written unless the value actually changed.** Assigning an
 *    identical string still dirties the node, so the diff below is what turns a
 *    steady tempo into genuinely zero layout work rather than merely cheap
 *    layout work.
 *
 * The beat dot is the deliberate exception: it runs every frame because it is
 * the one element whose whole job is to look locked to the music, and it
 * animates only `opacity` and `transform` — compositor-only properties that
 * trigger neither layout nor paint.
 */

/** How often the numeric/text fields refresh, in Hz. See the header. */
const TEXT_HZ = 10
const TEXT_INTERVAL_MS = 1000 / TEXT_HZ

export function BpmReadout() {
  const bpmRef = useRef<HTMLSpanElement>(null)
  const confRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const moodRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    let lastTextAt = 0
    // Last values actually written to the DOM, so an unchanged frame writes
    // nothing at all. Seeded to sentinels that cannot equal a real first value.
    let lastBpm = ''
    let lastConf = -1
    let lastBar = ''
    let lastMood = ''

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const f = audioEngine.features

      // --- every frame: compositor-only properties ---
      if (dotRef.current) {
        const pulse = Math.pow(1 - f.beatProgress, 2)
        dotRef.current.style.opacity = String(0.25 + pulse * 0.75 * Math.min(1, f.confidence * 3))
        dotRef.current.style.transform = `scale(${1 + pulse * 0.5})`
      }

      // --- throttled: anything that invalidates layout ---
      if (now - lastTextAt < TEXT_INTERVAL_MS) return
      lastTextAt = now

      if (bpmRef.current) {
        const bpm = f.confidence > 0.05 ? f.bpm.toFixed(1) : '—'
        if (bpm !== lastBpm) {
          lastBpm = bpm
          bpmRef.current.textContent = bpm
        }
      }
      if (confRef.current) {
        const conf = Math.round(f.confidence * 100)
        if (conf !== lastConf) {
          lastConf = conf
          confRef.current.style.width = `${conf}%`
        }
      }
      if (barRef.current) {
        const bar = `${f.beatInBar + 1}·${(f.bar % 4) + 1}`
        if (bar !== lastBar) {
          lastBar = bar
          barRef.current.textContent = bar
        }
      }
      if (moodRef.current) {
        const m = f.mood
        const arrow =
          m.predictedState !== m.state && m.beatsTillTransition >= 0 ? ` → ${m.predictedState}` : ''
        const mood = f.silence ? '' : `${m.state}${arrow}`
        if (mood !== lastMood) {
          lastMood = mood
          moodRef.current.textContent = mood
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="bpm-readout glass">
      <div ref={dotRef} className="beat-dot" />
      <div className="bpm-main">
        <span ref={bpmRef} className="bpm-value">
          —
        </span>
        <span className="bpm-label">BPM</span>
        <span ref={barRef} className="bar-label">
          1·1
        </span>
        <span ref={moodRef} className="mood-label" />
      </div>
      <div className="conf-track">
        <div ref={confRef} className="conf-fill" />
      </div>
    </div>
  )
}

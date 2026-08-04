import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'

/**
 * Live BPM / beat display. Updates the DOM directly on rAF — no React
 * re-renders at 60 fps.
 */
export function BpmReadout() {
  const bpmRef = useRef<HTMLSpanElement>(null)
  const confRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const moodRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const f = audioEngine.features
      if (bpmRef.current) {
        bpmRef.current.textContent = f.confidence > 0.05 ? f.bpm.toFixed(1) : '—'
      }
      if (confRef.current) {
        confRef.current.style.width = `${Math.round(f.confidence * 100)}%`
      }
      if (dotRef.current) {
        const pulse = Math.pow(1 - f.beatProgress, 2)
        dotRef.current.style.opacity = String(0.25 + pulse * 0.75 * Math.min(1, f.confidence * 3))
        dotRef.current.style.transform = `scale(${1 + pulse * 0.5})`
      }
      if (barRef.current) {
        barRef.current.textContent = `${f.beatInBar + 1}·${(f.bar % 4) + 1}`
      }
      if (moodRef.current) {
        const m = f.mood
        const arrow =
          m.predictedState !== m.state && m.beatsTillTransition >= 0 ? ` → ${m.predictedState}` : ''
        moodRef.current.textContent = f.silence ? '' : `${m.state}${arrow}`
      }
      raf = requestAnimationFrame(tick)
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

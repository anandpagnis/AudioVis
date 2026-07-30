import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { perf } from '../engine/PerfMonitor'
import { genStatus } from '../engine/textureGenerator'

const W = 280
const H = 154

/** Spectrum + band meters + beat markers, drawn straight to a canvas. */
export function DebugPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let flash = 0

    const draw = () => {
      const f = audioEngine.features
      ctx.clearRect(0, 0, W, H)

      // Spectrum (log-ish bucketing for readability).
      const bars = 64
      ctx.fillStyle = 'rgba(120, 200, 255, 0.75)'
      for (let i = 0; i < bars; i++) {
        const start = Math.floor(Math.pow(i / bars, 1.8) * f.spectrum.length)
        const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / bars, 1.8) * f.spectrum.length))
        let v = 0
        for (let j = start; j < end; j++) v = Math.max(v, f.spectrum[j])
        const h = Math.min(1, v * 14) * (H - 40)
        ctx.fillRect((i / bars) * W, H - 22 - h, W / bars - 1, h)
      }

      // Band meters.
      const meters: [string, number, string][] = [
        ['bass', f.bass, '#ff8a65'],
        ['mid', f.mid, '#ffd54f'],
        ['high', f.high, '#81d4fa'],
        ['rms', f.rms, '#b0bec5'],
      ]
      meters.forEach(([label, v, color], i) => {
        const x = 6 + i * 68
        ctx.fillStyle = 'rgba(255,255,255,0.12)'
        ctx.fillRect(x, H - 16, 40, 6)
        ctx.fillStyle = color
        ctx.fillRect(x, H - 16, 40 * v, 6)
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.font = '9px ui-monospace, monospace'
        ctx.fillText(label, x + 44, H - 10)
      })

      // Beat flash + structure flags.
      if (f.beat) flash = 1
      flash *= 0.9
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.9})`
      ctx.beginPath()
      ctx.arc(W - 14, 14, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.font = '10px ui-monospace, monospace'
      const flags = [
        f.silence ? 'silence' : null,
        f.buildUp ? 'build' : null,
        f.drop ? 'DROP' : null,
        f.sectionChange ? 'SECTION' : null,
      ]
        .filter(Boolean)
        .join(' ')
      ctx.fillText(
        `${f.bpm.toFixed(1)} bpm  conf ${(f.confidence * 100).toFixed(0)}%  ${flags}`,
        6,
        14,
      )
      // Phrase progress strip.
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(6, 20, W - 40, 3)
      ctx.fillStyle = 'rgba(179, 136, 255, 0.9)'
      ctx.fillRect(6, 20, (W - 40) * f.phraseProgress, 3)
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(`ph ${f.phrase}`, W - 30, 26)
      // Render stats + GPU telemetry.
      ctx.fillText(`${perf.fps.toFixed(0)} fps @ ${perf.dpr.toFixed(2)}×`, 6, 36)
      ctx.fillStyle = 'rgba(255, 214, 130, 0.8)'
      ctx.fillText(
        `${perf.drawCalls} draws  ${(perf.triangles / 1000).toFixed(0)}k tris  geo ${perf.geometries}  tex ${perf.textures}  prg ${perf.programs}`,
        6,
        60,
      )
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      // Mood readout: state → prediction, velocities, generative backend.
      const m = f.mood
      const pred =
        m.predictedState !== m.state && m.beatsTillTransition >= 0
          ? ` → ${m.predictedState} in ~${m.beatsTillTransition.toFixed(0)}b`
          : ''
      const gen = !genStatus.available
        ? 'gen:off'
        : genStatus.pending > 0
          ? `gen:${genStatus.pending}…`
          : 'gen:ok'
      ctx.fillStyle = 'rgba(130, 255, 190, 0.85)'
      ctx.fillText(
        `${m.state}${pred}  ${(m.confidence * 100).toFixed(0)}%  vE ${m.energyVel >= 0 ? '+' : ''}${m.energyVel.toFixed(2)}  ${gen}`,
        6,
        48,
      )

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="debug-panel glass">
      <canvas ref={canvasRef} width={W} height={H} />
    </div>
  )
}

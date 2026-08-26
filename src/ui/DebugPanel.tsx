import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { essentiaBridge } from '../audio/essentia/EssentiaBridge'
import { voiceBridge } from '../audio/essentia/VoiceBridge'
import { perf } from '../engine/PerfMonitor'
import { exposure } from '../engine/exposure'

const W = 280
/**
 * Panel height. Rows sit on a 12px grid starting at y=14:
 *
 *   14 bpm · 26 phrase strip · 36 fps/tier/dpr · 48 render scale ·
 *   60 exposure · 72 GPU telemetry · 84 mood · 96 key · 108 voice
 *
 * Written down because the rows are drawn by separate blocks in this file and
 * two of them silently shared y=48 for a while — the later draw simply painted
 * over the earlier one, which looks like a missing readout rather than a
 * collision. Add a row here before adding one below.
 */
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
        const end = Math.max(
          start + 1,
          Math.floor(Math.pow((i + 1) / bars, 1.8) * f.spectrum.length),
        )
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
      const est = audioEngine.bpmEstimator
      const oct = est.octaveCorrection
      const ess = essentiaBridge.status
      const flags = [
        // Tempo source: essentia worker read vs. the built-in IOI histogram.
        est.isModelDriven(f.time)
          ? `ess:${ess.lastMethod.slice(0, 4)}`
          : ess.error
            ? 'ess:err'
            : null,
        oct !== 1 ? `oct×${oct}` : null,
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
      // Render stats + GPU telemetry. p95 and tier are here for the same reason
      // FpsMeter shows them: fps comes off an EMA and cannot represent a stall,
      // so a show can read a steady 60 while visibly stuttering. p95 is the
      // hitch metric, and the tier says how much quality the governor already
      // gave up to reach that frame time.
      ctx.fillText(
        `${perf.fps.toFixed(0)} fps  ${perf.ms.toFixed(1)}ms  p95 ${perf.p95.toFixed(1)}  T${perf.tier} @ ${perf.dpr.toFixed(2)}×`,
        6,
        36,
      )
      // The internal-resolution governor's own readout: what the live
      // composition asked for, and what it is actually getting. The two differ
      // when the display cannot deliver the budget even at full scale (the
      // solve caps at 1) or when it is pinned at the floor — and reading which
      // of those is happening is otherwise guesswork from the DPR alone.
      ctx.fillText(
        `${perf.internalMP.toFixed(2)}/${perf.pixelBudget.toFixed(2)} MP  ×${perf.renderScale.toFixed(2)}`,
        6,
        48,
      )
      // The exposure servo's inputs AND its output. Calibration of the targets
      // is explicitly outstanding (docs/09_Rendering_Engine.md: only valid
      // against a real playing track), and a servo whose measurements you
      // cannot see is one you cannot calibrate. `--` until the first sample.
      ctx.fillText(
        exposure.sampled
          ? `exp ×${exposure.gain.toFixed(2)}  luma ${exposure.mean.toFixed(3)}` +
              `  p85 ${exposure.p85.toFixed(2)} p99 ${exposure.p99.toFixed(2)}` +
              `  blown ${(exposure.blownShare * 100).toFixed(1)}%`
          : 'exp -- (no sample yet)',
        6,
        60,
      )
      ctx.fillStyle = 'rgba(255, 214, 130, 0.8)'
      ctx.fillText(
        `${perf.drawCalls} draws  ${(perf.triangles / 1000).toFixed(0)}k tris  geo ${perf.geometries}  tex ${perf.textures}  prg ${perf.programs}`,
        6,
        72,
      )
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      // Mood readout: state → prediction, velocities.
      const m = f.mood
      const pred =
        m.predictedState !== m.state && m.beatsTillTransition >= 0
          ? ` → ${m.predictedState} in ~${m.beatsTillTransition.toFixed(0)}b`
          : ''
      ctx.fillStyle = 'rgba(130, 255, 190, 0.85)'
      ctx.fillText(
        `${m.state}${pred}  ${(m.confidence * 100).toFixed(0)}%  vE ${m.energyVel >= 0 ? '+' : ''}${m.energyVel.toFixed(2)}`,
        6,
        84,
      )
      // Key + raw danceability from the essentia worker (read-only for now).
      if (f.key || f.danceability > 0) {
        ctx.fillStyle = 'rgba(179, 136, 255, 0.85)'
        ctx.fillText(
          `${f.key ? `${f.key} ${f.scale} ${f.keyConfidence.toFixed(2)}` : 'key —'}   dance ${f.danceability.toFixed(2)}`,
          6,
          96,
        )
      }
      // Voice + mood heads from the classifier worker (read-only for now).
      const vs = voiceBridge.status
      if (vs.runs > 0) {
        ctx.fillStyle = 'rgba(255, 183, 197, 0.9)'
        const m = f.moods
        ctx.fillText(
          `voc ${(f.vocalPresence * 100).toFixed(0)}%  hap ${m.happy.toFixed(2)} agg ${m.aggressive.toFixed(2)} par ${m.party.toFixed(2)} rel ${m.relaxed.toFixed(2)}`,
          6,
          108,
        )
      } else if (vs.error) {
        ctx.fillStyle = 'rgba(255, 138, 101, 0.75)'
        ctx.fillText(`voice: ${vs.missing ? 'models not fetched' : vs.error.slice(0, 34)}`, 6, 108)
      }

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

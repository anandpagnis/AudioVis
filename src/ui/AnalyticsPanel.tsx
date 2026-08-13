import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { essentiaBridge } from '../audio/essentia/EssentiaBridge'
import { voiceBridge } from '../audio/essentia/VoiceBridge'
import { keyPaletteTracker } from '../engine/keyPalette'
import { performanceState } from '../engine/performanceState'
import type { MoodState } from '../audio/types'
import { analytics } from '../engine/analyticsMetrics'
import { frameTimeWindow } from '../engine/PerfMonitor'
import { transitionMetrics } from '../engine/transitionMetrics'

const W = 320
const H = 352

const MOOD_ORDER: MoodState[] = [
  'silence',
  'ambient',
  'mellow',
  'groove',
  'building',
  'peak',
  'aggressive',
]
const MOOD_LABEL: Record<MoodState, string> = {
  silence: 'sil',
  ambient: 'amb',
  mellow: 'mel',
  groove: 'grv',
  building: 'bld',
  peak: 'pek',
  aggressive: 'agr',
}

function sparkline(
  ctx: CanvasRenderingContext2D,
  values: readonly { t: number; v: number }[],
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  scale = 1,
) {
  if (values.length < 2) return
  const t0 = values[0].t
  const span = Math.max(0.001, values[values.length - 1].t - t0)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  values.forEach((s, i) => {
    const px = x + ((s.t - t0) / span) * w
    const py = y + h - Math.max(0, Math.min(1, s.v / scale)) * h
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()
}

/**
 * Numeric replacement/supplement for the "does it beatmatch, transition
 * smoothly, and pick up the vibe" manual checks (HANDOFF §8): rolling
 * beat-tracking accuracy, mood confidence/ambiguity and the live 7-state
 * score distribution, section-boundary strength, frame-time percentiles, and
 * a recent-transitions table with target vs. actual fade timing.
 *
 * Same pattern as DebugPanel: no React state, RAF-driven canvas, reads the
 * analytics singletons fresh every frame.
 */
export function AnalyticsPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0

    const draw = () => {
      const f = audioEngine.features
      ctx.clearRect(0, 0, W, H)
      ctx.font = '9px ui-monospace, monospace'

      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillText('ANALYTICS', 6, 12)

      // --- Frame time distribution (percentiles, not just the EMA) ---
      const meanMs = frameTimeWindow.mean()
      const p95Ms = frameTimeWindow.percentile(0.95)
      const maxMs = frameTimeWindow.max()
      ctx.fillStyle = p95Ms > 20 ? 'rgba(255, 138, 101, 0.9)' : 'rgba(255,255,255,0.7)'
      ctx.fillText(
        `frame  mean ${meanMs.toFixed(1)}ms  p95 ${p95Ms.toFixed(1)}ms  max ${maxMs.toFixed(1)}ms`,
        6,
        24,
      )

      // --- Beat-grid accuracy ---
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(`beat accuracy  ${(f.beatGridAccuracy * 100).toFixed(0)}%`, 6, 40)
      sparkline(ctx, analytics.bpmAccuracy.values(), 6, 44, W - 12, 22, 'rgba(120, 200, 255, 0.9)')

      // --- Mood confidence / ambiguity ---
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(
        `mood confidence ${(f.mood.confidence * 100).toFixed(0)}%  ambiguity ${(f.mood.ambiguity * 100).toFixed(0)}%`,
        6,
        84,
      )
      sparkline(
        ctx,
        analytics.moodConfidence.values(),
        6,
        88,
        W - 12,
        22,
        'rgba(130, 255, 190, 0.9)',
      )
      sparkline(
        ctx,
        analytics.moodAmbiguity.values(),
        6,
        88,
        W - 12,
        22,
        'rgba(255, 214, 130, 0.7)',
      )

      // --- Live mood-score distribution (how close was the runner-up?) ---
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText('mood scores', 6, 128)
      const scores = f.mood.scores
      const maxScore = Math.max(0.01, ...MOOD_ORDER.map((s) => scores[s]))
      const barW = (W - 12) / MOOD_ORDER.length
      const barBase = 156
      const barMaxH = 24
      MOOD_ORDER.forEach((s, i) => {
        const bh = (scores[s] / maxScore) * barMaxH
        const x = 6 + i * barW
        ctx.fillStyle = s === f.mood.state ? 'rgba(130, 255, 190, 0.9)' : 'rgba(255,255,255,0.25)'
        ctx.fillRect(x, barBase - bh, barW - 3, bh)
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.fillText(MOOD_LABEL[s], x, barBase + 10)
      })

      // --- Section-change strength vs. its 0.45 firing threshold ---
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(`section strength  ${f.sectionChangeStrength.toFixed(2)} (fires > 0.45)`, 6, 182)
      const secY = 186
      const secH = 18
      const secScale = 1.2
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.beginPath()
      const thresholdY = secY + secH - (0.45 / secScale) * secH
      ctx.moveTo(6, thresholdY)
      ctx.lineTo(W - 6, thresholdY)
      ctx.stroke()
      const secValues = analytics.sectionStrength.values()
      if (secValues.length > 0) {
        const t0 = secValues[0].t
        const span = Math.max(0.001, secValues[secValues.length - 1].t - t0)
        ctx.fillStyle = 'rgba(179, 136, 255, 0.9)'
        for (const s of secValues) {
          const px = 6 + ((s.t - t0) / span) * (W - 12)
          const py = secY + secH - (Math.min(secScale, s.v) / secScale) * secH
          ctx.beginPath()
          ctx.arc(px, py, 2, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // --- Essentia worker: key / danceability (surfaced, not yet wired) ---
      const ess = essentiaBridge.status
      ctx.fillStyle = ess.error ? 'rgba(255, 138, 101, 0.9)' : 'rgba(255,255,255,0.6)'
      if (ess.error) {
        ctx.fillText(`essentia  ${ess.error.slice(0, 40)}`, 6, 212)
      } else if (ess.keyRuns === 0 && ess.danceRuns === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText('essentia  (awaiting first 12s window)', 6, 212)
      } else {
        const keyTxt = f.key ? `${f.key} ${f.scale}` : '—'
        ctx.fillStyle = 'rgba(179, 136, 255, 0.9)'
        ctx.fillText(
          `key ${keyTxt.padEnd(9)} str ${f.keyConfidence.toFixed(2)}  dance ${f.danceability.toFixed(2)} (raw)`,
          6,
          212,
        )
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        ctx.fillText(
          `  ${ess.keyMs.toFixed(0)}ms/${ess.keyRuns}  ${ess.danceMs.toFixed(0)}ms/${ess.danceRuns}  rhythm ${ess.lastMs.toFixed(0)}ms`,
          6,
          224,
        )
      }

      // --- Voice / mood classifier (surfaced, not wired) ---
      const vs = voiceBridge.status
      if (vs.runs > 0) {
        const m = f.moods
        ctx.fillStyle = 'rgba(255, 183, 197, 0.9)'
        ctx.fillText(`voice ${(f.vocalPresence * 100).toFixed(0)}% of recent segments`, 6, 238)
        // Four mood heads as small bars — they share one embedding, so this
        // whole row costs ~1.5 ms on top of the voice read.
        const MOODS: [string, number][] = [
          ['hap', m.happy],
          ['agg', m.aggressive],
          ['par', m.party],
          ['rel', m.relaxed],
        ]
        MOODS.forEach(([label, v], i) => {
          const x = 6 + i * 76
          ctx.fillStyle = 'rgba(255,255,255,0.12)'
          ctx.fillRect(x + 22, 244, 46, 5)
          ctx.fillStyle = 'rgba(255, 183, 197, 0.9)'
          ctx.fillRect(x + 22, 244, 46 * Math.max(0, Math.min(1, v)), 5)
          ctx.fillStyle = 'rgba(255,255,255,0.55)'
          ctx.fillText(label, x, 249)
        })
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        // What the signals are actually DOING, not just what they read —
        // these four are wired now, so the panel shows the downstream effect.
        ctx.fillText(
          `focus ${performanceState.voiceFocus.toFixed(2)}  bloom ${performanceState.bloom.toFixed(2)}  ` +
            `fog ${performanceState.fog.toFixed(2)}  key→${keyPaletteTracker.family || '—'}`,
          6,
          262,
        )
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText(
          vs.error
            ? `voice: ${vs.missing ? 'models not fetched (see scripts/)' : vs.error.slice(0, 34)}`
            : 'voice: (awaiting first classification)',
          6,
          238,
        )
      }

      // --- Recent transitions: target vs. actual duration, frame-time p95 ---
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText('recent transitions', 6, 280)
      const rows = transitionMetrics.history.slice(-4).reverse()
      if (rows.length === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText('(switch scenes to populate)', 6, 294)
      }
      rows.forEach((r, i) => {
        const y = 294 + i * 14
        const off =
          Math.abs(r.actualDurationSec - r.targetDurationSec) / Math.max(0.01, r.targetDurationSec)
        const flagged = off > 0.25 || r.frameMsDuringFade.p95 > 20
        ctx.fillStyle = flagged ? 'rgba(255, 138, 101, 0.9)' : 'rgba(255,255,255,0.65)'
        const label = `${r.fromScene ?? '–'}→${r.toScene}`.slice(0, 20).padEnd(20)
        ctx.fillText(
          `${label} ${r.hardCut ? 'cut ' : 'fade'} ${r.targetDurationSec.toFixed(1)}/${r.actualDurationSec.toFixed(1)}s p95:${r.frameMsDuringFade.p95.toFixed(0)}ms`,
          6,
          y,
        )
      })

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="analytics-panel glass">
      <canvas ref={canvasRef} width={W} height={H} />
    </div>
  )
}

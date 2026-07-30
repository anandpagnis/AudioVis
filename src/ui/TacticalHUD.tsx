import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { getPalette } from '../engine/palettes'
import { useStore } from '../store'

/** #rrggbb → {r,g,b} (0..255). */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

type RGB = { r: number; g: number; b: number }
const TAU = Math.PI * 2

/**
 * Evangelion-inspired tactical HUD. A full-viewport canvas overlay that reads
 * audioEngine.features directly on rAF (never re-renders React), so it can
 * animate at 60 fps in lockstep with the beat grid. Part of the *show* — it
 * follows its own `tacticalHud` toggle, independent of the control chrome's
 * hide (`H`). Colored by the active palette so it harmonizes with the scene.
 */
export function TacticalHUD() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let W = 0
    let H = 0
    let dpr = 1

    // Smoothed palette colors so switches sweep rather than snap.
    const pal = getPalette(useStore.getState().paletteId)
    const col: RGB = hexToRgb(pal.colors[0]) // primary — structure
    const acc: RGB = hexToRgb(pal.colors[2]) // accent — highlights
    const sec: RGB = hexToRgb(pal.colors[1]) // secondary — warnings

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const rgba = (c: RGB, a: number) =>
      `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${Math.max(0, Math.min(1, a))})`
    const lerp = (c: RGB, t: RGB, k: number) => {
      c.r += (t.r - c.r) * k
      c.g += (t.g - c.g) * k
      c.b += (t.b - c.b) * k
    }
    const mono = (px: number) => `${px}px ui-monospace, "SF Mono", Menlo, monospace`

    // Telemetry state, nudged on each beat for a "live feed" jitter.
    const tel = { lat: 35.71, lon: 139.7669, sig: 0.7 }

    const draw = (f: typeof audioEngine.features) => {
      const bp = Math.pow(1 - f.beatProgress, 2) * Math.min(1, f.confidence * 3)
      const t = f.time
      const small = W < 620

      // ---- Corner brackets (targeting frame) --------------------------------
      const m = 26
      const L = 30 + bp * 8
      ctx.lineWidth = 1.5
      ctx.strokeStyle = rgba(acc, 0.45 + bp * 0.35)
      const corner = (x: number, y: number, dx: number, dy: number) => {
        ctx.beginPath()
        ctx.moveTo(x, y + dy * L)
        ctx.lineTo(x, y)
        ctx.lineTo(x + dx * L, y)
        ctx.stroke()
      }
      corner(m, m, 1, 1)
      corner(W - m, m, -1, 1)
      corner(m, H - m, 1, -1)
      corner(W - m, H - m, -1, -1)

      // ---- Top-left: system label + katakana --------------------------------
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillStyle = rgba(acc, 0.9)
      ctx.font = mono(13)
      ctx.fillText('AUDIOVIS // 音響解析', m + 12, m + 8)
      ctx.fillStyle = rgba(col, 0.5)
      ctx.font = mono(10)
      const status = f.silence ? 'STANDBY' : f.mood.state.toUpperCase()
      ctx.fillText(`SYS.LINK ● ${status}`, m + 12, m + 26)

      // ---- Scan line (CRT sweep) --------------------------------------------
      const scanY = (t * 90) % (H + 120) - 60
      const grd = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 4)
      grd.addColorStop(0, rgba(col, 0))
      grd.addColorStop(1, rgba(col, 0.06))
      ctx.fillStyle = grd
      ctx.fillRect(0, scanY - 40, W, 44)
      ctx.strokeStyle = rgba(col, 0.18)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, scanY)
      ctx.lineTo(W, scanY)
      ctx.stroke()

      // ---- Radar (bottom-left) with radial spectrum -------------------------
      const cx = small ? 96 : 132
      const cy = H - (small ? 96 : 132)
      const R = small ? 64 : 92
      ctx.save()
      ctx.translate(cx, cy)

      // rings
      ctx.strokeStyle = rgba(col, 0.28)
      ctx.lineWidth = 1
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath()
        ctx.arc(0, 0, (R * i) / 3, 0, TAU)
        ctx.stroke()
      }
      // crosshair
      ctx.strokeStyle = rgba(col, 0.18)
      ctx.beginPath()
      ctx.moveTo(-R, 0)
      ctx.lineTo(R, 0)
      ctx.moveTo(0, -R)
      ctx.lineTo(0, R)
      ctx.stroke()

      // radial spectrum around the dial
      const spec = f.spectrum
      const N = 72
      for (let i = 0; i < N; i++) {
        // log-ish sampling: emphasize lows
        const idx = Math.floor(Math.pow(i / N, 1.7) * (spec.length * 0.7))
        const v = spec[idx] || 0
        const a = (i / N) * TAU - Math.PI / 2
        const r0 = R + 3
        const r1 = R + 3 + v * (small ? 26 : 40)
        ctx.strokeStyle = rgba(i % 6 === 0 ? acc : col, 0.35 + v * 0.6)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
        ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1)
        ctx.stroke()
      }

      // beat ticks (16 = one phrase), current beat highlighted
      const beatPos = ((f.beatIndex % 16) + f.beatProgress) / 16
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU - Math.PI / 2
        const major = i % 4 === 0
        ctx.strokeStyle = rgba(major ? acc : col, major ? 0.5 : 0.28)
        ctx.lineWidth = major ? 2 : 1
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * (R - 8), Math.sin(a) * (R - 8))
        ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R)
        ctx.stroke()
      }

      // sweep line + head blip, anchored to the beat position
      const sweep = beatPos * TAU - Math.PI / 2
      ctx.save()
      ctx.rotate(sweep)
      // leading line
      ctx.strokeStyle = rgba(acc, 0.85)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(R, 0)
      ctx.stroke()
      // blip at the head, pulsing on beat
      ctx.fillStyle = rgba(acc, 0.6 + bp * 0.4)
      ctx.beginPath()
      ctx.arc(R, 0, 2.5 + bp * 3, 0, TAU)
      ctx.fill()
      ctx.restore()

      // center dot
      ctx.fillStyle = rgba(acc, 0.5 + bp * 0.5)
      ctx.beginPath()
      ctx.arc(0, 0, 2 + bp * 2, 0, TAU)
      ctx.fill()
      ctx.restore()

      // radar label
      ctx.textAlign = 'center'
      ctx.fillStyle = rgba(col, 0.55)
      ctx.font = mono(9)
      ctx.fillText('走査 / BEAT-SYNC', cx, cy + R + (small ? 30 : 46))

      // ---- Diagnostic panel (top-right) -------------------------------------
      if (!small) {
        const px = W - m - 12
        ctx.textAlign = 'right'
        ctx.textBaseline = 'top'
        let y = m + 6

        // BPM (big) + lock state
        const locked = f.confidence > 0.55
        ctx.fillStyle = rgba(acc, 0.95)
        ctx.font = mono(30)
        const bpmTxt = f.confidence > 0.05 ? f.bpm.toFixed(1) : '---.-'
        ctx.fillText(bpmTxt, px, y)
        const bpmW = ctx.measureText(bpmTxt).width
        ctx.fillStyle = rgba(col, 0.6)
        ctx.font = mono(11)
        ctx.fillText('BPM', px - bpmW - 8, y + 16)
        y += 40

        const rows: [string, string, number][] = [
          ['SYNC', locked ? '同期 LOCK' : 'SEEK…', locked ? 1 : 0.5],
          ['MOOD', f.silence ? '—' : f.mood.state.toUpperCase(), 0.9],
          [
            'NEXT',
            f.mood.predictedState !== f.mood.state && f.mood.beatsTillTransition >= 0
              ? `${f.mood.predictedState.toUpperCase()} ~${Math.round(f.mood.beatsTillTransition)}b`
              : 'STABLE',
            0.7,
          ],
          ['BAR', `${(f.bar % 4) + 1} : ${f.beatInBar + 1}`, 0.8],
          ['PHRASE', `${f.phrase + 1}`, 0.7],
        ]
        ctx.font = mono(12)
        for (const [k, v, a] of rows) {
          ctx.fillStyle = rgba(col, 0.4)
          ctx.textAlign = 'left'
          ctx.fillText(k, W - m - 200, y)
          ctx.fillStyle = rgba(acc, 0.55 + a * 0.4)
          ctx.textAlign = 'right'
          ctx.fillText(v, px, y)
          y += 18
        }

        // confidence + energy meters
        y += 4
        const meter = (label: string, val: number, yy: number) => {
          ctx.textAlign = 'left'
          ctx.fillStyle = rgba(col, 0.4)
          ctx.font = mono(10)
          ctx.fillText(label, W - m - 200, yy)
          const bx = W - m - 130
          const bw = 130 - 12
          ctx.strokeStyle = rgba(col, 0.25)
          ctx.lineWidth = 1
          ctx.strokeRect(bx, yy, bw, 6)
          ctx.fillStyle = rgba(acc, 0.75)
          ctx.fillRect(bx, yy, bw * Math.max(0, Math.min(1, val)), 6)
        }
        meter('CONF', f.confidence, y)
        meter('ENGY', f.energy, y + 12)
        meter('LOW', f.bass, y + 24)
        meter('HIGH', f.high, y + 36)
      }

      // ---- Center lock-on reticle -------------------------------------------
      const acquire = Math.max(f.drop ? 1 : 0, f.mood.isPeaking ? 0.6 : 0)
      const reticleA = 0.12 + acquire * 0.5 + bp * 0.1
      const mcx = W / 2
      const mcy = H / 2
      const rr = 46 + bp * 10 + acquire * 18
      ctx.save()
      ctx.translate(mcx, mcy)
      ctx.rotate(t * 0.3)
      ctx.strokeStyle = rgba(acc, reticleA)
      ctx.lineWidth = 1.5
      for (let i = 0; i < 4; i++) {
        ctx.rotate(TAU / 4)
        ctx.beginPath()
        ctx.arc(0, 0, rr, -0.35, 0.35)
        ctx.stroke()
      }
      ctx.restore()
      // fixed crosshair ticks
      ctx.strokeStyle = rgba(col, reticleA * 0.8)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(mcx - 14, mcy)
      ctx.lineTo(mcx - 5, mcy)
      ctx.moveTo(mcx + 5, mcy)
      ctx.lineTo(mcx + 14, mcy)
      ctx.moveTo(mcx, mcy - 14)
      ctx.lineTo(mcx, mcy - 5)
      ctx.moveTo(mcx, mcy + 5)
      ctx.lineTo(mcx, mcy + 14)
      ctx.stroke()

      // ---- Warnings (center-top) --------------------------------------------
      const blink = 0.5 + 0.5 * Math.sin(t * 22)
      if (f.drop) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = rgba(sec, 0.7 + blink * 0.3)
        ctx.font = mono(15)
        ctx.fillText('▼ 警告  DROP  警告 ▼', W / 2, m + 8)
      } else if (f.buildUp) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = rgba(acc, 0.5 + blink * 0.4)
        ctx.font = mono(13)
        ctx.fillText('▲ BUILD-UP ▲', W / 2, m + 8)
      }

      // ---- Bottom-right: oscilloscope + telemetry ---------------------------
      if (!small) {
        const wf = f.waveform
        const boxW = 180
        const boxH = 46
        const bx = W - m - boxW - 12
        const by = H - m - boxH - 30
        ctx.strokeStyle = rgba(col, 0.22)
        ctx.lineWidth = 1
        ctx.strokeRect(bx, by, boxW, boxH)
        ctx.strokeStyle = rgba(acc, 0.7)
        ctx.lineWidth = 1
        ctx.beginPath()
        const step = Math.max(1, Math.floor(wf.length / boxW))
        for (let i = 0, x = 0; i < wf.length; i += step, x++) {
          const y = by + boxH / 2 + wf[i] * (boxH / 2 - 2)
          if (x === 0) ctx.moveTo(bx + x, y)
          else ctx.lineTo(bx + x, y)
        }
        ctx.stroke()
        ctx.textAlign = 'left'
        ctx.fillStyle = rgba(col, 0.4)
        ctx.font = mono(9)
        ctx.fillText('波形 / WAVEFORM', bx, by - 12)

        // telemetry ticker — wanders on the beat
        if (f.beat) {
          tel.lat += (Math.random() - 0.5) * 0.004
          tel.lon += (Math.random() - 0.5) * 0.004
          tel.sig = 0.5 + f.confidence * 0.5
        }
        ctx.textAlign = 'right'
        ctx.fillStyle = rgba(col, 0.45)
        ctx.font = mono(10)
        const tx = W - m - 12
        let ty = by + boxH + 8
        const teleLines = [
          `LAT ${tel.lat.toFixed(4)}°  LON ${tel.lon.toFixed(4)}°`,
          `AMP ${(f.rms * 100).toFixed(0)}%   SIG ${(tel.sig * 100).toFixed(0)}%`,
          `T+${t.toFixed(1)}s   FLUX ${(f.flux * 100).toFixed(0)}`,
        ]
        for (const ln of teleLines) {
          ctx.fillText(ln, tx, ty)
          ty += 13
        }
      }
    }

    const tick = () => {
      const s = useStore.getState()
      const f = audioEngine.features
      ctx.clearRect(0, 0, W, H)
      if (s.tacticalHud && s.status === 'running') {
        const p = getPalette(s.paletteId)
        lerp(col, hexToRgb(p.colors[0]), 0.05)
        lerp(acc, hexToRgb(p.colors[2]), 0.05)
        lerp(sec, hexToRgb(p.colors[1]), 0.05)
        draw(f)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="tactical-hud" />
}

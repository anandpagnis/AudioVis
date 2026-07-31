import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { quality } from './quality'
import { RollingWindow } from './RollingWindow'
import { useStore } from '../store'

/** Live render stats, readable from anywhere (debug panel, future overlays). */
export const perf = {
  fps: 60,
  ms: 16.7,
  dpr: 1,
  tier: 1,
  /** GPU telemetry, copied from renderer.info each frame. */
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
}

/**
 * Raw (unsmoothed) per-frame time, last 10s — for percentile readouts. `perf.ms`
 * above is a scalar EMA, which is exactly what can't show a hitch buried in an
 * otherwise-good average; this keeps the samples a p95/max can be read from.
 */
export const frameTimeWindow = new RollingWindow(10)

/**
 * Drives the central {@link quality} governor from the measured frame time and
 * applies its render-scale to the canvas DPR. The governor also exposes
 * complexity knobs (raymarch steps, noise octaves, fluid iterations, particle
 * count) that heavy scenes read directly — so under load the *expensive work*
 * shrinks, not just the resolution. This component only owns the DPR side and
 * the telemetry; the tier logic lives in quality.ts.
 */
export function PerfMonitor() {
  const setDpr = useThree((s) => s.setDpr)
  const gl = useThree((s) => s.gl)
  const storeQuality = useStore((s) => s.quality)
  const ema = useRef(16.7)
  const appliedTier = useRef(-1)

  const applyDpr = () => {
    const base = Math.min(2, window.devicePixelRatio || 1)
    const dpr = base * quality.knobs.renderScale
    perf.dpr = dpr
    perf.tier = quality.tier
    appliedTier.current = quality.tier
    setDpr(dpr)
  }

  // Re-pin the governor whenever the user changes the quality control.
  useEffect(() => {
    quality.setMode(storeQuality)
    applyDpr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeQuality])

  useFrame(({ clock }, delta) => {
    const ms = Math.min(100, delta * 1000)
    ema.current += (ms - ema.current) * 0.05
    perf.ms = ema.current
    perf.fps = 1000 / ema.current
    frameTimeWindow.push(clock.elapsedTime, ms)

    // GPU memory + draw-call telemetry (renderer.info reflects the last
    // rendered frame — close enough for a live readout).
    const info = gl.info
    perf.drawCalls = info.render.calls
    perf.triangles = info.render.triangles
    perf.geometries = info.memory.geometries
    perf.textures = info.memory.textures
    perf.programs = info.programs?.length ?? 0

    quality.tick(ema.current, clock.elapsedTime)
    if (quality.tier !== appliedTier.current) applyDpr()
  })

  return null
}

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import { analyseLuma, applyExposureSample, SAMPLE_INTERVAL_SEC, type LumaSample } from './exposure'

/**
 * Reads the composited frame back to CPU and feeds the exposure servo.
 *
 * ## Priority 2, for the same reason ScreenshotCapture uses it
 *
 * `EffectComposer` takes over rendering at priority 1, so anything above that
 * runs after the frame is fully composited but before the browser reclaims the
 * drawing buffer. With `preserveDrawingBuffer` off — which `Stage` deliberately
 * leaves off, since retaining a framebuffer copy every frame to serve a handful
 * of screenshots is pure waste — that window is the only moment the canvas holds
 * readable pixels.
 *
 * ## Asynchronous, and that is not a micro-optimisation
 *
 * The obvious implementation is `ctx.drawImage(canvas, …)` straight off the
 * WebGL canvas. That blocks the CPU until every queued GPU command retires.
 * lilim measured the resulting stall at **117 ms every eleventh frame** on a
 * heavy scene at 3200x1800 — enough on its own to drag a 60fps scene to 30.
 *
 * `createImageBitmap(canvas)` snapshots the same pixels without blocking, and
 * the servo simply reads them a frame or two late. Late is free here: the loop's
 * time constant is ~2.3 s, so a two-frame delay is under 1.5% of it.
 *
 * A sample already in flight is skipped rather than queued. Queueing would let
 * back-pressure build on exactly the frames that are already slow, which is how
 * an async path quietly becomes a synchronous one.
 *
 * ## Downsampled to 24x16
 *
 * 384 pixels is plenty for a mean, an 85th percentile and a blown-pixel share —
 * all three are whole-frame statistics, and the GPU does the reduction for free
 * as part of the blit. It also keeps the CPU-side sort trivial.
 */

/** Sample resolution. Small enough that the per-sample sort is free. */
const SAMPLE_W = 24
const SAMPLE_H = 16

export function ExposureSampler() {
  const gl = useThree((s) => s.gl)
  const lastSampleAt = useRef(0)
  const busy = useRef(false)
  /** Reused across samples — this runs for the life of the session. */
  const sample = useRef<LumaSample>({ mean: 0, p85: 0, p99: 0, blownShare: 0 })

  const ctx = useMemo(() => {
    if (typeof document === 'undefined') return null
    const c = document.createElement('canvas')
    c.width = SAMPLE_W
    c.height = SAMPLE_H
    return c.getContext('2d', { willReadFrequently: true })
  }, [])

  // A sample resolving after unmount would write into a servo that a remounted
  // tree has already reset — see Stage's glEpoch remount on context loss.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useFrame(({ clock }) => {
    if (!ctx) return
    // Wall clock, so the loop's time constant is the same on every machine —
    // see SAMPLE_INTERVAL_SEC.
    if (clock.elapsedTime - lastSampleAt.current < SAMPLE_INTERVAL_SEC) return
    if (busy.current) return
    lastSampleAt.current = clock.elapsedTime

    const canvas = gl.domElement
    if (canvas.width === 0 || canvas.height === 0) return

    // `energy` is read NOW, with the frame being sampled, not when the bitmap
    // resolves — the gate is about what the music was doing when this picture
    // was made.
    const energy = audioEngine.features.energy

    if (typeof createImageBitmap !== 'function') {
      // No async path available. Take the synchronous stall rather than
      // silently running without an exposure guard — a blocked frame is
      // recoverable, an unprotected projector is not.
      try {
        ctx.drawImage(canvas, 0, 0, SAMPLE_W, SAMPLE_H)
        applyExposureSample(
          analyseLuma(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, sample.current),
          energy,
        )
      } catch {
        // A tainted or zero-sized canvas: skip this sample, keep the show up.
      }
      return
    }

    busy.current = true
    // Resize DURING bitmap creation, not after.
    //
    // `createImageBitmap(canvas)` snapshots the canvas at full resolution and
    // hands back every pixel, and the downscale to 24x16 then happens on the
    // CPU in `drawImage`. Measured, that cost 48 ms per frame on average — a
    // 60% slowdown — because the expensive part was never the downscale, it was
    // copying a full-resolution framebuffer out of the GPU.
    //
    // The resize options let the browser do the reduction as part of the
    // snapshot, so what crosses the boundary is 384 pixels rather than the
    // whole frame. `resizeQuality: 'low'` is deliberate: this feeds three
    // whole-frame statistics, and a box filter is not merely adequate for that,
    // it is what we would have written by hand.
    createImageBitmap(canvas, {
      resizeWidth: SAMPLE_W,
      resizeHeight: SAMPLE_H,
      resizeQuality: 'low',
    }).then(
      (bmp) => {
        busy.current = false
        if (!alive.current) {
          bmp.close()
          return
        }
        try {
          ctx.drawImage(bmp, 0, 0, SAMPLE_W, SAMPLE_H)
          applyExposureSample(
            analyseLuma(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, sample.current),
            energy,
          )
        } catch {
          // Same as above — never let a readback failure take the frame down.
        } finally {
          bmp.close()
        }
      },
      () => {
        busy.current = false
      },
    )
  }, 2)

  return null
}

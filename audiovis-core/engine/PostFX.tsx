import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector2 } from 'three'
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing'
import type { BloomEffect, ChromaticAberrationEffect } from 'postprocessing'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { getEffectiveParams } from './moodParams'
import { useStore } from '../store'

/** Chromatic-aberration offset at mount — starts at zero so no first-frame flash. */
const CA_INITIAL_OFFSET = new Vector2(0, 0)

/**
 * Shared post-processing across all scenes. Bloom breathes with the bass and
 * pulses on beats; chromatic aberration flares briefly on beats and drops.
 *
 * NOTE (July 2026): a filmic grade (AgX tone map + contrast/saturation + grain +
 * scanline) was attempted here and reverted — see VISION.md §3.1. Two hard
 * failures worth remembering before trying again:
 *   1. BrightnessContrast's `brightness` is an ADDITIVE offset, not exposure. A
 *      negative value drives black negative, and negative input to AgX's
 *      log-space transform returns a lifted mid-grey — washing out the whole
 *      frame and hiding every scene.
 *   2. The scenes render additively and very hot (most of the frame sits at or
 *      above 1.0), so any tone mapper parks the image at its rolloff knee and
 *      flattens it. Grading has to be preceded by bringing the SCENES' own
 *      output down — it cannot be fixed in post alone.
 * Calibrate against real audio; an idle frame is not representative.
 */
export function PostFX() {
  const bloomRef = useRef<BloomEffect>(null)
  const caRef = useRef<ChromaticAberrationEffect>(null)
  // Read as plain state (not to branch the effect LIST on — see below).
  const quality = useStore((s) => s.quality)

  useFrame(() => {
    const f = audioEngine.features
    const { intensity, reactivity } = getEffectiveParams()
    const pulse = beatPulse(f) * reactivity
    if (bloomRef.current) {
      bloomRef.current.intensity =
        (0.65 + (f.bass * 0.7 + pulse * 0.7 + (f.drop ? 0.8 : 0)) * reactivity) * intensity
    }
    if (caRef.current) {
      // Low quality zeroes the aberration instead of removing the pass. Adding
      // or removing an effect rebuilds the composer's merged shader — a
      // multi-hundred-ms stall that repeated has lost the WebGL context outright
      // (VISION.md §3.1). The effect list must stay FIXED; modulate by uniform.
      const amount = quality === 'low' ? 0 : 0.0006 + pulse * 0.0035 + (f.drop ? 0.004 : 0)
      caRef.current.offset.set(amount, amount * 0.6)
    }
  })

  // A single, FIXED effect chain for every quality — never branched, so the
  // merged shader is compiled once and never rebuilt as tiers change.
  return (
    <EffectComposer multisampling={0}>
      <Bloom ref={bloomRef} intensity={0.8} luminanceThreshold={0.18} mipmapBlur radius={0.75} />
      <ChromaticAberration ref={caRef} offset={CA_INITIAL_OFFSET} />
      <Vignette eskil={false} offset={0.18} darkness={0.85} />
    </EffectComposer>
  )
}

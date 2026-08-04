import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { FogExp2, Vector2 } from 'three'
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing'
import type { BloomEffect, ChromaticAberrationEffect } from 'postprocessing'
import { getPalette } from './palettes'
import { performanceState } from './performanceState'
import { useStore } from '../store'

/** Chromatic-aberration offset at mount — starts at zero so no first-frame flash. */
const CA_INITIAL_OFFSET = new Vector2(0, 0)

/**
 * Owns the post chain. Scenes never touch bloom, aberration, or vignette.
 *
 * This is a pure executor: it reads `performanceState.bloom` / `.glitch` and
 * applies them. It makes no decisions and reads no audio — everything creative
 * happened upstream. That separation is what lets a director dial the look
 * (calmer bloom in a breakdown, glitch on a drop) without any post-chain code
 * knowing what a "breakdown" is.
 *
 * ## Two constraints that are load-bearing, not style
 *
 * 1. **The effect list is structurally FIXED.** Adding or removing an effect
 *    rebuilds the composer's merged shader — a multi-hundred-millisecond stall
 *    that, repeated, has lost the WebGL context outright. Quality tiers and
 *    director decisions modulate by *uniform*, never by changing the list.
 * 2. **A filmic grade cannot be bolted on here.** It was attempted twice and
 *    reverted; the blocker is that scenes render hot (most of the frame at or
 *    above 1.0), so any tone mapper flattens the image. Scene exposure has to
 *    come down first. Full write-up in docs/09_Rendering_Engine.md — read it
 *    before touching this chain.
 */
export function EffectsDirector() {
  const bloomRef = useRef<BloomEffect>(null)
  const caRef = useRef<ChromaticAberrationEffect>(null)
  const scene = useThree((s) => s.scene)
  // Exponential fog, mutated in place — swapping the Scene.fog object per frame
  // would invalidate every material's shader cache.
  const fog = useRef(new FogExp2(0x000000, 0))

  useFrame(() => {
    const p = performanceState
    if (bloomRef.current) bloomRef.current.intensity = p.bloom
    if (caRef.current) caRef.current.offset.set(p.glitch, p.glitch * 0.6)

    // Atmospheric depth. Tinted toward the palette's background rather than
    // pure black so it reads as air, not as the subject being clipped away.
    if (p.fog > 0.001) {
      if (scene.fog !== fog.current) scene.fog = fog.current
      fog.current.density = p.fog * 0.035
      fog.current.color.set(getPalette(useStore.getState().paletteId).bg)
    } else if (scene.fog) {
      scene.fog = null
    }
  })

  return (
    <EffectComposer multisampling={0}>
      <Bloom ref={bloomRef} intensity={0.8} luminanceThreshold={0.18} mipmapBlur radius={0.75} />
      <ChromaticAberration ref={caRef} offset={CA_INITIAL_OFFSET} />
      <Vignette eskil={false} offset={0.18} darkness={0.85} />
    </EffectComposer>
  )
}

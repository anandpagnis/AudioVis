import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { FogExp2, Vector2 } from 'three'
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing'
import type { BloomEffect, ChromaticAberrationEffect, VignetteEffect } from 'postprocessing'
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
  const vignetteRef = useRef<VignetteEffect>(null)
  const scene = useThree((s) => s.scene)
  // Exponential fog, mutated in place — swapping the Scene.fog object per frame
  // would invalidate every material's shader cache.
  const fog = useRef(new FogExp2(0x000000, 0))

  /**
   * Fog is attached ONCE and never detached.
   *
   * Whether a scene has fog at all is part of Three's shader program cache key,
   * so assigning `scene.fog = null` and back recompiles every material in the
   * scene — a multi-hundred-millisecond stall. The old code did exactly that
   * around a `p.fog > 0.001` threshold, and because `p.fog` eases exponentially
   * (it never actually reaches zero) it crossed that threshold once in each
   * direction per ambient transition. Two whole-scene recompiles, landing on
   * precisely the musical moments that have to stay smooth.
   *
   * `FogExp2` at density 0 gives `1 - exp(-0 * depth) = 0` fog factor, so a
   * permanently-attached zero-density fog is visually identical to no fog while
   * keeping the program key stable for the whole session.
   */
  useEffect(() => {
    // Captured in a local so the cleanup detaches the fog this effect attached,
    // not whatever `fog.current` happens to hold when the component unmounts.
    const instance = fog.current
    instance.density = 0
    scene.fog = instance
    return () => {
      if (scene.fog === instance) scene.fog = null
    }
  }, [scene])

  useFrame(() => {
    const p = performanceState
    if (bloomRef.current) {
      bloomRef.current.intensity = p.bloom
      bloomRef.current.luminanceMaterial.threshold = p.bloomThreshold
    }
    // Same magnitude as before (the old fixed 1.0 : 0.6 ratio has length ~1.166),
    // now steerable — so switching to a directed smear does not also change how
    // strong the aberration reads.
    if (caRef.current) {
      const g = p.glitch * 1.166
      caRef.current.offset.set(Math.cos(p.caAngle) * g, Math.sin(p.caAngle) * g)
    }
    if (vignetteRef.current) vignetteRef.current.darkness = p.vignette

    // Atmospheric depth. Tinted toward the palette's background rather than
    // pure black so it reads as air, not as the subject being clipped away.
    // Density alone carries the whole range now — see the attach effect above
    // for why this must never toggle `scene.fog` itself.
    fog.current.density = p.fog * 0.035
    if (p.fog > 0.001) fog.current.color.set(getPalette(useStore.getState().paletteId).bg)
  })

  return (
    <EffectComposer multisampling={0}>
      <Bloom ref={bloomRef} intensity={0.8} luminanceThreshold={0.18} mipmapBlur radius={0.75} />
      <ChromaticAberration ref={caRef} offset={CA_INITIAL_OFFSET} />
      <Vignette ref={vignetteRef} eskil={false} offset={0.18} darkness={0.85} />
    </EffectComposer>
  )
}

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { PaletteBlender, getPalette } from './palettes'
import { useStore } from '../store'

/**
 * The lighting engine: palette-colored, audio-reactive lights that any
 * mesh-based scene picks up automatically (shader scenes simply ignore
 * them). Key light breathes with the bass, rim light flashes on beats.
 */
export function LightRig() {
  const keyRef = useRef<THREE.PointLight>(null)
  const rimRef = useRef<THREE.PointLight>(null)
  const ambRef = useRef<THREE.AmbientLight>(null)
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  useFrame(() => {
    const f = audioEngine.features
    blender.update(getPalette(useStore.getState().paletteId), f.delta)
    const pulse = beatPulse(f)
    if (keyRef.current) {
      keyRef.current.color.copy(blender.a)
      keyRef.current.intensity = 60 * (0.35 + f.bass * 0.9)
    }
    if (rimRef.current) {
      rimRef.current.color.copy(blender.b)
      rimRef.current.intensity = 40 * (0.2 + pulse * 1.4 + f.high * 0.4)
    }
    if (ambRef.current) {
      ambRef.current.color.copy(blender.c)
      ambRef.current.intensity = 0.12 + f.energy * 0.2
    }
  })

  return (
    <>
      <ambientLight ref={ambRef} intensity={0.15} />
      <pointLight ref={keyRef} position={[8, 10, 8]} intensity={40} distance={0} decay={2} />
      <pointLight ref={rimRef} position={[-10, 4, -8]} intensity={30} distance={0} decay={2} />
    </>
  )
}

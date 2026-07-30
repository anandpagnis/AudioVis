import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

const ROCK_COUNT = 48

interface Rock {
  angle: number
  radius: number
  y: number
  speed: number
  scale: number
  tumble: number
}

/**
 * A lit scene — the LightRig's palette lights do the shading. A black
 * monolith breathes with the beat while debris orbits it.
 */
export function MonolithScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
  const monoRef = useRef<THREE.Mesh>(null)
  const rocksRef = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const spin = useRef(0)

  const rocks = useMemo<Rock[]>(
    () =>
      Array.from({ length: ROCK_COUNT }, () => ({
        angle: Math.random() * Math.PI * 2,
        radius: 4 + Math.random() * 9,
        y: 0.5 + Math.random() * 7,
        speed: 0.05 + Math.random() * 0.2,
        scale: 0.12 + Math.random() * 0.4,
        tumble: Math.random() * Math.PI * 2,
      })),
    [],
  )

  const monoMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0b0d12',
        metalness: 0.9,
        roughness: 0.18,
        emissive: '#000000',
        transparent: true,
      }),
    [],
  )
  const floorMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#05070b',
        metalness: 0.7,
        roughness: 0.45,
        transparent: true,
      }),
    [],
  )
  const rockMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#12151c',
        metalness: 0.6,
        roughness: 0.4,
        flatShading: true,
        emissive: '#000000',
        transparent: true,
      }),
    [],
  )

  useDispose(monoMat, floorMat, rockMat)

  useFrame(({ camera }) => {
    const f = audioEngine.features
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(paletteId), f.delta)

    const pulse = beatPulse(f) * R
    const opacity = Math.min(1, fade.value * params.intensity)
    monoMat.opacity = opacity
    floorMat.opacity = opacity
    rockMat.opacity = opacity

    // The monolith hums with the bass and flashes on beats/drops.
    monoMat.emissive.copy(blender.a)
    monoMat.emissiveIntensity = pulse * 1.6 + f.high * 0.3 * R + (f.drop ? 2.2 : 0)
    rockMat.emissive.copy(blender.b)
    rockMat.emissiveIntensity = pulse * 0.5

    spin.current += f.delta * (0.05 + f.energy * 0.25) * params.speed
    if (monoRef.current) {
      monoRef.current.rotation.y = spin.current
      const s = 1 + pulse * 0.05 + f.bass * 0.04 * R
      monoRef.current.scale.set(s, 1 + pulse * 0.03, s)
    }

    if (rocksRef.current) {
      for (let i = 0; i < ROCK_COUNT; i++) {
        const r = rocks[i]
        const a = r.angle + spin.current * r.speed * 6
        dummy.position.set(
          Math.cos(a) * r.radius,
          r.y + Math.sin(f.time * r.speed * 3 + r.tumble) * (0.3 + f.bass * R),
          Math.sin(a) * r.radius,
        )
        dummy.rotation.set(r.tumble + spin.current, a, r.tumble * 2)
        const s = r.scale * (1 + pulse * 0.25)
        dummy.scale.set(s, s, s)
        dummy.updateMatrix()
        rocksRef.current.setMatrixAt(i, dummy.matrix)
      }
      rocksRef.current.instanceMatrix.needsUpdate = true
    }

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.orbit(camera, f, { radius: 15, elev: 4.5, elevSwing: 1.2, speed: 0.06 * params.speed, react: R })
    }
  })

  return (
    <group>
      <mesh ref={monoRef} position={[0, 3.5, 0]} material={monoMat}>
        <boxGeometry args={[1.7, 7, 0.9]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} material={floorMat}>
        <planeGeometry args={[220, 220]} />
      </mesh>
      <instancedMesh ref={rocksRef} args={[undefined, undefined, ROCK_COUNT]} material={rockMat}>
        <icosahedronGeometry args={[1, 0]} />
      </instancedMesh>
    </group>
  )
}

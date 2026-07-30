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

const COUNT = 200
const CYCLE_BEATS = 32

interface Shard {
  dir: THREE.Vector3
  dist: number
  maxScale: number
  stretch: number
  rotAxis: THREE.Vector3
  rot: number
  rotSpeed: number
  birth: number // beat inside the growth cycle when this shard appears
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Crystals grow outward from a molten core over a 32-beat cycle, shatter,
 * and regrow. Section changes trigger an early shatter so growth always
 * restarts with a new musical section.
 */
export function CrystalGrowthScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const coreRef = useRef<THREE.Mesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const cycleStart = useRef(-1)

  const shards = useMemo<Shard[]>(
    () =>
      Array.from({ length: COUNT }, () => {
        const dir = new THREE.Vector3(
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
        ).normalize()
        return {
          dir,
          dist: 1.2 + Math.pow(Math.random(), 1.4) * 6,
          maxScale: 0.25 + Math.random() * 1.1,
          stretch: 1.6 + Math.random() * 2.2,
          rotAxis: new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize(),
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.5,
          birth: Math.random() * (CYCLE_BEATS - 8),
        }
      }),
    [],
  )

  const shardMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0d1018',
        metalness: 0.35,
        roughness: 0.12,
        flatShading: true,
        emissive: '#000000',
        transparent: true,
      }),
    [],
  )
  const coreMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#101018',
        emissive: '#ffffff',
        emissiveIntensity: 1,
        roughness: 0.3,
        transparent: true,
      }),
    [],
  )

  useDispose(shardMat, coreMat)

  useFrame(({ camera }) => {
    const f = audioEngine.features
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(paletteId), f.delta)

    const total = f.beatIndex + f.beatProgress
    if (cycleStart.current < 0) cycleStart.current = total
    // Shatter + regrow on section changes or when the cycle completes.
    if (f.sectionChange || total - cycleStart.current > CYCLE_BEATS) {
      cycleStart.current = total
    }
    const cycleT = total - cycleStart.current

    const pulse = beatPulse(f) * R
    const opacity = Math.min(1, fade.value * params.intensity)
    shardMat.opacity = opacity
    coreMat.opacity = opacity

    shardMat.emissive.copy(blender.b)
    shardMat.emissiveIntensity = 0.12 + pulse * 1.1 + (f.drop ? 1.6 : 0)
    coreMat.emissive.copy(blender.a)
    coreMat.emissiveIntensity = 1.2 + f.bass * 2.5 * R + pulse * 1.5

    if (meshRef.current) {
      for (let i = 0; i < COUNT; i++) {
        const s = shards[i]
        // Grow over ~5 beats after birth; snap to 0 before birth.
        const grow = smooth((cycleT - s.birth) / 5)
        const scale = s.maxScale * grow * (1 + pulse * 0.07)
        s.rot += f.delta * s.rotSpeed * params.speed
        dummy.position.copy(s.dir).multiplyScalar(0.6 + s.dist * grow)
        dummy.quaternion.setFromAxisAngle(s.rotAxis, s.rot)
        dummy.scale.set(scale, scale * s.stretch, scale)
        dummy.updateMatrix()
        meshRef.current.setMatrixAt(i, dummy.matrix)
      }
      meshRef.current.instanceMatrix.needsUpdate = true
    }
    if (coreRef.current) {
      const cs = 0.7 + f.bass * 0.35 * R + pulse * 0.15
      coreRef.current.scale.set(cs, cs, cs)
    }

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.orbit(camera, f, { radius: 11.5, elev: 3, elevSwing: 2, speed: 0.07 * params.speed, react: R })
    }
  })

  return (
    <group>
      <mesh ref={coreRef} material={coreMat}>
        <icosahedronGeometry args={[0.8, 1]} />
      </mesh>
      <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]} material={shardMat} frustumCulled={false}>
        <octahedronGeometry args={[0.5, 0]} />
      </instancedMesh>
    </group>
  )
}

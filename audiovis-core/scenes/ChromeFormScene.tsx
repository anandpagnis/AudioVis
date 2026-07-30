import { useContext, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

/**
 * Chrome Form — a polished metal hero, lit for real.
 *
 * The other new scenes are additive line/point art that write their own colour.
 * This one is the opposite discipline: an opaque physically-shaded surface whose
 * entire look comes from what it reflects. That needs image-based lighting —
 * LightRig's three point lights alone would put exactly three hard specular
 * dots on a mirror-smooth surface and read as flat plastic. A prefiltered
 * environment map supplies the continuous base reflection; LightRig's
 * palette-coloured, beat-reactive lights then pop on top of it. Both, not either.
 *
 * The subject is abstract on purpose: sourcing a real character model is a
 * separate content decision, and VISION's rubric asks for a subject holding
 * negative space, not a literal figure.
 *
 * Exposure note: this scene is the one that does NOT blend additively, so it
 * cannot contribute to the whole-frame wash documented in VISION.md §3.1 — its
 * bright regions are small, tight highlights on an otherwise black frame.
 */

/**
 * Prefiltered environment, generated once per session and shared.
 *
 * RoomEnvironment is fixed — it does not depend on palette, audio, or anything
 * scene-local — so there is no reason to pay PMREM generation on every mount.
 * Caching at module scope means even the very first crossfade into this scene
 * pays it once, ever. It is deliberately never disposed (see useDispose below).
 */
let sharedEnv: THREE.Texture | null = null

function getSharedEnvMap(gl: THREE.WebGLRenderer): THREE.Texture {
  if (sharedEnv) return sharedEnv
  const pmrem = new THREE.PMREMGenerator(gl)
  const room = new RoomEnvironment()
  sharedEnv = pmrem.fromScene(room, 0.04).texture
  room.dispose()
  pmrem.dispose()
  return sharedEnv
}

export function ChromeFormScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const gl = useThree((s) => s.gl)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
  const heroRef = useRef<THREE.Mesh>(null)
  const spin = useRef(0)

  const heroGeo = useMemo(() => new THREE.TorusKnotGeometry(1.45, 0.46, 200, 28), [])

  const heroMat = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        // Near-mirror metal. Roughness this low is only legible with a real
        // environment map behind it — which is the point of the scene.
        color: '#d8dee6',
        metalness: 1,
        roughness: 0.08,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        envMap: getSharedEnvMap(gl),
        envMapIntensity: 0.75,
        transparent: true, // so SceneFade can crossfade it like every other scene
      }),
    [gl],
  )

  // Only the geometry and material are ours to free. The shared environment
  // texture is a session-lifetime singleton by design — disposing it here would
  // break the next mount (and any concurrent layer using it).
  useDispose(heroGeo, heroMat)

  const white = useMemo(() => new THREE.Color('#ffffff'), [])

  useFrame(({ camera }) => {
    const f = audioEngine.features
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(paletteId), f.delta)

    const pulse = beatPulse(f) * R
    const mid = f.mid * R
    const pres = f.presence * R
    const high = f.high * R
    const tr = f.transient * R
    heroMat.opacity = Math.min(1, fade.value * (0.6 + 0.4 * params.intensity))

    // Metal tints its reflections by base colour. Lerp from white rather than
    // using the palette directly, so it stays chrome that has picked up the
    // room's colour instead of becoming coloured plastic. Mid content deepens the
    // tint, so harmonically dense passages read as more saturated metal.
    heroMat.color.copy(white).lerp(blender.a, 0.3 + mid * 0.3)
    heroMat.emissive.copy(blender.c)
    // Emissive is the transient's job — a rim flash faster than any band
    // envelope, which is what reflections alone can never fake.
    heroMat.emissiveIntensity = pulse * 0.4 + tr * 0.7 + (f.drop ? 0.9 : 0)
    // Reflections swell with the low end: the room "brightens" on the bass.
    heroMat.envMapIntensity = 0.6 + f.bass * R * 0.55 + pulse * 0.3
    // Highs frost the surface. Raised well past the old 0.05 — at that amount it
    // was mathematically present but invisible, which is exactly the complaint.
    // Presence sharpens the clearcoat separately, so hats and snares do visibly
    // different things to the material.
    heroMat.roughness = 0.05 + high * 0.16
    heroMat.clearcoatRoughness = 0.04 + pres * 0.1

    spin.current += f.delta * (0.14 + f.energy * 0.3 + mid * 0.3) * params.speed
    if (heroRef.current) {
      heroRef.current.rotation.y = spin.current
      heroRef.current.rotation.x = Math.sin(f.time * 0.11) * 0.4
      const s = 1 + pulse * 0.055 + f.bass * R * 0.045
      heroRef.current.scale.setScalar(s)
    }

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      // Orbit, not hover: a static camera on a specular subject only ever shows
      // one set of highlights. The moving camera is what makes it read as metal.
      rig.orbit(camera, f, { radius: 8.2, elev: 1.2, elevSwing: 1.3, speed: 0.05 * params.speed, react: R })
    }
  })

  return (
    <group>
      <mesh ref={heroRef} geometry={heroGeo} material={heroMat} />
    </group>
  )
}

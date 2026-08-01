import { useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getSharedEnvMap } from '../engine/envMap'
import { useSceneFrame, useSpin } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

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
 * cannot contribute to the whole-frame wash documented in docs/09_Rendering_Engine.md — its
 * bright regions are small, tight highlights on an otherwise black frame.
 */

export function ChromeFormScene() {
  const gl = useThree((s) => s.gl)
  const heroRef = useRef<THREE.Mesh>(null)
  const spin = useSpin()

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

  useSceneFrame(
    ({ f, dt, b, col, vis, params, anim }) => {
      heroMat.opacity = vis

      // Metal tints its reflections by base colour. Lerp from white rather than
      // using the palette directly, so it stays chrome that has picked up the
      // room's colour instead of becoming coloured plastic. Mid content deepens the
      // tint, so harmonically dense passages read as more saturated metal.
      heroMat.color.copy(white).lerp(col.a, 0.3 + b.mid * 0.3)
      heroMat.emissive.copy(col.c)
      // Emissive is the transient's job — a rim flash faster than any band
      // envelope, which is what reflections alone can never fake.
      heroMat.emissiveIntensity = b.pulse * 0.4 + b.transient * 0.7 + (f.drop ? 0.9 : 0)
      // Reflections swell with the low end: the room "brightens" on the bass.
      // `inflate` folds sub in with bass, so a track whose weight sits below
      // the bass band still moves the reflections — b.bass alone misses it.
      heroMat.envMapIntensity = 0.6 + b.bass * 0.55 + b.pulse * 0.3 + anim.inflate * 0.25
      // Highs frost the surface. Raised well past the old 0.05 — at that amount it
      // was mathematically present but invisible, which is exactly the complaint.
      // Presence sharpens the clearcoat separately, so hats and snares do visibly
      // different things to the material.
      heroMat.roughness = 0.05 + b.high * 0.16
      heroMat.clearcoatRoughness = 0.04 + b.presence * 0.1

      const angle = spin(dt, 0.14 + f.energy * 0.3 + b.mid * 0.3, params.speed)
      if (heroRef.current) {
        heroRef.current.rotation.y = angle
        heroRef.current.rotation.x = Math.sin(f.time * 0.11) * 0.4
        heroRef.current.scale.setScalar(1 + b.pulse * 0.055 + anim.inflate * 0.05)
      }
    },
    { visCeiling: 1, visFloor: 0.6 },
  )

  return (
    <group>
      <mesh ref={heroRef} geometry={heroGeo} material={heroMat} />
    </group>
  )
}

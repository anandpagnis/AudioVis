import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getSharedEnvMap, releaseSharedEnvMap } from '../engine/envMap'
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

  // The geometry and material are ours to free outright. The shared
  // environment texture goes through the resource cache's refcounting
  // instead — releasing here is now safe even though it's pinned (a pinned
  // entry just ignores reaching a zero refcount), so this scene no longer
  // has to special-case excluding it from cleanup.
  useDispose(heroGeo, heroMat)
  useEffect(() => {
    return () => releaseSharedEnvMap()
  }, [])

  const white = useMemo(() => new THREE.Color('#ffffff'), [])

  useSceneFrame(
    ({ f, dt, b, col, vis, params, anim }) => {
      heroMat.opacity = vis

      // Write depth ONLY while effectively opaque.
      //
      // This is the one scene in the roster that writes depth at all — every
      // other material sets `depthWrite: false`, and `MeshPhysicalMaterial`
      // defaults it to true. `transparent: true` does not change that, which is
      // the trap: at low opacity the knot contributed almost no colour while
      // still stamping its full silhouette into the depth buffer, punching a
      // torus-knot-shaped hole through whatever else was on screen. The scene
      // read as "invisible, but visible in the negative".
      //
      // Two situations hit it constantly:
      //   - **Warm-up.** `EntryGroup` keeps a warming entry VISIBLE (that is how
      //     its shader compiles) while its fade sits at 0. So every time chrome
      //     was queued, an opacity-0 knot silently occluded the current scene
      //     for a few frames — the "blipping in and out".
      //   - **Crossfades.** Half-faded chrome occluded whatever it was fading
      //     to or from. Worst against `dissolve`, `plasma`, `pointcloud` and
      //     `ribbons`, which are the scenes that still depth-test (the
      //     fullscreen-quad scenes set `depthTest: false` and so ignore it).
      //
      // Keeping the write when settled preserves correct SELF-occlusion: the
      // knot passes behind itself, and without depth that ordering is left to
      // triangle order. Below the threshold the knot is faint enough that a
      // little see-through is far cheaper than a black hole in the frame.
      //
      // Keyed on `vis` (i.e. final opacity) rather than on the raw crossfade,
      // because opacity is what actually decides whether the hole is visible —
      // a user who pulls `intensity` down gets a dimmer, softer, non-occluding
      // chrome, which is the right reading of that request.
      heroMat.depthWrite = vis > 0.98

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

import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getSharedEnvMap, releaseSharedEnvMap } from '../engine/envMap'
import { criticalDamping, slew, spring, springStep, type SpringState } from '../engine/response'
import { useSceneFrame, useSpin } from '../engine/sceneFrame'
import { bipolar, drastic } from './contract'

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
 *
 * ## Scene Contract
 *
 *   speed     rotation rate
 *   fill      subject scale — how much of the frame the knot occupies
 *   tilt      pitch offset on top of the automatic bob (0.5 = level)
 *   contrast  surface finish — "polish", frosted metal to near-mirror
 *
 * `complexity`, `density` and `shape` are not declared. All three would have to
 * rebuild the torus knot, and this scene's cost is dominated by an opaque
 * physically-shaded pass over a near-mirror surface — the one place in the
 * roster where a dial that silently multiplies geometry is a frame-time risk
 * rather than a look.
 *
 * ## Band routing
 *
 *   bass + pulse + inflate -> envMapIntensity (reflections swell with the
 *                             low end; unchanged by this pass, see below)
 *   mid                    -> base-colour tint toward the palette
 *   transient + pulse + drop -> emissive heat (see "Response identity")
 *   high + presence        -> frost, i.e. roughness/clearcoat floor lift
 *   transient + pulse + drop -> a momentary EXTRA roughen on top of that
 *                             floor (see "Response identity") — reads as the
 *                             surface catching the impact, not brightening
 *   section change          -> smooth structural turn, rotation.z (critically
 *                             damped, no overshoot — see below)
 *   speed/mid/energy       -> spin rate; tilt dial + slow bob -> rotation.x
 *   fill dial + inflate    -> scale (pulse's old per-hit scale term is gone;
 *                             see "Response identity" below)
 *
 * ## Response identity: struck metal, not a brighter torus knot
 *
 * Before this pass every reactive term on this scene fed brightness or scale
 * — bass/inflate -> envMapIntensity, pulse/transient/drop -> emissiveIntensity,
 * pulse/inflate -> scale — which is exactly the roster-wide collapse
 * `engine/response.ts`'s header audits (22 of 22 scenes drove brightness off
 * an envelope, 14 of 22 drove a size term). Three changes give this scene a
 * physical, metal-specific identity instead:
 *
 *   - **Emissive heat now cools like metal, not like a symmetric pulse.**
 *     `emissiveIntensity` used to be set directly from the current band
 *     values every frame, so it rose and fell exactly on `b.transient`'s own
 *     (symmetric) envelope shape. It now runs through `engine/response.ts`'s
 *     `slew()` with a fast rise and a slow fall: a hit still flashes in
 *     essentially instantly, but the glow lingers and cools over roughly
 *     half a second afterward rather than tracking the input back down in
 *     lockstep — heated metal, not a strobe. The target itself is weighted
 *     `b.pulse * 0.7 + b.transient * 0.4` (was `0.4`/`0.7`) so the glow reads
 *     as landing on the beat rather than firing on every raw onset.
 *   - **Rotation now marks the music's structure, not a per-hit reaction.**
 *     The old `b.pulse * 0.055` term on `scale` — a per-hit size bump, the
 *     exact 14-of-22 pattern above — is gone (see the scale comment where
 *     `rotation.z` is assigned). It was first replaced by an underdamped
 *     spring on `rotation.z`, the one rotation axis nothing else drives (X is
 *     the tilt dial + bob, Y is the continuous spin): a hit displaced it and
 *     it rang back through zero and settled, the same primitive
 *     `MazeFlightScene`'s camera-roll lurch uses. Per direct report that
 *     specifically THIS per-hit rotation read as jerky, that spring is gone
 *     too. `rotation.z` now answers structural SECTION CHANGES instead of
 *     individual hits: one smooth, critically-damped turn per boundary
 *     (`criticalDamping()`, ratio 1.0 — see `TURN_STIFFNESS`/`TURN_DAMPING`
 *     below) that reaches its new target in roughly 1-1.5s with no overshoot
 *     and no ring, rather than an edge-triggered snap on every transient. The
 *     moment-to-moment reaction to a hit hasn't disappeared — it already
 *     lived on the emissive heat and roughen terms above and below, both
 *     already smooth by construction (asymmetric slew, not a spring) and
 *     never part of the "jerky" complaint. Rotation's job is now the music's
 *     larger-scale changes; the heat/roughen terms still carry every hit.
 *   - **A hit now visibly changes the SURFACE, not just its brightness.**
 *     `roughness`/`clearcoatRoughness` get a new additive term — zero at
 *     rest, so the documented default-reproduction invariant below is
 *     unaffected — driven by the same hit signal as the emissive heat, also
 *     through an asymmetric slew (fast in, slower-than-emissive fall): a hit
 *     momentarily roughens the finish before it re-polishes, reading as the
 *     surface itself catching the impact rather than merely glowing harder.
 *     This is the term moved fully off brightness, per the wave-2 brief.
 *
 * `envMapIntensity`'s bass/pulse/inflate routing is left as authored — it is
 * already a reflection-intensity response rather than a raw emissive one,
 * and the brief only asks that at least one term move off brightness
 * entirely, which the roughness/clearcoat term above does.
 *
 * ## Quality governance
 *
 * This scene reads no `quality.knobs` value, and that is correct rather than an
 * oversight — please do not "fix" it by wiring one up. Its cost is per-fragment
 * almost entirely: clearcoat puts a second specular lobe and a second env-map
 * sample on every pixel of the subject, against a fixed ~11k-triangle knot whose
 * vertex cost is noise by comparison. So the lever that works is the number of
 * pixels, which the engine already owns through this scene's declared
 * `pixelBudget` (see engine/renderScale.ts) — it is applied whether the scene
 * cooperates or not.
 *
 * The two knobs that would change per-fragment cost are both unavailable for
 * concrete reasons: toggling `clearcoat` off crosses a three.js `USE_CLEARCOAT`
 * boundary and recompiles the program, which is a synchronous stall delivered to
 * a machine that is by definition already struggling; and the environment map is
 * a pinned session-wide singleton shared with every other physical material, so
 * its resolution is not this scene's to move. If they are wanted later they belong on
 * `useSceneParamSteps`, which rebuilds at bucket boundaries rather than per
 * frame; see engine/sceneFrame.ts.
 */

/** Chrome's geometry + material, cached per renderer rather than per mount (F86). */
interface CachedChromeAssets {
  geometry: THREE.TorusKnotGeometry
  material: THREE.MeshPhysicalMaterial
}

/**
 * One resident torus-knot geometry + `MeshPhysicalMaterial` per renderer,
 * reused across every mount rather than rebuilt inside a component-scoped
 * `useMemo` — the same trade F144 made for `createShaderScene`'s materials,
 * applied here because this scene predates that factory and was never
 * covered by it.
 *
 * `MeshPhysicalMaterial` with `clearcoat`/`metalness`/`transparent` compiles
 * to a genuinely large program (a second specular lobe, a second env-map
 * sample, the transparency/premultiply paths), and disposing it on every
 * unmount hits the exact mechanism F144 found and fixed for shader-scene
 * materials: three's `WebGLPrograms.releaseProgram()` deletes the compiled
 * program once its last user (this material) is disposed, so the next mount
 * compiles from scratch — a real, uncached cost, not the "few milliseconds
 * nobody could see" F144 assumed for everything outside maze. F86's own
 * numbers (CPU mean 21.3/19.9/16.7/27.8/43.6ms across tiers 0-4, non-
 * monotone - "fine in the middle, bad on both sides") are exactly the shape
 * of a per-mount recompile landing unpredictably inside `/bench`'s per-tier
 * measurement, not a smooth per-fragment cost curve.
 *
 * Keyed by `gl` in a `WeakMap` rather than disposed by hand, same as F144:
 * a context loss remounts under a brand new `WebGLRenderer`, so the old
 * entry simply becomes unreachable.
 */

/**
 * Section-change turn (rotation.z — replaces the old impact-torque spring).
 * Critically damped (damping = criticalDamping(stiffness), ratio 1.0) so
 * there is NO overshoot and NO ring -- a smooth, deliberate turn instead of
 * the jerky edge-triggered snap this replaces. Stiffness chosen so the turn
 * completes in roughly 1-1.5s: too fast reads as a snap again, too slow
 * reads as the knot drifting rather than turning.
 */
const TURN_STIFFNESS = 18
const TURN_DAMPING = criticalDamping(TURN_STIFFNESS)
/** Radians added to the held target on each section change -- a definite,
 *  noticeable reorientation without spinning past a natural resting view. */
const TURN_STEP = Math.PI * 0.6

/** Rise/fall rates (1/s) for the emissive "heat" slew — fast in, slow cool. */
const EMISSIVE_RISE = 30
const EMISSIVE_FALL = 2.2
/** Rise/fall rates for the impact-roughen slew — same fast attack, an even
 *  slower release than the glow so the surface visibly re-polishes after the
 *  light has already cooled, reading as two separate physical events rather
 *  than one dial moving. */
const ROUGHEN_RISE = 30
const ROUGHEN_FALL = 1.6

const chromeAssetCache = new WeakMap<THREE.WebGLRenderer, CachedChromeAssets>()

function getChromeAssets(gl: THREE.WebGLRenderer): CachedChromeAssets {
  const existing = chromeAssetCache.get(gl)
  if (existing) return existing
  const geometry = new THREE.TorusKnotGeometry(1.45, 0.46, 200, 28)
  const material = new THREE.MeshPhysicalMaterial({
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
  })
  const created: CachedChromeAssets = { geometry, material }
  chromeAssetCache.set(gl, created)
  return created
}

export function ChromeFormScene() {
  const gl = useThree((s) => s.gl)
  const heroRef = useRef<THREE.Mesh>(null)
  const spin = useSpin()
  // Asymmetric-slew state for the emissive "heat" and the impact "roughen" —
  // see "Response identity" above. Persisted per-mount, same as `spin`'s own
  // phase accumulator.
  const emissiveHeat = useRef(0)
  const roughenHeat = useRef(0)
  // Section-change turn (rotation.z, replaces the old impact-torque spring —
  // see "Response identity" above). `turnTarget` is a held angle that steps
  // by TURN_STEP each section change; `turn` is the critically-damped spring
  // that chases it. `f.sectionChange` is already a one-frame pulse (see the
  // AudioFeatures doc comment and EffectDirector's own "needs no edge state"
  // note), so no separate rising-edge latch is needed here.
  const turnTarget = useRef(0)
  const turn = useRef<SpringState>(spring(0))

  // Cached across mounts (see getChromeAssets) — no useDispose for these two;
  // they outlive any one mount by design, same as createShaderScene's cache.
  const { geometry: heroGeo, material: heroMat } = useMemo(() => getChromeAssets(gl), [gl])

  // `releaseSharedEnvMap` still balances the ORIGINAL `getSharedEnvMap` call
  // inside `getChromeAssets` (now made once per renderer, not once per mount)
  // — firing it once per unmount instead is harmless: the entry is pinned, so
  // `resourceCache.release()` just clamps its refcount at 0 rather than
  // disposing, identical to never releasing at all (see envMap.ts's own doc
  // comment). Left as-is rather than rewired to fire once per renderer too,
  // since there is no observable difference and no reason to touch it.
  useEffect(() => {
    return () => releaseSharedEnvMap()
  }, [])

  const white = useMemo(() => new THREE.Color('#ffffff'), [])

  useSceneFrame(
    ({ f, dt, b, col, vis, params, anim, p }) => {
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
      // Impact strength shared by the emissive heat and the surface roughen
      // below — one signal read two different physical ways, rather than two
      // separate copies of "kick -> glow". Weighted toward the beat-synced
      // pulse rather than the raw transient (0.7/0.4, was 0.4/0.7) so the
      // glow reads as landing on the beat, not firing on every raw onset.
      const heatTarget = b.pulse * 0.7 + b.transient * 0.4 + (f.drop ? 0.9 : 0)
      // Emissive is the transient's job — a rim flash faster than any band
      // envelope, which is what reflections alone can never fake. Slewed
      // asymmetrically rather than assigned straight from the envelope: the
      // old code tracked `heatTarget` up AND down in lockstep, so the glow
      // decayed exactly as fast as it rose — a symmetric pulse. Fast rise,
      // slow fall reads instead as heated metal cooling: the flash is still
      // essentially instant, but it lingers afterward instead of matching
      // the input's own (much faster) decay.
      emissiveHeat.current = slew(emissiveHeat.current, heatTarget, dt, EMISSIVE_RISE, EMISSIVE_FALL)
      heroMat.emissiveIntensity = emissiveHeat.current
      // Reflections swell with the low end: the room "brightens" on the bass.
      // `inflate` folds sub in with bass, so a track whose weight sits below
      // the bass band still moves the reflections — b.bass alone misses it.
      // Left as a direct read (not slewed) — this is a slow, sustained swell
      // already, not a per-hit event competing with the emissive term above.
      heroMat.envMapIntensity = 0.6 + b.bass * 0.55 + b.pulse * 0.3 + anim.inflate * 0.25
      // Highs frost the surface. Raised well past the old 0.05 — at that amount it
      // was mathematically present but invisible, which is exactly the complaint.
      // Presence sharpens the clearcoat separately, so hats and snares do visibly
      // different things to the material.
      //
      // `contrast` sets the FLOOR both start from — the surface finish. Inverted
      // (high dial = low roughness) because the dial reads as tonal contrast and
      // a mirror has more of it than frosted metal. The audio's frosting is
      // added on top either way, so a hat pattern still reads at both ends.
      // Spans chosen so the DECLARED default (0.85, not 0.5) reproduces the
      // authored 0.05 / 0.04 exactly. The default sits high because this
      // surface is authored as near-mirror and the dial's job is to frost it —
      // a 0.5 default would have shipped a duller scene than the one reviewed.
      const finish = 1 - p.contrast
      // Impact roughen: a NEW term, additive on top of the authored
      // finish/frost floor above and zero at rest, so the declared-default
      // invariant documented there (0.85 -> the authored 0.05/0.04 exactly)
      // is unaffected by anything below. Driven by the same `heatTarget` as
      // the emissive heat but slewed with its own (slower) fall, so the
      // surface visibly re-polishes a beat after the glow has already
      // cooled — two distinct physical events reading off one hit, and the
      // one place this scene answers a hit with something other than
      // brightness or size.
      roughenHeat.current = slew(roughenHeat.current, Math.min(1, heatTarget), dt, ROUGHEN_RISE, ROUGHEN_FALL)
      heroMat.roughness = 0.029 + finish * 0.14 + b.high * 0.16 + roughenHeat.current * 0.1
      heroMat.clearcoatRoughness = 0.019 + finish * 0.14 + b.presence * 0.1 + roughenHeat.current * 0.06

      // Section-change turn: the held target steps by TURN_STEP once per
      // section boundary, and a critically-damped spring chases it — a
      // single smooth, deliberate reorientation with no overshoot and no
      // ring, replacing the old per-hit torque snap (see "Response identity"
      // above). `f.sectionChange` is already a one-frame pulse, so stepping
      // the target directly on it (no rising-edge latch) still fires exactly
      // once per boundary.
      if (f.sectionChange) {
        turnTarget.current += TURN_STEP
      }
      springStep(turn.current, turnTarget.current, dt, TURN_STIFFNESS, TURN_DAMPING)

      const angle = spin(dt, 0.14 + f.energy * 0.3 + b.mid * 0.3, params.speed * drastic(p.speed))
      if (heroRef.current) {
        heroRef.current.rotation.y = angle
        // `tilt` cranes the subject: bipolar, so 0.5 leaves the automatic bob
        // exactly as authored and the ends swing it well past level. The span is
        // 1.1 rather than something rounder so that even at a dial extreme the
        // +/-0.4 bob on top of it stays inside +/-1.5 rad — short of the pole at
        // pi/2, where the knot would present its silhouette edge-on and a
        // near-mirror surface has nothing left to reflect.
        heroRef.current.rotation.x = Math.sin(f.time * 0.11) * 0.4 + bipolar(p.tilt, 1.1)
        // The section-change turn's entire output lands here — the one
        // rotation axis nothing else drives. A boundary steps the held
        // target and the critically-damped spring above turns smoothly to
        // meet it, with no overshoot and no ring (see "Response identity").
        heroRef.current.rotation.z = turn.current.value
        // `fill` is the subject's size in frame. Bounded well inside the camera
        // anchor's 8.2-unit distance at the top end: the CameraDirector frames
        // this scene, and a scale that outgrows its framing reads as a bug
        // rather than as a bigger subject. The old per-hit `b.pulse * 0.055`
        // term is gone — that was a kick driving a size term, the exact
        // 14-of-22 pattern the wave-2 brief calls out; a hit's answer now
        // lives entirely on the emissive heat and roughen terms above (see
        // "Response identity"), not on scale or rotation. `inflate`'s slow bass
        // swell stays: a different, sustained physical read (mass breathing),
        // not a per-hit reaction.
        const size = 0.55 + p.fill * 0.9
        heroRef.current.scale.setScalar(size * (1 + anim.inflate * 0.05))
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

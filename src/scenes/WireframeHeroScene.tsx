import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js'
import { WireframeGeometry2 } from 'three/examples/jsm/lines/WireframeGeometry2.js'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { quality } from '../engine/quality'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

/**
 * Wireframe Hero — the GitS blueprint look built on real edge geometry.
 *
 * Where SchematicScene fakes a wireframe by rasterizing every triangle and
 * discarding non-edge fragments (barycentric + fwidth), this uses three's
 * Wireframe/WireframeGeometry2, which extracts only the mesh's TRUE edges and
 * draws them as instanced screen-space quads. Three wins: no triangulation
 * diagonals showing up as phantom lines, real line thickness with proper joins
 * (impossible with fwidth), and dashing — which is what makes the annotation
 * ring read as a drafting overlay rather than decoration. It is also cheaper:
 * a few hundred thin quads instead of a full-surface fragment pass.
 *
 * Composition is the point: one faceted hero centred in black, a counter-
 * rotating inner core for parallax, one dashed orbit ring for scale reference.
 * Nothing fills the frame.
 */

/** Ring of positions for a LineGeometry, closed back onto its first point. */
function ringPositions(radius: number, segments: number): number[] {
  const pts: number[] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius)
  }
  return pts
}

/**
 * Additive line-art material. Thin bright strokes on black, so `opacity`
 * (a real uniform on LineMaterial) is the exposure control — the frame stays
 * ~90% true black because coverage is thin, not because the lines are dim.
 */
function makeLineMaterial(linewidth: number, dashed = false): LineMaterial {
  const mat = new LineMaterial({
    color: 0x00e5ff, // non-black default: never black-on-black pre-first-frame
    linewidth,
    transparent: true,
    depthWrite: false,
    depthTest: false, // x-ray blueprint — the whole cage reads, front and back
    blending: THREE.AdditiveBlending,
  })
  if (dashed) {
    mat.dashed = true
    mat.dashSize = 0.55
    mat.gapSize = 0.35
  }
  return mat
}

/** Edge-only wireframe from a source geometry; the source is transient. */
function makeWireframe(source: THREE.BufferGeometry, mat: LineMaterial): Wireframe {
  const geo = new WireframeGeometry2(source)
  source.dispose() // only the derived line geometry is ever rendered
  const wf = new Wireframe(geo, mat)
  wf.computeLineDistances()
  wf.frustumCulled = false
  return wf
}

export function WireframeHeroScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
  const spin = useRef(0)
  const dash = useRef(0)

  const heroRef = useRef<THREE.Group>(null)
  const coreRef = useRef<THREE.Group>(null)
  const ringRef = useRef<THREE.Group>(null)

  // Detail 1, not 3: fewer, larger facets read as deliberately cut crystal
  // rather than a tessellated sphere — and keeps the edge count trivial.
  const heroMat = useMemo(() => makeLineMaterial(2.2), [])
  const coreMat = useMemo(() => makeLineMaterial(1.2), [])
  const ringMat = useMemo(() => makeLineMaterial(1.4, true), [])

  const hero = useMemo(
    () => makeWireframe(new THREE.IcosahedronGeometry(2.05, 1), heroMat),
    [heroMat],
  )
  const core = useMemo(
    () => makeWireframe(new THREE.OctahedronGeometry(0.95, 0), coreMat),
    [coreMat],
  )
  const ring = useMemo(() => {
    const geo = new LineGeometry()
    geo.setPositions(ringPositions(3.4, 96))
    const line = new Line2(geo, ringMat)
    line.computeLineDistances()
    line.frustumCulled = false
    return line
  }, [ringMat])

  useDispose(
    heroMat,
    coreMat,
    ringMat,
    hero.geometry,
    core.geometry,
    ring.geometry as THREE.BufferGeometry,
  )

  // Scratch colour so the per-frame palette lerp allocates nothing.
  const tint = useMemo(() => new THREE.Color(), [])

  useFrame(({ camera, gl }) => {
    const f = audioEngine.features
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(paletteId), f.delta)

    const pulse = beatPulse(f) * R
    // Each band gets its OWN visual job, so they stay separable by eye:
    //   bass     → mass (scale/breathing)
    //   mid      → harmonic body (hue shift + rotation speed)
    //   presence → edge definition (stroke weight snaps on snares/plucks)
    //   high     → the annotation ring (hats drive it, nothing else does)
    //   transient→ instantaneous flash, faster than any band envelope
    // Presence is preferred over high for punch: it spans 2–5 kHz over ~140 FFT
    // bins, where `high` averages 2–9 kHz over ~325 mostly-noise-floor bins and
    // so has visibly less dynamic range once normalized.
    const mid = f.mid * R
    const pres = f.presence * R
    const high = f.high * R
    const tr = f.transient * R

    // LineMaterial sizes strokes in CSS pixels, which means it needs the live
    // drawing-buffer size. PerfMonitor changes DPR whenever the quality tier
    // steps, so a mount-time value goes wrong the moment load changes — set it
    // every frame and resize/fullscreen/tier changes all stay correct for free.
    const w = gl.domElement.width
    const h = gl.domElement.height

    // Floored like SchematicScene: a line-art hero must stay readable through
    // quiet passages. Mood modulates it, but never crushes the subject away.
    const vis = Math.min(1.4, fade.value * (0.5 + 0.5 * params.intensity))

    // Body lines sit on the primary; the beat pushes them toward the accent, and
    // mid content pulls toward the secondary — so harmonic movement shifts hue
    // independently of rhythm instead of everything keying off the kick.
    tint
      .copy(blender.a)
      .lerp(blender.c, Math.min(1, pulse * 0.8))
      .lerp(blender.b, Math.min(0.6, mid * 0.5))

    for (const mat of [heroMat, coreMat, ringMat]) {
      mat.resolution.set(w, h)
    }

    // Brightness lives in the COLOUR, not in opacity — and deliberately runs
    // past 1.0. LineMaterial's alpha caps at 1, so opacity alone can only ever
    // reach "half-lit" against a black additive ground; overdriving the colour
    // is what gives these strokes the same hot phosphor punch SchematicScene
    // gets from its own >1.0 shader multiplier. Opacity is left to do one job:
    // carry the crossfade and the mood floor. The three elements' relative
    // multipliers are the visual hierarchy — hero reads first, ring last.
    heroMat.color.copy(tint).multiplyScalar(1.2 + pulse * 1.3 + tr * 0.9)
    heroMat.opacity = Math.min(1, vis)
    // Presence, not the beat, owns stroke weight — snares and plucks sharpen the
    // outline while the kick is busy moving the whole form.
    heroMat.linewidth = 1.9 + pres * 2.4 + pulse * 0.8

    coreMat.color.copy(tint).multiplyScalar(0.8 + f.bass * R * 0.9 + tr * 0.5)
    coreMat.opacity = Math.min(1, vis * 0.9)
    coreMat.linewidth = 1.1 + pres * 1.0

    // The ring is the highs' element, and only the highs': it stays dark through
    // a kick-only passage and lights up the moment hats/cymbals come in.
    ringMat.color.copy(tint).multiplyScalar(0.3 + high * 1.1 + pulse * 0.25)
    ringMat.opacity = Math.min(1, vis * 0.8)
    // Dash scroll accumulates with the highs, so the ring visibly speeds up on
    // busy hat patterns rather than crawling at a fixed rate.
    dash.current += f.delta * (0.1 + high * 0.9)
    ringMat.dashOffset = -dash.current

    // Mid content drives rotation, so a dense chord section visibly moves faster
    // than a sparse one at identical overall energy.
    spin.current += f.delta * (0.1 + f.energy * 0.24 + mid * 0.4) * params.speed
    if (heroRef.current) {
      heroRef.current.rotation.y = spin.current
      heroRef.current.rotation.x = Math.sin(f.time * 0.13) * 0.3
      const s = 1 + pulse * 0.05 + f.bass * R * 0.04
      heroRef.current.scale.setScalar(s)
    }
    if (coreRef.current) {
      // Counter-rotation is what sells depth on a see-through subject; presence
      // adds a fast twitch on top of the slow bass swell.
      coreRef.current.rotation.y = -spin.current * 1.9
      coreRef.current.rotation.z = spin.current * 0.7 + pres * 0.5
      coreRef.current.scale.setScalar(0.85 + f.bass * R * 0.3 + pulse * 0.12 + tr * 0.1)
    }
    if (ringRef.current) {
      ringRef.current.rotation.x = Math.PI * 0.5 + Math.sin(f.time * 0.18) * 0.34
      ringRef.current.rotation.y = spin.current * 0.4
      // Cheapest possible degrade: the annotation layer is the first thing to
      // go when the governor is under real pressure.
      ringRef.current.visible = quality.tier <= 2
    }

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.orbit(camera, f, { radius: 9.5, elev: 1.6, elevSwing: 1.1, speed: 0.045 * params.speed, react: R })
    }
  })

  return (
    <group>
      <group ref={heroRef}>
        <primitive object={hero} />
      </group>
      <group ref={coreRef}>
        <primitive object={core} />
      </group>
      <group ref={ringRef}>
        <primitive object={ring} />
      </group>
    </group>
  )
}

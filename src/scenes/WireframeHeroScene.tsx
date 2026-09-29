import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js'
import { WireframeGeometry2 } from 'three/examples/jsm/lines/WireframeGeometry2.js'
import { quality } from '../engine/quality'
import { impulseClock, sinceImpulse, slew } from '../engine/response'
import {
  useSceneFrame,
  useSceneMode,
  useSceneParamSteps,
  useSpin,
} from '../engine/sceneFrame'
import { bipolar, drastic } from './contract'
import { useDispose } from '../engine/useDispose'

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
 *
 * ## Scene Contract
 *
 *   modes       crystal | shard | cage — which solid the hero is cut from
 *   speed       rotation rate
 *   complexity  subdivision — "facets", how finely that solid is cut
 *   fill        overall scale — how much of the frame the assembly occupies
 *   tilt        pitch offset on top of the automatic bob (0.5 = level)
 *   contrast    stroke weight and brightness — "ink", hairline to hot phosphor
 *
 * This is the roster's reference implementation of the contract's two halves,
 * because it needs both:
 *
 *  - `speed`, `fill`, `tilt` and `contrast` are read from `ctx.p` inside the
 *    frame callback. They feed transforms and material properties, so they
 *    apply on the next frame at no cost.
 *  - `mode` and `complexity` decide GEOMETRY, which is built in `useMemo`
 *    during render. Those come from `useSceneMode` and `useSceneParamSteps`,
 *    which are reactive — and `useSceneParamSteps` is what keeps a slider drag
 *    from rebuilding the edge geometry on every frame of the gesture: it only
 *    reports a new value at a bucket boundary, so a full sweep of `complexity`
 *    rebuilds twice rather than a few hundred times.
 *
 * `density` is not declared. The three elements ARE the composition, and a dial
 * that removed the core or the ring would be a dial that removes the parallax
 * and the scale reference — the two things the header says the piece is for.
 *
 * ## Response identity: per-edge kick propagation
 *
 * `engine/response.ts`'s audit found the roster's propagation entries — `web`
 * (radially outward through a hex lattice) and `travelling` (axially
 * front-to-back through a tunnel) — both live in a continuous per-FRAGMENT
 * shader field: every pixel evaluates the same `travellingPulse()` against
 * its own position. This scene has no such field to write into — three's
 * `Wireframe`/`LineMaterial` compiles its own internal shader (see the file
 * header on why it is used at all), and patching that shader is exactly the
 * "redeclared uniform" / "backtick in a GLSL template literal" trap the brief
 * warns about. So this reaches for the thing that IS available here instead:
 * the hero is built from `LineSegmentsGeometry`'s (`instanceStart`,
 * `instanceEnd`) pairs — every edge is already its own separately-addressable
 * INSTANCE, not a sample point in a continuous field. `edgeHeights()` reads
 * each edge's own local-space midpoint once at geometry build time, and the
 * frame loop writes a per-edge brightness multiplier straight into the
 * geometry's `instanceColorStart`/`instanceColorEnd` attributes (enabled via
 * `LineMaterial.vertexColors`, which multiplies `diffuseColor.rgb` — see
 * `color_fragment.glsl.js` — so it rides ON TOP of the existing hue/ink
 * routing below rather than replacing it).
 *
 * A kick charges an `ImpulseClock`; each frame, each edge asks "has the wave
 * reached MY height yet" via the same `local = sinceImpulse - pos/speed;
 * exp(-local*decay)` shape `TRAVELLING_PULSE_GLSL` documents (engine/
 * shaderLib.ts) — computed in JS here rather than GLSL, since there is no
 * fragment stage to put it in. The result: a kick lights the hero's lowest
 * edges first and the wave visibly climbs to the apex over ~0.4s, edge by
 * edge, rather than the whole mesh flashing at once. The axis is the
 * geometry's own local Y, not world/view space, so the wave rides with the
 * hero's spin instead of smearing across it — the hero rotates about Y and a
 * Y-axis wave is invariant under its own rotation.
 *
 * This is a genuinely different mechanism from `web`'s and `travelling`'s
 * propagation, not just a different axis of the same one: those two evaluate
 * one formula per fragment across a continuous surface; this evaluates one
 * per DISCRETE, individually-addressable edge instance, using data
 * (`instanceStart`/`instanceEnd`) that only exists because the hero is drawn
 * as three's real per-edge instanced quads rather than a rasterized surface.
 *
 * Brightness is the only per-edge channel `LineMaterial` exposes — linewidth
 * and dash are single uniforms, not per-instance — so the wave necessarily
 * rides a colour multiplier. That is not the audit's complaint restated: the
 * complaint was a global envelope driving a global glow uniformly; this is a
 * spatially-delayed field walking across discrete geometry, and it sits ON
 * TOP of the hero/core/ring per-band routing below, which is untouched.
 */

/** The solid the hero is cut from, per mode. `shard` reads as a chunk of the
 *  crystal, `cage` as the box that would contain it. */
function heroSolid(mode: string | undefined, detail: number): THREE.BufferGeometry {
  switch (mode) {
    case 'shard':
      return new THREE.OctahedronGeometry(2.15, detail)
    case 'cage':
      // Segment counts rather than a detail level: BoxGeometry has no
      // subdivision parameter, and stepping all three axes together is what
      // reads as the same "more facets" gesture the other two modes make.
      return new THREE.BoxGeometry(2.9, 2.9, 2.9, detail + 1, detail + 1, detail + 1)
    case 'crystal':
    default:
      return new THREE.IcosahedronGeometry(2.05, detail)
  }
}

/**
 * Kick-wave propagation constants (see the header's Response identity
 * section). `WAVE_SPEED` is in "mesh heights per second": 2.4 means the
 * wavefront crosses the hero's full bottom-to-top span in ~0.42s — fast
 * enough to read as one sweep rather than a crawl at any tempo the roster is
 * tuned for. `WAVE_DECAY` fades an arrived pulse with the same `exp(-t*k)`
 * shape `TRAVELLING_PULSE_GLSL` documents. `WAVE_GAIN` is the peak per-edge
 * brightness multiplier at the wavefront, layered on top of — not instead
 * of — the existing bass/mid/presence routing in the frame callback below.
 */
const WAVE_SPEED = 2.4
const WAVE_DECAY = 3.2
const WAVE_GAIN = 2.2

/**
 * Per-edge 0..1 position along the geometry's own local Y axis (bottom to
 * top), read directly off the wireframe's (instanceStart, instanceEnd)
 * pairs — the per-instance data LineSegmentsGeometry already keeps for every
 * edge, and exactly the "instance index or spatial position along the mesh"
 * axis a per-edge propagation wave needs. Local space rather than world
 * space so the wave rides with the geometry: the hero spins around Y, and a
 * Y-axis wave is invariant under its own spin.
 */
function edgeHeights(geo: THREE.BufferGeometry): Float32Array {
  const start = geo.attributes.instanceStart as THREE.InterleavedBufferAttribute
  const end = geo.attributes.instanceEnd as THREE.InterleavedBufferAttribute
  const n = start.count
  const t = new Float32Array(n)
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const y = (start.getY(i) + end.getY(i)) * 0.5
    t[i] = y
    if (y < min) min = y
    if (y > max) max = y
  }
  const span = Math.max(1e-4, max - min)
  for (let i = 0; i < n; i++) t[i] = (t[i] - min) / span
  return t
}

/**
 * Neutral per-edge colour buffer: multiplier 1 everywhere, so before the
 * first kick (or with no audio at all) `LineMaterial`'s `diffuseColor.rgb *=
 * vColor` is a no-op and the hero reproduces exactly the look it had before
 * this response was added. `setColors()` wants 6 floats per edge (start rgb,
 * end rgb) — see LineSegmentsGeometry.setColors.
 */
function neutralEdgeColors(edgeCount: number): Float32Array {
  return new Float32Array(edgeCount * 6).fill(1)
}

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
function makeLineMaterial(linewidth: number, dashed = false, vertexColors = false): LineMaterial {
  const mat = new LineMaterial({
    color: 0x00e5ff, // non-black default: never black-on-black pre-first-frame
    linewidth,
    transparent: true,
    depthWrite: false,
    depthTest: false, // x-ray blueprint — the whole cage reads, front and back
    blending: THREE.AdditiveBlending,
    // Only the hero enables this (see the per-edge propagation call site) —
    // core and ring never pass `true`, so their shaders compile without the
    // USE_COLOR branch and are untouched by any of this.
    vertexColors,
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
  const spin = useSpin()
  const dash = useRef(0)
  /** Slewed `b.high` — see the dash-scroll update below. */
  const highEnv = useRef(0)
  // Kick-wave propagation state (see the header's Response identity
  // section): when the wave last fired, and how strong that kick was.
  const kickWave = useRef(impulseClock())
  const kickAmp = useRef(0)

  const heroRef = useRef<THREE.Group>(null)
  const coreRef = useRef<THREE.Group>(null)
  const ringRef = useRef<THREE.Group>(null)

  // Detail 1, not 3: fewer, larger facets read as deliberately cut crystal
  // rather than a tessellated sphere — and keeps the edge count trivial.
  // vertexColors on so the propagation wave below can drive a per-edge
  // brightness multiplier; core and ring stay off it (see makeLineMaterial).
  const heroMat = useMemo(() => makeLineMaterial(2.2, false, true), [])
  const coreMat = useMemo(() => makeLineMaterial(1.2), [])
  const ringMat = useMemo(() => makeLineMaterial(1.4, true), [])

  // Both reactive reads: a mode switch or a `complexity` step rebuilds the edge
  // geometry, which cannot happen from inside the frame callback. Detail is
  // capped at 2 — an icosahedron at 3 is a tessellated sphere, and the header's
  // "deliberately cut crystal" stops reading well before that.
  const mode = useSceneMode()
  const detail = useSceneParamSteps('complexity', 0, 2)

  // heroEdgeT is recomputed alongside hero every time mode/detail rebuilds
  // the geometry — it indexes the SAME edges in the SAME order, since both
  // come from the one WireframeGeometry2 built in this memo.
  const { hero, heroEdgeT } = useMemo(() => {
    const wf = makeWireframe(heroSolid(mode, detail), heroMat)
    const edgeT = edgeHeights(wf.geometry)
    // Seed the colour attribute neutral immediately — see neutralEdgeColors's
    // doc for why this has to happen before first render, not in the frame
    // loop, and before `heroMat.vertexColors = true` ever gets used to draw.
    // Cast needed: `Wireframe.geometry` is typed as the base BufferGeometry,
    // but at runtime it is always the WireframeGeometry2 built two lines up.
    ;(wf.geometry as WireframeGeometry2).setColors(neutralEdgeColors(edgeT.length))
    return { hero: wf, heroEdgeT: edgeT }
  }, [heroMat, mode, detail])
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

  useSceneFrame(
    ({ f, dt, b, col, vis, params, anim, p }) => {
      // Each band gets its OWN visual job, so they stay separable by eye:
      //   bass     → mass (scale/breathing)
      //   mid      → harmonic body (hue shift + rotation speed)
      //   presence → edge definition (stroke weight snaps on snares/plucks)
      //   high     → the annotation ring (hats drive it, nothing else does)
      //   transient→ instantaneous flash, faster than any band envelope
      // Presence is preferred over high for punch: it spans 2–5 kHz over ~140 FFT
      // bins, where `high` averages 2–9 kHz over ~325 mostly-noise-floor bins and
      // so has visibly less dynamic range once normalized.

      // Body lines sit on the primary; the beat pushes them toward the accent, and
      // mid content pulls toward the secondary — so harmonic movement shifts hue
      // independently of rhythm instead of everything keying off the kick.
      tint
        .copy(col.a)
        .lerp(col.c, Math.min(1, b.pulse * 0.8))
        .lerp(col.b, Math.min(0.6, b.mid * 0.5))

      // No `resolution` write: `Wireframe`/`Line2` set it themselves on every
      // draw, in their own `onBeforeRender`, from `renderer.getViewport()` —
      // the CSS-pixel viewport — which overwrote the drawing-buffer size this
      // used to write here before any draw could use it. So `linewidth` is in
      // CSS pixels of the shown frame and keeps its share of whatever target is
      // bound: the same stroke at every DPR and render scale, and in a wipe
      // capture.

      // Brightness lives in the COLOUR, not in opacity — and deliberately runs
      // past 1.0. LineMaterial's alpha caps at 1, so opacity alone can only ever
      // reach "half-lit" against a black additive ground; overdriving the colour
      // is what gives these strokes the same hot phosphor punch SchematicScene
      // gets from its own >1.0 shader multiplier. Opacity is left to do one job:
      // carry the crossfade and the mood floor. The three elements' relative
      // multipliers are the visual hierarchy — hero reads first, ring last.
      //
      // `contrast` is the ink weight: it scales both the overdrive and the
      // stroke width together, because on additive line art those are the same
      // perceptual control — a hairline at high brightness and a fat stroke at
      // low brightness both read as "less ink" than a bright fat stroke. One
      // dial moving both is what makes the ends read as different drawings
      // rather than as a brightness slider. Floored so 0 is a faint blueprint
      // rather than an empty frame.
      const ink = 0.45 + p.contrast * 1.1
      heroMat.color.copy(tint).multiplyScalar((1.2 + b.pulse * 1.3 + b.transient * 0.9) * ink)
      heroMat.opacity = Math.min(1, vis)
      // Presence, not the beat, owns stroke weight — snares and plucks sharpen the
      // outline while the kick is busy moving the whole form.
      heroMat.linewidth = (1.9 + b.presence * 2.4 + b.pulse * 0.8) * ink

      coreMat.color.copy(tint).multiplyScalar((0.8 + b.bass * 0.9 + b.transient * 0.5) * ink)
      coreMat.opacity = Math.min(1, vis * 0.9)
      coreMat.linewidth = (1.1 + b.presence * 1.0) * ink

      // The ring is the highs' element, and only the highs': it stays dark through
      // a kick-only passage and lights up the moment hats/cymbals come in.
      ringMat.color.copy(tint).multiplyScalar((0.3 + b.high * 1.1 + b.pulse * 0.25) * ink)
      ringMat.opacity = Math.min(1, vis * 0.8)
      // Dash scroll accumulates with the highs, so the ring visibly speeds up on
      // busy hat patterns rather than crawling at a fixed rate. `b.high`
      // slewed before it multiplies in — found in a systematic audit
      // (2026-09-11) for the "raw band drives an accumulating rate" pattern
      // reported live and fixed twice elsewhere this session
      // (GyroidFluxScene, JavaZoneLatticeScene). This swing (0.9 against a
      // 0.1 base — 900%) is the largest of any scene in that audit, and the
      // intent above ("speeds up on busy hats") survives unsmoothed — a
      // sustained busy passage still reads as sustained highs — the raw
      // per-frame FFT jitter riding on top of it does not.
      highEnv.current = slew(highEnv.current, b.high, dt, 3, 3)
      dash.current += dt * (0.1 + highEnv.current * 0.9)
      ringMat.dashOffset = -dash.current

      // ---- Per-edge kick propagation (see header: Response identity) -----
      // A kick charges the wave clock; each edge then asks how long ago the
      // wavefront reached ITS height, same shape as TRAVELLING_PULSE_GLSL.
      // Runs in JS, not GLSL, because LineMaterial's shader is three's own
      // (see the file header) and there is no fragment stage of ours to add
      // travellingPulse() to — see the header's Response identity section.
      const kickFired = f.percussion.kick.trigger
      const sinceKick = sinceImpulse(kickWave.current, f.time, kickFired)
      if (kickFired) kickAmp.current = f.percussion.kick.strength
      const edgeColorAttr = hero.geometry.attributes.instanceColorStart as
        | THREE.InterleavedBufferAttribute
        | undefined
      if (edgeColorAttr) {
        const colors = edgeColorAttr.data.array as Float32Array
        for (let i = 0; i < heroEdgeT.length; i++) {
          const local = sinceKick - heroEdgeT[i] / WAVE_SPEED
          const pulse = local < 0 ? 0 : Math.exp(-local * WAVE_DECAY)
          const mult = 1 + pulse * WAVE_GAIN * kickAmp.current
          const base = i * 6
          colors[base] = mult
          colors[base + 1] = mult
          colors[base + 2] = mult
          colors[base + 3] = mult
          colors[base + 4] = mult
          colors[base + 5] = mult
        }
        edgeColorAttr.needsUpdate = true
      }

      // Mid content drives rotation, so a dense chord section visibly moves faster
      // than a sparse one at identical overall energy.
      const angle = spin(dt, 0.1 + f.energy * 0.24 + b.mid * 0.4, params.speed * drastic(p.speed))
      // `fill` scales the whole assembly, hero and core and ring together, so
      // the composition's proportions survive the dial — scaling only the hero
      // would break the ring's job as a scale reference. Applied to each group
      // rather than a wrapper so each keeps its own audio-driven breathing.
      const size = 0.6 + p.fill * 0.8
      // `tilt` cranes the view. Bipolar, so 0.5 keeps the authored bob exactly.
      const pitch = bipolar(p.tilt, 0.9)
      if (heroRef.current) {
        heroRef.current.rotation.y = angle
        heroRef.current.rotation.x = Math.sin(f.time * 0.13) * 0.3 + pitch
        heroRef.current.scale.setScalar(size * (1 + b.pulse * 0.05 + b.bass * 0.04))
      }
      if (coreRef.current) {
        // Counter-rotation is what sells depth on a see-through subject; presence
        // adds a fast twitch on top of the slow bass swell. `twist` is an
        // accumulating mid-driven shear — unlike b.mid it has memory, so a long
        // harmonic passage keeps leaning the core over rather than resetting to
        // centre the moment the chord stops.
        coreRef.current.rotation.y = -angle * 1.9
        coreRef.current.rotation.z = angle * 0.7 + b.presence * 0.5 + anim.twist * 0.4
        // Tension pulls the core out of the hero before a drop lands: the two
        // shells separate, then snap back on the release.
        coreRef.current.scale.setScalar(
          size * (0.85 + b.bass * 0.3 + b.pulse * 0.12 + b.transient * 0.1 + anim.explode * 0.3),
        )
      }
      if (ringRef.current) {
        ringRef.current.rotation.x = Math.PI * 0.5 + Math.sin(f.time * 0.18) * 0.34 + pitch
        ringRef.current.rotation.y = angle * 0.4
        ringRef.current.scale.setScalar(size)
        // Cheapest possible degrade: the annotation layer is the first thing to
        // go when the governor is under real pressure.
        ringRef.current.visible = quality.tier <= 2
      }
    },
    // Floored like SchematicScene: a line-art hero must stay readable through
    // quiet passages. Mood modulates it, but never crushes the subject away.
    { visCeiling: 1.4, visFloor: 0.5 },
  )

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

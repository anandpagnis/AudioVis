import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { Wireframe } from 'three/examples/jsm/lines/Wireframe.js'
import { WireframeGeometry2 } from 'three/examples/jsm/lines/WireframeGeometry2.js'
import { CURL_NOISE_GLSL } from '../engine/shaderLib'
import { slew } from '../engine/response'
import { proceduralDispatcher } from '../engine/streaming/proceduralDispatcher'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Dissolve Cage — a form scattering into particles and reforming, contained.
 *
 * Deliberately a composition of the other two new techniques rather than a
 * third one: WireframeHeroScene's real-edge cage supplies the hard geometric
 * container, PlasmaFilamentScene's curl field supplies the organic transport.
 * The tension between them (rigid frame, liquid contents) is the whole image.
 *
 * The transport is closed-form: every particle interpolates between a formed
 * position (area-weighted sample of the hero surface) and a scattered one, with
 * a per-particle stagger so dissolution sweeps across the form as a wave rather
 * than flipping like a switch. The curl term is enveloped by sin(t·π) so it
 * peaks mid-transition and vanishes at both ends — the form is crisp when
 * assembled and settled when dispersed, and only churns while in motion.
 *
 * Musically it runs an autonomous cycle so there is always something happening,
 * but drops and section changes yank it apart on the transient.
 *
 * ## Band routing
 *
 *   mid + bass  -> curl-field strength (the swirl widens through dense
 *                  harmonic passages, not only on the kick)
 *   presence    -> cage stroke weight
 *   pulse       -> point size, cage colour drive
 *   high        -> sparse per-particle sparkle, cage colour drive
 *   transient   -> per-particle jitter (see "Response identity" below)
 *   energy + presence -> per-particle brightness
 *
 * ## Response identity: per-particle stagger, refined rather than replaced
 *
 * Of 22 live scenes exactly one had any per-element delay at all before wave 1
 * — this scene's `aRand.y` stagger, and per `TRAVELLING_PULSE_GLSL`'s own doc
 * "even that is not audio-keyed" (it is a fixed per-particle offset, not tied
 * to which band or beat fires). That stagger IS the identity and is untouched
 * here. Two refinements sit on top of it instead of replacing it:
 *
 *   - The drop-forced arrival at full scatter now runs through
 *     `engine/response.ts`'s `slew()` instead of a hand-rolled
 *     `Math.min(1, dt * rate)` step — see the comment at the dissolve blend
 *     below for why an underdamped SPRING (overshoot) was considered for this
 *     spot and declined: the per-particle clamp already saturates most of the
 *     cloud before an overshoot could render anything.
 *   - The transient jitter now fires on a deterministic ~35% of particles per
 *     beat (a GLSL-side hash of particle × beat index — the same contract as
 *     `response.ts`'s `gate()`, reimplemented in-shader because a vertex
 *     shader cannot call into TS) instead of nudging all 24k every hit. A hit
 *     now reads as a subset of debris catching the impulse, which deepens the
 *     per-particle differentiation the stagger already started rather than
 *     competing with it.
 */
const COUNT = 24000
const CYCLE_BEATS = 24
const CAGE = 7.0

/** Ease used for both the dissolve envelope and the cycle dwell. */
function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

export const VERT = /* glsl */ `
  attribute vec3 aScattered;
  attribute vec4 aRand;
  uniform float uDissolve;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uPulse;
  uniform float uTransient;
  uniform float uSize;
  uniform float uJitterSeed;
  varying float vT;
  varying vec4 vRand;

  ${CURL_NOISE_GLSL}

  void main() {
    vRand = aRand;

    // Stagger: each particle starts its own transition slightly late, so the
    // dissolve reads as a travelling wave across the surface.
    float t = smoothstep(0.0, 1.0, clamp((uDissolve - aRand.y * 0.32) / 0.68, 0.0, 1.0));
    vT = t;

    vec3 p = mix(position, aScattered, t);

    // One curl tap as an organic correction, enveloped to zero at both ends.
    // Mid content widens the swirl, so the cloud churns harder through dense
    // harmonic passages rather than only responding to the kick.
    float env = sin(t * 3.14159265);
    // 0.2: Dissolve's authored epsilon — a wider sample than Plasma's, giving
    // a softer swirl. Preserved exactly rather than reconciled.
    p += curlNoise(p * 0.45 + uTime * 0.06 + aRand.x, 0.2) * env * (0.26 + uBass * 0.34 + uMid * 0.3);
    // Transient jitter: a per-particle scatter on sharp hits, strongest
    // mid-flight. Gated to a deterministic MINORITY of particles per beat
    // rather than nudging all 24k -- a hash of (particle, beat index) decides
    // participation, the same contract engine/response.ts's gate() documents
    // (same beat of the same track always picks the same subset), just
    // reimplemented here because a vertex shader cannot call into TS. Reads
    // as a spray of debris catching the impulse instead of the whole cloud
    // twitching in lockstep; the boost after the gate keeps the particles
    // that DO fire clearly visible rather than diluted by the smaller count.
    float jHash = fract(sin(dot(vec2(aRand.z, uJitterSeed), vec2(127.1, 311.7))) * 43758.5453);
    float jGate = step(jHash, 0.35);
    p += normalize(p + 0.001) * uTransient * env * 0.22 * (aRand.z - 0.5) * jGate * 1.6;
    p *= 1.0 + uPulse * 0.03;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + aRand.w) * (1.0 + uPulse * 0.45)
      * (30.0 / max(1.0, -mv.z));
  }
`

export const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColForm;
  uniform vec3 uColHot;
  uniform vec3 uColAir;
  uniform float uEnergy;
  uniform float uHigh;
  uniform float uPresence;
  uniform float uTime;
  uniform float uFade;
  varying float vT;
  varying vec4 vRand;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float m = smoothstep(0.5, 0.08, length(d));
    if (m < 0.01) discard;

    // Particles glow hottest while actually in flight — the transition is the
    // event, so it is what carries the colour and the light.
    float heat = sin(vT * 3.14159265);
    vec3 col = mix(uColForm, uColHot, heat * 0.85);

    // A sparse subset sparkles with the highs, so hats read on the cloud itself
    // and not just on the cage.
    float tw = step(0.9, fract(vRand.z * 19.0 + uTime * (0.3 + vRand.y)));
    col = mix(col, uColAir, tw * uHigh * 0.7);

    // Low per-particle contribution: 24k additive points over a compact form
    // build up fast, and the cage has to stay readable through the cloud.
    // Presence adds the snare/pluck snap on top of the slower energy term.
    float bright = (0.05 + uEnergy * 0.14 + uPresence * 0.07) * (0.4 + vRand.w)
      * (1.0 + heat * 0.7 + tw * uHigh * 1.6);
    gl_FragColor = vec4(col * bright * m * uFade, 1.0);
  }
`

/**
 * Fixed seed, so the particle field is identical every mount — what makes a
 * recording or screenshot reproducible. Previously reseeded from Math.random().
 */
const SEED = 0xd1550

/**
 * An empty shell with correctly-shaped (zero-filled) attributes and a zero
 * draw range. The area-weighted surface sampling that fills it runs on a
 * worker (see the effect below); allocating these arrays is a memset, while
 * the CDF build plus 24k binary searches it replaces cost milliseconds on the
 * mounting frame.
 */
function buildEmptyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geo.setAttribute('aScattered', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(COUNT * 4), 4))
  geo.setDrawRange(0, 0)
  return geo
}

/**
 * Pull the source surface out as a plain non-indexed triangle soup.
 * `BufferGeometry` is not structured-cloneable, so the worker takes raw typed
 * arrays; this throwaway source is disposed immediately either way.
 */
function extractSurface(): { position: Float32Array; normal: Float32Array } {
  const src = new THREE.TorusKnotGeometry(1.3, 0.42, 180, 24)
  const nonIndexed = src.index ? src.toNonIndexed() : src
  const position = new Float32Array(nonIndexed.getAttribute('position').array)
  const normal = new Float32Array(nonIndexed.getAttribute('normal').array)
  if (nonIndexed !== src) nonIndexed.dispose()
  src.dispose()
  return { position, normal }
}

export function DissolveCageScene() {
  const gl = useThree((s) => s.gl)
  const dissolve = useRef(0)
  const cycleStart = useRef(-1)
  const cageRef = useRef<THREE.Group>(null)

  const cageMat = useMemo(
    () =>
      new LineMaterial({
        color: 0x00e5ff,
        linewidth: 1.8,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )

  const cage = useMemo(() => {
    const src = new THREE.BoxGeometry(CAGE, CAGE, CAGE)
    const geo = new WireframeGeometry2(src)
    src.dispose()
    const wf = new Wireframe(geo, cageMat)
    wf.computeLineDistances()
    wf.frustumCulled = false
    return wf
  }, [cageMat])

  const geometry = useMemo(() => buildEmptyGeometry(), [])
  /** False until the worker's field lands; gates the draw range so the
   *  un-generated (all-at-origin) placeholder never renders as one bright dot. */
  const filled = useRef(false)

  useEffect(() => {
    let cancelled = false
    const { position, normal } = extractSurface()
    void proceduralDispatcher
      .requestDissolve({ position, normal, count: COUNT, cage: CAGE, seed: SEED })
      .then(({ formed, scattered, rand }) => {
        if (cancelled) return
        // Adopt the transferred buffers directly rather than copying.
        geometry.setAttribute('position', new THREE.BufferAttribute(formed, 3))
        geometry.setAttribute('aScattered', new THREE.BufferAttribute(scattered, 3))
        geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
        filled.current = true
      })
    return () => {
      cancelled = true
    }
  }, [geometry])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uDissolve: { value: 0 },
          uTime: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uPresence: { value: 0 },
          uHigh: { value: 0 },
          uPulse: { value: 0 },
          uTransient: { value: 0 },
          uJitterSeed: { value: 0 },
          uEnergy: { value: 0 },
          uSize: { value: 1.9 },
          uFade: { value: 0 },
          uColForm: { value: new THREE.Color('#00e5ff') },
          uColHot: { value: new THREE.Color('#00ffa3') },
          uColAir: { value: new THREE.Color('#7c4dff') },
        },
      }),
    [],
  )

  useDispose(cageMat, cage.geometry, material, geometry)

  useSceneFrame(
    ({ f, dt, b, col, vis, params, state, anim }) => {
      const u = material.uniforms

      geometry.setDrawRange(0, filled.current ? Math.floor(COUNT * state.particleDensity) : 0)

      // Band jobs here: mid widens the swirl and turns the cage, presence snaps the
      // cage stroke, high sparkles the cloud, transient jitters it.
      // Autonomous cycle: assembled → dispersed → assembled over CYCLE_BEATS, so
      // the scene is never static even on a track that never drops. Section
      // changes restart it, which keeps the arc aligned with the music's own form.
      const total = f.beatIndex + f.beatProgress
      if (cycleStart.current < 0) cycleStart.current = total
      if (f.sectionChange) cycleStart.current = total
      const phase = ((total - cycleStart.current) / CYCLE_BEATS) % 1
      // Triangle wave through a smooth ease — dwells at both extremes instead of
      // crossing them at constant speed.
      let target = smooth(1 - Math.abs(1 - 2 * phase))
      if (f.drop) target = 1
      // The director's dissolve primitive can only ever pull the form further
      // APART, never hold it together — it carries visualTension, so a build
      // starts scattering the cloud before the drop lands, on top of whatever the
      // autonomous cycle was already doing. Taking the max rather than adding
      // keeps the cycle's dwell at both extremes intact.
      target = Math.max(target, anim.dissolve)
      // Drops rip it apart fast (rate 9); the autonomous cycle breathes
      // slowly (rate 2.2) -- same two rates as before, but run through
      // slew() instead of the old `Math.min(1, dt * rate)` linear step. That
      // form is a literal teleport once dt * rate >= 1 (a stall past ~111ms
      // mid-drop, ~454ms mid-cycle) -- exactly the frame-rate-dependent snap
      // engine/response.ts's header warns first-order forms are prone to.
      // slew()'s `1 - exp(-dt * rate)` is asymptotic at any dt and cannot
      // produce that jump; riseRate === fallRate here so it is exactly the
      // old exponential's intent, just correct under a stalled frame.
      //
      // Considered and declined for this spot: an underdamped SPRING for a
      // hit-then-overshoot instead of an eased arrival. uDissolve only acts
      // through the per-particle clamp in the vertex shader above, so by the
      // time a drop lands most of the 24k particles are already pinned at
      // t = 1 with no room to render an overshoot -- only the last sliver of
      // the stagger window (aRand.y near 1) could show it, as a one-frame
      // flicker invisible against the rest of the cloud. What this already
      // has -- a fast attack, then a HOLD at full scatter for the whole
      // ~0.6s `f.drop` window because target stays pinned at 1 throughout,
      // then a slow release once it lifts -- already reads as a struck
      // impact rather than an instant jump; the linear-step numerics were
      // the only real bug, and that is what this change fixes.
      dissolve.current = slew(dissolve.current, target, dt, f.drop ? 9 : 2.2, f.drop ? 9 : 2.2)

      cageMat.resolution.set(gl.domElement.width, gl.domElement.height)
      // Overdriven colour rather than low opacity — LineMaterial's alpha caps at
      // 1, so brightness has to come from the colour to read as hot phosphor
      // (same reasoning as WireframeHeroScene). The cage stays below the particle
      // cloud's brightness so the dissolving form remains the subject.
      cageMat.color.copy(col.a).multiplyScalar(0.75 + b.pulse * 0.7 + b.high * 0.5)
      cageMat.opacity = Math.min(1, vis * 0.85)
      // Presence owns the cage's stroke weight — the frame sharpens on snares.
      cageMat.linewidth = 1.6 + b.presence * 1.6 + b.pulse * 0.6

      if (cageRef.current) {
        cageRef.current.rotation.y += dt * (0.06 + b.mid * 0.14) * params.speed
        // Tempo-locked sway rather than a wall-clock sine: the cage now tilts in
        // time with the track instead of drifting against it.
        cageRef.current.rotation.x = anim.oscillate * 0.12
      }

      u.uDissolve.value = dissolve.current
      u.uTime.value = f.time
      u.uBass.value = b.bass
      u.uMid.value = b.mid
      u.uPresence.value = b.presence
      u.uHigh.value = b.high
      u.uPulse.value = b.pulse
      u.uTransient.value = b.transient
      // Integer per-beat seed for the jitter gate's GLSL hash -- constant
      // across a whole beat, distinct the next one, per gate()'s own
      // recommendation to key a probability off beat/bar index for a stable,
      // reproducible pattern rather than a per-frame reroll.
      u.uJitterSeed.value = f.beatIndex
      u.uEnergy.value = b.energy
      u.uFade.value = vis
      u.uColForm.value.copy(col.a)
      u.uColHot.value.copy(col.c)
      u.uColAir.value.copy(col.b)
    },
    { visCeiling: 1.3, visFloor: 0.55 },
  )

  return (
    <group>
      <group ref={cageRef}>
        <primitive object={cage} />
      </group>
      <points geometry={geometry} frustumCulled={false}>
        <primitive object={material} attach="material" />
      </points>
    </group>
  )
}

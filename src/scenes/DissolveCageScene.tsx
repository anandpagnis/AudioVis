import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
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
 */
const COUNT = 24000
const CYCLE_BEATS = 24
const CAGE = 7.0

/** Ease used for both the dissolve envelope and the cycle dwell. */
function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

const VERT = /* glsl */ `
  attribute vec3 aScattered;
  attribute vec4 aRand;
  uniform float uDissolve;
  uniform float uTime;
  uniform float uBass;
  uniform float uMid;
  uniform float uPulse;
  uniform float uTransient;
  uniform float uSize;
  varying float vT;
  varying vec4 vRand;

  vec3 snoiseVec3(vec3 x) {
    return vec3(
      sin(x.y * 1.7 + x.z * 0.9),
      sin(x.z * 1.3 + x.x * 1.1),
      sin(x.x * 1.9 + x.y * 0.7)
    );
  }

  vec3 curl(vec3 p) {
    const float e = 0.2;
    vec3 x1 = snoiseVec3(p + vec3(e, 0.0, 0.0)), x0 = snoiseVec3(p - vec3(e, 0.0, 0.0));
    vec3 y1 = snoiseVec3(p + vec3(0.0, e, 0.0)), y0 = snoiseVec3(p - vec3(0.0, e, 0.0));
    vec3 z1 = snoiseVec3(p + vec3(0.0, 0.0, e)), z0 = snoiseVec3(p - vec3(0.0, 0.0, e));
    return vec3(
      (y1.z - y0.z) - (z1.y - z0.y),
      (z1.x - z0.x) - (x1.z - x0.z),
      (x1.y - x0.y) - (y1.x - y0.x)
    ) / (2.0 * e);
  }

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
    p += curl(p * 0.45 + uTime * 0.06 + aRand.x) * env * (0.26 + uBass * 0.34 + uMid * 0.3);
    // Transient jitter: a per-particle scatter on sharp hits, strongest mid-flight.
    p += normalize(p + 0.001) * uTransient * env * 0.22 * (aRand.z - 0.5);
    p *= 1.0 + uPulse * 0.03;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + aRand.w) * (1.0 + uPulse * 0.45)
      * (30.0 / max(1.0, -mv.z));
  }
`

const FRAG = /* glsl */ `
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
 * Area-weighted surface sample of a geometry. Uniform-random triangle picking
 * would over-sample dense small triangles (a torus knot's are not equal-area),
 * clumping the particles; a cumulative-area CDF plus a barycentric sample
 * inside the chosen triangle distributes them evenly over the real surface.
 */
function sampleSurface(source: THREE.BufferGeometry, count: number) {
  const geo = source.index ? source.toNonIndexed() : source
  const pos = geo.getAttribute('position')
  const nrm = geo.getAttribute('normal')
  const triCount = pos.count / 3

  const cdf = new Float64Array(triCount)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  let total = 0
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, t * 3)
    b.fromBufferAttribute(pos, t * 3 + 1)
    c.fromBufferAttribute(pos, t * 3 + 2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    total += ab.cross(ac).length() * 0.5
    cdf[t] = total
  }

  const formed = new Float32Array(count * 3)
  const scattered = new Float32Array(count * 3)
  const rand = new Float32Array(count * 4)
  const na = new THREE.Vector3()
  const nb = new THREE.Vector3()
  const nc = new THREE.Vector3()
  const limit = CAGE * 0.5 * 0.93 // stay inside the cage walls

  for (let i = 0; i < count; i++) {
    // Binary search the CDF for an area-proportional triangle.
    const target = Math.random() * total
    let lo = 0
    let hi = triCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < target) lo = mid + 1
      else hi = mid
    }

    // Uniform barycentric point inside triangle `lo`.
    let u = Math.random()
    let v = Math.random()
    if (u + v > 1) {
      u = 1 - u
      v = 1 - v
    }
    const w = 1 - u - v

    a.fromBufferAttribute(pos, lo * 3)
    b.fromBufferAttribute(pos, lo * 3 + 1)
    c.fromBufferAttribute(pos, lo * 3 + 2)
    const fx = a.x * w + b.x * u + c.x * v
    const fy = a.y * w + b.y * u + c.y * v
    const fz = a.z * w + b.z * u + c.z * v
    formed[i * 3] = fx
    formed[i * 3 + 1] = fy
    formed[i * 3 + 2] = fz

    // Scatter along the interpolated surface normal, so the dispersed cloud
    // keeps a ghost of the form instead of collapsing to a featureless shell.
    na.fromBufferAttribute(nrm, lo * 3)
    nb.fromBufferAttribute(nrm, lo * 3 + 1)
    nc.fromBufferAttribute(nrm, lo * 3 + 2)
    const push = 0.7 + Math.random() * 1.5
    let sx = fx + (na.x * w + nb.x * u + nc.x * v) * push + (Math.random() - 0.5) * 0.7
    let sy = fy + (na.y * w + nb.y * u + nc.y * v) * push + (Math.random() - 0.5) * 0.7
    let sz = fz + (na.z * w + nb.z * u + nc.z * v) * push + (Math.random() - 0.5) * 0.7
    // Scale back along the ray rather than clamping per-axis — a hard clamp
    // would flatten stray particles onto visible planes at the cage faces.
    const worst = Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz))
    if (worst > limit) {
      const k = limit / worst
      sx *= k
      sy *= k
      sz *= k
    }
    scattered[i * 3] = sx
    scattered[i * 3 + 1] = sy
    scattered[i * 3 + 2] = sz

    rand[i * 4] = Math.random() * 6.28
    rand[i * 4 + 1] = Math.random()
    rand[i * 4 + 2] = Math.random()
    rand[i * 4 + 3] = Math.random()
  }

  if (geo !== source) geo.dispose()

  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(formed, 3))
  out.setAttribute('aScattered', new THREE.BufferAttribute(scattered, 3))
  out.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  return out
}

export function DissolveCageScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
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

  const geometry = useMemo(() => {
    const src = new THREE.TorusKnotGeometry(1.3, 0.42, 180, 24)
    const sampled = sampleSurface(src, COUNT)
    src.dispose()
    return sampled
  }, [])

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

  useFrame(({ camera, gl }) => {
    const f = audioEngine.features
    const u = material.uniforms
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    blender.update(getPalette(paletteId), f.delta)

    geometry.setDrawRange(0, Math.floor(COUNT * quality.knobs.particleFraction))

    const pulse = beatPulse(f) * R
    // Band jobs here: mid widens the swirl and turns the cage, presence snaps the
    // cage stroke, high sparkles the cloud, transient jitters it.
    const mid = f.mid * R
    const pres = f.presence * R
    const high = f.high * R

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
    // Drops rip it apart fast; the autonomous cycle breathes slowly.
    dissolve.current += (target - dissolve.current) * Math.min(1, f.delta * (f.drop ? 9 : 2.2))

    const vis = Math.min(1.3, fade.value * (0.55 + 0.45 * params.intensity))

    cageMat.resolution.set(gl.domElement.width, gl.domElement.height)
    // Overdriven colour rather than low opacity — LineMaterial's alpha caps at
    // 1, so brightness has to come from the colour to read as hot phosphor
    // (same reasoning as WireframeHeroScene). The cage stays below the particle
    // cloud's brightness so the dissolving form remains the subject.
    cageMat.color.copy(blender.a).multiplyScalar(0.75 + pulse * 0.7 + high * 0.5)
    cageMat.opacity = Math.min(1, vis * 0.85)
    // Presence owns the cage's stroke weight — the frame sharpens on snares.
    cageMat.linewidth = 1.6 + pres * 1.6 + pulse * 0.6

    if (cageRef.current) {
      cageRef.current.rotation.y += f.delta * (0.06 + mid * 0.14) * params.speed
      cageRef.current.rotation.x = Math.sin(f.time * 0.08) * 0.12
    }

    u.uDissolve.value = dissolve.current
    u.uTime.value = f.time
    u.uBass.value = f.bass * R
    u.uMid.value = mid
    u.uPresence.value = pres
    u.uHigh.value = high
    u.uPulse.value = pulse
    u.uTransient.value = f.transient * R
    u.uEnergy.value = f.energy * R
    u.uFade.value = vis
    u.uColForm.value.copy(blender.a)
    u.uColHot.value.copy(blender.c)
    u.uColAir.value.copy(blender.b)

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      // Hover, not orbit: a caged subject wants a stable frame so the cage
      // silhouette holds still while the interior comes apart.
      rig.hover(camera, f, { pos: [0, 1.1, 11.5], look: [0, 0, 0], bob: 0.7 })
    }
  })

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

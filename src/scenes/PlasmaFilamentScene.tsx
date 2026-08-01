import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Plasma Filament — one hot core radiating shard filaments into black.
 *
 * Built on ParticleFlowScene's closed-form curl-noise advection (stateless: the
 * position is a pure function of seed + time, so there are no ping-pong render
 * targets to allocate, sync, or leak). Three deliberate departures from that
 * scene, all of which are what turn "a cloud of dots" into a subject:
 *
 *  - Core-weighted radial seeding, so density itself builds the hot centre
 *    instead of a brightness hack.
 *  - Screen-space streak orientation: each sprite is elongated along the local
 *    curl direction, which is already computed by the advection loop. Filaments
 *    for free, no extra field evaluations.
 *  - Radial colour ramp, hot accent at the core easing out to the cool primary.
 *
 * Exposure is a hard constraint, not a taste call (docs/09_Rendering_Engine.md): only the
 * core is allowed near full brightness. Per-particle contribution stays tiny so
 * the periphery accumulates to a fraction of 1.0 and the frame reads as dead
 * black with one hot subject — never an additive haze that would flatten any
 * future grade pass.
 */
const COUNT = 70000
const SPREAD = 9.0

const VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uFlow;
  uniform float uBass;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uTransient;
  uniform float uSize;
  varying float vRadius;
  varying vec2 vStreak;
  varying vec4 vRand;

  // Cheap sine field; its curl is divergence-free, so particles ride
  // streamlines instead of collapsing into sinks.
  vec3 snoiseVec3(vec3 x) {
    return vec3(
      sin(x.y * 1.7 + x.z * 0.9),
      sin(x.z * 1.3 + x.x * 1.1),
      sin(x.x * 1.9 + x.y * 0.7)
    );
  }

  vec3 curl(vec3 p) {
    const float e = 0.15;
    vec3 dx = vec3(e, 0.0, 0.0);
    vec3 dy = vec3(0.0, e, 0.0);
    vec3 dz = vec3(0.0, 0.0, e);
    vec3 x1 = snoiseVec3(p + dx), x0 = snoiseVec3(p - dx);
    vec3 y1 = snoiseVec3(p + dy), y0 = snoiseVec3(p - dy);
    vec3 z1 = snoiseVec3(p + dz), z0 = snoiseVec3(p - dz);
    float cx = (y1.z - y0.z) - (z1.y - z0.y);
    float cy = (z1.x - z0.x) - (x1.z - x0.z);
    float cz = (x1.y - x0.y) - (y1.x - y0.x);
    return vec3(cx, cy, cz) / (2.0 * e);
  }

  void main() {
    vRand = aRand;
    vec3 fp = position;

    // Advect through the scrolling curl field. Step scales with bass so the
    // filaments stretch and whip on heavy low end.
    float step = 0.26 + uBass * 0.26;
    vec3 dir = vec3(0.0, 1.0, 0.0);
    for (int i = 0; i < 4; i++) {
      dir = curl(fp * 0.22 + vec3(0.0, 0.0, uFlow * 0.14) + aRand.x);
      fp += dir * step;
    }

    // Transient rides on top of the beat pulse: it reacts faster than any band
    // envelope, so sharp hits kick the whole field outward before bass responds.
    fp *= 1.0 + uPulse * 0.07 + uTransient * 0.06;
    vRadius = length(fp);

    vec4 mv = modelViewMatrix * vec4(fp, 1.0);
    vec4 clip = projectionMatrix * mv;

    // Project the local flow direction to screen space so the fragment shader
    // can stretch the sprite ALONG the streamline. This is the filament look —
    // and dir is a byproduct of the loop above, so it costs one extra
    // transform rather than another field evaluation.
    vec4 clipB = projectionMatrix * (modelViewMatrix * vec4(fp + normalize(dir) * 0.5, 1.0));
    vec2 a = clip.xy / max(1e-4, clip.w);
    vec2 b = clipB.xy / max(1e-4, clipB.w);
    vec2 delta = b - a;
    vStreak = dot(delta, delta) > 1e-9 ? normalize(delta) : vec2(1.0, 0.0);

    gl_Position = clip;
    gl_PointSize = uSize * (0.45 + aRand.w) * (1.0 + uPulse * 0.5 + uEnergy * 0.35)
      * (34.0 / max(1.0, -mv.z));
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColCore;
  uniform vec3 uColMid;
  uniform vec3 uColEdge;
  uniform float uEnergy;
  uniform float uMid;
  uniform float uPresence;
  uniform float uHigh;
  uniform float uFade;
  uniform float uSpread;
  varying float vRadius;
  varying vec2 vStreak;
  varying vec4 vRand;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    // Rotate into the streak frame: x runs along the flow, y across it.
    vec2 ax = vStreak;
    vec2 ay = vec2(-ax.y, ax.x);
    vec2 q = vec2(dot(d, ax), dot(d, ay));

    // Most particles are soft anisotropic filaments; a minority are hard-edged
    // shard fragments, which is what keeps the field from reading as fog.
    // Mid content STRETCHES the filaments (smaller along-flow divisor = longer
    // streak), so sustained chords visibly draw the field into strands while a
    // sparse kick-only passage keeps it pointillist.
    float stretch = 0.72 - uMid * 0.34;
    float soft = smoothstep(0.5, 0.0, length(vec2(q.x * stretch, q.y * 2.5)));
    float shardMask = 1.0 - step(0.3, max(abs(q.x) * 0.7, abs(q.y) * 2.4));
    float isShard = step(0.84, vRand.y);
    float m = mix(soft, shardMask, isShard);
    if (m < 0.01) discard;

    // Radial ramp: hot accent at the core, cool primary at the periphery.
    float r = clamp(vRadius / uSpread, 0.0, 1.0);
    vec3 col = mix(uColCore, uColMid, smoothstep(0.0, 0.42, r));
    col = mix(col, uColEdge, smoothstep(0.4, 1.0, r));

    // A sparse subset flickers with the highs — reads as ionisation.
    float tw = step(0.93, fract(vRand.z * 23.0 + vRadius * 0.7));
    col = mix(col, uColEdge, tw * uHigh * 0.6);

    // Exposure discipline, and the numbers matter. The base sits at roughly the
    // per-particle contribution ParticleFlowScene already runs in production at
    // this same 70k count, so total accumulation is a known quantity rather
    // than a guess. The core boost is deliberately modest on top of that,
    // because the core-weighted SEEDING is already concentrating density there
    // — brightness and density must not both be stacked, or the core clips and
    // the frame becomes the additive haze docs/09_Rendering_Engine.md warns about.
    float coreBoost = 1.0 - smoothstep(0.0, 0.4, r);
    // Presence lights the SHARDS specifically, so snares and plucks make the
    // hard-edged fragments flare while the soft filaments stay put — two
    // populations responding to two different parts of the mix.
    float bright = (0.045 + uEnergy * 0.16) * (0.32 + vRand.w)
      * (1.0 + coreBoost * 1.6 + tw * uHigh + isShard * uPresence * 1.4);

    gl_FragColor = vec4(col * bright * m * uFade, 1.0);
  }
`

function buildGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(COUNT * 3)
  const rand = new Float32Array(COUNT * 4)
  for (let i = 0; i < COUNT; i++) {
    // Core-weighted radial seeding: a random direction at a power-law radius,
    // so density falls off outward and the centre becomes a genuine hot core.
    // (Same radial power-law idea CrystalGrowthScene uses for its shard field.)
    // Rejection-sample a direction inside the unit sphere (uniform on the
    // sphere once normalized; sampling angles directly would cluster at poles).
    let x: number
    let y: number
    let z: number
    let len: number
    do {
      x = Math.random() * 2 - 1
      y = Math.random() * 2 - 1
      z = Math.random() * 2 - 1
      len = Math.sqrt(x * x + y * y + z * z)
    } while (len < 1e-4 || len > 1)
    const dist = Math.pow(Math.random(), 1.4) * SPREAD
    positions[i * 3] = (x / len) * dist
    positions[i * 3 + 1] = (y / len) * dist * 0.85 // slightly flattened body
    positions[i * 3 + 2] = (z / len) * dist
    rand[i * 4] = Math.random() * 6.28
    rand[i * 4 + 1] = Math.random()
    rand[i * 4 + 2] = Math.random()
    rand[i * 4 + 3] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  return geo
}

export function PlasmaFilamentScene() {
  const flow = useRef(0)
  const geometry = useMemo(() => buildGeometry(), [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uFlow: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uPresence: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uTransient: { value: 0 },
          uSize: { value: 2.1 },
          uFade: { value: 0 },
          uSpread: { value: SPREAD },
          // Non-black defaults so nothing is invisible before the first frame.
          uColCore: { value: new THREE.Color('#00ffa3') },
          uColMid: { value: new THREE.Color('#00e5ff') },
          uColEdge: { value: new THREE.Color('#7c4dff') },
        },
      }),
    [],
  )

  useDispose(material, geometry)

  useSceneFrame(
    ({ f, dt, b, col, vis, params, state }) => {
      const u = material.uniforms

      // The particle budget, read from the performance state rather than the
      // quality governor directly — the governor is only its current author, and
      // going through the seam is what lets a director thin the field for
      // creative reasons too. Seeds are generated in random order, so the first
      // N are already an unbiased subset of the whole field.
      geometry.setDrawRange(0, Math.floor(COUNT * state.particleDensity))

      flow.current += dt * (0.22 + f.energy * 0.9 + (f.drop ? 1.3 : 0)) * params.speed

      u.uFlow.value = flow.current
      u.uBass.value = b.bass
      u.uMid.value = b.mid
      u.uPresence.value = b.presence
      u.uHigh.value = b.high
      u.uEnergy.value = b.energy
      u.uPulse.value = b.pulse
      u.uTransient.value = b.transient
      u.uFade.value = vis
      // Accent burns at the core, primary through the body, secondary at the rim.
      u.uColCore.value.copy(col.c)
      u.uColMid.value.copy(col.a)
      u.uColEdge.value.copy(col.b)
    },
    // No readability floor: this scene is a particle field, not line art, so it
    // is allowed to fall away entirely in the quiet.
    { visCeiling: 1, visFloor: 0 },
  )

  return (
    <points geometry={geometry} frustumCulled={false}>
      <primitive object={material} attach="material" />
    </points>
  )
}

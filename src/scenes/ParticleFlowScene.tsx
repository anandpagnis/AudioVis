import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { quality } from '../engine/quality'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

/**
 * Particle Flow — the Phase 5 particle engine. ~90k GPU particles advected
 * through an animated curl-noise flow field entirely in the vertex shader
 * (single draw call, zero CPU per-frame work). The flow is divergence-free so
 * particles swirl in streamlines; the field scrolls with the music, the bass
 * widens it, the beat bursts it, and drops scatter it. Additive, so it also
 * works as an overlay over another scene.
 */
const COUNT = 70000
const SPREAD = 9.5

const VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uFlow;
  uniform float uBass;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uSize;
  varying float vSpeed;
  varying vec4 vRand;

  // Cheap sine-based vector field; curl of it is divergence-free (no sinks).
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
    vec3 seed = position;

    // Advect the seed through the curl field; the domain scrolls with uFlow so
    // the streamlines move. A few Euler steps give structure without state.
    vec3 fp = seed;
    float step = 0.32 + uBass * 0.3;
    for (int i = 0; i < 4; i++) {
      fp += curl(fp * 0.25 + vec3(0.0, 0.0, uFlow * 0.15) + aRand.x) * step;
    }

    // Beat breathes the whole cloud outward.
    fp *= 1.0 + uPulse * 0.09;

    vSpeed = length(fp - seed);

    vec4 mv = modelViewMatrix * vec4(fp, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.4 + aRand.w) * (1.0 + uPulse * 0.6 + uEnergy * 0.4) * (30.0 / max(1.0, -mv.z));
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uTime;
  uniform float uFade;
  varying float vSpeed;
  varying vec4 vRand;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float m = smoothstep(0.5, 0.04, length(d));
    if (m < 0.01) discard;

    // Slow, calm particles in A; fast, swirling ones in B.
    vec3 col = mix(uColA, uColB, clamp(vSpeed * 0.5, 0.0, 1.0));
    // A subset sparkles with the highs.
    float tw = step(0.9, fract(vRand.z * 17.0 + uTime * (0.2 + vRand.y)));
    col = mix(col, uColC, tw * uHigh);

    // Kept low: ~90k additive points accumulate fast, so each contributes a
    // small amount and only dense/energetic regions build toward white.
    float bright = (0.055 + uEnergy * 0.22) * (0.35 + vRand.w) * (1.0 + tw * uHigh * 1.5);
    gl_FragColor = vec4(col * bright * m * uFade, 1.0);
  }
`

function buildGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(COUNT * 3)
  const rand = new Float32Array(COUNT * 4)
  for (let i = 0; i < COUNT; i++) {
    // Seed uniformly inside a sphere so the flow has a compact body to shape.
    // Rejection sampling rather than sampling angles directly, which would
    // cluster seeds at the poles.
    let x: number
    let y: number
    let z: number
    do {
      x = Math.random() * 2 - 1
      y = Math.random() * 2 - 1
      z = Math.random() * 2 - 1
    } while (x * x + y * y + z * z > 1)
    positions[i * 3] = x * SPREAD
    positions[i * 3 + 1] = y * SPREAD
    positions[i * 3 + 2] = z * SPREAD
    rand[i * 4] = Math.random() * 6.28
    rand[i * 4 + 1] = Math.random()
    rand[i * 4 + 2] = Math.random()
    rand[i * 4 + 3] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  return geo
}

export function ParticleFlowScene() {
  const flow = useRef(0)
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
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
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uTime: { value: 0 },
          uSize: { value: 1.8 },
          uFade: { value: 0 },
          uColA: { value: new THREE.Color() },
          uColB: { value: new THREE.Color() },
          uColC: { value: new THREE.Color() },
        },
      }),
    [],
  )

  useDispose(material, geometry)

  useFrame(({ camera }) => {
    const f = audioEngine.features
    const u = material.uniforms
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity

    blender.update(getPalette(paletteId), f.delta)

    // Draw only a governed fraction of the budget under load. Seeds are stored
    // in random order, so the first N are already a uniform subset of the cloud.
    geometry.setDrawRange(0, Math.floor(COUNT * quality.knobs.particleFraction))

    // Flow scrolls faster with energy; drops surge it.
    flow.current += f.delta * (0.3 + f.energy * 1.2 + (f.drop ? 1.5 : 0)) * params.speed

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.orbit(camera, f, { radius: 19, elev: 3.5, speed: 0.05 * params.speed, react: R })
    }

    u.uFlow.value = flow.current
    u.uBass.value = f.bass * R
    u.uHigh.value = f.high * R
    u.uEnergy.value = f.energy * R
    u.uPulse.value = beatPulse(f) * R
    u.uTime.value = f.time
    u.uFade.value = fade.value * params.intensity
    u.uColA.value.copy(blender.a)
    u.uColB.value.copy(blender.b)
    u.uColC.value.copy(blender.c)
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <primitive object={material} attach="material" />
    </points>
  )
}

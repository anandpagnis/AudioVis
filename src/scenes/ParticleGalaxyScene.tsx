import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

const COUNT = 30000
const ARMS = 3
const RADIUS = 9

const VERT = /* glsl */ `
  attribute vec4 aRand;
  uniform float uSpin;
  uniform float uPulse;
  uniform float uBass;
  uniform float uTime;
  uniform float uSize;
  varying float vRadius;
  varying vec4 vRand;

  void main() {
    vRand = aRand;
    vec3 p = position;
    float r = length(p.xz);
    vRadius = r;

    // Differential rotation — inner stars orbit faster.
    float theta = uSpin * (0.25 + 1.4 / (r * 0.35 + 1.0));
    float c = cos(theta);
    float s = sin(theta);
    p.xz = mat2(c, -s, s, c) * p.xz;

    // Beat pulse breathes the whole galaxy outward; bass thickens the disc.
    p.xz *= 1.0 + uPulse * 0.14 * (0.5 + aRand.x);
    p.y *= 1.0 + uBass * 0.9;

    // Gentle per-star shimmer.
    p.y += sin(uTime * (0.4 + aRand.y) + aRand.z * 6.28) * 0.06 * r;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + aRand.w) * (36.0 / max(1.0, -mv.z));
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
  varying float vRadius;
  varying vec4 vRand;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float m = smoothstep(0.5, 0.05, length(d));
    if (m < 0.01) discard;

    vec3 col = mix(uColA, uColB, smoothstep(0.0, 1.0, vRadius / ${RADIUS.toFixed(1)}));

    // A slice of stars twinkles with the high end.
    float tw = step(0.85, fract(vRand.z * 17.0 + uTime * (0.2 + vRand.y)));
    col = mix(col, uColC, tw * uHigh);

    float bright = (0.28 + uEnergy * 0.9) * (0.4 + vRand.w) * (1.0 + tw * uHigh * 2.0);
    gl_FragColor = vec4(col * bright * m * uFade, 1.0);
  }
`

function buildGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(COUNT * 3)
  const rand = new Float32Array(COUNT * 4)
  for (let i = 0; i < COUNT; i++) {
    const r = Math.pow(Math.random(), 0.6) * RADIUS
    const arm = Math.floor(Math.random() * ARMS)
    const armAngle = (arm / ARMS) * Math.PI * 2
    const winding = r * 0.55
    const jitter = (Math.random() - 0.5) * (1.4 - r / RADIUS) * 1.6
    const angle = armAngle + winding + jitter
    const y = (Math.random() - 0.5) * (Math.random() - 0.5) * 2.2 * (1.2 - (r / RADIUS) * 0.8)
    positions[i * 3] = Math.cos(angle) * r
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = Math.sin(angle) * r
    rand[i * 4] = Math.random()
    rand[i * 4 + 1] = Math.random()
    rand[i * 4 + 2] = Math.random()
    rand[i * 4 + 3] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  return geo
}

export function ParticleGalaxyScene() {
  const spin = useRef(0)
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])
  const geometry = useMemo(buildGeometry, [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uSpin: { value: 0 },
          uPulse: { value: 0 },
          uBass: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uTime: { value: 0 },
          uSize: { value: 2.4 },
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

    // Spin accelerates with energy; drops kick it hard.
    spin.current += f.delta * (0.06 + f.energy * 0.35 + (f.drop ? 0.6 : 0)) * params.speed

    // Only the incoming/steady scene instance drives the camera during a
    // crossfade (its fade never decreases), so the outgoing one can't fight it.
    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.orbit(camera, f, { radius: 13, elev: 4.5, speed: 0.05 * params.speed, react: R })
    }

    u.uSpin.value = spin.current
    u.uPulse.value = beatPulse(f) * R
    u.uBass.value = f.bass * R
    u.uHigh.value = f.high * R
    u.uEnergy.value = f.energy * R
    u.uTime.value = f.time
    u.uFade.value = fade.value * params.intensity
    u.uColA.value.copy(blender.c)
    u.uColB.value.copy(blender.a)
    u.uColC.value.copy(blender.b)
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <primitive object={material} attach="material" />
    </points>
  )
}

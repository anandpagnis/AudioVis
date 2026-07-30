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

const RIBBONS = 48
const SEGMENTS = 72
const LENGTH = 46

const VERT = /* glsl */ `
  attribute float aT;      // 0..1 along the ribbon
  attribute float aSide;   // -1 / +1 across the ribbon
  attribute vec4 aSeed;
  uniform float uFlow;
  uniform float uMid;
  uniform float uBass;
  uniform float uWidth;
  varying float vT;
  varying float vAcross;
  varying float vSeedW;

  void main() {
    vT = aT;
    vAcross = aSide;
    vSeedW = aSeed.w;
    vec3 seed = aSeed.xyz * 2.0 - 1.0;
    float phase = aSeed.w * 6.2831;

    float s = aT * ${LENGTH.toFixed(1)} - ${(LENGTH / 2).toFixed(1)};
    float amp = 1.1 + uMid * 2.6;

    vec3 p;
    p.x = s;
    p.y = seed.y * 7.0
        + sin(s * 0.25 + phase + uFlow) * amp
        + sin(s * 0.52 + phase * 1.7 + uFlow * 1.6) * amp * 0.35;
    p.z = seed.z * 11.0 + cos(s * 0.21 + phase * 1.3 + uFlow * 0.8) * (1.6 + uBass * 1.5);

    // Approximate slope for a width direction that follows the wave.
    float dy = cos(s * 0.25 + phase + uFlow) * 0.25 * amp;
    vec3 across = normalize(vec3(-dy, 1.0, 0.35 * sin(phase)));
    p += across * aSide * uWidth * (0.7 + aSeed.x * 0.6);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform float uHead;   // 0..1 pulse position along ribbons (once per bar)
  uniform float uPulse;
  uniform float uEnergy;
  uniform float uHigh;
  uniform float uFade;
  varying float vT;
  varying float vAcross;
  varying float vSeedW;

  void main() {
    vec3 col = mix(uColA, uColB, vT);

    // A bright pulse travels the ribbon once per bar, offset per ribbon.
    float head = fract(uHead + vSeedW * 0.25);
    float d = abs(vT - head);
    d = min(d, 1.0 - d);
    float glow = exp(-d * d * 220.0) * (0.5 + uPulse * 1.8);
    col += uColC * glow;

    // Soft edges across the strip; ends taper out.
    float edge = smoothstep(1.0, 0.35, abs(vAcross));
    float taper = smoothstep(0.0, 0.08, vT) * smoothstep(1.0, 0.92, vT);

    float bright = (0.3 + uEnergy * 0.8 + uHigh * 0.25) * edge * taper;
    gl_FragColor = vec4(col * (bright + glow * edge) * uFade, 1.0);
  }
`

function buildGeometry(): THREE.BufferGeometry {
  const vertsPerRibbon = (SEGMENTS + 1) * 2
  const total = RIBBONS * vertsPerRibbon
  const positions = new Float32Array(total * 3) // required attribute; real shape is in the shader
  const aT = new Float32Array(total)
  const aSide = new Float32Array(total)
  const aSeed = new Float32Array(total * 4)
  const indices: number[] = []

  for (let r = 0; r < RIBBONS; r++) {
    const seed = [Math.random(), Math.random(), Math.random(), Math.random()]
    const base = r * vertsPerRibbon
    for (let s = 0; s <= SEGMENTS; s++) {
      for (let k = 0; k < 2; k++) {
        const v = base + s * 2 + k
        aT[v] = s / SEGMENTS
        aSide[v] = k === 0 ? -1 : 1
        aSeed.set(seed, v * 4)
      }
      if (s < SEGMENTS) {
        const a = base + s * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
  geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 4))
  geo.setIndex(indices)
  return geo
}

export function RibbonFieldsScene() {
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const flow = useRef(0)
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
        side: THREE.DoubleSide,
        uniforms: {
          uFlow: { value: 0 },
          uMid: { value: 0 },
          uBass: { value: 0 },
          uWidth: { value: 0.28 },
          uHead: { value: 0 },
          uPulse: { value: 0 },
          uEnergy: { value: 0 },
          uHigh: { value: 0 },
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
    flow.current += f.delta * (0.4 + f.energy * 1.6 + (f.drop ? 1 : 0)) * params.speed

    u.uFlow.value = flow.current
    u.uMid.value = f.mid * R
    u.uBass.value = f.bass * R
    u.uHead.value = (f.beatInBar + f.beatProgress) / 4
    u.uPulse.value = beatPulse(f) * R
    u.uEnergy.value = f.energy * R
    u.uHigh.value = f.high * R
    u.uFade.value = fade.value * params.intensity
    u.uColA.value.copy(blender.a)
    u.uColB.value.copy(blender.b)
    u.uColC.value.copy(blender.c)

    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.hover(camera, f, { pos: [0, 3.5, 24], look: [0, 0, 0], bob: R })
    }
  })

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <primitive object={material} attach="material" />
    </mesh>
  )
}

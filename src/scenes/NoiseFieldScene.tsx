import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { CameraRig } from '../engine/CameraRig'
import { NOISE_GLSL } from '../engine/glsl'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

const VERT = /* glsl */ `
  uniform float uScroll;
  uniform float uAmp;
  uniform float uPulse;
  varying float vHeight;
  varying float vDist;

  ${NOISE_GLSL}

  void main() {
    vec3 p = position;
    vec2 st = vec2(p.x * 0.055, (p.y + uScroll * 12.0) * 0.055);
    float h = fbm(st);
    // Ridge the peaks a little for a more dramatic skyline.
    h = pow(h, 1.6);
    p.z = h * uAmp * (1.0 + uPulse * 0.35);
    vHeight = h;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform float uEnergy;
  uniform float uHigh;
  uniform float uFade;
  varying float vHeight;
  varying float vDist;

  void main() {
    vec3 col = mix(uColA, uColB, smoothstep(0.1, 0.6, vHeight));
    col = mix(col, uColC, smoothstep(0.55, 0.9, vHeight));
    float bright = 0.35 + uEnergy * 0.9 + vHeight * uHigh * 1.2;
    // Fade with distance into black.
    float fog = exp(-vDist * 0.055);
    gl_FragColor = vec4(col * bright * fog * uFade, 1.0);
  }
`

export function NoiseFieldScene() {
  const scroll = useRef(0)
  const fade = useContext(SceneFade)
  const lastFade = useRef(0)
  const rig = useMemo(() => new CameraRig(), [])
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        wireframe: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uScroll: { value: 0 },
          uAmp: { value: 4 },
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

  useDispose(material)

  useFrame(({ camera }) => {
    const f = audioEngine.features
    const u = material.uniforms
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity

    blender.update(getPalette(paletteId), f.delta)

    // Fly forward; speed locked to tempo (one grid-length per bar feel),
    // scaled up by energy so drops feel like acceleration.
    const beatsPerSec = f.bpm / 60
    scroll.current +=
      f.delta * (0.04 + beatsPerSec * 0.02 * (0.5 + f.energy * 1.5)) * params.speed

    const pulse = beatPulse(f) * R
    u.uScroll.value = scroll.current
    u.uAmp.value = 3.2 + f.bass * 5.5 * R
    u.uPulse.value = pulse
    u.uEnergy.value = f.energy * R
    u.uHigh.value = f.high * R
    u.uFade.value = fade.value * params.intensity
    u.uColA.value.copy(blender.a)
    u.uColB.value.copy(blender.b)
    u.uColC.value.copy(blender.c)

    // Low hovering camera with subwoofer dips on beats.
    const drivesCamera = fade.value >= lastFade.current
    lastFade.current = fade.value
    if (drivesCamera) {
      rig.hover(camera, f, { pos: [0, 6.5, 26], look: [0, 3.5, 0], bob: R })
    }
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} frustumCulled={false}>
      <planeGeometry args={[130, 130, 180, 180]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

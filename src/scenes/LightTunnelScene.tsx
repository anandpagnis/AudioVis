import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine } from '../audio/AudioEngine'
import { FULLSCREEN_VERT, NOISE_GLSL } from '../engine/glsl'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { getAudioResponse } from '../engine/audioResponse'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uZ;      // beatIndex + beatProgress: exactly one ring per beat
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uDrop;
  uniform float uFade;
  uniform vec2 uRes;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;

  ${NOISE_GLSL}

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 2.0;

    // Tunnel center drifts with the mids — feels like steering with the music.
    uv -= vec2(sin(uTime * 0.31), cos(uTime * 0.23)) * 0.25 * (0.3 + uMid);

    float ang = atan(uv.y, uv.x);
    float rad = length(uv);
    float depth = 1.0 / (rad + 0.08);
    float z = depth + uZ;

    // Rings fly past locked to the beat grid.
    float ring = fract(z);
    float ringGlow = smoothstep(0.35, 0.02, abs(ring - 0.5)) * (0.6 + uPulse * 1.6);

    // Rotating spokes; twist speeds up with energy.
    float twist = uTime * (0.15 + uEnergy * 0.5);
    float spokes = pow(abs(sin(ang * 6.0 + z * 0.35 + twist)), 6.0) * (0.3 + uHigh * 0.9);

    // Wall texture.
    float wall = fbm(vec2(ang * 2.2, z * 0.45)) * 0.5;

    // Color cycles down the tunnel; every 4th ring (the downbeat) is accented.
    float section = fract(z * 0.25);
    vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.5, section));
    col = mix(col, uColC, smoothstep(0.5, 1.0, section));
    float downbeat = step(0.75, fract(z * 0.25)) * 0.6;

    float bright = ringGlow * (1.0 + downbeat) + spokes + wall * 0.4;
    bright *= (0.4 + uBass * 0.8 + uDrop * 1.2);

    // Distance fog toward the center, soft clip near the camera.
    float fog = exp(-depth * 0.11);
    bright *= fog;
    bright *= smoothstep(0.0, 0.25, rad);

    vec3 outCol = col * bright + uColC * uDrop * 0.25 * fog;
    outCol *= uFade;
    gl_FragColor = vec4(outCol, 1.0);
  }
`

export function LightTunnelScene() {
  const fade = useContext(SceneFade)
  const zSmooth = useRef(0)
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: FRAG,
        depthWrite: false,
        depthTest: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uZ: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uDrop: { value: 0 },
          uFade: { value: 0 },
          uRes: { value: new THREE.Vector2(1, 1) },
          uColA: { value: new THREE.Color() },
          uColB: { value: new THREE.Color() },
          uColC: { value: new THREE.Color() },
        },
      }),
    [],
  )

  useDispose(material)

  useFrame(({ size }) => {
    const f = audioEngine.features
    const u = material.uniforms
    const { paletteId } = useStore.getState()
    const params = getEffectiveParams()
    const R = params.reactivity
    const response = getAudioResponse(f, 4)

    blender.update(getPalette(paletteId), f.delta)

    // Continuous beat-grid position: advances exactly one unit per beat.
    // Smoothed slightly so phase corrections never cause a visible jump.
    const zTarget = f.beatIndex + f.beatProgress
    if (zSmooth.current === 0) zSmooth.current = zTarget
    zSmooth.current += (zTarget - zSmooth.current) * Math.min(1, f.delta * 10)
    zSmooth.current += f.delta * 0.05 * params.speed // tiny drift so silence still moves

    u.uTime.value = f.time
    u.uZ.value = zSmooth.current
    u.uBass.value = response.bass * R
    u.uMid.value = response.mid * R
    u.uHigh.value = response.high * R
    u.uEnergy.value = response.energy * R
    u.uPulse.value = response.beatPulse * R
    u.uDrop.value = response.dropPulse
    u.uFade.value = fade.value * params.intensity
    u.uRes.value.set(size.width, size.height)
    u.uColA.value.copy(blender.a)
    u.uColB.value.copy(blender.b)
    u.uColC.value.copy(blender.c)
  })

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

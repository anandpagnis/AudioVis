import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { FULLSCREEN_VERT, NOISE_GLSL } from '../engine/glsl'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFlow;
  uniform float uBass;
  uniform float uMid;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uSplash;   // 0..1 expanding ring, restarts every beat
  uniform float uDrop;
  uniform float uFade;
  uniform vec2 uRes;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;

  ${NOISE_GLSL}

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    vec2 p = uv * 1.5;

    // Iterative advection — ink folding into itself.
    float t = uFlow;
    for (int i = 1; i <= 4; i++) {
      float fi = float(i);
      p += (vec2(
        fbm(p * 1.1 + vec2(t * 0.11 * fi, 3.7 * fi)),
        fbm(p * 1.1 + vec2(7.3 * fi, t * 0.09 * fi))
      ) - 0.5) * (0.62 - uMid * 0.12);
    }
    float dye = fbm(p * 1.7 + t * 0.05);

    // Layered ink colors.
    vec3 col = mix(uColA * 0.45, uColB, smoothstep(0.28, 0.62, dye));
    col = mix(col, uColC, smoothstep(0.6, 0.92, fbm(p * 2.4 - t * 0.04)));
    col += uColC * pow(dye, 5.0) * (1.0 + uPulse * 2.0);

    // Beat splash: a dye ring expanding from the center each beat.
    float rad = length(uv);
    float ring = exp(-pow((rad - uSplash * 1.4) * 9.0, 2.0));
    col += mix(uColB, uColC, 0.5) * ring * (1.0 - uSplash) * (0.35 + uPulse) * 1.6;

    // Drops flood the frame.
    col += uColA * uDrop * 0.28;

    col *= (0.38 + uEnergy * 0.85 + uBass * 0.25);
    col *= 1.0 - dot(uv, uv) * 0.45;
    col *= uFade;
    gl_FragColor = vec4(col, 1.0);
  }
`

export function FluidScene() {
  const fade = useContext(SceneFade)
  const flow = useRef(0)
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
          uFlow: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uSplash: { value: 1 },
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

    blender.update(getPalette(paletteId), f.delta)
    flow.current += f.delta * (0.35 + f.energy * 1.8 + (f.drop ? 1.2 : 0)) * params.speed

    u.uTime.value = f.time
    u.uFlow.value = flow.current
    u.uBass.value = f.bass * R
    u.uMid.value = f.mid * R
    u.uEnergy.value = f.energy * R
    u.uPulse.value = beatPulse(f) * R
    u.uSplash.value = f.beatProgress
    u.uDrop.value = f.drop ? 1 : 0
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

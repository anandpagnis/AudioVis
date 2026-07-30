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
  uniform float uWarpTime;
  uniform float uBass;
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
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Slow breathing zoom, plus a beat-synced pulse toward the viewer.
    float zoom = 1.35 - uPulse * 0.12 - uEnergy * 0.1;
    vec2 p = uv * zoom;

    // Domain-warped fbm — the nebula body.
    vec2 q = vec2(
      fbm(p * 1.6 + vec2(0.0, uWarpTime * 0.12)),
      fbm(p * 1.6 + vec2(5.2, uWarpTime * 0.09))
    );
    vec2 r = vec2(
      fbm(p * 1.6 + 3.0 * q + vec2(1.7, 9.2) + uWarpTime * 0.06),
      fbm(p * 1.6 + 3.0 * q + vec2(8.3, 2.8) + uWarpTime * 0.05)
    );
    float n = fbm(p * 1.6 + 3.2 * r);

    // Color layering.
    vec3 col = mix(uColA * 0.55, uColB, smoothstep(0.25, 0.75, n));
    col = mix(col, uColC, smoothstep(0.55, 0.95, length(q)) * 0.6);
    col += uColC * pow(n, 4.0) * (1.2 + uPulse * 2.2);

    // Core glow driven by bass.
    float core = exp(-dot(uv, uv) * 3.5);
    col += mix(uColB, uColA, 0.5) * core * (0.25 + uBass * 0.9 + uDrop * 0.8);

    // Star sparkle on the highs.
    float star = step(0.9975, hash21(floor((uv + 0.5) * uRes.y * 0.5)));
    col += vec3(1.0) * star * uHigh * (0.4 + uPulse);

    // Overall brightness rides the music, never dies in silence.
    col *= (0.35 + uEnergy * 0.75 + uPulse * 0.35);

    // Vignette + fade-in.
    col *= 1.0 - dot(uv, uv) * 0.55;
    col *= uFade;

    gl_FragColor = vec4(col, 1.0);
  }
`

export function NebulaScene() {
  const matRef = useRef<THREE.ShaderMaterial>(null)
  const warpTime = useRef(0)
  const fade = useContext(SceneFade)
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
          uWarpTime: { value: 0 },
          uBass: { value: 0 },
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
    const response = getAudioResponse(f)

    // The nebula churns faster when the music is loud.
    warpTime.current += f.delta * (0.25 + response.energy * 1.6 + response.dropPulse * 1.5) * params.speed

    blender.update(getPalette(paletteId), f.delta)

    u.uTime.value = f.time
    u.uWarpTime.value = warpTime.current
    u.uBass.value = response.bass * R
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
      <primitive object={material} attach="material" ref={matRef} />
    </mesh>
  )
}

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
  uniform float uDrift;
  uniform float uBass;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform float uBarPhase; // 0..1 across each bar — curtains sway with it
  uniform float uDrop;
  uniform float uFade;
  uniform vec2 uRes;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;

  ${NOISE_GLSL}

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    vec3 col = vec3(0.0);

    // Star field.
    float star = step(0.9965, hash21(floor((uv + 0.5) * uRes.y * 0.6)));
    col += vec3(0.8, 0.9, 1.0) * star * (0.25 + uHigh * 0.6);

    // Three aurora curtains. Bass lifts their amplitude, the bar phase sways
    // them, the highs shimmer the striations.
    float sway = sin(uBarPhase * 6.2831) * 0.12;
    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      float cy = -0.05 + fl * 0.16
        + (fbm(vec2(uv.x * 1.1 + fl * 4.7, uDrift * (0.5 + fl * 0.2))) - 0.5)
          * (0.5 + uBass * 0.55)
        + sway * (1.0 - fl * 0.3);
      float band = exp(-pow((uv.y - cy) * (6.5 - fl * 1.4), 2.0));
      // Vertical striations — the curtain folds.
      float str = 0.55 + 0.45 * sin(uv.x * 34.0 + fbm(vec2(uv.x * 3.0, uDrift + fl)) * 9.0
        + uTime * (0.4 + fl * 0.25));
      vec3 curtain = mix(uColA, uColB, fl * 0.5);
      curtain = mix(curtain, uColC, band * 0.35);
      col += curtain * band * str * (0.5 + uEnergy * 0.75 + uPulse * 0.5) * (1.0 - fl * 0.22);
    }

    // Drop: the whole sky ignites.
    col += uColB * uDrop * 0.3;

    // Ground silhouette + reflection hint.
    float ground = smoothstep(-0.34, -0.4, uv.y);
    col *= mix(0.12, 1.0, ground);

    col *= 1.0 - dot(uv, uv) * 0.35;
    col *= uFade;
    gl_FragColor = vec4(col, 1.0);
  }
`

export function DigitalAuroraScene() {
  const fade = useContext(SceneFade)
  const drift = useRef(0)
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
          uDrift: { value: 0 },
          uBass: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uBarPhase: { value: 0 },
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
    drift.current += f.delta * (0.05 + f.energy * 0.2) * params.speed

    u.uTime.value = f.time
    u.uDrift.value = drift.current
    u.uBass.value = f.bass * R
    u.uHigh.value = f.high * R
    u.uEnergy.value = f.energy * R
    u.uPulse.value = beatPulse(f) * R
    u.uBarPhase.value = (f.beatInBar + f.beatProgress) / 4
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

import { useContext, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine } from '../audio/AudioEngine'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { NOISE3D_GLSL, RAYMARCH_GLSL, SDF_GLSL } from '../engine/shaderLib'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { getAudioResponse } from '../engine/audioResponse'
import { applyQualityUniforms, qualityUniforms } from '../engine/quality'
import { useDispose } from '../engine/useDispose'
import { useStore } from '../store'

/**
 * Holographic Ocean — a raymarched sea of layered waves under a glowing
 * horizon. Swells rise with the bass, the surface flickers iridescent on the
 * highs, and the whole plane scrolls with the music. A heightfield field for
 * the shaderLib raymarcher (map returns a conservative vertical distance).
 */
const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uWarpTime;
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

  ${NOISE3D_GLSL}
  ${SDF_GLSL}
  ${RAYMARCH_GLSL}

  float waveHeight(vec2 p) {
    float h = 0.0;
    float amp = 0.55 * (1.0 + uBass * 0.9 + uPulse * 0.4);
    float freq = 0.35;
    vec2 dir = normalize(vec2(1.0, 0.6));
    for (int i = 0; i < 5; i++) {
      h += amp * sin(dot(p, dir) * freq + uWarpTime * (1.0 + float(i) * 0.35));
      dir = rot2(2.4) * dir;
      freq *= 1.7;
      amp *= 0.55;
    }
    h += (fbm3(vec3(p * 0.5, uWarpTime * 0.2)) - 0.5) * 0.7;
    return h;
  }

  float map(vec3 p) {
    // Vertical distance to the surface, scaled down so grazing rays step safely.
    return (p.y - waveHeight(p.xz)) * 0.4;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Hover above the water, looking toward the horizon while scrolling forward.
    vec3 ro = vec3(0.0, 2.3, uWarpTime * 1.2);
    vec3 rd = normalize(vec3(uv.x, uv.y * 0.6 - 0.32, 1.0));

    float glow = 0.0;
    float t = raymarch(ro, rd, 42.0, glow);

    vec3 col;
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec3 nrm = calcNormal(p);
      float fres = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 3.0);

      // Deep water in A, lit crests in B.
      col = mix(uColA * 0.12, uColB * 0.6, clamp(nrm.y, 0.0, 1.0));
      // Iridescent sky reflection via fresnel.
      vec3 sky = mix(uColB, uColC, vUv.y);
      col = mix(col, sky, fres);
      col += uColC * fres * (0.4 + uHigh * 1.1);
      // Holographic glints riding the crests on the highs.
      float glint = pow(max(0.0, sin(p.x * 6.0 + uWarpTime) * sin(p.z * 6.0)), 16.0);
      col += vec3(1.0) * glint * (0.3 + uHigh * 1.2) * fres;
      // Distance haze into the horizon.
      col = mix(col, mix(uColB, uColC, 0.5), clamp(t / 42.0, 0.0, 1.0) * 0.7);
    } else {
      // Sky: dark aloft, glowing at the horizon band.
      col = mix(mix(uColB, uColC, 0.5), uColA * 0.15, clamp(rd.y * 2.0, 0.0, 1.0));
      col += uColC * pow(max(0.0, 1.0 - abs(rd.y) * 3.0), 4.0) * (0.4 + uEnergy * 0.5 + uPulse * 0.4);
    }

    col += uColC * (uPulse * 0.15 + uDrop * 0.4);
    col *= (0.6 + uEnergy * 0.5 + uPulse * 0.2);
    col *= 1.0 - dot(uv, uv) * 0.3;
    col *= uFade;

    gl_FragColor = vec4(col, 1.0);
  }
`

export function HolographicOceanScene() {
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
          ...qualityUniforms(),
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

    // Swell scrolls faster with the music.
    warpTime.current += f.delta * (0.4 + response.energy * 1.0 + response.dropPulse * 1.0) * params.speed

    blender.update(getPalette(paletteId), f.delta)

    u.uTime.value = f.time
    u.uWarpTime.value = warpTime.current
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
    applyQualityUniforms(u)
  })

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <primitive object={material} attach="material" ref={matRef} />
    </mesh>
  )
}

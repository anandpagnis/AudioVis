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
 * Angel Core — a raymarched biomechanical organism. A displaced core sphere
 * breathes with the bass, orbiting bulbs pulse on the beat, and a twisted
 * membrane ring surrounds it. The first scene of the new art direction and the
 * reference for the raymarch shader pipeline (shaderLib.ts).
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

  // Organic surface displacement amount, kept as a global so both the field and
  // the shading can reference the same turbulence.
  float map(vec3 p) {
    // Slow tumble of the whole organism, hastened by the warp clock.
    vec3 q = p;
    q.xz = rot2(uTime * 0.15) * q.xz;
    q.xy = rot2(uTime * 0.1 + uWarpTime * 0.05) * q.xy;

    // Breathing core: radius rides bass, kicks on the beat.
    float breath = 0.72 + uBass * 0.28 + uPulse * 0.16;
    float core = sdSphere(q, breath);

    // Fleshy displacement.
    float n = fbm3(q * 2.1 + uWarpTime * 0.25);
    core += (n - 0.5) * (0.26 + uEnergy * 0.22);

    // Orbiting bulbs — the "tendril" nodes.
    float blobs = 1e9;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float a = fi * 1.5708 + uTime * 0.5;
      vec3 c = vec3(cos(a), sin(a * 1.3) * 0.5, sin(a)) * (1.12 + uMid * 0.3);
      float b = sdSphere(q - c, 0.15 + uPulse * 0.08);
      blobs = opSmoothUnion(blobs, b, 0.32);
    }

    // Twisted membrane ring.
    vec3 t = opTwist(q, 1.1 + uPulse * 1.4);
    float ring = sdTorus(t, vec2(1.4, 0.1 + uHigh * 0.12));

    float d = opSmoothUnion(core, ring, 0.5);
    d = opSmoothUnion(d, blobs, 0.4);
    return d;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Fixed pinhole camera; the field itself rotates (cheaper, stable).
    vec3 ro = vec3(0.0, 0.0, 3.2);
    vec3 rd = normalize(vec3(uv, -1.5));

    float glow = 0.0;
    float t = raymarch(ro, rd, 8.0, glow);

    vec3 col = vec3(0.0);
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec3 nrm = calcNormal(p);
      vec3 lightDir = normalize(vec3(0.6, 0.8, 0.4));
      float diff = clamp(dot(nrm, lightDir), 0.0, 1.0);
      float fres = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 3.0);

      // Two-tone body: shadowed flesh in A, lit flesh in B, rim in C.
      col = mix(uColA * 0.35, uColB, diff);
      col += uColC * fres * (0.6 + uHigh * 0.8);

      // Emissive pulse from within on the beat / drop.
      col += mix(uColB, uColC, 0.5) * (uPulse * 0.5 + uDrop * 0.7);
    }

    // Soft volumetric haze from grazing rays — bloom picks this up.
    col += mix(uColA, uColC, 0.5) * glow * (0.05 + uEnergy * 0.08 + uPulse * 0.06);

    // Overall level rides the music, never fully dies.
    col *= (0.45 + uEnergy * 0.7 + uPulse * 0.3);

    // Vignette + scene fade-in.
    col *= 1.0 - dot(uv, uv) * 0.4;
    col *= uFade;

    gl_FragColor = vec4(col, 1.0);
  }
`

export function AngelCoreScene() {
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

    // The organism tumbles faster when the music is loud.
    warpTime.current += f.delta * (0.3 + response.energy * 1.4 + response.dropPulse * 1.4) * params.speed

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

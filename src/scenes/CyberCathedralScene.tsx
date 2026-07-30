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
 * Cyber Cathedral — a raymarched colonnade you drift through: fluted columns on
 * an infinite grid, a barrel-vaulted ceiling, light bleeding between the
 * pillars. Columns swell on the bass; the vaults shimmer on the highs. Uses the
 * shaderLib SDF/raymarch toolkit.
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

  float map(vec3 p) {
    // Floor and vaulted ceiling bound the nave.
    float floorD = p.y + 2.4;
    float ceilD = 3.6 - p.y;

    // Carve barrel vaults into the ceiling (arches repeated across x).
    vec3 cp = p;
    cp.x = mod(cp.x + 3.0, 6.0) - 3.0;
    float vault = length(vec2(cp.x, p.y - 3.6)) - 2.2;
    ceilD = opSmoothSubtract(vault, ceilD, 0.35);

    float room = min(floorD, ceilD);

    // Fluted columns on a 6-unit grid in x and z.
    vec3 rp = p;
    rp.x = mod(rp.x + 3.0, 6.0) - 3.0;
    rp.z = mod(rp.z + 3.0, 6.0) - 3.0;
    float rad = 0.42 + uBass * 0.16 + uPulse * 0.06;
    float flute = 0.04 * sin(atan(rp.z, rp.x) * 10.0);
    float col = length(rp.xz) - (rad - flute);

    float d = min(room, col);
    // A little surface tremor so flat planes still read as alive.
    d += (fbm3(p * 0.9 + uWarpTime * 0.05) - 0.5) * 0.06;
    return d;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Drift forward down the nave, with a gentle sway.
    float travel = uWarpTime * 1.4;
    vec3 ro = vec3(sin(travel * 0.15) * 0.8, 0.2 * sin(travel * 0.2), travel);
    vec3 rd = normalize(vec3(uv.x, uv.y, 1.0));

    float glow = 0.0;
    float t = raymarch(ro, rd, 22.0, glow);

    vec3 col = vec3(0.0);
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec3 nrm = calcNormal(p);
      vec3 lightDir = normalize(vec3(0.3, 0.9, -0.2));
      float diff = clamp(dot(nrm, lightDir), 0.0, 1.0);
      float fres = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 3.0);

      // Cold stone: shadowed in A, lit in B, cold rim in C.
      col = mix(uColA * 0.25, uColB * 0.8, diff);
      col += uColC * fres * (0.5 + uHigh * 0.9);
      // Distance fog toward the vanishing point.
      col *= exp(-t * 0.06);
    }

    // God-ray haze between the columns (bloom amplifies this).
    col += mix(uColB, uColC, 0.5) * glow * (0.05 + uEnergy * 0.08 + uPulse * 0.05);
    col += mix(uColB, uColC, 0.5) * (uPulse * 0.25 + uDrop * 0.5);

    col *= (0.5 + uEnergy * 0.6 + uPulse * 0.25);
    col *= 1.0 - dot(uv, uv) * 0.35;
    col *= uFade;

    gl_FragColor = vec4(col, 1.0);
  }
`

export function CyberCathedralScene() {
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

    // Forward travel speeds up with the music.
    warpTime.current += f.delta * (0.5 + response.energy * 1.3 + response.dropPulse * 1.2) * params.speed

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

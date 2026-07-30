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
 * Infinite Tunnel — a raymarched flight down a warping fractal throat. The wall
 * radius pumps with the bass, corrugation rings scroll on the beat, and the
 * whole thing accelerates with the music. Distinct from the geometric Light
 * Tunnel: this is organic, noise-displaced, endless. Uses shaderLib.
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

  // Centerline of the tunnel wanders with depth.
  vec2 tunnelCenter(float z) {
    return vec2(sin(z * 0.28) * 0.9, cos(z * 0.22) * 0.9);
  }

  float map(vec3 p) {
    vec2 c = tunnelCenter(p.z);
    vec2 d2 = p.xy - c;
    float r = length(d2);
    float ang = atan(d2.y, d2.x);

    // Base radius pumps with the bass and beat.
    float radius = 2.1 + uBass * 0.5 + uPulse * 0.25;

    // We're inside: distance to the wall is (radius - r), a safe underestimate.
    float d = radius - r;

    // Fractal wall relief + scrolling corrugation rings.
    d += (fbm3(vec3(ang * 1.6, p.z * 0.5, uWarpTime * 0.2)) - 0.5) * (0.55 + uEnergy * 0.3);
    d += sin(p.z * 3.0 - uTime * 5.0) * (0.06 + uHigh * 0.06);

    // Scale down for safe sphere-tracing through the displaced field.
    return d * 0.6;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Fly forward along the wandering centerline.
    float travel = uWarpTime * 2.2;
    vec2 c = tunnelCenter(travel);
    vec3 ro = vec3(c, travel);
    // Slow roll of the camera on its axis.
    float roll = uTime * 0.15;
    mat2 rr = rot2(roll);
    vec3 rd = normalize(vec3(rr * uv, 1.0));

    float glow = 0.0;
    float t = raymarch(ro, rd, 26.0, glow);

    vec3 col = vec3(0.0);
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec3 nrm = calcNormal(p);
      float fres = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 2.0);

      // Depth-cycled color bands sweeping toward the camera.
      float band = sin(p.z * 0.5 - uTime * 2.0) * 0.5 + 0.5;
      col = mix(uColA, uColB, band);
      col += uColC * fres * (0.6 + uHigh * 1.0);
      col *= 0.5 + 0.5 * clamp(dot(nrm, normalize(vec3(0.4, 0.5, -0.6))), 0.0, 1.0);
    }

    // Neon core glow down the throat — kept restrained (interior travel
    // accumulates a lot of grazing distance, so a small coefficient here).
    float g = min(glow, 6.0);
    col += mix(uColB, uColC, 0.5) * g * (0.015 + uEnergy * 0.02 + uPulse * 0.02);
    col += uColC * (uPulse * 0.2 + uDrop * 0.4);

    col *= (0.42 + uEnergy * 0.5 + uPulse * 0.2);
    col *= 1.0 - dot(uv, uv) * 0.3;
    col *= uFade;

    gl_FragColor = vec4(col, 1.0);
  }
`

export function InfiniteTunnelScene() {
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

    // Flight speed rides the tempo/energy.
    warpTime.current += f.delta * (0.6 + response.energy * 1.8 + response.dropPulse * 2.0) * params.speed

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

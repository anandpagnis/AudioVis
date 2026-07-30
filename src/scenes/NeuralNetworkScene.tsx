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
 * Neural Network — an endless lattice of nodes wired together by thin struts,
 * drifting past the camera. Nodes swell on the bass; waves of activation sweep
 * through the mesh (brightness pulses travelling by cell index), firing harder
 * on the beat. A domain-repeated SDF field for the shaderLib raymarcher, so the
 * whole infinite grid is a couple of cheap distance evals per step.
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

  const float CELL = 3.0;

  // Distance to the nearest node, writing the node's cell id to outId.
  float nodeField(vec3 q, out vec3 outId) {
    vec3 id = floor(q / CELL);
    vec3 cell = mod(q + CELL * 0.5, CELL) - CELL * 0.5;
    // Nodes jitter within their cell so the lattice reads organic, not rigid.
    vec3 jitter = (vec3(hash13(id), hash13(id + 7.3), hash13(id + 19.1)) - 0.5) * 1.1;
    outId = id;
    return length(cell - jitter) - (0.24 + uBass * 0.14 + uPulse * 0.08);
  }

  float map(vec3 p) {
    vec3 id;
    float node = nodeField(p, id);
    // Connection struts: thin tubes along each axis through the cell centre.
    vec3 cell = mod(p + CELL * 0.5, CELL) - CELL * 0.5;
    float tx = length(cell.yz) - 0.03;
    float ty = length(cell.xz) - 0.03;
    float tz = length(cell.xy) - 0.03;
    float conn = min(tx, min(ty, tz));
    return opSmoothUnion(node, conn, 0.25);
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);

    // Slow drift through the mesh with a gentle tumble.
    vec3 ro = vec3(sin(uWarpTime * 0.2) * 1.5, cos(uWarpTime * 0.17) * 1.2, uWarpTime * 1.1);
    float rz = uTime * 0.08;
    vec3 rd = normalize(vec3(rot2(rz) * uv, 1.2));

    float glow = 0.0;
    float t = raymarch(ro, rd, 20.0, glow);

    vec3 col = vec3(0.0);
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec3 nrm = calcNormal(p);
      float fres = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 2.0);

      // Which node are we near — used to sweep activation across the lattice.
      vec3 id;
      nodeField(p, id);
      float phase = fract((id.x + id.y + id.z) * 0.15 - uTime * 0.5);
      float fire = smoothstep(0.0, 0.15, phase) * smoothstep(0.6, 0.2, phase);

      col = mix(uColA * 0.3, uColB, clamp(dot(nrm, normalize(vec3(0.5, 0.7, -0.4))), 0.0, 1.0));
      col += uColC * fres * (0.5 + uHigh * 0.9);
      // Activation pulse lights up the node and its struts.
      col += mix(uColB, uColC, 0.5) * fire * (0.6 + uPulse * 1.2 + uDrop);
      col *= exp(-t * 0.05);
    }

    // Synaptic haze from the accumulated near-misses.
    col += mix(uColB, uColC, 0.5) * glow * (0.04 + uEnergy * 0.06 + uPulse * 0.05);

    col *= (0.5 + uEnergy * 0.6 + uPulse * 0.25);
    col *= 1.0 - dot(uv, uv) * 0.35;
    col *= uFade;

    gl_FragColor = vec4(col, 1.0);
  }
`

export function NeuralNetworkScene() {
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

    warpTime.current += f.delta * (0.35 + response.energy * 1.1 + response.dropPulse * 1.0) * params.speed

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

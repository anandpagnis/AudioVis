import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality } from '../engine/quality'
import { SDF_GLSL } from '../engine/shaderLib'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Torus Fold — a Mandelbox-style folded-space fractal intersected with a
 * torus, adapted from an unattributed Shadertoy source (no author/title
 * comment was pasted, so this name is descriptive, not a reproduced title).
 *
 * The first scene to actually reuse shaderLib.ts's SDF_GLSL chunk — its
 * `rot2`/`sdTorus` are byte-identical to what this shader hand-rolled, so
 * importing the shared chunk drops the duplicate declarations instead of
 * re-authoring them a third time. The fold itself (de()) and the march/shade
 * fusion (march() returns a computed ring-pattern scalar directly, not a hit
 * distance) are still bespoke — shaderLib's generic raymarch() doesn't
 * support that fusion, same reasoning as the other two raymarch scenes this
 * session.
 *
 * Camera: like InversionMachineScene (real R3F camera drives the viewpoint)
 * rather than NetworkConstellationScene/FoldPathScene (self-contained). The
 * deciding question established this session: is the camera's own movement
 * the point, or is it a neutral vantage on a fixed subject? Here the
 * fold+torus structure sits still at the origin — only its internal fold
 * rotates — so orbiting it with CameraDirector is the natural fit, same as
 * Inversion Machine's static fractal object.
 *
 * Content animation (fold rotation, glow-band scroll, ring pulse) all rode a
 * single iTime in the source, at different per-use multipliers (1x, .2x,
 * 10x) — ported as one shared uTime accumulator at those same relative
 * rates, now audio-nudged instead of wall-clock.
 */

/**
 * Overall brightness multiplier. Measured via the same standalone-WebGL
 * compile+draw technique used for the other two ported scenes this session,
 * sampled across several uTime phases (the ring term is a sin(), so a
 * single sample can land near a trough and understate the real worst case).
 * 0.3 put the quiet state right at the <20 ceiling (19.76); 0.15 keeps the
 * worst sampled case (across 5 time phases x quiet/loud audio) at ~15.4.
 */
const BRIGHTNESS = 0.15

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};

  uniform vec2 uRes;
  uniform vec3 uRayOrigin;
  uniform vec3 uForward;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uTime;
  uniform float uBass;
  uniform float uHigh;
  uniform float uEnergy;
  uniform float uPulse;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uFade;
  // Direct reuse of the quality governor's raymarchSteps knob — this march
  // is a standard adaptive SDF sphere-trace (td+=d using the real computed
  // distance), the same style shaderLib's own RAYMARCH_GLSL/uMaxSteps
  // convention was calibrated for. Unlike FoldPathScene's fixed-step march,
  // no rescaling is needed here.
  uniform int uMaxSteps;

  ${SDF_GLSL}

  // Bass breathes the torus radius, mid (via the shared uTime rate below)
  // nudges fold-rotation speed.
  float de(vec3 p) {
    float t = -sdTorus(p, vec2(2.3 + uBass * 0.3, 2.0));
    p.y += 1.0;
    float d = 100.0, s = 2.0;
    p *= 0.5;
    for (int i = 0; i < 6; i++) {
      p.xz *= rot2(uTime);
      p.xz = abs(p.xz);
      float inv = 1.0 / clamp(dot(p, p), 0.0, 1.0);
      p = p * inv - 1.0;
      s *= inv;
      d = min(d, length(p.xz) + fract(p.y * 0.05 + uTime * 0.2) - 0.1);
    }
    return min(d / s, t);
  }

  // High sharpens/brightens the ring pulse, energy+pulse lift the
  // step-count glow (an ambient-occlusion stand-in, not a proximity glow).
  float march(vec3 from, vec3 dir) {
    float td = 0.0, g = 0.0;
    vec3 p = from;
    for (int i = 0; i < 100; i++) {
      if (i >= uMaxSteps) break;
      p = from + dir * td;
      float d = de(p);
      if (d < 0.002) break;
      g += 1.0;
      td += d;
    }
    float ring = smoothstep(0.3, 0.0, abs(0.5 - fract(p.y * 15.0))) * exp(-0.07 * td * td)
      * sin(p.y * 10.0 + uTime * 10.0) * (1.0 + uHigh * 0.8);
    float stepGlow = g * g * 0.00008 * (1.0 + uEnergy * 0.6 + uPulse * 0.4);
    return max(0.0, ring + stepGlow);
  }

  void main() {
    vec2 uv = vUv - 0.5;
    uv.x *= uRes.x / uRes.y;

    vec3 dir = normalize(uForward + uv.x * uRight + uv.y * uUp);
    float col = march(uRayOrigin, dir);

    vec3 baseCol = mix(uColA, uColB, 0.5 + 0.5 * sin(uTime * 0.3));
    vec3 tinted = col * baseCol;
    tinted *= U_BRIGHTNESS;
    tinted *= uFade;

    gl_FragColor = vec4(tinted, 1.0);
  }
`

/** Original camera sat at z=-3.3 from a torus/fold structure centered at the
 *  origin — a static subject, so this anchor mirrors that distance rather
 *  than the wider 8-17 range other (unit-sphere-scale) scenes use. */
const ANCHOR_DISTANCE = 3.3

export function TorusFoldScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const clock = useRef(0)
  const rightVec = useRef(new THREE.Vector3())
  const upVec = useRef(new THREE.Vector3())
  const forwardVec = useRef(new THREE.Vector3())

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uRes: { value: new THREE.Vector2(1, 1) },
          uRayOrigin: { value: new THREE.Vector3(0, 0, -ANCHOR_DISTANCE) },
          uForward: { value: new THREE.Vector3(0, 0, 1) },
          uRight: { value: new THREE.Vector3(1, 0, 0) },
          uUp: { value: new THREE.Vector3(0, 1, 0) },
          uTime: { value: 0 },
          uBass: { value: 0 },
          uHigh: { value: 0 },
          uEnergy: { value: 0 },
          uPulse: { value: 0 },
          uColA: { value: new THREE.Color('#ffcc33') },
          uColB: { value: new THREE.Color('#ff3d81') },
          uFade: { value: 0 },
          uMaxSteps: { value: quality.knobs.raymarchSteps },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ dt, b, col, vis, params, camera }) => {
    const u = material.uniforms

    clock.current += dt * (1.0 + b.mid * 0.3) * params.speed

    const m = camera.matrixWorld.elements
    rightVec.current.set(m[0], m[1], m[2])
    upVec.current.set(m[4], m[5], m[6])
    forwardVec.current.set(-m[8], -m[9], -m[10])

    u.uRayOrigin.value.copy(camera.position)
    u.uForward.value.copy(forwardVec.current)
    u.uRight.value.copy(rightVec.current)
    u.uUp.value.copy(upVec.current)

    u.uTime.value = clock.current
    u.uBass.value = b.bass
    u.uHigh.value = b.high
    u.uEnergy.value = b.energy
    u.uPulse.value = b.pulse
    u.uColA.value.copy(col.a)
    u.uColB.value.copy(col.c)
    u.uFade.value = vis

    u.uMaxSteps.value = Math.min(100, quality.knobs.raymarchSteps)
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

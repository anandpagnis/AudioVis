import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { effectEnvelope } from './effectEnvelope'

/**
 * Section Flare — a soft cross-shaped flash marking a structural change:
 * a new song section, or the peak a build resolves into.
 *
 * Original content, same slot-safety contract as `ShockRingScene` (see its
 * header for why `orbs` couldn't be the one to claim this role). Deliberately
 * a DIFFERENT silhouette from the ring: a ring reads as an outward hit, this
 * reads as a camera-flash "something just changed" moment — a soft central
 * bloom plus two perpendicular streaks, the classic photographic flare
 * shape. Two effects sharing one visual language would not actually give
 * `pickVariedScene` real variety to choose between when both are eligible on
 * the same fired trigger set.
 *
 * ## Math
 *
 * Every term is an `exp()` of a squared distance — no division anywhere, so
 * every term is bounded in `(0, 1]` for any finite input and there is no
 * singularity to guard against. The two streak terms are a 1-D Gaussian
 * across one axis multiplied by a slow exponential falloff along the other,
 * which is the standard closed-form way to draw a soft directional beam
 * without a loop or a raymarch.
 *
 * ## Band routing: energy, captured once
 *
 * `energy` sets how bright THIS flare reads, sampled once on the rising edge
 * into the `effect` role — same discipline as `ShockRingScene` / the seed
 * capture in `TransientSparkScene` — and held for the whole 1.8s firing so it
 * doesn't reshape as the mix moves underneath it mid-flare. A section change
 * during a loud passage flares harder than one during a quiet one.
 */

const CORE_SHARPNESS = 9.0
const STREAK_CROSS_SHARPNESS = 130.0
const STREAK_ALONG_FALLOFF = 1.1

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uRes;
  uniform vec3 uColor;
  /** Section-change loudness (energy), captured once on the rising edge. */
  uniform float uStrength;
  uniform float uFade;

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord - 0.5 * uRes) / min(uRes.x, uRes.y);

    float distC2 = dot(uv, uv);
    float core = exp(-distC2 * ${CORE_SHARPNESS.toFixed(1)});

    float beamH = exp(-(uv.y * uv.y) * ${STREAK_CROSS_SHARPNESS.toFixed(1)})
                * exp(-abs(uv.x) * ${STREAK_ALONG_FALLOFF.toFixed(2)});
    float beamV = exp(-(uv.x * uv.x) * ${STREAK_CROSS_SHARPNESS.toFixed(1)})
                * exp(-abs(uv.y) * ${STREAK_ALONG_FALLOFF.toFixed(2)});

    vec3 color = uColor * (core * 1.5 + (beamH + beamV) * 1.15) * uStrength;
    gl_FragColor = vec4(color * uFade, 1.0);
  }
`

export function SectionFlareScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const wasEffect = useRef(false)
  /** Captured energy strength, held for the whole firing — see header. */
  const strength = useRef(1)

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
          uColor: { value: new THREE.Color('#ffffff') },
          uStrength: { value: 1 },
          uFade: { value: 0 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ b, col, vis, role, slotProgress }) => {
    const u = material.uniforms
    u.uColor.value.copy(col.accent)

    // Re-sample exactly once per firing — the rising edge into the effect
    // role — same discipline as ShockRingScene / TransientSparkScene's seed
    // capture. energy is the declared band: how loud this section change
    // reads. 0.7..1.4, neutral-ish at a moderate level.
    const isEffect = role === 'effect'
    if (isEffect && !wasEffect.current) {
      strength.current = 0.7 + Math.min(1, b.energy) * 0.7
    }
    wasEffect.current = isEffect
    u.uStrength.value = strength.current

    u.uFade.value = isEffect ? vis * effectEnvelope(slotProgress) : vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

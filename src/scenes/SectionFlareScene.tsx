import { useEffect, useMemo } from 'react'
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
 */

const CORE_SHARPNESS = 9.0
const STREAK_CROSS_SHARPNESS = 130.0
const STREAK_ALONG_FALLOFF = 1.1

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uRes;
  uniform vec3 uColor;
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

    vec3 color = uColor * (core * 1.5 + (beamH + beamV) * 1.15);
    gl_FragColor = vec4(color * uFade, 1.0);
  }
`

export function SectionFlareScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)

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

  useSceneFrame(({ col, vis, role, slotProgress }) => {
    const u = material.uniforms
    u.uColor.value.copy(col.accent)
    u.uFade.value = role === 'effect' ? vis * effectEnvelope(slotProgress) : vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

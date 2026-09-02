import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { effectEnvelope } from './effectEnvelope'

/**
 * Shock Ring — a thin bright ring expanding out from centre, for a drop.
 *
 * Original content, written for the `effect` slot directly rather than
 * ported and adapted (see F20/F105's history: `orbs` claimed this role once
 * but was reopened when the licence sweep quarantined its Shadertoy-derived
 * source; the fix the ledger asked for is "a LICENSED scene willing to claim
 * the role", the same pattern `malachite` used for `background`).
 *
 * The picture: a Gaussian ring (not a hard edge, not a `1/d` singularity —
 * see MATH below) grows outward from the centre over the effect's whole
 * lifetime, plus a brief central flash in the first instant for extra
 * punch. Both terms are bounded and singularity-free by construction, which
 * matters more here than in a scene rendered continuously: an effect scene
 * fires unattended, mid-show, and a NaN or a blown-out frame is the one
 * failure mode that is actually visible to an audience.
 *
 * ## Why a Gaussian ring, not `1/d`
 *
 * `OrbitGlowScene`'s glow is `min(k/d, CAP)` — correct there because the cap
 * is applied AFTER the divide and only clips the singularity's immediate
 * neighbourhood. A ring's bright band is everywhere ON the ring, not just at
 * one point, so the natural shape is a distance-from-the-ring falloff:
 * `exp(-(d - r)^2 * k)`, which has no division at all and is bounded in
 * (0, 1] for every finite input.
 *
 * ## Timing
 *
 * Driven entirely by `slotProgress` (0..1), not elapsed seconds — the ring's
 * radius is `slotProgress * MAX_RADIUS`, so it always finishes its expansion
 * exactly when the effect retires, regardless of `durationSec`.
 *
 * ## Band routing: hit strength, captured once
 *
 * `bass` + `energy` set how hard THIS drop reads, not how the ring moves —
 * same discipline as `TransientSparkScene`'s seed: sampled once on the rising
 * edge into the `effect` role (`wasEffect` -> `!wasEffect`) and held for the
 * whole firing, not re-read every frame. A continuous read would fight the
 * ring's own timing (`slotProgress`-driven, not audio-driven) and reshape it
 * mid-expansion; a one-shot capture instead answers "how hard was the hit
 * that fired this" and scales the ring's brightness and band width by it —
 * loud stays loud and quiet stays quiet for the ring's whole 4s lifetime.
 */

const MAX_RADIUS = 1.55
/** Ring thickness control — higher is a thinner, sharper band. */
const RING_SHARPNESS = 260.0
const FLASH_SHARPNESS = 40.0

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uRes;
  uniform vec3 uColor;
  /** 0..MAX_RADIUS — how far the ring has expanded this frame. */
  uniform float uRadius;
  /** 0..1 slotProgress, for the central flash's own decay. */
  uniform float uProgress;
  /** Hit strength (bass+energy), captured once on the firing's rising edge. */
  uniform float uStrength;
  uniform float uFade;

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord - 0.5 * uRes) / min(uRes.x, uRes.y);
    float d = length(uv);

    float ringDelta = d - uRadius;
    // Dividing sharpness by uStrength widens the band on a hard hit — a
    // bigger-reading ring without disturbing the slotProgress-locked radius.
    float ring = exp(-(ringDelta * ringDelta) * (${RING_SHARPNESS.toFixed(1)} / uStrength));
    float flash = exp(-(uProgress * uProgress) * ${FLASH_SHARPNESS.toFixed(1)}) * exp(-d * d * 3.0);

    vec3 color = uColor * (ring * 2.4 * uStrength + flash * 0.85);
    gl_FragColor = vec4(color * uFade, 1.0);
  }
`

export function ShockRingScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const wasEffect = useRef(false)
  /** Captured hit strength, held for the whole firing — see header. */
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
          uRadius: { value: 0 },
          uProgress: { value: 0 },
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

    // Colour: the glow slot in the palette reads brightest against a busy
    // frame — this is meant to read as a hit, not a hue shift.
    u.uColor.value.copy(col.glow)
    u.uRadius.value = slotProgress * MAX_RADIUS
    u.uProgress.value = slotProgress

    // Re-sample exactly once per firing — the rising edge into the effect
    // role — same discipline as TransientSparkScene's seed capture. bass +
    // energy are the declared bands: how hard the drop reads, sampled once
    // so the ring doesn't reshape mid-expansion as the mix moves underneath
    // it. 0.7..1.4, neutral-ish at a moderate hit.
    const isEffect = role === 'effect'
    if (isEffect && !wasEffect.current) {
      const raw = Math.min(1, b.bass * 0.6 + b.energy * 0.6)
      strength.current = 0.7 + raw * 0.7
    }
    wasEffect.current = isEffect
    u.uStrength.value = strength.current

    // Same discipline as OrbitGlowScene: `slotProgress` is only meaningful in
    // the effect role, and `effectEnvelope` is zero at slotProgress 0, so a
    // scene that read it unconditionally would be invisible outside `effect`.
    u.uFade.value = isEffect ? vis * effectEnvelope(slotProgress) : vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

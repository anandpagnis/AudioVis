import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { effectEnvelope } from './effectEnvelope'

/**
 * Transient Spark — three small points of light popping in on a hit.
 *
 * `transient` fires far more often than `drop` or a section change (any
 * onset crossing the threshold in `TriggerEdges`), and a punctuation effect
 * that fires on every one of those stops being punctuation and becomes
 * texture — the exact failure mode F20's original notes named as the reason
 * `drop` was chosen for the FIRST effect scene ever wired up. The mitigation
 * here is a real cooldown (2.5s — see index.ts), not a sub-second duration:
 * this engine's own effect-lifetime contract holds "under about a second
 * reads as a dropped frame" regardless of how often the trigger fires, so a
 * frequent trigger still gets the same 1-8s lifetime as a rare one and is
 * throttled by `cooldownSec` instead. `effectEnvelope`'s fast-rise,
 * long-decay shape still reads as a quick pop at 1.2s, since the decay
 * dominates the lifetime at any duration.
 *
 * ## Deterministic placement, not random
 *
 * Every selector in this engine is a pure function of a seed or a rotation
 * counter — no `Math.random()` — so a recorded show replays identically.
 * The three spark positions follow the same discipline: seeded from the
 * beat position (`beatIndex + beatProgress`) at the instant the effect
 * fires, spread by the golden angle (≈2.39996 rad), a standard closed-form
 * way to place a small deterministic set of points without them clustering.
 * The seed is captured once per firing (an edge, exactly like
 * `TriggerEdges` tracks rising edges elsewhere) rather than read continuously,
 * so the three points hold still for the burst instead of drifting.
 *
 * ## Falloff without a singularity
 *
 * `amt / (d² · k + 1)` — bounded in `(0, amt]` for every finite `d`, unlike
 * `amt / d` (a true singularity at the spark centre, tamed only by an
 * external clamp in `OrbitGlowScene`). At `d = 0` this reads exactly `amt`;
 * no clamp needed because there is nothing to clamp.
 *
 * ## Band routing: transient strength, captured once
 *
 * `high` + `energy` set how bright THIS pop reads, sampled in the exact same
 * rising-edge block that already seeds the three positions — one read of `b`
 * alongside the existing read of `f.beatIndex`/`f.beatProgress`, held for the
 * whole 1.2s firing. A sharp, loud transient now pops visibly brighter than a
 * soft one, not just at a different spot.
 */

const GOLDEN_ANGLE = 2.399963
const SPARK_RADIUS = 0.34
const FALLOFF_K = 110.0

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uRes;
  uniform vec3 uCol1;
  uniform vec3 uCol2;
  uniform vec3 uCol3;
  uniform vec2 uPos1;
  uniform vec2 uPos2;
  uniform vec2 uPos3;
  /** Transient strength (high+energy), captured once on the firing's rising edge. */
  uniform float uStrength;
  uniform float uFade;

  vec3 spark(vec2 uv, vec2 pos, vec3 c){
    float d2 = dot(uv - pos, uv - pos);
    return c / (d2 * ${FALLOFF_K.toFixed(1)} + 1.0);
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord - 0.5 * uRes) / min(uRes.x, uRes.y);

    vec3 color = spark(uv, uPos1, uCol1) + spark(uv, uPos2, uCol2) + spark(uv, uPos3, uCol3);
    gl_FragColor = vec4(color * uStrength * uFade, 1.0);
  }
`

export function TransientSparkScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const wasEffect = useRef(false)
  /** Captured transient strength, held for the whole firing — see header. */
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
          uCol1: { value: new THREE.Color('#ffffff') },
          uCol2: { value: new THREE.Color('#ffffff') },
          uCol3: { value: new THREE.Color('#ffffff') },
          uPos1: { value: new THREE.Vector2(0, 0) },
          uPos2: { value: new THREE.Vector2(0, 0) },
          uPos3: { value: new THREE.Vector2(0, 0) },
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

  useSceneFrame(({ f, b, col, vis, role, slotProgress }) => {
    const u = material.uniforms

    // Re-seed exactly once per firing — the rising edge into the effect
    // role — so the three points hold still for the whole burst rather than
    // drifting as beatProgress advances underneath them. Same edge also
    // captures how bright this pop reads: high + energy are the declared
    // bands, sampled once so the spark doesn't reshape mid-burst. 0.7..1.4,
    // neutral-ish at a moderate transient.
    const isEffect = role === 'effect'
    if (isEffect && !wasEffect.current) {
      const seed = f.beatIndex + f.beatProgress
      const set = (uni: THREE.Vector2, i: number) => {
        const angle = seed * GOLDEN_ANGLE + i * ((2 * Math.PI) / 3)
        uni.set(Math.cos(angle) * SPARK_RADIUS, Math.sin(angle) * SPARK_RADIUS)
      }
      set(u.uPos1.value, 0)
      set(u.uPos2.value, 1)
      set(u.uPos3.value, 2)

      const raw = Math.min(1, b.high * 0.6 + b.energy * 0.6)
      strength.current = 0.7 + raw * 0.7
    }
    wasEffect.current = isEffect
    u.uStrength.value = strength.current

    u.uCol1.value.copy(col.mid)
    u.uCol2.value.copy(col.accent)
    u.uCol3.value.copy(col.glow)
    u.uFade.value = isEffect ? vis * effectEnvelope(slotProgress) : vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

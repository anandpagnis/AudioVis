import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { effectEnvelope } from './effectEnvelope'
import { layoutSparks, MAX_SPARKS, pickSparkCount, RECENT_WINDOW } from './transientSparkLayout'

/**
 * Transient Spark — points of light popping in on a hit: anywhere from a single big soft bloom to a
 * crowd of 15 small ones, with the count and spread changing every firing (`transientSparkLayout.ts`).
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
 * The count and positions follow the same discipline: seeded from the
 * beat position (`beatIndex + beatProgress`) at the instant the effect
 * fires plus a per-firing counter, then laid out by the golden angle (≈2.39996 rad), a
 * standard closed-form way to place a set of points without them clustering.
 * The seed is captured once per firing (an edge, exactly like
 * `TriggerEdges` tracks rising edges elsewhere) rather than read continuously,
 * so the points hold still for the burst instead of drifting. It used to be exactly three
 * lights every time, which read as one repeated stamp.
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
 *
 * ## Mood scale, folded into the same `raw` this already feeds `pickSparkCount`
 *
 * `EffectDirector` captures a bounded mood `intensity` (0.8..1.1) onto this
 * firing's `ActiveEffect` at fire time, only while a valid mood look drove the
 * pick. Read once, on the same rising edge, off the live `state.layers.effects`
 * singleton, and folded straight into `raw` (the 0..1 value already driving
 * BOTH `strength` and `pickSparkCount`) before either consumes it — so a
 * mood-favoured transient reads a little brighter AND tends toward a bigger
 * burst, through the exact same lever the audio-driven strength already uses,
 * with no change to `pickSparkCount`'s own signature or contract.
 */

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2 uRes;
  uniform vec3 uCol1;
  uniform vec3 uCol2;
  uniform vec3 uCol3;
  /** Live light count, 1..MAX_SPARKS. */
  uniform int uCount;
  /** Per light: xy = position, z = falloff steepness, w = brightness. */
  uniform vec4 uSpark[${MAX_SPARKS}];
  /** Transient strength (high+energy), captured once on the firing's rising edge. */
  uniform float uStrength;
  uniform float uFade;

  vec3 spark(vec2 uv, vec4 s, vec3 c){
    vec2 d = uv - s.xy;
    return c * s.w / (dot(d, d) * s.z + 1.0);
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord - 0.5 * uRes) / min(uRes.x, uRes.y);

    vec3 color = vec3(0.0);
    for (int i = 0; i < ${MAX_SPARKS}; i++) {
      if (i >= uCount) break;
      float slot = mod(float(i), 3.0);
      vec3 c = slot < 0.5 ? uCol1 : (slot < 1.5 ? uCol2 : uCol3);
      color += spark(uv, uSpark[i], c);
    }
    gl_FragColor = vec4(color * uStrength * uFade, 1.0);
  }
`

export function TransientSparkScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const wasEffect = useRef(false)
  /** Captured transient strength, held for the whole firing — see header. */
  const strength = useRef(1)
  /** Firings so far, folded into the seed so two bursts on the same beat position still differ. */
  const firings = useRef(0)
  /** Recent light counts, so the next burst is a clearly different size. */
  const recentCounts = useRef<number[]>([])

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
          uCount: { value: 3 },
          uSpark: { value: Array.from({ length: MAX_SPARKS }, () => new THREE.Vector4(0, 0, 100, 0)) },
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

  useSceneFrame(({ f, b, col, vis, role, slotProgress, state }) => {
    const u = material.uniforms

    // Re-seed exactly once per firing — the rising edge into the effect
    // role — so the points hold still for the whole burst rather than
    // drifting as beatProgress advances underneath them. Same edge also
    // captures how bright this pop reads: high + energy are the declared
    // bands, sampled once so the spark doesn't reshape mid-burst. 0.7..1.4,
    // neutral-ish at a moderate transient.
    const isEffect = role === 'effect'
    if (isEffect && !wasEffect.current) {
      // Mood intensity for THIS firing — see header. undefined (no mood look
      // driving the pick) reads as neutral.
      const moodIntensity = state.layers.effects.find((e) => e.id === 'spark')?.intensity ?? 1
      const raw = Math.min(1, Math.max(0, Math.min(1, b.high * 0.6 + b.energy * 0.6) * moodIntensity))
      strength.current = 0.7 + raw * 0.7

      const seed = f.beatIndex + f.beatProgress + firings.current++ * 7.31
      const count = pickSparkCount(seed, raw, recentCounts.current)
      recentCounts.current = [...recentCounts.current, count].slice(-RECENT_WINDOW)
      const sparks = layoutSparks(count, seed, size.width / Math.max(1, size.height))
      u.uCount.value = sparks.length
      sparks.forEach((sp, i) => u.uSpark.value[i].set(sp.x, sp.y, sp.k, sp.amp))
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

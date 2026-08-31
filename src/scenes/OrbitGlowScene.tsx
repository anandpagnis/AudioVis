import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { drastic } from './contract'
import { effectEnvelope } from './effectEnvelope'

/**
 * Orbit Glow — three soft orbs drifting on independent Lissajous paths.
 * Floating and calm: the opposite pole from Heap Corruption's glitch and
 * Tunnel Drift's forward drive.
 *
 * Ported from an untitled Shadertoy piece (the source carried Vietnamese
 * comments and no author or licence, so there is nothing to credit beyond
 * that). The maths is four lines — an inverse-distance glow at a
 * cos/sin-parameterised position, summed over three orbs.
 *
 * ## Band routing: one orb per band
 *
 * The source gives all three orbs the same fixed radius, the same fixed glow,
 * and hardcoded RGB. That makes them decorative but interchangeable. Here each
 * orb owns a different part of the spectrum, following the per-band job
 * separation WireframeHeroScene documents:
 *
 *   orb 1  bass      → slowest orbit, widest swing, the mass of the piece
 *   orb 2  mid       → mid-rate orbit, the harmonic body
 *   orb 3  presence  → fastest orbit, the detail that sharpens on plucks
 *                      and snare rather than on the kick
 *
 * Each orb's GLOW is driven by its own band plus the shared beat pulse, so on a
 * bass-heavy bar orb 1 flares while orb 3 stays dim, and a hat-and-pluck
 * passage does the reverse. That separation is the whole point — three orbs
 * pulsing identically would just be a brighter version of one.
 *
 * Colour comes from the palette blender rather than the source's hardcoded
 * coral/amber/violet, so this recolours with the rest of the show.
 *
 * ## Orbit phase accumulates
 *
 * Speed scales with energy and tempo, which means the phase has to ACCUMULATE
 * in JS rather than being `uTime * rate`. Multiplying a running clock by a
 * changing rate makes every orb teleport the instant the rate moves — the same
 * trap TunnelDriftScene's flight distance documents. `cos(phase * k)` stays
 * continuous under a varying rate as long as `phase` only ever increases.
 *
 * ## Scene Contract
 *
 *   speed     orbit rate
 *   density   radius SPREAD — "spread", how far the three paths separate
 *   fill      orbit width — "orbit", how much of the frame they sweep
 *   contrast  glow amount — "glow", faint haze to hot core
 *
 * `density` is the spread rather than a count because the count is three, and
 * three is the piece: one orb per band is what makes the bands separable by eye
 * (see the band routing above), and a fourth orb would have no band to give it.
 * At 0 the three collapse onto one shared radius and read as a single braided
 * path; at 1 they pull apart into three distinct rings.
 *
 * `shape` and `tilt` are not declared — the path frequency constants are the
 * source's identity, and the piece is centred and flat.
 */

/**
 * Overall brightness.
 *
 * `glow = k / d` has no upper bound as `d` approaches zero, so the orb centres
 * are singularities — fine in the source, which renders alone on black, but
 * this is authored as an additive LAYER over a subject, where the whole frame
 * is already carrying light. The falloff is capped in the shader (see
 * MAX_GLOW) rather than softened, so the curve keeps its shape and only the
 * blown centre is tamed.
 *
 * 0.28 is set for layer use, in the same spirit as the 0.65x trim Flow Ribbons
 * needed once it was actually seen composited. Not measured by rendering —
 * worth a look.
 */
/**
 * ## Quality governance
 *
 * No `quality.knobs` read, deliberately. There is no loop in this shader and no
 * geometry behind it — three analytic blobs, a length and a divide each — so
 * there is no complexity to scale and nothing a knob could honestly reduce.
 *
 * Its governance is `metadata.fillBound: false` (see index.ts) — the assertion
 * that downscaling this scene would save nothing measurable while banding the
 * 1/d falloff that is the entire picture, so it renders at `NATIVE_PIXEL_BUDGET`
 * instead of the `low`-cost default. Not an exemption: the budget still
 * combines with its neighbours' when this is layered, so `orbs` under a
 * raymarcher still ends up rendering at the raymarcher's resolution.
 */
const BRIGHTNESS = 0.28

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};
  // Caps the 1/d singularity at each orb centre without changing the falloff
  // shape everywhere else.
  const float MAX_GLOW = 6.0;

  uniform vec2 uRes;
  /** Accumulated orbit phase. Replaces the source's raw iTime. */
  uniform float uPhase;
  uniform vec3 uCol1;
  uniform vec3 uCol2;
  uniform vec3 uCol3;
  /** Per-orb glow amount — each driven by its own band. */
  uniform vec3 uGlow;
  /** Per-orb orbit radius. */
  uniform vec3 uRadius;
  uniform float uFade;

  vec3 colorBall(vec3 glowColor, float speedx, float speedy, vec2 uv, float radius, float amt){
    vec2 pos = vec2(cos(uPhase*speedx), sin(uPhase*speedy)) * radius;
    float d = length(uv - pos);
    float glow = min(amt / max(d, 1e-4), MAX_GLOW);
    return glow * glowColor;
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord - 0.5 * uRes) / min(uRes.x, uRes.y);

    // Frequency constants are the source's, unchanged — they are what makes the
    // three paths drift in and out of phase with each other. Only the overall
    // RATE is audio-driven, via uPhase.
    vec3 ball1 = colorBall(uCol1, 1.3, 3.0, uv, uRadius.x, uGlow.x);
    vec3 ball2 = colorBall(uCol2, 0.4, 2.0, uv, uRadius.y, uGlow.y);
    vec3 ball3 = colorBall(uCol3, 1.9, 0.6, uv, uRadius.z, uGlow.z);

    vec3 finalColor = ball1 + ball2 + ball3;
    gl_FragColor = vec4(finalColor * U_BRIGHTNESS * uFade, 1.0);
  }
`

export function OrbitGlowScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const phase = useRef(0)

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
          uPhase: { value: 0 },
          uCol1: { value: new THREE.Color('#ff5e62') },
          uCol2: { value: new THREE.Color('#ff9966') },
          uCol3: { value: new THREE.Color('#8a2387') },
          uGlow: { value: new THREE.Vector3(0.03, 0.03, 0.03) },
          uRadius: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
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

  useSceneFrame(({ f, dt, b, col, vis, params, p, role, slotProgress }) => {
    const u = material.uniforms

    // Phase ACCUMULATES — see the header. Tempo sets the baseline (a 140 BPM
    // track drifts faster than a 90 BPM one) and energy opens it up further, so
    // the orbits speed up as the track builds instead of running independently
    // of it. Floored so a breakdown drifts rather than freezing.
    const tempo = Math.min(1.6, Math.max(0.6, f.bpm / 120))
    phase.current += dt * (0.35 + b.energy * 0.85) * tempo * params.speed * drastic(p.speed)
    u.uPhase.value = phase.current

    // Radius: orbits widen on a swell and tighten when the track thins out.
    // Per-orb spread keeps them from tracing the same ellipse.
    //
    // `fill` scales all three together — how much of the frame the orbits
    // sweep. `density` scales only their DIFFERENCES from the mean, so the
    // dial separates the paths without changing how wide they run. Applied to
    // the audio-driven radii rather than to the constants, so a swell still
    // widens whatever spread is dialled in.
    const width = 0.55 + p.fill * 0.9
    const spread = drastic(p.density)
    const r1 = 0.24 + b.bass * 0.14
    const r2 = 0.3 + b.mid * 0.1
    const r3 = 0.36 + b.presence * 0.08
    const mean = (r1 + r2 + r3) / 3
    u.uRadius.value.set(
      (mean + (r1 - mean) * spread) * width,
      (mean + (r2 - mean) * spread) * width,
      (mean + (r3 - mean) * spread) * width,
    )

    // The high-value term: each orb flares on ITS band, with the shared beat
    // pulse underneath so all three still breathe together on the downbeat.
    // `contrast` scales the whole glow budget; floored above zero so the dial
    // at 0 dims the orbs rather than deleting them.
    const pulse = b.pulse * 0.012
    const glow = 0.35 + p.contrast * 1.3
    u.uGlow.value.set(
      (0.016 + b.bass * 0.042 + pulse) * glow,
      (0.016 + b.mid * 0.038 + pulse) * glow,
      (0.014 + b.presence * 0.034 + pulse) * glow,
    )

    u.uCol1.value.copy(col.a)
    u.uCol2.value.copy(col.b)
    u.uCol3.value.copy(col.c)
    // In the EFFECT slot this scene owns its own exit.
    //
    // `SceneManager` retires an effect entry the moment `slotProgress` reaches
    // 1 and does NOT fade it out — so a scene that is still bright there simply
    // vanishes. That requirement is the only reason the effect role went
    // unclaimed while everything else about the slot was finished and tested
    // (F20).
    //
    // Every other role keeps the plain `vis`, which is what the crossfade
    // machinery is already driving. Reading `slotProgress` unconditionally
    // would be a bug: it is 0 for a normal layer, and this envelope is 0 at 0.
    u.uFade.value = role === 'effect' ? vis * effectEnvelope(slotProgress) : vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

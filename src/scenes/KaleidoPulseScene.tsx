import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality } from '../engine/quality'
import { useSceneFrame } from '../engine/sceneFrame'
import { bipolar, drastic, steps } from './contract'
import { useDispose } from '../engine/useDispose'

/**
 * Kaleido Pulse — a centred, symmetric fractal mandala of pulsing rings, built
 * by domain-repeating the plane and glowing the folded distance.
 *
 * The structure is the widely-circulated teaching shader from kishimisu's "An
 * Introduction to Shader Art Coding"; `palette()` is Inigo Quilez's cosine
 * palette (iquilezles.org/articles/palettes). Neither carried a licence header
 * in the source given, so this credits both by name.
 *
 * Radial and centred, which is the point of adding it: Tunnel Drift already
 * covers hypnotic-and-rhythmic, but its silhouette is a forward flythrough.
 * This one holds still and pulses outward, so the two read as different
 * pictures even in the same mood.
 *
 * ## Band routing
 *
 *   pulse      → RING PHASE. The highest-value mapping by a distance; see below.
 *   bass       → domain-repeat scale, kept deliberately tiny.
 *   transient  → ring contrast, a brief sharpening "snap" on hits.
 *   energy     → overall ring travel rate.
 *   section    → palette rotation (see the colour note).
 *
 * ## Why the pulse can drive this phase directly, unlike Tunnel Drift
 *
 * `b.pulse` is an envelope: it rises and falls on every beat rather than
 * advancing. Tunnel Drift could not use it as a phase because its glow bands
 * live inside `fract()`, where running the phase backwards makes the pattern
 * jump — so that scene takes its timing from the monotonic beat grid instead.
 *
 * Here the phase sits inside `sin()`, which is smooth and symmetric, so a
 * phase that goes up and back down does not glitch — it makes the rings expand
 * and contract. That is precisely the wanted behaviour, so the envelope is used
 * directly, as the highest-value change in the port.
 *
 * A slow monotonic drift is kept underneath it. With the pulse term alone the
 * rings would be motionless between beats and freeze completely in a quiet
 * passage, which reads as broken rather than as calm.
 *
 * ## Colour
 *
 * This is the one scene in the roster that does NOT take its colours from the
 * palette blender. The cosine palette IS the piece — replacing it with two
 * blended tints throws away the thing that makes it recognisable, the same
 * reasoning that let JuliaWingsScene keep its inverted background.
 *
 * It is not left purely on wall-clock either: the palette phase takes a nudge
 * on every section boundary, so the mandala still recolours WITH the song's
 * structure even though it does not follow the mood palette.
 *
 * ## Scene Contract
 *
 *   speed       ring travel and palette rotation rate
 *   complexity  fractal iterations — "layers", the finest ring layer first
 *   density     domain-repeat scale — "fold", how tightly the plane packs
 *   contrast    ring falloff exponent — "edge", soft haze to hard filament
 *
 * `fill`, `shape` and `tilt` are not declared: the piece is centred, radial and
 * frame-filling by construction, so all three would be dials that move nothing.
 * See scenes/contract.ts on why a dead dial is worse than a missing one.
 */

/**
 * Overall brightness.
 *
 * `pow(0.01/d, 1.2)` is unbounded as the folded distance approaches zero, and
 * it is summed across every iteration, so ring intersections are singularities.
 * MAX_GLOW caps each iteration's contribution rather than softening the
 * falloff, keeping the thin bright rings that define the look while stopping
 * the crossings from blowing out and dominating bloom.
 *
 * Not measured by rendering — a conservative first pass. Worth a look.
 */
const BRIGHTNESS = 0.25

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};
  /** Caps each iteration's 1/d singularity without changing the falloff shape. */
  const float MAX_GLOW = 4.0;

  uniform vec2 uRes;
  /** Slow monotonic ring drift, so the pattern lives between beats. */
  uniform float uRingDrift;
  /** Beat envelope swinging the ring phase. The pulse itself. */
  uniform float uPulse;
  /** Palette rotation: slow drift plus a nudge on each section boundary. */
  uniform float uColorPhase;
  /** Domain-repeat scale. Structurally sensitive — modulated only slightly. */
  uniform float uRepeat;
  /** Ring contrast exponent; rises briefly on a transient. */
  uniform float uSharp;
  uniform float uFade;
  /** Fractal iterations, from the quality governor. */
  uniform int uIters;

  // Inigo Quilez's cosine palette, unchanged.
  vec3 palette( float t ) {
    vec3 a = vec3(0.5, 0.5, 0.5);
    vec3 b = vec3(0.5, 0.5, 0.5);
    vec3 c = vec3(1.0, 1.0, 1.0);
    vec3 d = vec3(0.263, 0.416, 0.557);
    return a + b*cos( 6.28318*(c*t+d) );
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = (fragCoord * 2.0 - uRes) / uRes.y;
    vec2 uv0 = uv;
    vec3 finalColor = vec3(0.0);

    // Constant bound with an early break: GLSL ES 1.00 has no dynamic loop
    // bounds. The source's counter is pre-incremented, so the body sees 0..3.
    for (int i = 0; i < 4; i++) {
      if (i >= uIters) break;
      float fi = float(i);

      uv = fract(uv * uRepeat) - 0.5;
      float d = length(uv) * exp(-length(uv0));
      vec3 col = palette(length(uv0) + fi*.4 + uColorPhase);

      // THE PULSE. Source was sin(d*8. + iTime): rings travelling at a fixed
      // rate. The drift keeps that travel; the pulse term swings the phase back
      // and forth on the beat, so the rings visibly breathe on each hit.
      d = sin(d*8. + uRingDrift + uPulse*2.2)/8.;
      d = abs(d);
      d = min(pow(0.01 / max(d, 1e-4), uSharp), MAX_GLOW);
      finalColor += col * d;
    }

    gl_FragColor = vec4(finalColor * U_BRIGHTNESS * uFade, 1.0);
  }
`

export function KaleidoPulseScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const drift = useRef(0)
  const colorPhase = useRef(0)
  const prevSection = useRef(false)

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
          uRingDrift: { value: 0 },
          uPulse: { value: 0 },
          uColorPhase: { value: 0 },
          uRepeat: { value: 1.5 },
          uSharp: { value: 1.2 },
          uFade: { value: 0 },
          uIters: { value: 4 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ f, dt, b, vis, params, p }) => {
    const u = material.uniforms

    // The scene's own rate dial, on top of the global speed multiplier. Both
    // apply: `params.speed` is how fast the whole show moves, `p.speed` is how
    // fast this mandala moves within it.
    const rate = params.speed * drastic(p.speed)

    // Ring travel accumulates so a changing rate stays continuous, and is
    // floored well above zero so a breakdown still drifts.
    drift.current += dt * (0.35 + b.energy * 0.75) * rate

    // Palette rotation: a slow crawl, plus a step on each section boundary, so
    // the mandala recolours with the song's structure. Edge-detected because
    // `sectionChange` is a one-frame flag.
    colorPhase.current += dt * 0.12 * rate
    if (f.sectionChange && !prevSection.current) colorPhase.current += 0.35
    prevSection.current = f.sectionChange

    u.uRingDrift.value = drift.current
    u.uPulse.value = b.pulse
    u.uColorPhase.value = colorPhase.current

    // Domain-repeat scale. The AUDIO range is deliberately tiny: this constant
    // sets how the plane folds, so large swings do not "breathe", they reshuffle
    // the whole fractal into a different pattern. +/-0.05 reads as the mandala
    // tightening on a swell without the structure jumping.
    //
    // The DIAL is allowed to be drastic in a way the audio is not — reshuffling
    // the fractal is a legitimate thing to ask for deliberately, and is exactly
    // what `density` means here. Bipolar so the centre keeps the source's 1.5.
    u.uRepeat.value = 1.5 + bipolar(p.density, 0.55) + b.bass * 0.05

    // Brief contrast snap on a hit — thinner, harder rings for a moment.
    // The dial sets where that snap starts from: low is a soft haze, high is
    // hard filament. Floored above zero, where every ring would vanish.
    u.uSharp.value = 0.45 + p.contrast * 1.5 + b.transient * 0.35

    u.uFade.value = vis

    // `noiseOctaves` rather than `raymarchSteps`: this is an octave-style
    // accumulation loop, and the governor's octave ladder (4/4/3/3/2) maps onto
    // a 4-iteration fractal exactly. Dropping an iteration removes the finest
    // ring layer, which is the least missed.
    //
    // The dial asks for a ceiling; the governor still owns the floor. `min` of
    // the two rather than an average, because a user asking for fewer layers
    // and a governor demanding fewer layers both want the same thing, and
    // neither may be overruled by the other into MORE work than it allowed.
    u.uIters.value = Math.min(
      steps(p.complexity, 1, 4),
      Math.max(2, Math.min(4, quality.knobs.noiseOctaves)),
    )
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

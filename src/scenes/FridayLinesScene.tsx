import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { bipolar, drastic } from './contract'

/**
 * Friday Lines — a lattice of glowing thread-tunnels, folded and doubly
 * inverted around a slowly wandering rotation axis, breathing in and out.
 *
 * Shadertoy source "Crazy friday lines". Header is an explicit, named CC0
 * declaration: "This file is released under CC0 1.0 Universal... mrange has
 * waived all copyright..." — same author and same basis as `beats` /
 * `travelling` / `web`, so `license: 'original'`.
 *
 * ## FORCED LIVE by explicit request — pending a real /bench
 *
 * 77-step accumulation with a SOFT exit (`z < 49.0`, not a hit test) — most
 * rays still run close to the full count. Per-iteration work is a double
 * 4D inversion plus a lattice fold — heavier than `gyroid`'s single gyroid
 * tap, lighter than `beats`' full min-tree. `SCENE_COST_MS.fridaylines` in
 * `sceneCost.ts` is a documented worst-case op-count estimate, not a
 * fabricated ceiling built to clear `slotBudget.test.ts` — see that row's
 * own comment. ACTION: run `/bench` and replace it with a measurement.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution.xy       -> uRes (focal length generalised into `uFocal`)
 *   iTime                -> uRawT, JS-accumulated (see `GyroidFluxScene` for
 *                            why this has to be an accumulator, not
 *                            `elapsed * speed` — the same "jump on a speed
 *                            change" failure applies to a pure oscillator
 *                            phase too, not just a position)
 *   mainImage/fragColor  -> main() / gl_FragColor, final * uFade
 *   `R*dot(R,p.xyz)+cross(R,p.xyz)` -> named `rotAxis()`: this is exactly the
 *                            Rodrigues rotation formula at a fixed 90 degrees
 *                            (cos=0, sin=1), unchanged, just given a name.
 *   self-colour (`O=1.+sin(log2(k*K)+...)`) -> routed through the four
 *                            palette slots, same move `beats` makes for its
 *                            near-identical `1.+sin(P.z+log2(k)+...)` term.
 *   `tanh()`              -> `tanh3()` polyfill, copied from `beats`/
 *                            `harkonnen` (GLSL ES 1.00 has no tanh).
 *   uninitialised `o`/`vec4 p` accumulator -> `o` starts `vec3(0.0)`
 *                            explicitly (the source leans on drivers
 *                            zeroing locals; same fix `beats`' port made).
 *
 * `sin(uRawT*U)` (the drift offset) and `uBreathe*sin(uRawT*0.5)` (the
 * breathing phase) depend only on the clock, not on the march position —
 * the source recomputed both on every one of up to 77 iterations; this port
 * hoists them to once per pixel. Same values, evaluated the right number of
 * times, not an optimisation that changes what's on screen.
 *
 * ## What was added (the source is wall-clock only)
 *
 *   speed + mids  -> the one clock (uRawT)
 *   complexity    -> the first inversion constant `k` (source const 7.0),
 *                    plus a small highs nudge on top
 *   shape         -> the second inversion's breathing AMPLITUDE (source
 *                    const 4.0 at shape=1; a still, unbreathing lattice at 0)
 *   density       -> line/tube thickness (source const 0.04); sub adds a
 *                    continuous swell on top, distinct from onKick
 *   contrast      -> the tanh divisor (source const 2e4)
 *   fill          -> focal length / zoom
 *   tilt          -> static offset on the z-twist rotation phase
 *   onKick        -> uShock, folded into the ambient-bias brightness
 *   energy        -> overall brightness
 *
 * ## Band routing
 *
 *   onKick  -> decaying brightness flash on the ambient-bias term
 *   sub     -> continuous swell on line thickness
 *   mids    -> clock rate
 *   highs   -> small nudge on the first inversion constant (more detail)
 *   energy  -> overall brightness
 *
 * ## Scene Contract
 *
 *   speed       clock rate
 *   shape       breathing amplitude — static lattice to full pulse
 *   complexity  first-inversion constant — "fold"
 *   density     line/tube thickness — "thickness"
 *   contrast    tanh clip point
 *   fill        focal length / zoom
 *   tilt        static z-twist offset — "roll"
 */

export const FRAG = /* glsl */ `
  uniform float uRawT;    // JS-accumulated clock, replaces every iTime
  uniform float uK;       // complexity dial (+highs) -> first inversion const, source 7.0
  uniform float uBreathe; // shape dial -> second-inversion breathing amplitude, source 4.0
  uniform float uThick;   // density dial (+sub) -> line/tube thickness, source 0.04
  uniform float uClip;    // contrast dial -> tanh divisor, source 2e4
  uniform float uFocal;   // fill dial -> zoom
  uniform float uRoll;    // tilt dial (+transient) -> static z-twist offset
  uniform float uAmbient; // energy+onKick -> ambient-bias brightness, source 20.0
  uniform int   uMaxSteps;

  vec3 tanh3(vec3 x) {
    x = clamp(x, -10.0, 10.0);
    vec3 e = exp(2.0 * x);
    return (e - 1.0) / (e + 1.0);
  }

  // Rodrigues rotation of v around unit axis k at a fixed 90 degrees
  // (cos=0, sin=1) -- exactly the source's R*dot(R,p.xyz)+cross(R,p.xyz).
  vec3 rotAxis(vec3 v, vec3 k) {
    return k * dot(k, v) + cross(k, v);
  }

  void main() {
    vec4 U = vec4(7.0, 5.0, 3.0, 2.0) / 9.0;
    vec3 axis = normalize(sin(uRawT * U.wzy));
    vec3 rd = normalize(vec3(gl_FragCoord.xy - 0.5 * uRes.xy, uRes.y * uFocal));
    // Both depend only on uRawT, not on the march position -- hoisted out of
    // the loop rather than recomputed on every one of up to 77 iterations
    // (the source recomputed them per-step; same math, evaluated once).
    vec4 drift = sin(uRawT * U);
    float breathePhase = uBreathe * sin(uRawT * 0.5);

    float z = 0.0;
    vec3 o = vec3(0.0);

    for (int idx = 0; idx < 77; idx++) {
      if (idx >= uMaxSteps || z >= 49.0) break;

      vec4 p = z * rd.xyzx;
      p.z -= 9.0;
      p.xyz = rotAxis(p.xyz, axis);

      float k = uK / dot(p, p);
      p *= k;
      p += drift;
      float K = (5.0 + breathePhase) / dot(p, p);
      p *= K;

      p.xy -= floor(p.xy + 0.5);
      p.xy *= mat2(cos(0.3 * p.z + uRoll + vec4(0.0, 11.0, 33.0, 0.0)));
      p.xy = abs(p.xy);
      p.xy -= 0.25;

      float d = length(p.xy) - uThick;
      d /= k * K;
      d = abs(d) + 1e-3;

      vec4 ph = 1.0 + sin(log2(k * K) + vec4(0.0, 1.0, 2.0, 0.0) + uRawT);
      vec3 tint = uShadow + uMid * ph.x + uAccent * ph.y + uGlow * ph.z;
      o += (ph.w / d) * tint + uAmbient * K * vec3(1.0, 2.0, 3.0);

      z += 0.7 * d;
    }

    vec3 col = tanh3(o / uClip);
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface FridayLinesState {
  rawT: number
  shock: number
}

export const FridayLinesScene = createShaderScene<FridayLinesState>({
  id: 'fridaylines',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Offscreen + upscale, same shape as beats/gyroid. Starting point pending
  // /bench, not a measurement.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.1 : 0.65),
  uniforms: () => ({
    uRawT: { value: 0 },
    uK: { value: 7 },
    uBreathe: { value: 4 },
    uThick: { value: 0.04 },
    uClip: { value: 2e4 },
    uFocal: { value: 1 },
    uRoll: { value: 0 },
    uAmbient: { value: 20 },
    uMaxSteps: { value: 77 },
  }),
  state: () => ({ rawT: 0, shock: 0 }),
  update({ u, s, P, st, dt, ctx }) {
    st.rawT += dt * (1 + s.mids * 0.6) * drastic(P.speed)
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uRawT.value = st.rawT
    // complexity 0.5 -> 7.0 (source const); highs nudges it further
    u.uK.value = 7 + bipolar(P.complexity, 3) + s.highs * 1.5
    // shape 0 -> static (no breathing), shape 1 -> source's full 4.0 amplitude
    u.uBreathe.value = 4 * P.shape
    // density 0.5 -> 0.04 (source const); sub adds a continuous swell
    u.uThick.value = Math.max(0.005, 0.04 + bipolar(P.density, 0.03) + s.sub * 0.02)
    // contrast 0.5 -> 2e4 (source const)
    u.uClip.value = 2e4 * (1.6 - 1.2 * P.contrast)
    // fill 0.5 -> 1.0 (source const)
    u.uFocal.value = 0.6 + P.fill * 0.8
    // tilt replaces nothing in the source (it had no roll axis); transient
    // adds a dynamic flinch on top, same convention as gyroid's uWobble.
    u.uRoll.value = bipolar(P.tilt, 2.0) + ctx.b.transient * 0.6
    // energy + kick flash, both boosts on top of the source const (20.0)
    u.uAmbient.value = 20 * (1 + s.energy * 0.5) * (1 + st.shock * 0.6)

    // Soft exit (z >= 49.0) means this march is not as step-sensitive as
    // beats' pure accumulate-forever loop, but it is not a true hit test
    // either -- floored a little higher than gyroid's 47% as a middle
    // ground, pending real data from /bench.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(40, Math.min(77, Math.round(77 * qFrac)))
  },
})

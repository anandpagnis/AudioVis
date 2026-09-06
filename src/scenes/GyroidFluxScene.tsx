import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { bipolar, drastic } from './contract'

/**
 * Gyroid Flux — an infinite, glowing gyroid minimal-surface lattice, warped by
 * a slow sinusoidal domain distortion, with the camera drifting and orbiting
 * through it rather than committing to a single flight path.
 *
 * Shadertoy source, supplied directly by the requester and credited as CC0 ->
 * `license: 'original'`, same basis as `beats` / `harkonnen` / `web`. No URL
 * was given with the paste (unlike `tunnel`'s recorded MfVfz3 link) — if a
 * source page turns up later, this header is the place to add it.
 *
 * ## PARKED in DISABLED_SCENES — cost, not licence
 *
 * This is a 150-step march with NO hit-based early-out — like `beats`, every
 * pixel accumulates glow for every step it is given; the only exits besides
 * the step cap are `t > U_DEPTH` (25.4) and the loop bound itself, and the
 * adaptive step size floors at 0.004, so in practice nearly every pixel runs
 * close to the full 150. Rough op-count read against the two nearest
 * measured/estimated analogues (see docs/ISSUES.md F181b for why this stays a
 * documented estimate rather than a fabricated pass-the-test number):
 *
 *   - vs `kifs` (2.97 ms @ tier 0, ~20 folds, WITH an escape that spares most
 *     pixels): 150 steps is 7.5x the iteration count. Each iteration here is
 *     lighter (one warp `sin(vec3)` plus the gyroid tap's `sin`/`cos`/`dot`/
 *     `abs`, no nested fold), but kifs's escape means its true full-run cost
 *     is higher than 2.97/20 suggests. Scaling the count alone: ~18-22 ms.
 *   - vs `beats` (est. 15.2 ms @ tier 0, 77 steps, ALSO no hit-based
 *     early-out — the closest true analogue): 150/77 = 1.95x the steps, but
 *     beats' own iteration does 3 mat2 rotations + an inversion divide + a
 *     lattice fold + a 7-deep min() tree + a vec4 sin colour phase — several
 *     times the arithmetic of this shader's single warp-plus-gyroid tap.
 *     Scaling both factors: roughly 7-8 ms.
 *
 * The two methods land 7-22 ms apart. `SCENE_COST_MS.gyroid` in
 * `sceneCost.ts` is priced at the pessimistic (kifs-scaled) end of that
 * range rather than split down the middle — same call `beats`' own row
 * makes for its own two-sided estimate — and is a documented worst-case
 * estimate, not a fabricated ceiling built to clear `slotBudget.test.ts`.
 *
 * ## FORCED LIVE by explicit request — pending a real /bench
 *
 * ACTION: run `/bench`, get a real number, then decide whether it needs
 * `pixelBudget` tightened further, a step-count cut, or is fine as measured.
 * Do not trust the estimate above longer than it takes to get a measurement.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution.xy       -> uRes
 *   iTime                 -> uRawT, JS-accumulated (see below), NOT
 *                            `elapsed * speed` — multiplying a running clock
 *                            by a changing rate would jump the camera's orbit
 *                            position the moment the dial or mids changed,
 *                            same reasoning as `TunnelDriftScene`'s `uDist`.
 *                            `tt` and the warp phase are both reconstructed
 *                            from this ONE accumulator (`uRawT * 0.46` and
 *                            `uRawT * 0.6` respectively) so they can never
 *                            drift out of the source's authored ratio.
 *   iMouse                -> dropped; this project has no mouse input. The
 *                            look-direction wobble it drove is now `uWobble`
 *                            (tilt dial, static) plus a transient-driven
 *                            flinch on top (see `update()`).
 *   mainImage/fragColor   -> main() / gl_FragColor, final * uFade
 *   fragCoord              -> gl_FragCoord.xy
 *
 * `col = 1.0 - exp(-col)` is the source's own exposure tonemap, not a 1/2.2
 * sRGB encode — three's renderer does that itself. Kept as-is.
 *
 * ## What was added (the source is wall-clock + mouse only)
 *
 *   speed + mids  -> the one flight/warp clock (see uRawT above)
 *   shape         -> U_WARP, the domain-warp amount: rectilinear grid at low,
 *                    molten/organic at high
 *   complexity    -> U_SCALE, the lattice cell frequency
 *   density       -> U_THICK, the glow-band thickness (see `map()` — higher
 *                    packs more of the volume into the glowing region)
 *   contrast+highs-> glow falloff sharpness (was the constant `8.0`)
 *   fill          -> focal length / zoom (was the constant `1.6`)
 *   tilt          -> static camera-wobble offset (replaces `mo`)
 *   onKick        -> uShock, folded into brightness: decaying flash
 *   sub           -> continuous warp-amount swell, distinct from onKick
 *   energy        -> overall glow brightness
 *
 * ## Band routing
 *
 *   onKick  -> decaying brightness flash (uShock, folded into uGlowAmt)
 *   sub     -> continuous swell added straight onto the warp amount
 *   mids    -> flight/orbit clock rate
 *   highs   -> tighter glow edges (stacks with the contrast dial)
 *   energy  -> overall glow brightness
 *
 * ## Scene Contract
 *
 *   speed       flight/orbit + domain-warp clock rate
 *   shape       domain-warp amount — "warp", grid to molten
 *   complexity  lattice cell frequency — "scale"
 *   density     glow-band thickness — "thickness"
 *   contrast    glow falloff sharpness
 *   fill        focal length / zoom
 *   tilt        static camera-wobble offset (replaces the source's mouse look)
 */

export const FRAG = /* glsl */ `
  uniform float uRawT;    // JS-accumulated clock; tt = uRawT*0.46, warp phase = uRawT*0.6
  uniform float uWarp;    // shape dial (+ sub swell) -> domain-warp amount, source const 2.5
  uniform float uScale;   // complexity dial -> gyroid cell frequency, source const 0.6
  uniform float uThick;   // density dial -> glow-band thickness, source const 0.0
  uniform float uSharp;   // contrast+highs -> glow falloff sharpness, source const 8.0
  uniform float uFocal;   // fill dial -> zoom, source const 1.6
  uniform vec2  uWobble;  // tilt (static) + transient (dynamic) -> replaces mouse look
  uniform float uGlowAmt; // energy + onKick shock -> overall glow brightness, source const 4.6
  uniform vec3  uColA;    // palette-tinted, source const vec3(0.0, 0.25, 1.0)
  uniform vec3  uColB;    // palette-tinted, source const vec3(0.3, 0.3, 1.0)
  uniform int   uMaxSteps;

  #define U_DEPTH 25.4

  mat2 rot(float a) {
    float c = cos(a); float s = sin(a);
    return mat2(c, -s, s, c);
  }

  float gyroid(vec3 p) {
    p *= uScale;
    return abs(dot(sin(p), cos(p.yzx))) / uScale - uThick;
  }

  float map(vec3 p) {
    return gyroid(p + uWarp * sin(p.yzx * 1.7 + uRawT * 0.6));
  }

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    float tt = uRawT * 0.46;
    vec3 ro = vec3(0.8 * sin(tt * 0.4), 0.8 * cos(tt * 0.3), tt);
    vec3 rd = normalize(vec3(uv, uFocal));
    rd.yz = rot(0.5 * sin(tt * 0.3) + uWobble.y) * rd.yz;
    rd.xz = rot(0.6 * cos(tt * 0.23) + uWobble.x) * rd.xz;

    float t = 0.0;
    float atten = 1.0;
    vec3 col = vec3(0.0);

    for (int i = 0; i < 150; i++) {
      if (i >= uMaxSteps) break;
      vec3 p = ro + rd * t;
      float d = map(p);
      float ad = abs(d);

      vec3 surfaceColor = mix(uColA, uColB, clamp(ad * uSharp, 0.0, 1.0));
      col += surfaceColor * (uGlowAmt * 0.014) * exp(-ad * uSharp) * atten;

      t += max(ad * 0.455, 0.004);
      atten *= 0.999;
      if (t > U_DEPTH) break;
    }

    col += uColA * 0.015;
    col = 1.0 - exp(-col);
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

/**
 * Source colour constants, preserved as the VALUE structure of the piece —
 * same move as `TunnelDriftScene`'s WALL_BASE/RAIL_BASE/FOG_BASE. Palette
 * TINTS these; it must not replace them outright, or the deep-blue / violet
 * contrast the source was built around flattens to whatever the live palette
 * happens to be.
 */
const COL_A_BASE = new THREE.Color(0.0, 0.25, 1.0)
const COL_B_BASE = new THREE.Color(0.3, 0.3, 1.0)

interface GyroidState {
  /** Unscaled accumulated clock — tt and the warp phase are both derived from this in-shader. */
  rawT: number
  /** Kick brightness flash, decaying. */
  shock: number
}

export const GyroidFluxScene = createShaderScene<GyroidState>({
  id: 'gyroid',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Offscreen + upscale, same shape as beats/harkonnen — the glow accumulation
  // hides a soft upscale. Numbers borrowed from `beats` pending a real
  // /bench: this scene's own estimate range (see header) overlaps beats'
  // ballpark closely enough that inventing different numbers blind would not
  // be more honest, just differently wrong.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.2 : 0.7),
  uniforms: () => ({
    uRawT: { value: 0 },
    uWarp: { value: 2.5 },
    uScale: { value: 0.6 },
    uThick: { value: 0 },
    uSharp: { value: 8 },
    uFocal: { value: 1.6 },
    uWobble: { value: new THREE.Vector2(0, 0) },
    uGlowAmt: { value: 4.6 },
    uColA: { value: new THREE.Color().copy(COL_A_BASE) },
    uColB: { value: new THREE.Color().copy(COL_B_BASE) },
    uMaxSteps: { value: 150 },
  }),
  state: () => ({ rawT: 0, shock: 0 }),
  update({ u, s, P, pal, st, dt, ctx }) {
    // One accumulator; tt and the warp phase are both reconstructed from it
    // in-shader at the source's authored ratio (0.46 : 0.6) — see the header.
    st.rawT += dt * (1 + s.mids * 0.6) * drastic(P.speed)

    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uRawT.value = st.rawT

    // shape 0.5 -> 2.5 (source const); sub adds a continuous swell on top,
    // distinct from onKick's transient flash below.
    u.uWarp.value = 2.5 + bipolar(P.shape, 1.5) + s.sub * 0.8
    // complexity 0.5 -> 0.6 (source const)
    u.uScale.value = 0.6 + bipolar(P.complexity, 0.3)
    // density 0.5 -> 0.0 (source const)
    u.uThick.value = bipolar(P.density, 0.15)
    // contrast 0.5 -> 8.0 (source const); highs tightens further on top
    u.uSharp.value = 8.0 + bipolar(P.contrast, 4.0) + s.highs * 3.0
    // fill 0.5 -> 1.6 (source const)
    u.uFocal.value = 1.2 + P.fill * 0.8
    // tilt replaces the source's mouse look; transient adds a dynamic flinch
    // on top, larger on X to match the source's own 3.0-vs-1.5 asymmetry.
    u.uWobble.value.set(
      bipolar(P.tilt, 3.0) + ctx.b.transient * 1.2,
      bipolar(P.tilt, 1.5) + ctx.b.transient * 0.8,
    )
    // energy + kick flash, both boosts ON TOP of the source const (4.6), so
    // silence still reproduces the authored brightness rather than dimming it.
    u.uGlowAmt.value = 4.6 * (1 + s.energy * 0.6) * (1 + st.shock * 0.7)

    u.uColA.value.copy(COL_A_BASE).lerp(pal.accent, 0.4)
    u.uColB.value.copy(COL_B_BASE).lerp(pal.glow, 0.4)

    // No hit-based early-out (see header) — cutting steps genuinely shortens
    // how far the ray reaches before the glow accumulation truncates, not
    // just resolution softness (same Finding-4 shape `beats` documents).
    // Floored higher than beats' 20/77 (26%) for that reason: 70/150 (~47%).
    // Purely governor-driven, no user dial on top — same call TunnelDriftScene
    // makes for its own `uMaxSteps`, and for the same reason: a dial that
    // could reach this floor would be a dial that breaks the scene.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(70, Math.min(150, Math.round(150 * qFrac)))
  },
})

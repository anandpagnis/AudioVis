import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { bipolar, drastic } from './contract'

/**
 * Lattès Fold — a chaotic complex-dynamics warp (a Lattès rational map,
 * "2 fixed points, loxodromic" per the source's own comment) driving the
 * offset of a Menger/Amazing-Box-style 3D fold, banded by a scrolling
 * depth-stripe overlay.
 *
 * Shadertoy source, untitled, supplied directly by the requester. UNLIKE
 * `fridaylines` / `javazone` (both carry an explicit, named CC0 block in the
 * source itself), this paste carries **no header, no author, no licence
 * declaration at all** — the requester's own statement ("CC0 shadertoy") is
 * the entire basis for `license: 'original'` here, the same provenance basis
 * `snowflake` uses ("a witnessed generation, no upstream to audit"). Flagged
 * explicitly rather than silently treated as equally attested to its two
 * siblings — if a source page turns up later, this header is the place to
 * add it.
 *
 * ## FORCED LIVE by explicit request — pending a real /bench
 *
 * By far the heaviest of the four new shaders in this batch, and very
 * likely the heaviest scene in the whole roster even after the hoist fix
 * below. The outer accumulation loop runs up to 90 times; EACH of those runs
 * an inner fold up to 12 times internally — up to 1080 total fold iterations
 * per pixel, before the Lattès warp (computed once, outside both loops) or
 * the secondary 24-step depth-band pass. For reference, `harkonnen`'s entire
 * per-pixel fractal budget is ~52 iterations at its neutral `complexity`.
 * `SCENE_COST_MS.lattesfold` in `sceneCost.ts` is a documented worst-case
 * op-count estimate, not a fabricated ceiling built to clear
 * `slotBudget.test.ts` — see that row's own comment. `pixelBudget` here is
 * already markedly more aggressive than its siblings' for the same reason.
 * ACTION: run `/bench` and replace the estimate with a measurement; this one
 * plausibly needs real optimisation beyond the hoist below, not just a lower
 * `pixelBudget`, before it is anything but a manual pick.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution.xy  -> uRes (focal length generalised into `uFocal`)
 *   iTime           -> uRawT, JS-accumulated (see `GyroidFluxScene`'s header
 *                      for why an oscillator phase needs this too, not just
 *                      a position)
 *   mainImage/O     -> main() / gl_FragColor, final * uFade. The source's `O`
 *                      is vec4 but only `.xyz` ever reaches the screen — same
 *                      simplification `beats`' port already made ("Only o.rgb
 *                      survives the tone map, so o is a vec3 here").
 *   `H()` macro     -> renamed `hue()`, a real function, same output
 *   ternary swaps    -> `n1.x<n1.z?n1=n1.zyx:n1;` (and its two siblings)
 *                      rewritten as plain `if` statements. An assignment
 *                      inside a ternary branch is unusual enough across GLSL
 *                      profiles that this rewrite removes the question
 *                      entirely rather than trust it; behaviour is identical.
 *   `for(...;++i<N.;...)` -> rewritten to `for(int idx=0;idx<N;idx++)`
 *                      (GLSL ES 1.00 needs a constant-shaped loop; same fix
 *                      class `beats`/`tunnel` document). Verified neither
 *                      loop counter (`i`, inner `i`) is ever READ inside its
 *                      own body — both are pure iteration counts — so this
 *                      is a mechanical rewrite with no off-by-one subtlety
 *                      to preserve (contrast `tunnel`'s `fi`/`fj`, which DO
 *                      need the source's post-increment offset reproduced).
 *
 * The inner fold's per-iteration `e` and its offset vector
 * (`vec3(5.+cos(...)*3.,120.,8.+cos(...)*5.)`) depend only on `uRawT`/
 * `uRough`, never on `n1` or either loop counter — the source recomputed
 * both (3 trig calls) on every one of up to 1080 fold iterations. This port
 * hoists them to once per pixel (`foldScale`/`foldOffset`), which is most of
 * this shader's real cost: the naive per-iteration-trig version was
 * estimated at roughly 3x the hoisted one. Same values, evaluated the right
 * number of times, not an optimisation that changes what's on screen.
 *
 * ## Dropped as dead code
 *
 * The `R(p,a,r)` macro, and the `unit` / `factor` / `q` locals, are declared
 * in the source and never referenced anywhere in `mainImage`. Dropped rather
 * than carried — same call `TunnelDriftScene`'s port makes for its source's
 * unused `pal()` function.
 *
 * ## An uninitialised local, made explicit
 *
 * The secondary depth-band pass computes its own step size from a macro
 * (`S`) that reads `p.x`/`p.y`/`p.z` — but `p` (`vec3 p;`, no initialiser) is
 * never assigned anywhere before that pass runs; the position it actually
 * marches (`p3`) is a DIFFERENT variable. This reads as a copy/paste slip in
 * the source (very plausibly `p3` was meant), not a deliberate design — but
 * rather than guess at unstated intent, this port makes the same call
 * `beats`' own audit made for its uninitialised locals: pin it to a defined
 * value (`vec3(0.0)`) rather than leave it to whatever a given driver
 * happens to zero-fill. With `p` pinned at zero, `S` collapses to a flat
 * `2.0`, so the pass becomes a fixed-step scan — a real, if likely
 * accidental, simplification, disclosed here rather than silently "fixed"
 * into what might have been intended instead.
 *
 * ## What was added (the source is wall-clock only)
 *
 *   speed + mids  -> the one clock (uRawT)
 *   shape         -> Lattès iteration depth (source const 3, fixed)
 *   complexity    -> inner-fold depth (source const 8) — a user dial only,
 *                    never tier-gated, same reasoning `harkonnen` gives for
 *                    its own fractal depth (iteration count changing under
 *                    load reads as glitching, not as a quality drop)
 *   density       -> lattice cell half-size (source const 10.0); sub adds a
 *                    continuous swell on top, distinct from onKick
 *   contrast      -> the final brightness divisor (source const 8e3)
 *   fill          -> focal length / zoom
 *   tilt          -> static rotation of the screen coordinate feeding the
 *                    Lattès warp (the source has no roll axis of its own)
 *   onKick        -> uBright flash
 *   highs         -> boosts the inner fold's wobble amplitude
 *   energy        -> overall brightness
 *
 * ## Band routing
 *
 *   onKick  -> decaying brightness flash
 *   sub     -> continuous swell on the lattice cell size
 *   mids    -> clock rate
 *   highs   -> inner-fold wobble amplitude
 *   energy  -> overall brightness
 *
 * ## Scene Contract
 *
 *   speed       clock rate
 *   shape       Lattès iteration depth — "chaos"
 *   complexity  inner-fold depth — "fold depth" (user dial only, ungoverned)
 *   density     lattice cell size — "scale"
 *   contrast    brightness divisor
 *   fill        focal length / zoom
 *   tilt        rotation of the Lattès input coordinate — "roll"
 */

const PI = 3.1415926538

export const FRAG = /* glsl */ `
  uniform float uRawT;
  uniform int   uLatN;      // shape dial -> Lattes iteration count, source const 3
  uniform float uCellA;     // density dial (+sub) -> lattice cell half-size, source const 10.0
  uniform float uRough;     // highs -> inner-fold wobble amplitude, source const 0.1
  uniform float uClip;      // contrast dial -> final brightness divisor, source const 8e3
  uniform float uFocal;     // fill dial -> zoom
  uniform float uRoll;      // tilt dial -> rotates the Lattes input coordinate
  uniform float uBright;    // energy+onKick -> overall brightness
  uniform int   uMaxSteps;  // governor -> outer accumulation loop cap, source const 90
  uniform int   uInnerIter; // complexity dial -> inner fold depth, source const 8

  #define PI ${PI}

  vec2 cMul(in vec2 z1, in vec2 z2) { return mat2(z1, -z1.y, z1.x) * z2; }
  vec2 cDiv(in vec2 z1, in vec2 z2) { return z1 * mat2(z2, -z2.y, z2.x) / dot(z2, z2); }

  vec2 lattes(in vec2 z) {
    vec2 z2 = cMul(z, z);
    vec2 numerator = z2 + vec2(1.0, 0.0);
    numerator = cMul(numerator, numerator);
    vec2 denom = cMul(vec2(4.0, 0.0), cMul(z, z2 - vec2(1.0, 0.0)));
    return cDiv(numerator, denom);
  }

  vec2 lattesN(in vec2 z, in int n) {
    vec2 result = z;
    for (int i = 0; i < 5; i++) {
      if (i >= n) break;
      result = lattes(result);
    }
    return result;
  }

  vec3 hue(float h) {
    return cos(h * 6.3 + vec3(50.0, 23.0, 11.0)) * 0.5 + 0.5;
  }

  void main() {
    vec3 rd = normalize(vec3((2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y, uFocal));

    vec2 p2 = 6.0 * (2.0 * gl_FragCoord.xy - uRes.xy) / max(uRes.x, uRes.y);
    float rc = cos(uRoll), rs = sin(uRoll);
    p2 = mat2(rc, -rs, rs, rc) * p2;
    p2 = lattesN(p2, uLatN);

    float theta = atan(p2.y, p2.x);
    float len = length(p2);
    float xIndex = sin(PI * (theta * 12.0 / PI - uRawT));
    float yIndex = sin(PI * (log(len) * 4.0 - uRawT));
    float v = xIndex * yIndex;

    // Secondary depth-band pass. See the header: the source's step size (S)
    // reads a local the source never assigns before this point, pinned here
    // to vec3(0.0) rather than left undefined -- which collapses this to a
    // fixed-step (2.0) scan.
    vec3 p = vec3(0.0);
    vec3 p3 = vec3(0.0, 0.0, -30.0 + uRawT);
    vec3 t3 = normalize(vec3(gl_FragCoord.xy - 0.5 * uRes.xy, 30.0));
    for (int i = 0; i < 24; i++) {
      float S = 2.0 - abs(p.x * sin(0.2 * p.z) + p.y * cos(0.2 * p.z));
      p3 += t3 * S;
      if (S < 0.001) break;
    }
    vec3 O2 = clamp(
      2.0 - abs(mod(100.0 * ceil(p3.z + uRawT) / 60.0 - vec3(0.0, 2.0, 4.0), 6.0) - 3.0),
      0.0, 1.0
    );

    // Both depend only on uRawT/uRough, not on n1 or either loop counter --
    // hoisted out of the inner loop rather than recomputed on every one of
    // up to 90*12=1080 fold iterations (the source recomputed them per
    // iteration; same math, evaluated once per pixel).
    float foldScale = 1.4 + uRough * sin(uRawT * 0.234);
    vec3 foldOffset = vec3(
      5.0 + cos(uRawT * 0.3 + 0.5 * cos(uRawT * 0.3)) * 3.0,
      120.0,
      8.0 + cos(uRawT * 0.5) * 5.0
    );

    vec3 o = vec3(0.0);
    float g = 0.0;
    for (int idx = 0; idx < 90; idx++) {
      if (idx >= uMaxSteps) break;

      vec3 n1 = g * rd * O2;
      float a = uCellA;
      n1 = mod(n1 - a, a * 2.0) - a;
      float s = 6.0;

      for (int j = 0; j < 12; j++) {
        if (j >= uInnerIter) break;
        n1 = 0.3 - abs(n1);
        if (n1.x < n1.z) n1 = n1.zyx;
        if (n1.z < n1.y) n1 = n1.xzy;
        if (n1.y < n1.x) n1 = n1.zyx;
        s *= foldScale;
        n1 = abs(n1) * foldScale - foldOffset + v;
      }

      float e = length(n1.yx + n1.zx) / s;
      g += e;
      o += mix(vec3(1.0), hue(g * 0.1), sin(0.8)) * uBright / e / uClip;
    }

    gl_FragColor = vec4(o * O2 * uFade, 1.0);
  }
`

interface LattesFoldState {
  rawT: number
  shock: number
}

export const LattesFoldScene = createShaderScene<LattesFoldState>({
  id: 'lattesfold',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Markedly more aggressive than its siblings' (0.5/0.3 vs ~1.2/0.7): see
  // the header's cost note. Starting point pending /bench, not a measurement.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 0.5 : 0.3),
  uniforms: () => ({
    uRawT: { value: 0 },
    uLatN: { value: 3 },
    uCellA: { value: 10 },
    uRough: { value: 0.1 },
    uClip: { value: 8e3 },
    uFocal: { value: 1 },
    uRoll: { value: 0 },
    uBright: { value: 1 },
    uMaxSteps: { value: 90 },
    uInnerIter: { value: 8 },
  }),
  state: () => ({ rawT: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    st.rawT += dt * (1 + s.mids * 0.6) * drastic(P.speed)
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uRawT.value = st.rawT
    // shape 0.5 -> 3 (source const), 1..5 range
    u.uLatN.value = Math.max(1, Math.min(5, Math.round(1 + P.shape * 4)))
    // complexity 0.5 -> 8 (source const), 4..10 range. User dial only, never
    // tier-gated -- see the header's reasoning (matches harkonnen).
    u.uInnerIter.value = Math.max(4, Math.min(12, Math.round(5 + P.complexity * 5)))
    // density 0.5 -> 10.0 (source const); sub adds a continuous swell
    u.uCellA.value = 10 + bipolar(P.density, 4) + s.sub * 1.5
    // highs only -- no dial competes for this one
    u.uRough.value = 0.1 + s.highs * 0.15
    // contrast 0.5 -> 8e3 (source const)
    u.uClip.value = 8e3 * (1.6 - 1.2 * P.contrast)
    // fill 0.5 -> 1.0 (source const)
    u.uFocal.value = 0.6 + P.fill * 0.8
    // tilt replaces nothing in the source (it had no roll axis)
    u.uRoll.value = bipolar(P.tilt, 1.5)
    // energy + kick flash, both boosts on top of the source's implicit 1.0
    u.uBright.value = (1 + s.energy * 0.6) * (1 + st.shock * 0.7)

    // Outer accumulation loop only -- the inner fold depth is a user dial,
    // never governor-gated (see header). Floored low (33%) because the
    // inner-loop multiplier (up to 12x per outer step) makes this by far the
    // most step-sensitive of the three new scenes.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(30, Math.min(90, Math.round(90 * qFrac)))
  },
})

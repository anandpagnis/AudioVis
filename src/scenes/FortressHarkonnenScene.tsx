import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'

/**
 * Fortress Harkonnen — a lit, carved relief of a "very simple formula" escape
 * fractal, slowly zooming through a 5-step macro cycle.
 *
 * Shadertoy shader "Fortress Harkonnen", header declares **CC0**. Reads as
 * mrange's (SABS credited to ollj; the fractalforums formula is public). CC0
 * -> `license: 'original'`.
 *
 * ## What was optimised to make it a live scene (not just re-priced)
 *
 * The source samples a 25-iteration `nfield()` FOUR times per pixel for the
 * normal (~100 iterations) plus an 18-iteration `field()` — ~118 fixed
 * iterations/pixel, no early-out, 2-3 `pow` each. Changes here:
 *
 *   - `nfield` / `field` loop counts are uniforms (`uNIter` / `uFIter`), capped
 *     at 16, driven by the `complexity` dial (10..16). NOT tier-gated — fractal
 *     iteration depth changing under load reads as the scene glitching, not as
 *     a quality drop (`kifs` F129 / `maze` F139 precedent). With `s *= 0.75`
 *     each iteration, term `i` contributes ~0.75^i to the accumulator before a
 *     saturating tanh, so 10-16 is a safe visual range. The governor's only
 *     lever here is `pixelBudget` — and on `createShaderScene`'s offscreen path
 *     that lever is weaker than it sounds: see the declaration's risk note.
 *   - Normal is a 3-tap forward difference (centre + x + z), not the source's
 *     4-tap central difference. Slight bias, invisible on organic relief.
 *   - `pow(s, 1.0)` -> `s`; `pow(s, 0.65)` -> a running multiply by the
 *     constant 0.75^0.65. Two `pow` removed per `nfield` iteration.
 *   - `pixelBudget` renders offscreen and upscales — the relief is soft, no
 *     hard edges (cf. `maze`, same treatment). Re-anchored 1.4/0.8 -> 7.8/4.4;
 *     see the declaration below for why. At the old numbers the sentence above
 *     was not describing what shipped: the "soft upscale" was a ~2.5x one, with
 *     the offscreen buffer sitting on (tiers 3-4) or within a hundredth of
 *     (tiers 0-2) `createShaderScene`'s own `MIN_RENDER_SCALE` clamp on any 4K
 *     panel.
 *
 * ## GLSL ES 1.00 fixes
 *
 *   tanh()          -> tanh_approx() (ES 1.00 has no tanh); `tanh2`'s
 *                      precision guard kept around it
 *   vec2(x, 0)      -> vec2(x, 0.0)
 *   loop bounds     -> constant caps + uniform early-break
 *
 * `postProcess`'s `pow(col, vec3(0.75))` is a mild lift, NOT a 1/2.2 sRGB
 * encode — three's renderer does that itself. Left as-is.
 *
 * ## COST IS AN ESTIMATE — not /bench-measured
 *
 * The `SCENE_COST_MS` row is a documented op-count estimate (see sceneCost.ts).
 * With the cuts above it is plausibly ~3.5 ms at tier 0, under
 * `slotBudget.test.ts`'s `< sceneBudget(0)/2 ≈ 4ms` bar — but `pow`/`tanh`
 * cost is unpredictable on weak GPUs. Run `/bench` and re-price; if it comes in
 * over the bar it must move to DISABLED_SCENES or take further cuts.
 *
 * That ~3.5 ms was reasoned against the OLD 1.4 MP budget — i.e. against an
 * offscreen buffer pinned to `createShaderScene`'s `MIN_RENDER_SCALE` clamp
 * (0.40-0.41 linear, ~17% of the panel's pixels) on anything above ~1440p. The
 * re-anchor below takes tier 0 on a 4K panel from 0.41 to 0.97 linear, about
 * 5.6x the internal pixels, and every op counted for that estimate is
 * per-pixel. So the real tier-0 cost is correspondingly higher and the
 * `sceneCost.ts` row now prices a frame this scene no longer renders.
 * No replacement number is invented here: the honest state is UNMEASURED, and
 * the `/bench` sweep this section already asks for is now also the thing that
 * decides whether the scene still clears the bar at its new resolution.
 *
 * ## Band routing
 *
 *   onKick  -> uShock: specular pop + overall brightness punch (decaying)
 *   sub     -> lighting bulge: deepens the fake height term light direction
 *              is computed from, so the relief reads as pushing toward camera
 *              on bass (see `gp` in main() — safe hook: it only feeds the two
 *              light directions, never the fractal field or normal, so it
 *              cannot destabilise `nfield`'s tuned recursion)
 *   mids    -> zoom/flythrough rate
 *   energy  -> luminance + the `f.z` accent glow
 *   highs   -> tighter, brighter key-light specular
 */

export const FRAG = /* glsl */ `
  uniform float uFly;      // speed-scaled clock (replaces iTime)
  uniform float uShock;    // decaying kick envelope
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBass;     // s.sub -> lighting bulge (see main()'s gp)
  uniform float uZoom;     // fill dial
  uniform float uRoll;     // tilt dial -> static frame rotation, radians
  uniform float uContrast; // contrast dial -> S-curve strength
  uniform int   uNIter;    // quality: nfield iterations (8..16)
  uniform int   uFIter;    // quality: field iterations (8..16)

  #define LESS(a,b,c) mix(a,b,step(0.,c))
  #define SABS(x,k)   LESS((.5/k)*x*x+k*.5,abs(x),abs(x)-k)

  #define PI      3.141592654
  #define TAU     (2.0*3.141592654)
  #define TIME    uFly
  #define PERIOD  55.0
  #define PERIODS 5.0

  // 0.75^0.65 — the per-iteration factor that replaces pow(s, 0.65)
  #define SP065   0.8445975

  float tanh_approx(float x) {
    float x2 = x*x;
    return clamp(x*(27.0 + x2)/(27.0+9.0*x2), -1.0, 1.0);
  }

  void rot(inout vec2 p, float a) {
    float c = cos(a);
    float s = sin(a);
    p = vec2(c*p.x + s*p.y, -s*p.x + c*p.y);
  }

  float plane(vec2 p, vec2 n, float m) {
    return dot(p, n) + m;
  }

  float circle(vec2 p, float r) {
    return length(p) - r;
  }

  float holey(float d, float k) {
    return abs(d) - k;
  }

  float tanh2(float x) {
    // Hack around precision problem (kept from source)
    if (abs(x) > 50.0) {
      return sign(x);
    } else {
      return tanh_approx(x);
    }
  }

  float nfield(vec2 p, vec2 c) {
    vec2 u = p;

    float a = 0.0;
    float s = 1.0;
    float sp = 1.0;   // running 0.75^(0.65*i), replaces pow(s, 0.65)

    for (int i = 0; i < 16; ++i) {
      if (i >= uNIter) break;
      float m = dot(u,u);
      u = SABS(u, 0.0125)/m + c;
      u *= sp;
      a += s*m;       // was pow(s, 1.0)*m
      s *= 0.75;
      sp *= SP065;
    }

    return -tanh2(0.125*a);
  }

  vec3 normal(vec2 p, vec2 c) {
    vec2 e = vec2(2.0/uRes.y, 0.0);

    // 3-tap forward difference (was a 4-tap central difference)
    float c0 = nfield(p, c);
    vec3 n;
    n.x = nfield(p + e.xy, c) - c0;
    n.y = e.x;
    n.z = nfield(p + e.yx, c) - c0;

    return normalize(n);
  }

  vec3 field(vec2 p, vec2 c) {
    vec2 u = p;

    float a = 0.0;
    float s = 1.0;

    vec2 tc = vec2(0.5, 0.3);
    rot(tc, TAU*TIME/PERIOD);
    vec2 tpn = normalize(vec2(1.0));
    float tpm = 0.0 + 1.4*tanh_approx(length(p));

    float tcd = 1E10;
    float tcp = 1E10;

    for (int i = 0; i < 16; ++i) {
      if (i >= uFIter) break;
      float m = dot(u,u);
      u = SABS(u, 0.0125)/m + c;
      tcd = min(tcd, holey(circle(u-tc, 0.05), -0.1));
      tcp = min(tcp, holey(plane(u, tpn, tpm), -0.1));
      u *= sqrt(s);   // was pow(s, 0.5)
      a += s*m;       // was pow(s, 1.0)*m
      s *= 0.75;
    }

    return vec3(tanh_approx(0.125*a), tanh_approx(tcd), tanh_approx(tcp));
  }

  vec3 postProcess(vec3 col, vec2 q) {
    col = pow(clamp(col,0.0,1.0), vec3(.75));
    col = col*(1.0-uContrast) + uContrast*col*col*(3.0-2.0*col);   // contrast (dial)
    col = mix(col, vec3(dot(col, vec3(0.33))), -0.4);              // saturation
    col *= 0.5+0.5*pow(19.0*q.x*q.y*(1.0-q.x)*(1.0-q.y),0.7);      // vignette
    return col;
  }

  void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 q = fragCoord/uRes.xy;
    vec2 p = -1. + 2. * q;
    p.x *= uRes.x/uRes.y;
    rot(p, uRoll);

    float currentPeriod = mod(floor(TIME/PERIOD), PERIODS);
    float timeInPeriod = mod(TIME, PERIOD);

    p *= (0.25 + (0.005*timeInPeriod) + pow(1.35, currentPeriod)) * uZoom;
    vec2 c = vec2(-0.5, -0.35);

    // gp is a fake height field used ONLY to aim the two light directions
    // below -- it never touches nfield/normal, so swelling it with the
    // sub-bass level is safe: the relief's actual carved geometry is
    // untouched, but the light rakes across it as though it bulged toward
    // camera on the bass, reading as the fortress pressing outward on a hit.
    vec3 gp = vec3(p.x, (1.0 + uBass*0.6)*tanh_approx(1.0 - (length(p))), p.y);
    vec3 lp1 = vec3(-1.0, 1.5, 1.0);
    vec3 ld1 = normalize(lp1 - gp);
    vec3 lp2 = vec3(1.0, 1.5, 1.0);
    vec3 ld2 = normalize(lp2 - gp);
    vec3 f = field(p, c);

    vec3 n = normal(p, c);

    float diff1 = max(dot(ld1, n), 0.0);
    float diff2 = max(dot(ld2, n), 0.0);

    vec3 col = vec3(0.0);

    const vec3 dcol1 = vec3(0.3, 0.5, 0.7);
    const vec3 dcol2 = 0.5*vec3(0.7, 0.5, 0.3);
    const vec3 scol1 = 0.5*vec3(1.0);
    const vec3 scol2 = 0.5*0.5*vec3(1.0);

    col += diff1*dcol1;
    col += diff2*dcol2;
    col += scol1*pow(diff1, 10.0 - uHighs*4.0)*(1.0 + uHighs*1.2 + uShock*2.0);
    col += scol2*pow(diff2, 3.0);
    col -= vec3(tanh_approx(f.y-0.1));
    col += 0.5*(diff1+diff2)*(1.25*pow(vec3(f.z), 5.0*vec3(1.0, 4.0, 5.0)))*(1.0 + uEnergy*0.6);
    col *= 1.0 + uEnergy*0.3 + uShock*0.5;

    col = postProcess(col, q);

    // Source's per-period 2s breath at the zoom-reset seam — kept (it masks the
    // 1.35x scale pop). Multiplied by uFade so it also honours the compositor.
    const float fade = 2.0;
    float fadeIn  = smoothstep(0.0, fade, timeInPeriod);
    float fadeOut = 1.0-smoothstep(PERIOD - fade, PERIOD, timeInPeriod);
    col *= fadeIn*fadeOut;

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface HarkonnenState {
  /** Zoom / macro-cycle clock, accumulated so a changing rate stays continuous. */
  fly: number
  /** Kick pop, decaying. */
  shock: number
}

export const FortressHarkonnenScene = createShaderScene<HarkonnenState>({
  id: 'harkonnen',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Estimate — replace with a /bench sweep. Offscreen + upscale; the relief is
  // soft so a gentle upscale is invisible. Tier-sensitive like MazeFlightScene.
  //
  // ## Which `pixelBudget` this is
  //
  // This is `createShaderScene`'s spec field, which sizes THIS SCENE'S OWN
  // offscreen buffer and nothing else. It is solved by that module's private
  // `solveScale` (createShaderScene.tsx:191-196):
  //
  //     scale = clamp(sqrt(budget / fullMP), MIN_RENDER_SCALE /* 0.4 */, 1)
  //
  // That is the whole solver. It is NOT the `SceneMetadata.pixelBudget` field
  // in scenes/index.ts, and it does not touch engine/renderScale.ts: there is
  // no `combinePixelBudgets` reciprocal sum with the post chain, and no
  // `quality.knobs.pixelBudgetScale` tier multiplier anywhere on this path.
  // (`SceneMetadata.pixelBudget` is declared and validated but set by no scene
  // in the roster, so the renderScale ladder never had this scene on it.)
  //
  // ## Re-anchored 1.4/0.8 -> 7.8/4.4
  //
  // The old pair was chosen when the roster was being developed against 1080p
  // and laptop displays, where 1.4 MP still solved to something meaningful.
  // On any panel at or above ~1440p it does not: 1.4 MP solves to 0.41 linear
  // at 4K and the 0.8 branch lands flat on the 0.4 clamp. The declared number
  // had stopped meaning anything — the buffer was pinned at ~40% linear (a
  // ~2.5x upscale, ~17% of the panel's pixels) regardless of display or
  // hardware. 7.8/4.4 is the roster-wide 5.5556x re-anchor (from `maze`'s
  // 0.9 -> 5.0), which preserves this scene's relative cost and its own tier
  // step.
  //
  // 4K (3840x2160, fullMP 8.29) linear scale by tier, from `solveScale`:
  //
  //     OLD  0.41 / 0.41 / 0.41 / 0.40 / 0.40
  //     NEW  0.97 / 0.97 / 0.97 / 0.73 / 0.73     buffer @ tier 0: 3723x2094
  //
  // The only tier sensitivity on this path is this scene's own `>= 50`
  // threshold flipping the declared budget between branches: tiers 0-2 take
  // 7.8 (96/72/54 march steps), tiers 3-4 take 4.4 (40/28). At 1440p, 1080p
  // and on the MacBook panel below, both branches now solve to 1.00.
  //
  // ## KNOWN RISK: this raises the FLOOR, and the governor cannot lower it
  //
  // `solveScale` has no tier multiplier, so the quality governor CANNOT claw
  // resolution back on this scene under load — it never could, and that cuts
  // the other way now that the budget is large. Raising it raises the floor of
  // what a weak machine must render, not just the ceiling. Concretely, on a
  // 2560x1664 MacBook Air this scene goes from 0.57 to 1.00 (native): ~3.0x
  // the pixels, at every tier, with no way for the governor to back off.
  //
  // It is worth being blunt about how little the governor holds here. The
  // `raymarchSteps` read below is a TIER PROXY only — this shader has no march
  // loop, and its actual iteration depth (`uNIter`/`uFIter`) comes from the
  // user's `complexity` dial and is deliberately never tier-gated (see the
  // header). So the branch flip below is the ladder's entire influence on this
  // scene: on 4K it buys 0.97 -> 0.73, and on any panel at or below ~1440p it
  // buys literally nothing, because both branches solve to 1.00 there. The
  // governor can cut neither pixel count nor per-pixel cost on this scene.
  // That is a known and accepted-for-now consequence, pending the `/bench` the
  // cost section above already asks for; it is not a solved problem.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 7.8 : 4.4),
  uniforms: () => ({
    uFly: { value: 0 },
    uShock: { value: 0 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBass: { value: 0 },
    uZoom: { value: 1 },
    uRoll: { value: 0 },
    uContrast: { value: 0.4 },
    uNIter: { value: 13 },
    uFIter: { value: 13 },
  }),
  state: () => ({ fly: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Source clock was a raw iTime driving the 55s x 5 macro zoom. Accumulate
    // so a changing rate stays continuous; mids lean on the throttle.
    st.fly += dt * (1 + s.mids * 0.5) * drastic(P.speed)
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uFly.value = st.fly
    u.uShock.value = st.shock
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs
    u.uBass.value = s.sub

    // Piecewise so slider centre reproduces the authored look: zoom x1,
    // roll 0, contrast S-curve strength 0.4 (the source's baked constant).
    u.uZoom.value = 0.6 + P.fill * 0.8 // 0.5 -> 1.0
    u.uRoll.value = (P.tilt - 0.5) * 2.0 // 0.5 -> 0 rad
    u.uContrast.value = P.contrast * 0.8 // 0.5 -> 0.4

    // Fractal iteration depth — user's `complexity` dial only, never the
    // governor (see header). 10..16, neutral 0.5 -> 13.
    const it = 10 + Math.round(P.complexity * 6)
    u.uNIter.value = it
    u.uFIter.value = it
  },
})

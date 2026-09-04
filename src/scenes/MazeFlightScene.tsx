import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { criticalDamping, spring, springStep, type SpringState } from '../engine/response'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Maze Flight — first-person flythrough of an infinite fractal maze.
 *
 * A solid universe with corridors carved at three nested scales, so every wall
 * is itself a smaller maze. Sourced from glslop (shader `gstbkfmm`, "Can't Find
 * My Way Out" by `ksin`), CC0-1.0, `provenance_type: "witnessed_generation"`,
 * `parents: []`.
 * https://glslop.com/api/v1/shaders/gstbkfmm carries the record.
 *
 * ## This is the most expensive scene in the roster, and why
 *
 * `map()` is the hot path and it is not cheap: a `carveScale` at each nested
 * scale (six `hash31` each) plus a `pathPos` call for the guaranteed corridor.
 * It runs once per raymarch step, then ~15 more times during shading — 4 for
 * the normal, 5 for AO, 6 for the edge-glow Laplacian.
 *
 * **Measured, not guessed** (Apple M1, ANGLE/Metal, 2560x1600 target, offscreen
 * draw timed with a `readPixels` sync — `gl.finish()` is a no-op under ANGLE
 * and reports zero):
 *
 *   as-published, full res, 150 steps ....... 70.4 ms   (14 fps)
 *   optimised, full res ..................... 48.7 ms
 *   optimised + pixelBudget, tier 0 .......... 5.4 ms   <- shipped default
 *   optimised + pixelBudget, tier 4 .......... 2.7 ms
 *   user maxes `detail` to 3 levels ......... ~9.5 ms
 *
 * An ablation at fixed resolution says the cost is concentrated in two places,
 * and the intuitive candidates are nearly worthless:
 *
 *   drop 3rd nesting level ....... -33%   <- dominant shader-side lever
 *   drop to 1 nesting level ...... -58%
 *   resolution ................... linear in pixel count
 *   edge glow off ................ -14%
 *   AO 5 taps -> 3 ................ -6%
 *   march steps 96 -> 48 .......... -5%   (inside measurement noise)
 *   TMAX 48 -> 34 .................. ~0%
 *
 * The last two are the surprise and worth recording: in a maze almost every ray
 * hits a wall within a few steps, so the step ceiling and far plane hardly ever
 * bind. Capping them is nearly free but also buys nearly nothing — they are
 * kept only for the open-corridor case and for weak hardware. Anyone optimising
 * this further should go after **nesting levels and resolution**, not the march.
 *
 * What that produced:
 *
 * 1. **`pixelBudget` scales with tier, not fixed at 0.9 (F128).** Cost is
 *    linear in pixel count and this scene has to leave room for the post
 *    chain, so it already rendered at roughly half linear scale and
 *    upscaled — Neon-and-fog tolerates that; this is the opposite of
 *    `matrix`, whose hard glyph edges ruled the offscreen path out entirely.
 *    Below tier ~2 the budget drops further still (0.9 -> 0.55), trading
 *    resolution for nesting depth rather than the other way round: the third
 *    (CELL/9) level was already documented as mostly sub-pixel at 0.47
 *    render scale, so losing more of it to a lower buffer costs less than
 *    losing an entire nesting level costs structurally (see point 2).
 * 2. **~~One nesting level survives down to tier ~3, not zero (F128).~~
 *    Superseded 2026-08-29 (F139 hard fix): nesting depth is no longer
 *    tier-gated at all — see point 3.** The third (CELL/9) level costs a
 *    third of the frame on its own; the second (CELL/3) level flattening
 *    the maze to its bare CELL=3 grid was a structural loss (corridors
 *    stop looking carved, not just blurrier) that read as far worse than
 *    any resolution cut. The authored `complexity` default sits at 2
 *    levels; maxing the slider still reaches 3.
 * 3. **~~Quality-capped nesting.~~ Removed 2026-08-29 (F139 hard fix):**
 *    fractal nesting depth (`uDetail`, driven by the `complexity` dial and
 *    tied to `uDensity`/`uDetail` structurally) must never degrade under
 *    load — the maze's geometry changing shape as quality drops reads as
 *    the scene glitching, not as a quality change, and the old
 *    `detailCap` ladder collided with `pixelBudget`'s tier-50 cutoff to
 *    produce a 2.1s single-frame stall (see ISSUES.md F139). Only the
 *    user's `complexity` dial controls nesting now; the governor is
 *    limited to resolution / march-step / AO / edge-glow below, none of
 *    which change the maze's structure. Cost at low tiers is higher than
 *    it used to be as a result — an accepted tradeoff, not an oversight.
 * 4. **Dead sinusoid branch deleted.** The source's `pathPos` computed BOTH a
 *    sinusoidal and a value-noise path, then `mix`ed by `randomness`. That knob
 *    is fixed here at its authored 1.0, which selects the noise path outright —
 *    so four `sin` calls were dead weight on every march step. Cuts `pathPos`
 *    from 12 transcendentals to 8.
 * 5. **Edge glow gated off** below tier ~2 (6 `map()` calls per shaded pixel).
 * 6. **Governed march steps / AO taps / far plane** — small, kept for the cases
 *    above.
 *
 * At ~5.4 ms this sits alongside the roster's existing heavyweights (`network`
 * measured 6.3 ms) rather than off the scale, but it is still `high` and still
 * worth re-checking with `/bench` in situ.
 *
 * ## Colour
 *
 * The source drove everything from its own cosine hue wheel (`hue`, `hueCycle`,
 * `depthHue`), which would have ignored the active palette entirely. Emissive
 * elements now sample `paletteLit()` (mid/accent/glow — never the dark ground),
 * fog and walls sample the darker end, and depth still walks the ramp so
 * distance reads as colour. See `PALETTE_RAMP_GLSL` for why the lookup wraps
 * rather than clamps.
 *
 * ## Band routing
 *
 *   onKick  → SPRING lurch: shoves the ray origin down the corridor, which then
 *             rings back through its rest position (see below). The same signed
 *             spring value walks the palette ramp and thins/thickens the fog.
 *   mids    → flight-speed drift
 *   energy  → headlight and emissive intensity
 *   highs   → circuit and window shimmer
 *
 * ## Response identity: the spring settle — the roster's only overshoot
 *
 * The audit behind `engine/response.ts` measured the reaction vocabulary and
 * found **zero** springs across 22 scenes: every scene charged a value on a
 * kick and let `exp(-dt*k)` slide it monotonically back, so every hit in every
 * scene read as the same soft thud with a different texture painted over it.
 * This scene is the answer to that, and it is deliberately the only one.
 *
 * A kick displaces `st.lurch` — a real mass on a real spring, deliberately
 * UNDER-damped — and `springStep` then does what an exponential decay
 * structurally cannot: the corridor surges forward, carries PAST where it
 * should have stopped, rocks back through rest, and settles. That readable
 * overshoot is the whole point. It is the difference between a light that got
 * brighter and a thing that got hit, and it costs two multiplies a frame.
 *
 * Notice what the kick no longer does: it does not brighten anything. The old
 * `uShock * 0.8` term in `light` was the 22nd of 22 scenes driving glow from a
 * kick envelope, so it is gone outright. The spring reaches the image three
 * ways, none of them a gain term:
 *
 *   1. `uPhase` — the ray origin's position on the path. The lurch itself.
 *   2. `uHue`   — palette-ramp POSITION, so the neon swings colour and rocks
 *                 back with the geometry rather than merely flashing.
 *   3. `uLurch` — fog density, signed: surging forward opens the corridor
 *                 ahead of you, the rock-back closes it in again.
 *
 * The kick therefore no longer permanently advances the flight the way the old
 * `st.z += 0.8 * s.onKick` did — displacement now returns to zero, because a
 * corridor with mass that keeps the ground it gained on every hit is not a
 * corridor with mass, it is a speed knob. Cruise distance is `speed`/`mids`
 * alone; the kick only rocks the camera about it.
 */

/**
 * The lurch spring. Two numbers, chosen against the music rather than by feel.
 *
 * `stiffness = 60` puts the ringing frequency at `sqrt(60) ≈ 7.75 rad/s`, a
 * 0.81 s period — so the surge-and-return half cycle is ~0.4 s, which at
 * anything near 120-150 BPM lands the rock-back around the following beat.
 * Faster and the overshoot is a twitch too quick to read as mass; slower and
 * the corridor is still swinging when the next kick displaces it again.
 *
 * Damping is `criticalDamping(60) * 0.38` — 0.38 of critical, so the spring is
 * genuinely under-damped and the first rebound is `exp(-0.38π/sqrt(1-0.38²))`
 * ≈ 27% of the initial displacement, then ~7%, then gone. Visible for two
 * swings, settled inside a bar. Critical damping (`* 1.0`) would settle with no
 * overshoot at all and this scene would be back to being one more exponential
 * slide, which is exactly what the primitive exists to escape.
 */
const LURCH_STIFFNESS = 60
const LURCH_DAMPING = criticalDamping(LURCH_STIFFNESS) * 0.38

/**
 * Forward displacement per unit of kick onset — the source's authored lurch
 * size, unchanged from when it was added straight onto `st.z`. What changed is
 * where it goes (into the spring's position) and what happens next.
 */
const LURCH_IMPULSE = 0.8

/**
 * Ceiling on accumulated displacement, so a dense kick pattern rocks the
 * corridor rather than catapulting it. Matches the old `shock` clamp's intent.
 */
const LURCH_MAX = 1.4

/** Palette-ramp travel per unit of spring displacement. Colour, not gain. */
const LURCH_HUE = 0.06

/**
 * Loop ceilings. GLSL ES 1.00 needs constant bounds; uniforms early-break.
 *
 * MAX_STEPS lowered from 150 (F137). A live session log showed a single
 * 1877.8ms frame land exactly on this scene's first commit — not a warm-mount
 * scheduling bug (`shaderPrewarm.ts` already refuses to trust `isReady()` on
 * this exact driver stack, ANGLE/D3D11, and correctly falls back to the
 * visible-warm-frame path), but the underlying compile itself taking that
 * long. `uMaxSteps` is clamped to `quality.knobs.raymarchSteps`, whose
 * highest real value is 96 (tier 0) — the constant loop bound below has
 * never been reached by any runtime value since it was set to 150, so this
 * is a compile-time-only ceiling with a large, unused margin. 96 matches that
 * real ceiling exactly: zero runtime/visual change (uMaxSteps was already
 * clamped below it at every tier), on the chance that a smaller static bound
 * gives ANGLE's D3D11 backend less to unroll or optimize. Unverified without
 * a live re-test — this is the most defensible lever to try first (it can't
 * regress anything), not a confirmed fix.
 */
const MAX_STEPS = 96
const MAX_AO = 5

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see MatrixRainScene). Full source is
 * `SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  /**
   * Signed lurch-spring displacement, roughly -0.4..1.4. NOT an envelope: it
   * crosses zero and changes sign as the corridor rocks back, so anything
   * reading it must behave sensibly for negative values. Drives fog depth
   * only -- the lurch proper arrives as uPhase, the colour swing as uHue.
   */
  uniform float uLurch;
  uniform float uTurns;
  uniform float uSmooth;
  uniform float uDensity;
  uniform float uDetail;
  uniform float uFov;
  uniform float uGlowAmt;
  uniform float uHue;
  uniform float uEnergy;
  uniform float uHighs;
  uniform int uMaxSteps;
  uniform int uAoSteps;
  uniform float uTMax;
  /** 1 = compute the convex-edge trim, 0 = skip its 6 map() calls. */
  uniform float uEdgeOn;

  const float TAU = 6.28318530718;
  const float CELL = 3.0;

  // Fixed at the source's authored defaults — the knobs that did not earn a
  // slot in the seven-key vocabulary.
  const float WIDTH = 0.91;
  const float EDGE_GLOW = 0.10;
  const float CIRCUITS = 1.67;
  const float WINDOWS = 2.36;
  const float ZHUE = 1.28;
  const float SAT = 1.54;
  const float FOG = 1.0;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float hash11(float p) { return fract(sin(p * 127.1) * 43758.5453123); }

  float vnoise(float x) {
    float i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), f);
  }

  float stairs(float x) {
    float f = fract(x);
    float hw = mix(0.14, 0.5, clamp(uSmooth, 0.0, 1.0));
    return floor(x) + smoothstep(0.5 - hw, 0.5 + hw, f);
  }

  // The source also built a sinusoidal path here and mixed it in by a
  // randomness knob. That knob is fixed at its authored 1.0, which selects
  // this noise path outright, so the sinusoidal half was four sin calls of
  // dead weight on every single march step. Deleted.
  vec3 pathPos(float z) {
    float zc = z / CELL;
    float gx = ((vnoise(zc / 3.5 + 3.0) - 0.5)
              + 0.5 * (vnoise(zc / 1.575 + 9.0) - 0.5)) * 1.60 * uTurns;
    float gy = ((vnoise(zc / 3.9 + 21.0) - 0.5)
              + 0.5 * (vnoise(zc / 1.75 + 40.0) - 0.5)) * 1.35 * uTurns;
    return vec3((stairs(gx) + 0.5) * CELL, (stairs(gy) + 0.5) * CELL, z);
  }

  // Corridors reach through any cell face whose symmetric hash rolls open, each
  // half-tube overshooting the shared face by w so adjacent cells describe
  // identical geometry at the seam (continuous field).
  float carveScale(vec3 p, float s, float prob, float w, float seed) {
    vec3 id = floor(p / s);
    vec3 f = p - (id + 0.5) * s;
    float e = 0.5 * s + w;
    float d = 1e9;

    float crx = max(abs(f.y), abs(f.z)) - w;
    if (hash31(id + vec3( 0.5, 0.0, 0.0) + seed) < prob)
      d = min(d, max(crx, max( f.x - e, -f.x - w)));
    if (hash31(id + vec3(-0.5, 0.0, 0.0) + seed) < prob)
      d = min(d, max(crx, max(-f.x - e,  f.x - w)));

    float sz = seed + 33.17;
    float crz = max(abs(f.x), abs(f.y)) - w;
    if (hash31(id + vec3(0.0, 0.0,  0.5) + sz) < prob)
      d = min(d, max(crz, max( f.z - e, -f.z - w)));
    if (hash31(id + vec3(0.0, 0.0, -0.5) + sz) < prob)
      d = min(d, max(crz, max(-f.z - e,  f.z - w)));

    float sy = seed + 71.73;
    float py = prob * 0.45;
    float cry = max(abs(f.x), abs(f.z)) - w;
    if (hash31(id + vec3(0.0,  0.5, 0.0) + sy) < py)
      d = min(d, max(cry, max( f.y - e, -f.y - w)));
    if (hash31(id + vec3(0.0, -0.5, 0.0) + sy) < py)
      d = min(d, max(cry, max(-f.y - e,  f.y - w)));

    return d;
  }

  float map(vec3 p) {
    float w0 = 0.34 * CELL * WIDTH;
    float carve = carveScale(p, CELL, 0.58 * uDensity, w0, 0.0);

    // Guaranteed corridor along the camera path, scaled by 0.2 to stay
    // Lipschitz-safe near turns (keeps the march from over-stepping and
    // punching "blade" shards through walls). Scaling an SDF by a positive
    // constant does not move its zero-crossing.
    vec3 pc = pathPos(p.z);
    carve = min(carve, (max(abs(p.x - pc.x), abs(p.y - pc.y)) - w0) * 0.2);

    // Nested detail: the walls are themselves mazes. Each level is six more
    // hashes on EVERY map() call, which is why the governor caps uDetail.
    if (uDetail > 0.25) {
      float s1 = CELL / 3.0;
      carve = min(carve, carveScale(p, s1, 0.42 * uDensity, 0.30 * s1 * WIDTH, 101.3));
    }
    if (uDetail > 0.75) {
      float s2 = CELL / 9.0;
      carve = min(carve, carveScale(p, s2, 0.45 * uDensity, 0.32 * s2 * WIDTH, 57.7));
    }
    return -carve;
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.0015, -0.0015);
    return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
                     e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
  }

  float calcAO(vec3 p, vec3 n) {
    float occ = 0.0;
    float sca = 1.0;
    for (int i = 0; i < ${MAX_AO}; i++) {
      if (i >= uAoSteps) break;
      float h = 0.02 + 0.11 * float(i);
      occ += (h - map(p + n * h)) * sca;
      sca *= 0.72;
    }
    return clamp(1.0 - 1.4 * occ, 0.0, 1.0);
  }

  float edgeGlowAt(vec3 p, float h) {
    float d0 = map(p);
    float s = map(p + vec3( h, 0.0, 0.0)) + map(p - vec3( h, 0.0, 0.0))
            + map(p + vec3(0.0,  h, 0.0)) + map(p - vec3(0.0,  h, 0.0))
            + map(p + vec3(0.0, 0.0,  h)) + map(p - vec3(0.0, 0.0,  h));
    return clamp((s / 6.0 - d0) / h * 4.0, 0.0, 1.0);
  }

  vec3 shade(vec3 ro, vec3 rd, float t, float zt, float hue0) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    float ao = calcAO(p, n);
    vec3 an = abs(n);
    float hue = hue0 + p.z * 0.012 * ZHUE;
    float dfade = exp(-t * 0.06);
    // A kick deliberately does NOT appear here. The old term was uShock * 0.8,
    // which made this the 22nd of 22 scenes turning a kick into brightness;
    // the lurch spring reaches the image as position, ramp colour and fog
    // depth instead. Continuous energy still opens the headlight.
    float light = 1.0 + uEnergy * 0.5;

    // Neutral base so the neon reads, tinted toward the palette's dark end.
    float tint = hash31(floor(p / CELL) + 7.7);
    vec3 alb = mix(vec3(0.16, 0.17, 0.20), vec3(0.23, 0.21, 0.27), tint) + uShadow * 0.6;

    float gs = 0.5;
    vec3 fr = fract(p / gs);
    vec3 dl = gs * min(fr, 1.0 - fr);
    float lm = 0.0;
    lm = max(lm, (1.0 - smoothstep(0.006, 0.028, dl.x)) * (1.0 - an.x));
    lm = max(lm, (1.0 - smoothstep(0.006, 0.028, dl.y)) * (1.0 - an.y));
    lm = max(lm, (1.0 - smoothstep(0.006, 0.028, dl.z)) * (1.0 - an.z));
    lm *= dfade;

    float lh = hash31(floor(p / gs) + 13.7);
    float circuit = lm * step(0.72, lh)
                  * (0.7 + 0.3 * sin(uTime * 2.0 + lh * TAU * 3.0) * (0.5 + 0.5 * uHighs));

    vec3 wq = abs(fract(p) - 0.5);
    float inset = max(wq.x * (1.0 - an.x), max(wq.y * (1.0 - an.y), wq.z * (1.0 - an.z)));
    float wh = hash31(floor(p) + 91.7);
    float thr = 1.0 - 0.11 * WINDOWS;
    float wmask = (1.0 - smoothstep(0.27, 0.33, inset)) * step(thr, wh)
                * (0.65 + 0.35 * sin(uTime * 1.5 + wh * TAU * 5.0) * (0.5 + 0.5 * uHighs));

    float trim = 0.0;
    if (uEdgeOn > 0.5) trim = edgeGlowAt(p, 0.06) * EDGE_GLOW * uGlowAmt;

    vec3 lp = ro + vec3(0.0, 0.2, 0.0);
    vec3 ld = lp - p;
    float lr = max(length(ld), 1e-3);
    ld /= lr;
    float att = 1.0 / (1.0 + 0.14 * lr * lr);
    float dif = max(dot(n, ld), 0.0) * att;
    float spe = pow(max(dot(reflect(rd, n), ld), 0.0), 24.0) * att;

    // Coloured scout light drifting ahead down the corridor.
    vec3 lp2 = pathPos(zt + 9.0 + 3.0 * sin(uTime * 0.4));
    vec3 ld2 = lp2 - p;
    float lr2 = max(length(ld2), 1e-3);
    float att2 = 1.0 / (1.0 + 0.20 * lr2 * lr2);
    float dif2 = max(dot(n, ld2 / lr2), 0.0) * att2;

    vec3 neon = paletteLit(hue);
    vec3 col = alb * (0.05 + 1.5 * dif * light) * ao;
    col += alb * paletteLit(hue + 0.45) * dif2 * 2.2 * light;
    col *= 1.0 - 0.45 * lm;
    col += vec3(0.9) * spe * 0.5 * light * ao;
    col += neon * trim * 1.5 * (0.3 + 0.7 * ao);
    col += neon * circuit * 1.1 * CIRCUITS * uGlowAmt;
    col += paletteLit(hue + 0.13 + wh * 0.35) * wmask * 2.0 * uGlowAmt;
    return col;
  }

  void main() {
    vec2 uv = (2.0 * gl_FragCoord.xy - uRes.xy) / uRes.y;

    float zt = uPhase;
    vec3 ro = pathPos(zt);
    vec3 ta = pathPos(zt + 2.4);
    vec3 fw = normalize(ta - ro);

    float lean = clamp(-0.22 * (pathPos(zt + 2.8).x - ro.x) / CELL, -0.35, 0.35);
    vec3 wup = vec3(sin(lean), cos(lean), 0.0);
    vec3 rt = normalize(cross(fw, wup));
    vec3 up = cross(rt, fw);
    float focal = 1.15 / max(uFov, 0.25);
    vec3 rd = normalize(uv.x * rt + uv.y * up + fw * focal);

    float hue0 = uHue;

    float t = 0.0;
    float d = 0.0;
    for (int i = 0; i < ${MAX_STEPS}; i++) {
      if (i >= uMaxSteps) break;
      d = map(ro + rd * t);
      if (d < 0.0013 * (1.0 + t * 1.2) || t > uTMax) break;
      t += d * 0.8;
    }

    bool hit = t < uTMax && d < 0.05;
    vec3 fogc = uBg + paletteLit(hue0 + t * 0.008 * ZHUE) * 0.10;
    vec3 col;
    if (hit) {
      col = shade(ro, rd, t, zt, hue0);
      // Fog breathes with the spring, signed both ways: the forward surge
      // thins it and the corridor opens ahead of you, the rock-back thickens
      // it and closes in. Depth and contrast rather than a glow pulse. At
      // uLurch = 0 this is exactly FOG, so silence is the authored image.
      float fogAmt = FOG * clamp(1.0 - uLurch * 0.35, 0.4, 1.6);
      col = mix(col, fogc, 1.0 - exp(-t * t * 0.0014 * fogAmt));
    } else {
      col = fogc;
    }

    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, SAT);
    col = 1.0 - exp(-col * 1.7);
    // The source ended with pow(col, 0.4545) — a full linear->sRGB encode,
    // correct for the raw WebGL canvas it was written against. Removed here:
    // three's renderer has outputColorSpace = SRGBColorSpace and does that
    // encode itself on the way to the canvas, so keeping it applied gamma
    // TWICE (col^0.207) and washed the walls out to a milky grey. Scenes in
    // this roster output linear and let the renderer encode — the only pows
    // elsewhere are mild contrast shaping (0.85-0.92), never a 1/2.2.
    col *= 1.0 - 0.28 * dot(uv * 0.55, uv * 0.55);
    // Dither, breaking the banding a heavy fog gradient would otherwise show.
    col += (hash21(gl_FragCoord.xy + fract(uTime)) - 0.5) / 256.0;

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface MazeState {
  /** Distance flown along the corridor, accumulated. */
  z: number
  /** Palette-ramp drift. */
  hue: number
  /**
   * Forward-lurch spring: a kick displaces its position, and it rings back
   * through rest rather than sliding there. Signed — it goes negative on the
   * rebound, which is the entire reason it is a spring and not a `shock`.
   */
  lurch: SpringState
}

export const MazeFlightScene = createShaderScene<MazeState>({
  id: 'maze',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  // Governs the OFFSCREEN pass only — BlendedLayer forces `add` on the
  // on-screen material for the primary slot. Replace is right for the buffer:
  // this scene paints every pixel including its own fog ground.
  blending: THREE.NoBlending,
  // Measured: 48.7 ms at full res vs 5.4 ms here. Cost is linear in pixel
  // count and this scene must leave room for the post chain, so it renders at
  // roughly half linear scale. Neon-plus-fog upscales gracefully.
  //
  // Read every frame (F128): below tier ~2 the budget drops further, paying
  // for the nesting level `detailCap` keeps alive down to tier ~3 instead of
  // flattening the maze outright. `quality.knobs.raymarchSteps` is the same
  // tier proxy `update()` already reads below.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 0.9 : 0.55),
  uniforms: () => ({
    uPhase: { value: 0 },
    uLurch: { value: 0 },
    uTurns: { value: 1.63 },
    uSmooth: { value: 0.6 },
    uDensity: { value: 1.5 },
    uDetail: { value: 0.7 },
    uFov: { value: 1.39 },
    uGlowAmt: { value: 1 },
    uHue: { value: 0 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uMaxSteps: { value: MAX_STEPS },
    uAoSteps: { value: MAX_AO },
    uTMax: { value: 48 },
    uEdgeOn: { value: 1 },
  }),
  state: () => ({ z: 0.4, hue: 0, lurch: spring(0) }),
  update({ u, s, P, st, dt }) {
    // Source's authored cruise: 3.2 units/s at speed 1.
    st.z += dt * 3.2 * (1 + s.mids * 0.5) * drastic(P.speed)

    // A kick is a lurch forward down the corridor, not a flash — and now it is
    // a lurch with mass. The onset SHOVES the spring's position (an impulse to
    // displacement, so the surge is instant at exactly the authored 0.8 per
    // unit of onset, as it was when this went straight onto `st.z`)...
    if (s.onKick > 0) {
      st.lurch.value = Math.min(LURCH_MAX, st.lurch.value + LURCH_IMPULSE * s.onKick)
    }
    // ...and the spring, pulling back toward a rest of zero and deliberately
    // under-damped, then carries the corridor past rest and rocks it back.
    // This line is the whole identity: `exp(-dt * k)` here would only ever
    // slide home, and the scene would be indistinguishable in MANNER from the
    // other 21. See LURCH_STIFFNESS for the tuning argument.
    springStep(st.lurch, 0, dt, LURCH_STIFFNESS, LURCH_DAMPING)

    // Slow drift through the palette ramp, so depth and time both read as
    // colour without spinning a full rainbow.
    st.hue += dt * 0.015

    // The spring reaches the shader three ways, none of them a gain term: as
    // the ray origin's position, as a swing in palette-ramp POSITION that
    // rocks back with the geometry, and (signed) as fog depth.
    u.uPhase.value = st.z + st.lurch.value
    u.uLurch.value = st.lurch.value
    u.uHue.value = st.hue + st.lurch.value * LURCH_HUE
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs

    u.uTurns.value = P.shape * 2.0
    u.uSmooth.value = P.tilt
    u.uDensity.value = P.density * 1.5
    u.uFov.value = 0.4 + P.fill * 1.6
    u.uGlowAmt.value = 0.2 + P.contrast * 1.6

    // --- quality governance -------------------------------------------------
    // Fractal nesting depth is NEVER tier-gated (F139 hard fix, 2026-08-29):
    // only the user's own `complexity` dial decides it, same as `uDensity`
    // above. See the header comment (point 3) for why — the old `detailCap`
    // ladder flattened the maze's actual geometry under load and collided
    // with `pixelBudget`'s tier-50 cutoff to produce a 2.1s stall.
    u.uDetail.value = P.complexity
    // March steps / AO taps / edge glow / far plane are NEVER tier-gated
    // either, as of the same request that drove F139: the header's own
    // profiling table says these are nearly free (march 96->48 ~5%, AO
    // 5->3 ~6%, TMAX ~0%; only edge-glow-off is real at ~14%) next to
    // nesting depth and resolution, which is why the table's own verdict is
    // "go after nesting levels and resolution, not the march." `pixelBudget`
    // above is the ONLY knob the quality governor still moves for this
    // scene — cost is linear in pixel count, so it carries the actual
    // tier-to-tier scaling on its own.
    u.uMaxSteps.value = MAX_STEPS
    u.uAoSteps.value = MAX_AO
    u.uEdgeOn.value = 1
    u.uTMax.value = 48
  },
})

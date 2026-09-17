import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'
import { slew } from '../engine/response'

/**
 * Truchet Kaleidoscope — an endless flythrough of stacked kaleidoscope planes,
 * each tiled with a Truchet distance-field pattern, folded n-fold and rolling.
 *
 * Shadertoy shader "Truchet + Kaleidoscope FTW". Its header declares **CC0**.
 * It bundles helpers under MIT (Inigo Quilez — `pmin`, `postProcess`) and
 * "MIT OR CC-BY-NC-4.0" (mercury / hg_sdf — `modMirror1`; the MIT option
 * applies), plus a couple of trivial "License: Unknown" utility snippets
 * (`hash`, `tanh_approx`, `alphaBlend`) that are ubiquitous public fragments.
 * Consistent with CC0 → `license: 'original'`.
 *
 * ## HELD OUT in DISABLED_SCENES — pending TWO things
 *
 *  1. **Author confirmed.** It arrived as a bare paste with "found: don't
 *     remember" provenance. It reads as mrange's (who releases everything CC0),
 *     but that should be nailed down before it ships.
 *  2. **A real /bench sweep.** `color()` accumulates up to 6 kaleidoscope +
 *     Truchet planes per pixel with a dual-ray AA. No march loop, but each
 *     plane runs `smoothKaleidoscope` + `truchet_df` + several smoothsteps —
 *     unmeasured, and it does NOT clear `slotBudget.test.ts`'s tier-0
 *     `< sceneBudget(0)/2` bar. That bar is **5.05 ms**, not the "≈ 4ms" this
 *     header used to quote: `TIER_BUDGET_MS[0]` (11) minus `POST_CHAIN_MS` +
 *     `FEEDBACK_MS` (0.9), halved. `SCENE_COST_MS.truchet` puts tier 0 at 6.8.
 *     `uPlanes` (below) is wired to the quality governor so a bench can be run
 *     at each tier.
 *
 *     `pixelBudget` was re-anchored 1.6/1.0 -> 8.9/5.6 by F195 and has now
 *     been REVERTED to 1.6/1.0 (see the declaration below for the full
 *     reasoning). Under 8.9 this scene rendered at full native on any panel up
 *     to 4K — about 5.2x the internal pixels its own `SCENE_COST_MS` row was
 *     priced at, putting its true tier-0 cost near 35 ms rather than 6.8. The
 *     revert makes the declared row describe the resolution the scene actually
 *     renders at, so a bench run now measures the thing the table claims.
 *     Resolution alone still cannot clear the bar: `MIN_RENDER_SCALE` floors
 *     the buffer at 1.327 MP on a 4K panel, which prices this scene at 5.64 ms
 *     even at its cheapest possible resolution.
 *
 * Promotion = move the object literal into `SCENES` + add a `SCENE_COST_MS`
 * row from the sweep.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution / RESOLUTION -> uRes
 *   iTime / TIME             -> uFly (JS speed-scaled accumulator; the per-plane
 *                              ROT(...*TIME) terms ride the same clock)
 *   fragCoord                -> gl_FragCoord.xy
 *   mainImage()              -> main() / gl_FragColor, final * uFade
 *   `round()`                -> `floor(x + 0.5)` (round() is GLSL ES 3.00 only)
 *   `max(int,int)`           -> constant-folded (ES 1.00 has no int max())
 *   postProcess `pow(col, 1/2.2)` -> `pow(col, 0.85)` — three's renderer does
 *                              the linear->sRGB encode itself; the full 1/2.2
 *                              here would double-gamma (cf. MazeFlightScene).
 *
 * ## What was added (the source is time-driven only)
 *
 *   speed dial + mids  -> flythrough rate
 *   onKick             -> uShock: Truchet line-width bloom + brightness punch
 *   sub                -> Truchet arc radius (per-plane `r` in `plane()`):
 *                         the tile pattern itself swells with the bass,
 *                         distinct from `uLw`'s line-weight dial and uShock's
 *                         transient line-width bloom
 *   energy             -> plane + sky brightness
 *   highs              -> a bright-area shimmer
 *   uBeatSin2 (free)   -> a small breathing on the kaleidoscope rep/symmetry
 *                         count (`rep` in `plane()`), so the fold order
 *                         itself ticks with the tempo grid, not just the
 *                         static complexity dial (see "Second pass" below)
 *   highs              -> ALSO the fold's smoothing radius (`sm`): a
 *                         structural shimmer alongside the brightness one
 *
 * ## Band routing
 *
 *   onKick  -> uShock: line bloom + brightness (decaying)
 *   sub     -> Truchet cell arc radius (continuous swell)
 *   mids    -> flythrough rate
 *   energy  -> overall luminance / sky glow
 *   highs   -> highlight shimmer (main()) AND fold smoothing radius `sm`
 *              (plane()) — one band, two distinct dimensions: color vs. shape
 *   uBeatSin2 -> kaleidoscope rep/symmetry count: a small +-5% beat-locked
 *              breathing layered on the static complexity dial
 *
 * ## "jerky and bumpy, should be smooth" (reported directly) — the flythrough
 * ## rate was reading a live envelope, not a trend
 *
 * `st.fly` is the *only* clock in this scene: it drives the camera's forward
 * position (`tm = TIME*0.25` in `effect()`), every plane's per-plane spin
 * (`ROT(...*TIME)` in `plane()`), and — through the fold's own phase — the
 * kaleidoscope symmetry's apparent rotation. One noisy input there is not one
 * bump, it is the whole scene bumping in lockstep every frame.
 *
 * The rate used to read `s.mids` directly — `dt * (1 + s.mids * 0.6)` — and
 * `s.mids` is a live audio envelope, not itself smoothed frame-to-frame. Every
 * fluctuation of the mids band landed straight in the flythrough's velocity,
 * so the camera visibly sped up and slowed down (and every plane's spin
 * along with it) on every wobble of the band rather than gliding — this is
 * the identical root cause `GyroidFluxScene.update()` found and fixed on
 * direct request, and the same fix applies here: `slew()` the band before it
 * touches a rate. `slew(..., 3, 3)` tracks the real mids trend within a few
 * tenths of a second while erasing the frame-to-frame jitter a rate is
 * uniquely sensitive to (a position tolerates noise; an integrated velocity
 * does not — the noise never washes out, it accumulates as stutter).
 *
 * `uShock` (the kick line-bloom + brightness punch) keeps its instant attack
 * on purpose — that is the roster's standard percussive accent (see
 * `response.ts`'s `slew` doc), a deliberately sharp, momentary snap riding on
 * top of an otherwise-smooth scene, not the source of the reported jerkiness.
 *
 * ## Second pass — "see if some specific bands can be wired specifically"
 *
 * Two dimensions were still purely time/dial-driven with no audio at all:
 * `uKRep` (kaleidoscope rep/symmetry count — driven only by the static
 * complexity dial) and the fold's own smoothing radius `sm` (derived purely
 * from `rep`, no band feeding it either). Separately, no scene-wide clock in
 * this file ever reads the engine's tempo-locked oscillators (`uBeatSin*`),
 * despite them being free in every shader — everything here is either a raw
 * band, `st.fly`, or a per-plane hash times `TIME`.
 *
 * Added, both small and additive per the house convention of one band
 * driving one distinct visual dimension rather than a blanket multiplier:
 *
 *  - `uBeatSin2` (half-bar oscillator) -> a +-5% breathing on the pre-floor
 *    `rep` scalar in `plane()`, so the fold count itself gently ticks with
 *    the tempo grid instead of sitting dead-static on the complexity dial.
 *    `uBeatSin2` needs no JS wiring (no new uniform, no new `st` field) — the
 *    prelude injects it directly, and it is a deterministic function of the
 *    tracked beat grid rather than a noisy audio band, so it is safe to use
 *    as-is rather than needing a `slew()` pass first.
 *  - `uHighs` -> ALSO the fold's smoothing radius `sm` (previously derived
 *    from `rep` alone with no band input at all), a *structural* shimmer —
 *    the fold's own corner-rounding breathes with the highs — distinct from
 *    the existing `uHighs` term in `main()`, which only scales the final
 *    color and never touches geometry.
 *
 * Passed over: driving the per-plane spin (`ROT(0.5*(h4-0.5)*TIME)` in
 * `plane()`) with a beat term. That rotation's angle already comes straight
 * off the monotonically-increasing `TIME` clock; laying a bounded oscillator
 * over it the way GyroidFluxScene's orbit path did before its own fix is the
 * wrong shape of fix here too — several planes draw an `h4` near 0.5, i.e. a
 * per-plane base spin rate near zero, and once an added oscillator's swing is
 * comparable to that base rate, the *combined* angle's rate can flip sign at
 * the oscillator's own turning points, reading as back-and-forth rather than
 * a tick. The `rep` / `sm` routes above land the same "the tempo grid should
 * be felt somewhere" request on two quantities that are magnitudes, not
 * angles, so there is no turning-point risk to weigh for either of them.
 */

export const FRAG = /* glsl */ `
  uniform float uFly;      // speed-scaled loop clock (replaces iTime)
  uniform float uShock;    // decaying kick envelope
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBass;     // s.sub -> Truchet cell arc radius (continuous)
  uniform float uKRep;     // complexity dial -> kaleidoscope symmetry multiplier
                           // (also gets a small beat-locked breathing in-shader
                           // via the free uBeatSin2 -- see rep in plane())
  uniform float uLw;       // density dial -> Truchet line weight
  uniform float uFov;      // fill dial -> field of view
  uniform float uTilt;     // tilt dial -> static roll, radians
  uniform int   uPlanes;   // quality: planes accumulated (3..6)

  #define PI              3.141592654
  #define TAU             (2.0*PI)
  #define RESOLUTION      uRes
  #define TIME            uFly
  #define ROT(a)          mat2(cos(a), sin(a), -sin(a), cos(a))
  #define PCOS(x)         (0.5+0.5*cos(x))

  vec4 alphaBlend(vec4 back, vec4 front) {
    float w = front.w + back.w*(1.0-front.w);
    vec3 xyz = (front.xyz*front.w + back.xyz*back.w*(1.0-front.w))/w;
    return w > 0.0 ? vec4(xyz, w) : vec4(0.0);
  }

  vec3 alphaBlend(vec3 back, vec4 front) {
    return mix(back, front.xyz, front.w);
  }

  float hash(float co) {
    return fract(sin(co*12.9898) * 13758.5453);
  }

  float hash(vec2 p) {
    float a = dot(p, vec2 (127.1, 311.7));
    return fract(sin (a)*43758.5453123);
  }

  float tanh_approx(float x) {
    float x2 = x*x;
    return clamp(x*(27.0 + x2)/(27.0+9.0*x2), -1.0, 1.0);
  }

  // License: MIT, author: Inigo Quilez, found: https://iquilezles.org/articles/smin
  float pmin(float a, float b, float k) {
    float h = clamp(0.5+0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
  }

  // License: MIT, author: Inigo Quilez, found: https://iquilezles.org/www/index.htm
  vec3 postProcess(vec3 col, vec2 q) {
    col = clamp(col, 0.0, 1.0);
    // Source had pow(col, vec3(1.0/2.2)) here — a full linear->sRGB encode.
    // Removed: three's renderer has outputColorSpace = SRGBColorSpace and does
    // that encode on the way to the canvas, so keeping it applied gamma twice.
    // A mild 0.85 lift keeps the postProcess S-curve's intended input range.
    col = pow(col, vec3(0.85));
    col = col*0.6+0.4*col*col*(3.0-2.0*col);
    col = mix(col, vec3(dot(col, vec3(0.33))), -0.4);
    col *=0.5+0.5*pow(19.0*q.x*q.y*(1.0-q.x)*(1.0-q.y),0.7);
    return col;
  }

  float pmax(float a, float b, float k) {
    return -pmin(-a, -b, k);
  }

  float pabs(float a, float k) {
    return pmax(a, -a, k);
  }

  vec2 toPolar(vec2 p) {
    return vec2(length(p), atan(p.y, p.x));
  }

  vec2 toRect(vec2 p) {
    return vec2(p.x*cos(p.y), p.x*sin(p.y));
  }

  // License: MIT OR CC-BY-NC-4.0, author: mercury, found: https://mercury.sexy/hg_sdf/
  float modMirror1(inout float p, float size) {
    float halfsize = size*0.5;
    float c = floor((p + halfsize)/size);
    p = mod(p + halfsize,size) - halfsize;
    p *= mod(c, 2.0)*2.0 - 1.0;
    return c;
  }

  float smoothKaleidoscope(inout vec2 p, float sm, float rep) {
    vec2 hp = p;

    vec2 hpp = toPolar(hp);
    float rn = modMirror1(hpp.y, TAU/rep);

    float sa = PI/rep - pabs(PI/rep - abs(hpp.y), sm);
    hpp.y = sign(hpp.y)*(sa);

    hp = toRect(hpp);

    p = hp;

    return rn;
  }

  vec3 offset(float z) {
    float a = z;
    vec2 p = -0.075*(vec2(cos(a), sin(a*sqrt(2.0))) + vec2(cos(a*sqrt(0.75)), sin(a*sqrt(0.5))));
    return vec3(p, z);
  }

  vec3 doffset(float z) {
    float eps = 0.1;
    return 0.5*(offset(z + eps) - offset(z - eps))/eps;
  }

  vec3 ddoffset(float z) {
    float eps = 0.1;
    return 0.125*(doffset(z + eps) - doffset(z - eps))/eps;
  }

  vec2 cell_df(float r, vec2 np, vec2 mp, vec2 off) {
    const vec2 n0 = normalize(vec2(1.0, 1.0));
    const vec2 n1 = normalize(vec2(1.0, -1.0));

    np += off;
    mp -= off;

    float hh = hash(np);
    float h0 = hh;

    vec2  p0 = mp;
    p0 = abs(p0);
    p0 -= 0.5;
    float d0 = length(p0);
    float d1 = abs(d0-r);

    float dot0 = dot(n0, mp);
    float dot1 = dot(n1, mp);

    float d2 = abs(dot0);
    float t2 = dot1;
    d2 = abs(t2) > sqrt(0.5) ? d0 : d2;

    float d3 = abs(dot1);
    float t3 = dot0;
    d3 = abs(t3) > sqrt(0.5) ? d0 : d3;

    float d = d0;
    d = min(d, d1);
    if (h0 > .85)
    {
      d = min(d, d2);
      d = min(d, d3);
    }
    else if(h0 > 0.5)
    {
      d = min(d, d2);
    }
    else if(h0 > 0.15)
    {
      d = min(d, d3);
    }

    return vec2(d, d0-r);
  }

  vec2 truchet_df(float r, vec2 p) {
    vec2 np = floor(p+0.5);
    vec2 mp = fract(p+0.5) - 0.5;
    return cell_df(r, np, mp, vec2(0.0));
  }

  vec4 plane(vec3 ro, vec3 rd, vec3 pp, vec3 off, float aa, float n) {
    float h_ = hash(n);
    float h0 = fract(1777.0*h_);
    float h1 = fract(2087.0*h_);
    float h2 = fract(2687.0*h_);
    float h3 = fract(3167.0*h_);
    float h4 = fract(3499.0*h_);

    float l = length(pp - ro);

    vec2 p = (pp-off*vec3(1.0, 1.0, 0.0)).xy;
    p *= ROT(0.5*(h4 - 0.5)*TIME);
    // round() is ES 3.00 only -> floor(x + 0.5). uKRep is the complexity dial.
    // uBeatSin2 (free half-bar oscillator, no JS wiring needed) rides on top
    // as a +-5% breathing so the fold count itself ticks with the tempo grid
    // -- a magnitude nudge on a pre-floor scalar, not a rotation or a rate,
    // so it carries none of the back-and-forth risk a bounded oscillator
    // would have if it drove a rotation angle instead. Kept small: since rep
    // varies quite a bit from plane to plane, a bigger swing would
    // occasionally pop the fold count by more than one step, reading as a
    // glitch rather than a tick.
    float rep = 2.0*floor(mix(5.0, 30.0, h2)*uKRep*(1.0 + 0.05*uBeatSin2) + 0.5);
    // uHighs also nudges the fold's own smoothing radius -- a structural
    // shimmer on the kaleidoscope corner rounding, distinct from main()'s
    // post-hoc brightness multiply on the same band (that one scales the
    // final color; this one changes the shape of the fold itself).
    float sm = 0.05*20.0/rep * (1.0 + uHighs*0.2);
    float sn = smoothKaleidoscope(p, sm, rep);
    p *= ROT(TAU*h0+0.025*TIME);
    float z = mix(0.2, 0.4, h3);
    p /= z;
    p+=0.5+floor(h1*1000.0);
    float tl = tanh_approx(0.33*l);
    // sub-bass swells the arc radius itself, not just the stroke around it --
    // the tile pattern breathes with the bass. Capped at +10%: cells are unit
    // size and the source's own radius already reaches 0.45, so any more
    // would start clipping arcs into their neighbouring cell.
    float r = mix(0.30, 0.45, PCOS(0.1*n)) * (1.0 + uBass*0.10);
    vec2 d2 = truchet_df(r, p);
    d2 *= z;
    float d = d2.x;
    float lw = 0.025*z*uLw*(1.0 + uShock*0.8);   // density dial + kick bloom
    d -= lw;

    vec3 col = mix(vec3(1.0), vec3(0.0), smoothstep(aa, -aa, d));
    col = mix(col, vec3(0.0), smoothstep(mix(1.0, -0.5, tl), 1.0, sin(PI*100.0*d)));
    col = mix(col, vec3(0.0), step(d2.y, 0.0));
    float t = smoothstep(aa, -aa, -d2.y-3.0*lw)*mix(0.5, 1.0, smoothstep(aa, -aa, -d2.y-lw));
    col *= 1.0 + uEnergy*0.4 + uShock*0.6;        // energy / kick brightness
    return vec4(col, t);
  }

  vec3 skyColor(vec3 ro, vec3 rd) {
    float d = pow(max(dot(rd, vec3(0.0, 0.0, 1.0)), 0.0), 20.0);
    return vec3(d)*(1.0 + uEnergy*0.5);
  }

  vec3 color(vec3 ww, vec3 uu, vec3 vv, vec3 ro, vec2 p) {
    float lp = length(p);
    vec2 np = p + 1.0/RESOLUTION.xy;
    float rdd = (2.0+1.0*tanh_approx(lp))*uFov;   // fill dial -> fov
    vec3 rd = normalize(p.x*uu + p.y*vv + rdd*ww);
    vec3 nrd = normalize(np.x*uu + np.y*vv + rdd*ww);

    const float planeDist = 1.0-0.25;
    const int furthest = 6;
    const int fadeFrom = 1;   // was max(furthest-5, 0); ES 1.00 has no int max()

    const float fadeDist = planeDist*float(furthest - fadeFrom);
    float nz = floor(ro.z / planeDist);

    vec3 skyCol = skyColor(ro, rd);

    vec4 acol = vec4(0.0);
    const float cutOff = 0.95;
    bool cutOut = false;

    for (int i = 1; i <= furthest; ++i) {
      if (i > uPlanes) break;                     // quality: fewer planes at low tier
      float pz = planeDist*nz + planeDist*float(i);

      float pd = (pz - ro.z)/rd.z;

      if (pd > 0.0 && acol.w < cutOff) {
        vec3 pp = ro + rd*pd;
        vec3 npp = ro + nrd*pd;

        float aa = 3.0*length(pp - npp);

        vec3 off = offset(pp.z);

        vec4 pcol = plane(ro, rd, pp, off, aa, nz+float(i));

        float nz = pp.z-ro.z;
        float fadeIn = smoothstep(planeDist*float(furthest), planeDist*float(fadeFrom), nz);
        float fadeOut = smoothstep(0.0, planeDist*0.1, nz);
        pcol.xyz = mix(skyCol, pcol.xyz, fadeIn);
        pcol.w *= fadeOut;
        pcol = clamp(pcol, 0.0, 1.0);

        acol = alphaBlend(pcol, acol);
      } else {
        cutOut = true;
        break;
      }
    }

    vec3 col = alphaBlend(skyCol, acol);
    return col;
  }

  vec3 effect(vec2 p, vec2 q) {
    float tm  = TIME*0.25;
    vec3 ro   = offset(tm);
    vec3 dro  = doffset(tm);
    vec3 ddro = ddoffset(tm);

    vec3 ww = normalize(dro);
    vec3 uu = normalize(cross(normalize(vec3(0.0,1.0,0.0)+ddro), ww));
    vec3 vv = normalize(cross(ww, uu));

    vec3 col = color(ww, uu, vv, ro, p);

    return col;
  }

  void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 q = fragCoord/RESOLUTION.xy;
    vec2 p = -1. + 2. * q;
    p.x *= RESOLUTION.x/RESOLUTION.y;
    p *= ROT(uTilt);                              // tilt dial -> static roll

    vec3 col = effect(p, q);
    col += col * uHighs * 0.3;                    // highs shimmer in the bright areas
    col = postProcess(col, q);

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface TruchetState {
  /** Flythrough clock, accumulated so a changing rate stays continuous. */
  fly: number
  /** Kick bloom, decaying. */
  shock: number
  /** `s.mids`, slewed — see the "jerky and bumpy" note above for why the raw
   *  band must not feed a rate directly. */
  midsSlew: number
}

export const TruchetKaleidoScene = createShaderScene<TruchetState>({
  id: 'truchet',
  frag: FRAG,
  // Paints every pixel including its own sky.
  blending: THREE.NoBlending,
  // Starting point only — replace with a real /bench sweep before promotion.
  // The dual-ray AA is resolution-aware, so a soft upscale degrades gracefully.
  //
  // ## Which `pixelBudget` this is
  //
  // `createShaderScene`'s spec field, sizing THIS SCENE'S OWN offscreen buffer
  // and nothing else, solved by that module's private `solveScale`
  // (createShaderScene.tsx:191-196):
  //
  //     scale = clamp(sqrt(budget / fullMP), MIN_RENDER_SCALE /* 0.4 */, 1)
  //
  // Not `SceneMetadata.pixelBudget` from scenes/index.ts, and nothing to do
  // with engine/renderScale.ts: no `combinePixelBudgets` reciprocal sum, no
  // `quality.knobs.pixelBudgetScale` tier multiplier on this path.
  //
  // ## Re-anchored 1.6/1.0 -> 8.9/5.6 (F195), then REVERTED to 1.6/1.0 (F196/F200)
  //
  // F195 applied a uniform 5.5556x to eleven scenes, derived from `maze` —
  // whose 4K solve was 0.40, i.e. pinned ON `solveScale`'s clamp, which is the
  // defect the re-anchor existed to fix. This scene's pre-anchor 4K solve was
  // **0.44** by F195's own table: above the clamp, binding correctly, not
  // suffering that defect. It was multiplied anyway, and 8.9 MP exceeds a 4K
  // panel outright, so tiers 0-2 solved to 1.00 and paid `createShaderScene`'s
  // extra fullscreen blit for a buffer that was already native — the overhead
  // the spec doc (`:157-159`) says to omit `pixelBudget` to avoid. That is
  // F196.
  //
  // ## Why revert rather than pick a new number
  //
  // Because `SCENE_COST_MS.truchet` was priced AT the old 1.6/1.0 pair, and
  // F195 explicitly did not re-price it ("every measured-ms figure in these
  // eleven headers was taken at the old budget"). The row is internally
  // consistent with 1.6/1.0 and with nothing else — its tier-2 -> tier-3 step
  // (4.2 -> 3.2, 1.31x) tracks the 1.6 -> 1.0 branch flip's pixel ratio
  // (1.600 -> 1.327 MP, 1.21x) with `uPlanes` flat at 3 across both rungs;
  // there is no other lever at that step that could explain it.
  //
  // So under 8.9 this scene rendered **5.18x** the pixels its own declared
  // cost describes (8.294 MP against the 1.600 MP the row assumes), making its
  // true tier-0 cost ~**35 ms**, not the 6.8 the table reports. Reverting to
  // 1.6/1.0 makes the declared row TRUE again rather than inventing a fresh
  // number to sit under a resolution nobody measured. 4K solves, from
  // `solveScale`:
  //
  //     F195's 8.9/5.6   1.00 / 1.00 / 1.00 / 0.82 / 0.82   (native, blit for nothing)
  //     REVERTED 1.6/1.0 0.44 / 0.44 / 0.44 / 0.40 / 0.40   (1.600 / 1.327 MP)
  //
  // At 1440p 1.6 solves to 0.66 and at 1080p to 0.88 — binding, not native, on
  // every panel from 1080p up, which is what F196 asked for. The tier-3/4
  // branch does sit on the 0.40 clamp at 4K; that is the benign direction (the
  // floor renders MORE than the budget asked for), and it is the state F195
  // found this scene in, not a new regression.
  //
  // ## STILL OVER THE TIER-0 BAR, and it cannot be fixed from here (F199)
  //
  // 6.8 ms against `sceneBudget(0)/2` = 5.05 ms. Resolution cannot close that
  // gap: `MIN_RENDER_SCALE` 0.40 floors the buffer at 0.16 * 8.294 = 1.327 MP,
  // so the cheapest this scene can EVER render on the reference display is
  // 6.8 * (1.327 / 1.600) = **5.64 ms** — still over the bar at any
  // `pixelBudget` whatsoever. Closing it needs a per-pixel cut (fewer planes,
  // or dropping the dual-ray AA) or a `/bench` showing the estimate is
  // pessimistic. Left LIVE deliberately: it was force-promoted by explicit
  // request, and the estimate is unmeasured — `slotBudget.test.ts` now reports
  // it rather than aborting before it, which is where that decision belongs.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.6 : 1.0),
  uniforms: () => ({
    uFly: { value: 0 },
    uShock: { value: 0 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBass: { value: 0 },
    uKRep: { value: 1 },
    uLw: { value: 1 },
    uFov: { value: 1 },
    uTilt: { value: 0 },
    uPlanes: { value: 6 },
  }),
  state: () => ({ fly: 0, shock: 0, midsSlew: 0 }),
  update({ u, s, P, st, dt }) {
    // Source's clock was a raw iTime (the flythrough uses TIME*0.25). Accumulate
    // so a changing rate stays continuous; mids lean on the throttle.
    //
    // Slewed rather than read raw — see the "jerky and bumpy" header note.
    // `s.mids` is a live envelope; feeding it straight into a rate every frame
    // makes the camera (and every plane's spin, which rides the same clock)
    // visibly lurch on the band's own noise instead of gliding. `slew(..., 3, 3)`
    // follows the trend within a few tenths of a second and drops the jitter.
    st.midsSlew = slew(st.midsSlew, s.mids, dt, 3, 3)
    st.fly += dt * (1 + st.midsSlew * 0.6) * drastic(P.speed)
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 3.5)

    u.uFly.value = st.fly
    u.uShock.value = st.shock
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs
    u.uBass.value = s.sub

    // Piecewise so each dial's neutral 0.5 lands on the source's authored look:
    // symmetry x1, line weight x1, fov x1, roll 0.
    u.uKRep.value = 0.6 + P.complexity * 0.8 // 0.5 -> 1.0
    u.uLw.value = 0.5 + P.density // 0.5 -> 1.0
    u.uFov.value = 0.6 + P.fill * 0.8 // 0.5 -> 1.0
    u.uTilt.value = (P.tilt - 0.5) * 2.0 // 0.5 -> 0 rad

    // Quality lever: plane count, mapped off the governor's iteration knob.
    u.uPlanes.value = Math.max(3, Math.min(6, Math.round((6 * quality.knobs.raymarchSteps) / 96)))
  },
})

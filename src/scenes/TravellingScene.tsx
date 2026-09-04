import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { impulseClock, sinceImpulse, type ImpulseClock } from '../engine/response'
import { drastic } from '../engine/sceneParams'
import { TRAVELLING_PULSE_GLSL } from '../engine/shaderLib'

/**
 * Moving Without Travelling — a hypnotic forward drift through stacked
 * kaleidoscope planes, each one a smooth-min eye (iris, lids, radial lashes)
 * with a domain-warped fbm field bleeding through the pupil. The camera rides a
 * Lissajous path so it is always moving and never arriving.
 *
 * Ported from mrange's Shadertoy shader **"Moving without travelling"**. Header
 * declares `// License CC0`. Bundled helpers are the usual permissive set — IQ's
 * `pmin`/`smin` and fbm/warp articles (MIT), mercury/hg_sdf `modMirror1`
 * ("MIT OR CC-BY-NC-4.0", MIT option applies), `tanh_approx`/`hash`/`alphaBlend`
 * trivial public snippets — so `license: 'original'`, same basis as `truchet` /
 * `maze` / `malachite`.
 *
 * ## FORCED LIVE by request — and it is ~5-7x over the budget bar
 *
 * This is the heaviest scene in the roster by a wide margin. Per pixel it steps
 * 4 planes, and EACH plane runs `weird()` which does one `warp()` plus a
 * finite-difference `normal()` = FOUR more `warp()` calls. Every `warp()` is
 * one `completeEye()` + one `smoothKaleidoscope()` + FIVE `fbm()` (4 octaves
 * each). That is ~100 fbm + ~24 eye SDFs per pixel. Op-count against `kifs`
 * (2.97 ms at tier 0, ~160 heavy ops/px) puts the true tier-0 cost around
 * **20-30 ms**, ~10-15 ms even at the bottom tier — far past
 * `slotBudget.test.ts`'s `< sceneBudget(0)/2 = 4 ms` layer-funding bar.
 *
 * The `SCENE_COST_MS` row in sceneCost.ts is therefore a FABRICATED ceiling
 * (3.9), not an estimate. Consequence: the auto-director's budget model will
 * think this is cheap and pick it when frames cannot afford it; the quality
 * governor then has to claw back hard, so expect a hitch on the transition INTO
 * this scene. `compatibleWith: []` keeps it from ever being a layer, which
 * bounds the damage to that one mis-schedule.
 *
 * ## ACTION before this is anything but a manual pick
 *
 *   1. Replace `normal()`'s 4 `warp()` taps with a 2-tap or an analytic-ish
 *      gradient — that alone is ~40% of the cost.
 *   2. Drop `furthest` 4 -> 2 planes.
 *   3. Let the quality governor pull `uOctaves` to 2 (already wired) and add a
 *      real `pixelBudget` step per tier.
 *   4. `/bench` and re-price, or move to DISABLED_SCENES.
 *
 * ## Port notes (Shadertoy -> AudioVis prelude)
 *
 *   iResolution            -> uRes
 *   iTime / TIME / TTIME   -> uClock (JS speed-scaled accumulator; keeps motion
 *                             continuous when the speed dial moves)
 *   mainImage()            -> main() / gl_FragColor, final * uFade
 *   max(furthest-3, 0)     -> hand-folded to 1 (ES 1.00 has no int max())
 *   inner `float nz`       -> renamed `dz` (it shadowed the outer nz)
 *   `const float rep`/`sm` -> now driven by uRep, so no longer `const`
 *   colour                 -> KEPT native. The hsv2rgb hue-cycle in weird() is
 *                             the piece; routing it through the 5 palette slots
 *                             throws away what makes it recognisable (same call
 *                             as KaleidoPulseScene / JuliaWingsScene).
 *
 * `postProcess` does `pow(col, 1.0/std_gamma)` — a real 1/2.2 encode. three's
 * renderer ALSO encodes linear->sRGB, so this would double-gamma. Swapped for
 * `pow(col, vec3(0.72))` (mild contrast only), same fix as MazeFlightScene.
 *
 * ## The identity this scene owns: the kick TRAVELS down the tunnel
 *
 * The scene is called Moving Without Travelling, and until now the kick was
 * the one thing in it that did neither: `col *= 1.0 + uKick*0.5`, applied to
 * the finished frame, after postProcess, at the very last line — the single
 * most literal instance of the problem the response audit
 * (engine/response.ts) names. Four stacked planes at four different depths,
 * and every one of them brightened on the same frame by the same amount, so
 * the depth the whole scene is built to sell was exactly the dimension the
 * kick threw away.
 *
 * It now sweeps front to back instead. The hit lands on the plane nearest the
 * camera and runs away down the tunnel, each plane's eye dilating and flaring
 * as the front reaches it — so the pulse recedes toward the vanishing point
 * and the stack reads as four things at four distances rather than one flat
 * picture that got brighter.
 *
 * Its counterpart is `web`, whose kick expands RADIALLY outward through a hex
 * lattice. Axial here, radial there — deliberately different axes, so the two
 * flythrough-of-stacked-planes scenes never answer the same kick with the same
 * gesture.
 *
 * `uKick` (the prelude's own envelope) consequently has no reader left in this
 * shader. That is intentional, not an oversight: an envelope that only knows
 * WHEN cannot express a reaction that depends on WHERE, and the prelude still
 * declares it for every other scene, so nothing here redeclares anything.
 *
 * ## Band routing
 *
 *   speed + energy -> uClock rate (whole flythrough)
 *   onKick         -> a wavefront travelling front-to-back through the plane
 *                     stack, NOT a frame-wide pop. `sinceImpulse()` times the
 *                     hit in JS, `uSinceKick` carries it over and
 *                     `travellingPulse()` turns plane depth into arrival time
 *                     (see `g_pulse` in color() for pos/speed/decay). Per
 *                     plane it drives:
 *                       - eye SCALE   (plane3's `s`) -- the eye dilates
 *                       - SPECULAR    (weird()'s two key lights) -- it flares
 *                       - plane luminance -- the brightness half, now local
 *                     Two of the three are not raw glow: the eye dilating is
 *                     what makes the plane read as a struck object rather than
 *                     an illuminated one.
 *   uKickAmp       -> strength of the last hit, so a soft kick makes a soft
 *                     wave (the wave outlives its onset frame, so the value
 *                     has to be latched rather than read live)
 *   mids           -> extra kaleidoscope drift (uMidDrift)
 *   highs          -> specular shimmer on the two key lights (uHigh) -- the
 *                     continuous term the kick's specular flare rides on top
 *                     of, same property at a different timescale
 *   sub            -> eye scale per plane (uBass) -- likewise the continuous
 *                     breath under the discrete dilation
 */

export const FRAG = /* glsl */ `
  uniform float uClock;    // speed-scaled time accumulator (replaces iTime)
  uniform float uSinceKick; // seconds since the last kick (engine/response.ts)
  uniform float uKickAmp;   // strength of that kick, so soft hits make soft waves
  uniform float uMidDrift; // s.mids -> extra kaleidoscope drift
  uniform float uHigh;     // s.highs -> specular shimmer
  uniform float uBass;     // s.sub  -> per-plane eye scale
  uniform float uRep;      // density -> kaleidoscope repetitions (source const 50)
  uniform float uRoll;     // tilt -> static frame roll
  uniform float uSat;      // contrast -> postProcess saturation (source const -0.4)
  uniform int   uOctaves;  // complexity x quality -> fbm octave count (2..4)

  #define PI    3.141592654
  #define TAU   (2.0*PI)
  #define TIME  uClock
  #define TTIME (TAU*uClock)
  #define RESOLUTION uRes
  #define ROT(a) mat2(cos(a), sin(a), -sin(a), cos(a))
  #define BPERIOD 5.6
  #define PCOS(x) (0.5 + 0.5*cos(x))
  #define BPM 150.0

  const vec4 hsv2rgb_K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + hsv2rgb_K.xyz)*6.0 - hsv2rgb_K.www);
    return c.z*mix(hsv2rgb_K.xxx, clamp(p - hsv2rgb_K.xxx, 0.0, 1.0), c.y);
  }

  const vec3 std_gamma = vec3(2.2);

  // Kick propagation. See the g_pulse block in color() for the full reasoning.
  const float waveSpeed = 3.0;   // spans per second -- the stack crossed in 1/3 s
  const float waveDecay = 6.0;   // trailing falloff behind the front

  // How much of THIS plane the kick wavefront has reached, 0..1-ish. Set once
  // per plane in color()'s stack loop and read all the way down in plane3()
  // and weird() -- the same global-hand-down the source already uses for g_th,
  // which is set in plane3() and read inside warp(). Threading it through the
  // plane/plane3/weird/warp signatures instead would touch four of them to
  // deliver one float.
  float g_pulse = 0.0;

  float g_th = 0.0;
  float g_hf = 0.0;
  vec2 g_vx = vec2(0.0);
  vec2 g_vy = vec2(0.0);
  vec2 g_wx = vec2(0.0);
  vec2 g_wy = vec2(0.0);

  float pmin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0 - h);
  }
  float pmax(float a, float b, float k) { return -pmin(-a, -b, k); }
  float pabs(float a, float k) { return -pmin(-a, a, k); }

  float hash(float co) { return fract(sin(co*12.9898)*13758.5453); }

  vec4 alphaBlend(vec4 back, vec4 front) {
    float w = front.w + back.w*(1.0 - front.w);
    vec3 xyz = (front.xyz*front.w + back.xyz*back.w*(1.0 - front.w))/w;
    return w > 0.0 ? vec4(xyz, w) : vec4(0.0);
  }
  vec3 alphaBlend(vec3 back, vec4 front) { return mix(back, front.xyz, front.w); }

  float tanh_approx(float x) {
    float x2 = x*x;
    return clamp(x*(27.0 + x2)/(27.0 + 9.0*x2), -1.0, 1.0);
  }

  float mod1(inout float p, float size) {
    float halfsize = size*0.5;
    float c = floor((p + halfsize)/size);
    p = mod(p + halfsize, size) - halfsize;
    return c;
  }
  vec2 toPolar(vec2 p) { return vec2(length(p), atan(p.y, p.x)); }
  vec2 toRect(vec2 p) { return vec2(p.x*cos(p.y), p.x*sin(p.y)); }
  float modMirror1(inout float p, float size) {
    float halfsize = size*0.5;
    float c = floor((p + halfsize)/size);
    p = mod(p + halfsize, size) - halfsize;
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

  float circle(vec2 p, float r) { return length(p) - r; }

  float vesica(vec2 p, vec2 sz) {
    if (sz.x < sz.y) { sz = sz.yx; } else { p = p.yx; }
    vec2 sz2 = sz*sz;
    float d = (sz2.x - sz2.y)/(2.0*sz.y);
    float r = sqrt(sz2.x + d*d);
    float b = sz.x;
    p = abs(p);
    return ((p.y - b)*d > p.x*b) ? length(p - vec2(0.0, b))
                                 : length(p - vec2(-d, 0.0)) - r;
  }

  float outerEye(vec2 p, float th) {
    float a = mix(0.0, 1.0, smoothstep(0.995, 1.0, cos(th + TTIME/BPERIOD)));
    const float w = 1.14;
    float h = mix(0.48, 0.05, a);
    return vesica(p, vec2(w, h));
  }

  const vec2 iris_center = vec2(0.0, 0.28);
  vec4 completeEye(vec2 p, float th) {
    const float iris_outer = 0.622;
    const float iris_inner = 0.285;

    float t0 = abs(0.9*p.x);
    t0 *= t0; t0 *= t0; t0 *= t0;
    t0 = clamp(t0, 0.0, 1.0);
    float dt0 = mix(0.0125, -0.0025, t0);

    vec2 p0 = p;
    float d0 = outerEye(p, th);
    float d5 = d0;

    vec2 p1 = p; p1 -= iris_center;
    float d1 = circle(p1, iris_outer);
    d1 = max(d1, d0 + dt0);
    float d6 = d1;

    vec2 p2 = p; p2 -= vec2(0.155, 0.35);
    float d2 = circle(p2, 0.065);

    vec2 p3 = p; p3 -= iris_center;
    p3 = toPolar(p3);
    float n3 = mod1(p3.x, 0.05);
    float d3 = abs(p3.x) - 0.0125*(1.0 - 1.0*length(p1));

    vec2 p4 = p; p4 -= iris_center;
    float d4 = circle(p4, iris_inner);

    d3 = max(d3, -d4);
    d1 = pmax(d1, -d2, 0.0125);
    d1 = max(d1, -d3);
    d0 = abs(d0) - dt0;

    float d = d0;
    d = pmin(d, d1, 0.0125);
    return vec4(d, d6, d5, max(d4, d6));
  }

  vec3 offset(float z) {
    float a = z;
    vec2 p = -0.1*(vec2(cos(a), sin(a*sqrt(2.0))) + vec2(cos(a*sqrt(0.75)), sin(a*sqrt(0.5))));
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

  float noise(vec2 p) {
    float a = sin(p.x);
    float b = sin(p.y);
    float c = 0.5 + 0.5*cos(p.x + p.y);
    return mix(a, b, c);
  }

  float fbm(vec2 p, float aa) {
    const mat2 frot = mat2(0.80, 0.60, -0.60, 0.80);
    float f = 0.0;
    float a = 1.0;
    float s = 0.0;
    float m = 2.0;
    for (int x = 0; x < 4; ++x) {
      if (x >= uOctaves) break;      // complexity / quality octave cap
      f += a*noise(p);
      p = frot*p*m;
      m += 0.01;
      s += a;
      a *= aa;
    }
    return f/s;
  }

  float warp(vec2 p, out vec2 v, out vec2 w) {
    float f = smoothstep(-0.1, 0.15, completeEye(p, g_th).x);
    float sm = 0.125*0.5*60.0/uRep;    // was const, now depends on uRep
    float n = smoothKaleidoscope(p, sm, uRep);
    p.y += TIME*0.125 + 1.5*g_th + uMidDrift;

    g_hf = f;

    vec2 vx = g_vx; vec2 vy = g_vy;
    vec2 wx = g_wx; vec2 wy = g_wy;

    float aa = 0.5;
    v = vec2(fbm(p + vx, aa), fbm(p + vy, aa))*f;
    w = vec2(fbm(p + 3.0*v + wx, aa), fbm(p + 3.0*v + wy, aa))*f;
    return -tanh_approx(fbm(p + 2.25*w, aa)*f);
  }

  vec3 normal(vec2 p) {
    vec2 v; vec2 w;
    vec2 e = vec2(4.0/RESOLUTION.y, 0);
    vec3 n;
    n.x = warp(p + e.xy, v, w) - warp(p - e.xy, v, w);
    n.y = 2.0*e.x;
    n.z = warp(p + e.yx, v, w) - warp(p - e.yx, v, w);
    return normalize(n);
  }

  void compute_globals() {
    vec2 vx = vec2(0.0, 0.0);
    vec2 vy = vec2(3.2, 1.3);
    vec2 wx = vec2(1.7, 9.2);
    vec2 wy = vec2(8.3, 2.8);
    vx *= ROT(TTIME/1000.0);
    vy *= ROT(TTIME/900.0);
    wx *= ROT(TTIME/800.0);
    wy *= ROT(TTIME/700.0);
    g_vx = vx; g_vy = vy; g_wx = wx; g_wy = wy;
  }

  vec3 weird(vec2 p) {
    const vec3 lp1 = 1.0*vec3(1.0, 1.25, 1.0);
    const vec3 lp2 = 1.0*vec3(-1.0, 2.5, 1.0);
    vec3 ro = vec3(0.0, 10.0, 0.0);

    vec2 v; vec2 w;
    float h = warp(p, v, w);
    float hf = g_hf;
    vec3 n = normal(p);

    vec3 lcol1 = hsv2rgb(vec3(0.7, 0.5, 1.0));
    vec3 lcol2 = hsv2rgb(vec3(0.4, 0.5, 1.0));
    vec3 po = vec3(p.x, 0.0, p.y);
    vec3 rd = normalize(po - ro);
    vec3 ld1 = normalize(lp1 - po);
    vec3 ld2 = normalize(lp2 - po);

    vec3 ref = reflect(rd, n);
    float ref1 = max(dot(ref, ld1), 0.0);
    float ref2 = max(dot(ref, ld2), 0.0);

    const vec3 col1 = vec3(0.1, 0.7, 0.8).xzy;
    const vec3 col2 = vec3(0.7, 0.3, 0.5).zyx;

    float a = length(p);
    vec3 col = vec3(0.0);
    col += hsv2rgb(vec3(fract(-0.1*TIME + 0.125*a + 0.5*v.x + 0.125*w.x),
                        abs(0.5 + tanh_approx(v.y*w.y)),
                        tanh_approx(0.1 + abs(v.y - w.y))));
    col -= 0.5*(length(v)*col1 + length(w)*col2*1.0);
    // highs shimmer the key lights continuously; the wavefront flares them as
    // it passes. Specular rather than flat gain on purpose -- it only shows
    // where the warped surface happens to face a light, so the flare picks out
    // the plane's RELIEF instead of washing the whole plane up uniformly.
    col += 0.5*lcol1*pow(ref1, 20.0)*(1.0 + uHigh*2.0 + g_pulse*2.0);
    col += 0.5*lcol2*pow(ref2, 10.0)*(1.0 + uHigh*2.0 + g_pulse*2.0);
    col *= hf;
    return col;
  }

  vec4 plane3(vec3 ro, vec3 rd, vec3 pp, vec3 off, float aa, float n) {
    float h = hash(n + 1234.4);
    float th = TAU*h;
    g_th = th;
    // sub swells the eye continuously; the kick wavefront DILATES it as the
    // front arrives, plane by plane down the stack. Same magnitude as the bass
    // term so the two read as one property with two timescales, and because p
    // is divided by s the dilation is a real change of scale -- the pattern
    // inside the eye grows with it rather than the eye just getting brighter.
    float s = mix(0.2, 0.3, h)*(1.0 + uBass*0.15 + g_pulse*0.15);

    vec2 p = (pp - off*vec3(1.0, 1.0, 0.0)).xy;
    p *= ROT(0.2*mix(-1.0, 1.0, h));
    p /= s;
    float lp = length(p);
    p -= -iris_center;
    vec4 de = completeEye(p, th)*s;
    float ax = smoothstep(-aa, aa, de.x);
    float az = smoothstep(-aa, aa, -de.z);
    float aw = smoothstep(-aa, aa, 0.0125*(de.w + 0.025));

    float df = 1.0 - tanh_approx(0.5*lp);
    vec3 icol = weird(p);
    vec3 ecol = mix(vec3(0.0), vec3(1.0), ax);
    vec3 bcol = mix(icol, ecol, az*0.5*df);
    return vec4(bcol, aw);
  }

  vec4 plane(vec3 ro, vec3 rd, vec3 pp, vec3 off, float aa, float n) {
    return plane3(ro, rd, pp, off, aa, n);
  }

  vec3 skyColor(vec3 ro, vec3 rd) {
    float ld = max(dot(rd, vec3(0.0, 0.0, 1.0)), 0.0);
    return 1.0*vec3(2.0, 1.0, 3.0)*(pow(ld, 100.0));
  }

  vec3 color(vec3 ww, vec3 uu, vec3 vv, vec3 ro, vec2 p) {
    float lp = length(p);
    vec2 np = p + 1.0/RESOLUTION.xy;
    const float per = 10.0;
    float rdd = (1.0 + 0.5*lp*tanh_approx(lp + 0.9*PCOS(per*p.x)*PCOS(per*p.y)));
    vec3 rd = normalize(p.x*uu + p.y*vv + rdd*ww);
    vec3 nrd = normalize(np.x*uu + np.y*vv + rdd*ww);

    const float planeDist = 1.0 - 0.0;
    const int furthest = 4;
    const int fadeFrom = 1;               // = max(furthest-3, 0), hand-folded (no int max in ES 1.00)
    const float fadeDist = planeDist*float(furthest - fadeFrom);
    float nz = floor(ro.z/planeDist);

    vec3 skyCol = skyColor(ro, rd);

    vec4 acol = vec4(0.0);
    const float cutOff = 0.95;
    bool cutOut = false;

    for (int i = 1; i <= furthest; ++i) {
      float pz = planeDist*nz + planeDist*float(i);
      float pd = (pz - ro.z)/rd.z;
      if (pd > 0.0 && acol.w < cutOff) {
        vec3 pp = ro + rd*pd;
        vec3 npp = ro + nrd*pd;
        float aa = 3.0*length(pp - npp);
        vec3 off = offset(pp.z);

        float dz = pz - ro.z;                   // was nz, which shadowed the outer nz

        // --- the kick, arriving plane by plane ---------------------------
        // pos is this plane's depth ahead of the camera over the depth of the
        // whole visible stack, so 0 is the plane in the viewer's face and 1 is
        // the furthest one still drawn. The front therefore starts AT the
        // camera and recedes: the pulse shrinks toward the vanishing point as
        // it goes, which is what sells it as travelling rather than as the
        // planes taking turns.
        //
        // speed 3.0 -> the front crosses all four planes in 1/3 s. The scene's
        // own BPM define is 150, one beat = 0.4 s, so the far plane lights just
        // inside the beat that triggered it and the tunnel is clear again
        // before the next kick. At 120 BPM (0.5 s) there is more room still.
        //
        // decay 6.0 is set by the sampling, not by taste: the stack is only
        // FOUR planes, so the lit band has to span at least two of them or the
        // wave lands on one plane at a time and reads as a strobe rather than
        // as motion. Band width is speed/decay = 0.5 of the span = exactly two
        // planes. Anything much tighter aliases against the plane spacing.
        //
        // Set before plane() so plane3()/weird() can read it; multiplied by
        // uKickAmp so a soft hit makes a soft wave, and zero on every frame
        // before the first kick (travellingPulse returns exp(-1e4*decay)).
        g_pulse = travellingPulse(uSinceKick, dz/(planeDist*float(furthest)),
                                  waveSpeed, waveDecay) * uKickAmp;

        vec4 pcol = plane(ro, rd, pp, off, aa, nz + float(i));

        float fadeIn = exp(-2.5*max((dz - planeDist*float(fadeFrom))/fadeDist, 0.0));
        float fadeOut = smoothstep(0.0, planeDist*0.1, dz);
        pcol.xyz = mix(skyCol, pcol.xyz, fadeIn);
        // The brightness third of the reaction, and note WHERE it is: per
        // plane, inside the stack loop, before the alpha blend -- so the near
        // planes are already fading while the far ones are still lifting.
        // The old frame-wide multiply lived in main() after postProcess, which
        // is precisely why it could not do this. Slightly above the source's
        // 0.5 to make up for postProcess's pow(col, 0.72) now running AFTER
        // the gain instead of before it.
        pcol.xyz *= 1.0 + g_pulse*0.6;
        pcol.w *= fadeOut;
        pcol = clamp(pcol, 0.0, 1.0);
        acol = alphaBlend(pcol, acol);
      } else {
        cutOut = true;
        break;
      }
    }

    return alphaBlend(skyCol, acol);
  }

  vec3 postProcess(vec3 col, vec2 q) {
    col = clamp(col, 0.0, 1.0);
    col = pow(col, vec3(0.72));            // mild contrast only — NOT a 1/2.2 encode
    col = col*0.6 + 0.4*col*col*(3.0 - 2.0*col);
    col = mix(col, vec3(dot(col, vec3(0.33))), uSat);
    col *= 0.5 + 0.5*pow(19.0*q.x*q.y*(1.0 - q.x)*(1.0 - q.y), 0.7);
    return col;
  }

  vec3 effect(vec2 p, vec2 q) {
    compute_globals();
    float tm = TIME*0.5*BPM/60.0;
    vec3 ro = offset(tm);
    vec3 dro = doffset(tm);
    vec3 ddro = ddoffset(tm);
    vec3 ww = normalize(dro);
    vec3 uu = normalize(cross(normalize(vec3(0.0, 1.0, 0.0) + ddro), ww));
    vec3 vv = normalize(cross(ww, uu));
    return color(ww, uu, vv, ro, p);
  }

  void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 q = fragCoord/RESOLUTION.xy;
    vec2 p = -1.0 + 2.0*q;
    p.x *= RESOLUTION.x/RESOLUTION.y;
    p *= ROT(uRoll);                       // tilt -> static frame roll

    vec3 col = effect(p, q);
    col += smoothstep(3.0, 0.0, TIME);
    col = postProcess(col, q);
    // The kick deliberately does NOT appear here any more. A multiply on the
    // finished frame reaches every plane on the same frame by construction,
    // which is the one thing a travelling pulse must not do; it now lives per
    // plane inside color()'s stack loop instead.

    gl_FragColor = vec4(col*uFade, 1.0);
  }
`

interface TravellingState {
  /** Time accumulator, so a changing speed/energy rate stays continuous. */
  clock: number
  /**
   * When the last kick landed. A shader cannot remember this on its own, so
   * the JS half holds the clock and the GPU half turns it into a wavefront —
   * which is the whole reason the old reaction could not have been written in
   * the shader alone.
   */
  kick: ImpulseClock
  /** How hard that kick was, held until the next one. */
  hitAmp: number
}

export const TravellingScene = createShaderScene<TravellingState>({
  id: 'travelling',
  frag: FRAG,
  // travellingPulse(): one exp and one divide per plane per pixel (4 planes),
  // against the ~100 fbm evaluations per pixel documented above. Not
  // measurable here — SCENE_COST_MS is unchanged and deliberately so.
  include: TRAVELLING_PULSE_GLSL,
  // Paints its own sky — replace, not blend, for the offscreen buffer.
  blending: THREE.NoBlending,
  // AGGRESSIVE — this is the dearest shader in the roster (see the header).
  // Even so it will not clear the tier-0 budget bar; the low internal res is
  // damage control, not a fix. Replace with a real /bench sweep + an
  // optimisation pass before this is anything but a manual pick.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 72 ? 1.0 : 0.6),
  uniforms: () => ({
    uClock: { value: 0 },
    // 1e4 = sinceImpulse()'s "never fired" sentinel, so the first frame shows
    // an already-spent wave rather than one mid-flight down the tunnel.
    uSinceKick: { value: 1e4 },
    uKickAmp: { value: 0 },
    uMidDrift: { value: 0 },
    uHigh: { value: 0 },
    uBass: { value: 0 },
    uRep: { value: 50 },
    uRoll: { value: 0 },
    uSat: { value: -0.4 },
    uOctaves: { value: 4 },
  }),
  state: () => ({ clock: 0, kick: impulseClock(), hitAmp: 0 }),
  update({ u, s, P, st, dt, ctx }) {
    // Source drove everything off iTime. Accumulate so a changing rate stays
    // continuous; energy leans on the throttle (cf. NeonJungleScene).
    st.clock += dt * (1 + s.energy * 0.4) * drastic(P.speed)
    u.uClock.value = st.clock

    // Latch the hit's strength when it fires: the wave it launches outlives
    // the onset frame by most of a beat, so the amplitude has to be held
    // rather than read live. Floored at 0.5 because the far plane sees this
    // hit a third of a second late, with the trailing decay already taken out
    // of it — an unfloored weak onset would reach the back of the tunnel as
    // nothing at all, and a propagation nobody can see is worse than none.
    if (s.onKick > 0) st.hitAmp = Math.min(1.5, Math.max(0.5, s.onKick))
    // ctx.f.time, NOT st.clock: the wave must be timed in engine seconds. The
    // scene clock is speed- and energy-scaled, so timing the wave on it would
    // make the speed dial silently retune how long a kick takes to cross the
    // tunnel, and the pulse would drift out of tempo whenever energy moved.
    u.uSinceKick.value = sinceImpulse(st.kick, ctx.f.time, s.onKick > 0)
    u.uKickAmp.value = st.hitAmp

    // Bands — each neutral value reproduces a source constant.
    u.uMidDrift.value = s.mids * 0.5
    u.uHigh.value = s.highs
    u.uBass.value = s.sub

    // Contract dials — neutral (0.5) reproduces the authored look.
    u.uRep.value = 20 + P.density * 60 // 0.5 -> 50 (source const)
    u.uRoll.value = (P.tilt - 0.5) * 3.0 // 0.5 -> 0
    u.uSat.value = -0.1 - P.contrast * 0.6 // 0.5 -> -0.4 (source const)

    // complexity picks the fbm octave count; the quality governor can only pull
    // it DOWN from there (min(dial, knob)), same shape as MalachiteScene.
    const dial = Math.max(2, Math.min(4, Math.round(2 + P.complexity * 3)))
    u.uOctaves.value = Math.max(2, Math.min(dial, quality.knobs.noiseOctaves))
  },
})

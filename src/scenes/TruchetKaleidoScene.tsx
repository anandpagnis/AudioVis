import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'

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
 *     unmeasured, and it may not clear `slotBudget.test.ts`'s tier-0
 *     `< sceneBudget(0)/2 ≈ 4ms` bar. `uPlanes` (below) is wired to the
 *     quality governor so a bench can be run at each tier.
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
 *
 * ## Band routing
 *
 *   onKick  -> uShock: line bloom + brightness (decaying)
 *   sub     -> Truchet cell arc radius (continuous swell)
 *   mids    -> flythrough rate
 *   energy  -> overall luminance / sky glow
 *   highs   -> highlight shimmer
 */

export const FRAG = /* glsl */ `
  uniform float uFly;      // speed-scaled loop clock (replaces iTime)
  uniform float uShock;    // decaying kick envelope
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBass;     // s.sub -> Truchet cell arc radius (continuous)
  uniform float uKRep;     // complexity dial -> kaleidoscope symmetry multiplier
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
    float rep = 2.0*floor(mix(5.0, 30.0, h2)*uKRep + 0.5);
    float sm = 0.05*20.0/rep;
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
}

export const TruchetKaleidoScene = createShaderScene<TruchetState>({
  id: 'truchet',
  frag: FRAG,
  // Paints every pixel including its own sky.
  blending: THREE.NoBlending,
  // Starting point only — replace with a real /bench sweep before promotion.
  // The dual-ray AA is resolution-aware, so a soft upscale degrades gracefully.
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
  state: () => ({ fly: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Source's clock was a raw iTime (the flythrough uses TIME*0.25). Accumulate
    // so a changing rate stays continuous; mids lean on the throttle.
    st.fly += dt * (1 + s.mids * 0.6) * drastic(P.speed)
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

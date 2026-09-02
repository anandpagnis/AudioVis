import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'

/**
 * Oversaturated Web — a flythrough of stacked hex-tiled planes, each node wired
 * to its neighbours with glowing curved strands. Bloom-heavy, saturated.
 *
 * Shadertoy shader "Oversaturated web", header declares **CC0**. A derivative
 * of BigWing's https://www.shadertoy.com/view/lscczl (also on Shadertoy).
 * Reads as mrange's. CC0 -> `license: 'original'`, same basis as `truchet` /
 * `maze` / `malachite`. Credit + source links kept above.
 *
 * ## LIVE on an ESTIMATE — read the cost note
 *
 * The source draws 6 planes x 6 hex-neighbour strands = 36 cubic-bezier
 * distance solves per pixel (each with `acos` + `pow(,1/3)` + `cos`/`sin`),
 * plus 6 `hextile` and ~36 hashes. That is heavier than `truchet` and well
 * over the tier-0 layer-funding bar at native res. This port keeps the curves
 * but makes it fundable:
 *
 *   - strand count per node is the `density` dial (2..6, default 4), NOT 6
 *   - plane count is the `complexity` dial (3..6, default 5), NOT tier-gated
 *     (fractal/stack depth changing under load reads as glitching — kifs F129 /
 *     maze F139); the governor's lever here is `pixelBudget`
 *   - `pixelBudget` renders offscreen at 0.8 MP (tiers 0-1) / 0.5 MP below —
 *     the output is inverse-distance GLOW, which upscales invisibly (cf. maze)
 *   - `hash()` swapped for a sine-free version (it was called ~36x/pixel)
 *
 * The `SCENE_COST_MS` row is a documented estimate, not a /bench measurement.
 * Run `/bench`; if tier 0 lands at or above `sceneBudget(0)/2` (~4 ms), drop
 * `density`'s default, cut `complexity`, or move this to DISABLED_SCENES.
 * Flip `#define USE_BEZIER 0` for straight strands if you need more headroom.
 *
 * ## GLSL ES 1.00 fixes
 *
 *   `const vec2 off6[6] = vec2[6](...)` -> `off6f(int)` / `noff6f(int)` fns
 *                          (ES 1.00 has no array constructors / init'd const arrays)
 *   `round()`           -> `floor(x + 0.5)`
 *   `for (float i...)`  -> int loop + `float(i)`
 *   `0.6f` literals     -> `0.6` (no `f` suffix in ES 1.00)
 *   `pi = acos(-1.)`    -> hardcoded constant
 *   `vec4(0,1,2,3)`     -> `vec4(0.0, 1.0, 2.0, 3.0)`
 *
 * Source ended `col = aces_approx(col); col = sqrt(col);` — the `sqrt` is a
 * gamma lift that three's renderer would double (it sRGB-encodes itself).
 * Removed; aces output goes straight out (cf. MazeFlightScene).
 *
 * ## Band routing
 *
 *   onKick  -> uShock: strand + node glow surge, brightness punch (decaying)
 *   sub     -> strand/node glow RADIUS: bias into the bezier/segment and node
 *              distance fields (`plane()`'s `dd`/`cd`) so the web reads as
 *              physically swelling thicker on bass, not just brighter --
 *              distinct from uShock's additive brightness punch above
 *   mids    -> flythrough rate
 *   energy  -> overall luminance / glow gain
 *   highs   -> hex-cell edge glow
 */

export const FRAG = /* glsl */ `
  uniform float uFly;
  uniform float uShock;
  uniform float uEnergy;
  uniform float uHighs;
  uniform float uBass;      // s.sub -> strand/node glow radius (continuous)
  uniform float uFov;       // fill dial
  uniform float uRoll;      // tilt dial -> static roll, radians
  uniform float uExposure;  // contrast dial -> pre-aces exposure
  uniform int   uPlanes;    // complexity dial -> 3..6
  uniform int   uStrands;   // density dial -> 2..6

  #define USE_BEZIER 1      // 1 = curved strands (default), 0 = straight

  #define TIME        uFly
  #define RESOLUTION  uRes

  #define ROT(a)  mat2(cos(a), sin(a), -sin(a), cos(a))

  const float
    pi        = 3.14159265358979
  , tau       = 2.*pi
  , planeDist = .5
  , FURTHEST  = 6.
  , fadeFrom  = 4.
  , cutOff    = .975
  ;
  const vec3 L = vec3(0.299, 0.587, 0.114);

  const vec2 pathA = vec2(.31, .41);
  const vec2 pathB = vec2(1.41421356, 1.0);

  const vec4 U = vec4(0.0, 1.0, 2.0, 3.0);

  // ES 1.00: no array constructors — the source's off6[6] / noff6[6] as fns
  vec2 off6f(int i) {
    float a = float(i)*tau/6.0;
    return vec2(cos(a), sin(a));
  }
  vec2 noff6f(int i) {
    if (i == 0) return vec2(-1.0,  0.0);
    if (i == 1) return vec2(-0.5,  0.5);
    if (i == 2) return vec2( 0.5,  0.5);
    if (i == 3) return vec2( 1.0,  0.0);
    if (i == 4) return vec2( 0.5, -0.5);
    return                 vec2(-0.5, -0.5);
  }

  vec3 offset(float z)   { return vec3(pathB*sin(pathA*z), z); }
  vec3 doffset(float z)  { return vec3(pathA*pathB*cos(pathA*z), 1.0); }
  vec3 ddoffset(float z) { return vec3(-pathA*pathA*pathB*sin(pathA*z), 0.0); }

  float tanh_approx(float x) {
    float x2 = x*x;
    return clamp(x*(27. + x2)/(27.+9.*x2), -1., 1.);
  }

  // sine-free hash (was fract(sin(dot(...))*13758) — called ~36x/pixel)
  float hash(vec2 co) {
    vec3 p3 = fract(vec3(co.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // License: Unknown, author: Martijn Steinrucken — hex tiling
  vec2 hextile(inout vec2 p) {
    const vec2 sz  = vec2(1.0, 1.73205081);
    const vec2 hsz = 0.5*sz;
    vec2 p1 = mod(p, sz)-hsz;
    vec2 p2 = mod(p - hsz, sz)-hsz;
    vec2 p3 = dot(p1, p1) < dot(p2, p2) ? p1 : p2;
    vec2 n = ((p3 - p + hsz)/sz);
    p = p3;
    n -= vec2(0.5);
    return floor(n*2.0 + 0.5)*0.5;   // was round(n*2.0)*0.5
  }

  // License: MIT, author: Inigo Quilez — hexagon SDF
  float hexagon(vec2 p, float r) {
    p = p.yx;
    const vec3 k = 0.5*vec3(-1.73205081, 1.0, 1.15470054);
    p = abs(p);
    p -= 2.0*min(dot(k.xy,p),0.0)*k.xy;
    p -= vec2(clamp(p.x, -k.z*r, k.z*r), r);
    return length(p)*sign(p.y);
  }

  float dot2(vec2 p) { return dot(p, p); }

  // License: MIT, author: Inigo Quilez — segment
  float segment(vec2 p, vec2 a, vec2 b ) {
    vec2 pa = p-a, ba = b-a;
    float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
    return length( pa - ba*h );
  }

  // License: MIT, author: Inigo Quilez — quadratic bezier
  float bezier(vec2 pos, vec2 A, vec2 B, vec2 C) {
    vec2 a = B - A;
    vec2 b = A - 2.0*B + C;
    vec2 c = a * 2.0;
    vec2 d = A - pos;
    float kk = 1.0/dot(b,b);
    float kx = kk * dot(a,b);
    float ky = kk * (2.0*dot(a,a)+dot(d,b)) / 3.0;
    float kz = kk * dot(d,a);
    float res = 0.0;
    float p = ky - kx*kx;
    float p3 = p*p*p;
    float q = kx*(2.0*kx*kx-3.0*ky) + kz;
    float h = q*q + 4.0*p3;
    if( h >= 0.0) {
      h = sqrt(h);
      vec2 x = (vec2(h,-h)-q)/2.0;
      vec2 uv = sign(x)*pow(abs(x), vec2(1.0/3.0));
      float t = clamp( uv.x+uv.y-kx, 0.0, 1.0 );
      res = dot2(d + (c + b*t)*t);
    } else {
      float z = sqrt(-p);
      float v = acos( q/(p*z*2.0) ) / 3.0;
      float m = cos(v);
      float n = sin(v)*1.732050808;
      vec3  t = clamp(vec3(m+m,-n-m,n-m)*z-kx,0.0,1.0);
      res = min( dot2(d+(c+b*t.x)*t.x), dot2(d+(c+b*t.y)*t.y) );
    }
    return sqrt( res );
  }

  vec2 coff(float h) {
    float h0 = h;
    float h1 = fract(h0*9677.0);
    float t = 0.75*mix(0.5, 1.0, h0*h0)*(TIME+1234.5);
    return mix(0.1, 0.2, h1*h1)*sin(t*vec2(1.0, 0.70710678));
  }

  // License: Unknown, author: Matt Taylor — aces approx
  vec3 aces_approx(vec3 v) {
    v = max(v, 0.0);
    v *= 0.6;
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((v*(a*v+b))/(v*(c*v+d)+e), 0.0, 1.0);
  }

  vec3 alphaBlend(vec3 back, vec4 front) {
    return mix(back, front.xyz, front.w);
  }
  vec4 alphaBlend(vec4 back, vec4 front) {
    float w = front.w + back.w*(1.-front.w);
    vec3 xyz = (front.xyz*front.w + back.xyz*back.w*(1.-front.w))/w;
    return w > 0. ? vec4(xyz, w) : vec4(0.);
  }

  vec4 plane(vec3 ro, vec3 rd, vec3 pp, vec3 off, float aa, float n) {
    vec2 p = (pp-off*U.yyx).xy;
    vec2 p2 = p;
    p2 *= ROT(tau*0.1*n+0.05*TIME);
    p2 += 0.125*(ro.z-pp.z)*vec2(1.0)*ROT(tau*hash(vec2(n)));
    vec2 hp = p2;
    hp += 0.5;
    const float z = 1.0/3.0;
    hp /= z;
    vec2 hn = hextile(hp);

    float h0 = hash(hn+n);
    vec2 p0 = coff(h0);

    vec3 bcol = 0.5*(1.0+cos(vec3(0.0, 1.0, 2.0) + 2.0*(p2.x*p2.y+p2.x) - 0.33*n));
    vec3 col = vec3(0.0);

    for (int i = 0; i < 6; ++i) {
      if (i >= uStrands) break;
      float h1 = hash(hn+noff6f(i)+n);
      vec2 p1 = off6f(i)+coff(h1);

      float h2 = h0+h1;
      float fade = smoothstep(1.05, 0.85, distance(p0, p1));
      if (fade < 0.0125) continue;

  #if USE_BEZIER
      vec2 pb = 0.5*(p1+p0)+coff(h2);
      float dd = bezier(hp, p0, pb, p1);
  #else
      float dd = segment(hp, p0, p1);
  #endif
      // sub-bass biases INTO the distance field itself (not just the glow
      // multiplier below) -- the strand's effective radius grows with the
      // bass, so the web reads as physically swelling rather than merely
      // brightening. Kept well under the node-spacing scale so strands don't
      // fuse into their neighbours at full bass.
      dd = max(dd - uBass*0.012, 0.0);
      float gd = abs(dd);
      gd *= sqrt(gd);
      gd = max(gd, 0.0005);
      col += fade*0.002*bcol/(gd) * (1.0 + uShock*1.5 + uEnergy*0.4);
    }

    {
      float cd = max(length(hp-p0) - uBass*0.02, 0.0);   // node swells with bass too
      float gd = max(abs(cd)*abs(cd), 0.0005);
      col += 0.0025*sqrt(bcol)/(gd) * (1.0 + uShock*2.0);
    }

    {
      float hd = hexagon(hp, 0.485);
      float gd = max(abs(hd), 0.005);
      col += 0.0005*bcol*bcol/(gd) * (1.0 + uHighs*1.0);
    }

    float l = dot(col, L);
    return vec4(col, tanh_approx(sqrt(l)+dot(p, p)));
  }

  vec3 color(vec3 ww, vec3 uu, vec3 vv, vec3 ro, vec2 p) {
    vec2 np = p + 1./RESOLUTION.xy;
    float rdd = 2.0*uFov;

    vec3 rd  = normalize(p.x*uu + p.y*vv + rdd*ww);
    vec3 nrd = normalize(np.x*uu + np.y*vv + rdd*ww);

    float nz = floor(ro.z / planeDist);
    vec4 acol = vec4(0);
    vec3 skyCol = vec3(0.0);

    for (int i = 1; i <= 6; ++i) {
      if (i > uPlanes) break;
      float fi = float(i);
      float pz = planeDist*nz + planeDist*fi;
      float pd = (pz - ro.z)/rd.z;

      if (pd > 0. && acol.w < cutOff) {
        vec3 pp = ro + rd*pd;
        vec3 npp = ro + nrd*pd;
        float aa = 3.*length(pp - npp);
        vec3 off = offset(pp.z);
        vec4 pcol = plane(ro, rd, pp, off, aa, nz+fi);

        float dz = pp.z-ro.z;
        float fadeIn = smoothstep(planeDist*FURTHEST, planeDist*fadeFrom, dz);
        float fadeOut = smoothstep(0., planeDist*.1, dz);
        pcol.w *= fadeOut*fadeIn;

        acol = alphaBlend(pcol, acol);
      } else {
        acol.w = acol.w > cutOff ? 1. : acol.w;
        break;
      }
    }

    return alphaBlend(skyCol, acol);
  }

  void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 r = RESOLUTION.xy, q = fragCoord/r.xy, pp = -1.0+2.0*q, p = pp;
    p.x *= r.x/r.y;
    p *= ROT(uRoll);

    float tdist = length(pp);
    float tm  = 0.2*planeDist*TIME+0.1*tdist;

    vec3 ro   = offset(tm);
    vec3 dro  = doffset(tm);
    vec3 ddro = ddoffset(tm);

    vec3 ww = normalize(dro);
    vec3 uu = normalize(cross(U.xyx+ddro, ww));
    vec3 vv = cross(ww, uu);
    vec3 col = color(ww, uu, vv, ro, p);
    col -= 0.02*U.zwx*(length(pp)+0.125);
    col *= smoothstep(1.5, 1.0, length(pp));
    col *= uExposure * (1.0 + uEnergy*0.2 + uShock*0.35);
    col = aces_approx(col);
    // Source had a sqrt(col) here — a gamma lift three's renderer would double.

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface WebState {
  /** Flythrough clock, accumulated so a changing rate stays continuous. */
  fly: number
  /** Kick glow surge, decaying. */
  shock: number
}

export const OversaturatedWebScene = createShaderScene<WebState>({
  id: 'web',
  frag: FRAG,
  blending: THREE.NoBlending,
  // Aggressive — inverse-distance glow upscales invisibly. Tier-sensitive
  // like MazeFlightScene. Estimate; replace with a /bench sweep.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 0.8 : 0.5),
  uniforms: () => ({
    uFly: { value: 0 },
    uShock: { value: 0 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBass: { value: 0 },
    uFov: { value: 1 },
    uRoll: { value: 0 },
    uExposure: { value: 1 },
    uPlanes: { value: 5 },
    uStrands: { value: 4 },
  }),
  state: () => ({ fly: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Source clock was a raw iTime driving the flythrough + per-strand wobble.
    // Accumulate so a changing rate stays continuous; mids lean on the throttle.
    st.fly += dt * (1 + s.mids * 0.5) * drastic(P.speed)
    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 4.0)

    u.uFly.value = st.fly
    u.uShock.value = st.shock
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs
    u.uBass.value = s.sub

    // Piecewise so slider centre is near the authored look (which is 6 planes,
    // 6 strands, fov 1, roll 0). `complexity`/`density` default a touch under
    // the max — a perf call, cranking to 1.0 restores the full web. Neither is
    // tier-gated (kifs F129 / maze F139); pixelBudget is the governor's lever.
    u.uFov.value = 0.6 + P.fill * 0.8 // 0.5 -> 1.0
    u.uRoll.value = (P.tilt - 0.5) * 2.0 // 0.5 -> 0 rad
    u.uExposure.value = 0.7 + P.contrast * 0.6 // 0.5 -> 1.0
    u.uPlanes.value = 3 + Math.round(P.complexity * 3) // 3..6, neutral 5
    u.uStrands.value = 2 + Math.round(P.density * 4) // 2..6, neutral 4
  },
})

import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { impulseClock, sinceImpulse, type ImpulseClock } from '../engine/response'
import { drastic } from '../engine/sceneParams'
import { TRAVELLING_PULSE_GLSL } from '../engine/shaderLib'

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
 * ## The identity this scene owns: a hit PROPAGATES through the network
 *
 * The response audit (engine/response.ts) found every one of 22 scenes moving
 * as a rigid body on a kick — the whole frame brightens, or the whole object
 * scales, all at once. This scene is now the one that answers a kick by
 * *transmitting* it: the hit enters at the tunnel axis and races outward
 * through the hex lattice, so a node does not know the kick happened until the
 * wavefront reaches it. Which is exactly what a network should look like when
 * something is injected into it, and is the whole reason this scene is a WEB
 * rather than a field of unrelated glowing dots.
 *
 * It replaces the old `uShock` — a JS `exp(-dt*4)` envelope, the same decay ten
 * other scenes independently wrote — which lit every strand, every node and the
 * global exposure on the same frame. That envelope carried no information about
 * WHERE anything was, so the 36 bezier strands this scene pays dearly for were
 * spatially indistinguishable during the one moment the viewer was looking
 * hardest. The propagation makes the topology legible: you can see the lattice
 * conduct.
 *
 * Its counterpart is `travelling`, which sweeps its pulse along DEPTH (front to
 * back down the tunnel). Radial-outward here, axial there — deliberately
 * different axes so two flythrough-of-stacked-planes scenes do not read as one
 * idea on the same kick.
 *
 * ## Band routing
 *
 *   onKick  -> a travelling wavefront, NOT a global flash. `sinceImpulse()`
 *              (engine/response.ts) times the hit on the JS side; `uSinceKick`
 *              carries it to the GPU and `travellingPulse()` turns it into a
 *              ring expanding outward through the lattice. See `pulse` in
 *              `plane()` for the pos/speed/decay reasoning. It drives:
 *                - node RADIUS  (`cd` bias)     -- nodes swell as the front hits
 *                - strand RADIUS (`dd` bias)    -- strands fatten in sequence
 *                - node + strand glow           -- the brightness half
 *              Note two of those three are geometry, not glow: a node that
 *              grows reads as receiving something, where a node that merely
 *              brightens reads as being lit from outside.
 *   uKickAmp -> how hard the last hit was, so a soft kick makes a soft wave.
 *              Floored (see `update`) because a pulse nobody can see is worse
 *              than no pulse.
 *   sub     -> strand/node glow RADIUS: a CONTINUOUS bias into the same
 *              bezier/segment and node distance fields the pulse biases, so the
 *              web breathes with the bass under the discrete kick waves --
 *              same property, different timescale, which is what lets the two
 *              coexist without either being lost
 *   mids    -> flythrough rate
 *   energy  -> overall luminance / glow gain
 *   highs   -> hex-cell edge glow
 */

export const FRAG = /* glsl */ `
  uniform float uFly;
  uniform float uSinceKick;  // seconds since the last kick (engine/response.ts)
  uniform float uKickAmp;    // strength of that kick, so soft hits make soft waves
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
  // Kick propagation. See the pulse block in plane() for the full reasoning.
  , waveSpan  = 6.      // hex cells from the axis at which pos reaches 1.0
  , waveSpeed = 3.      // spans per second -- one span in 1/3 s
  , waveDecay = 8.      // trailing falloff behind the front
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

    // --- the kick, arriving late ----------------------------------------
    // pos is this NODE's radius in the plane's hex lattice, normalised over
    // waveSpan cells. Two properties earn it over a per-pixel radius:
    //
    //  - hn is constant across a whole hex cell, so a node and the strands
    //    leaving it fire as ONE event instead of the front sliding across
    //    each node's face. Quantising to the lattice is what makes this read
    //    as a network conducting rather than as a gradient sweeping over a
    //    picture of a network.
    //  - hn is a world-space radius shared by every plane, so the front is a
    //    single cylinder expanding along the tunnel axis rather than an
    //    unrelated ripple per plane. On screen the near planes' rings run off
    //    the edge first and the far ones trail behind them, which is what
    //    gives the wave depth as well as spread.
    //
    // pos is deliberately NOT clamped to 1: the outermost cells (radius ~8 at
    // the far planes) simply arrive proportionally later. Clamping would fire
    // every one of them on the same frame and put a hard flashing rim around
    // the picture.
    //
    // speed 3.0 -> the span is crossed in 1/3 s, inside one beat at any tempo
    // above 90 BPM, so the wave reads as belonging to THIS hit and is spent
    // before the next. decay 8.0 puts the lit band at speed/decay = 0.375 of
    // the span (~2 hex rings): narrow enough to read as a ring, wide enough
    // that it never falls between rings and strobes. Together they run about
    // 0.7 s from axis to rim-and-gone, close to the old uShock envelope's
    // total lifetime -- the event is the same LENGTH, it is just no longer
    // happening everywhere at once.
    float pulse = travellingPulse(uSinceKick, length(hn)/waveSpan, waveSpeed, waveDecay) * uKickAmp;

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
      // Both audio terms bias INTO the distance field itself (not just the
      // glow multiplier below) -- the strand's effective radius grows, so the
      // web reads as physically swelling rather than merely brightening.
      // uBass is the continuous breath; pulse is the discrete wave, so a
      // strand FATTENS as the front passes through it and relaxes behind.
      // Both kept well under the node-spacing scale (1.0 in hp units) so
      // strands never fuse into their neighbours, even on a loud hit over
      // full bass.
      dd = max(dd - uBass*0.012 - pulse*0.008, 0.0);
      float gd = abs(dd);
      gd *= sqrt(gd);
      gd = max(gd, 0.0005);
      col += fade*0.002*bcol/(gd) * (1.0 + pulse*1.5 + uEnergy*0.4);
    }

    {
      // The node swells with the bass continuously AND punches out as the
      // wavefront arrives -- radius first, glow second. A node that grows
      // reads as having RECEIVED something; a node that only brightens reads
      // as having been lit from somewhere else.
      float cd = max(length(hp-p0) - uBass*0.02 - pulse*0.015, 0.0);
      float gd = max(abs(cd)*abs(cd), 0.0005);
      col += 0.0025*sqrt(bcol)/(gd) * (1.0 + pulse*2.0);
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
    // The kick deliberately does NOT appear here. A global exposure term is
    // the rigid-body reaction this scene exists to stop doing: it would lift
    // the un-reached half of the lattice at the same instant as the reached
    // half and flatten the wavefront back into a flash. energy keeps its
    // whole-frame gain because it IS a whole-frame quantity.
    col *= uExposure * (1.0 + uEnergy*0.2);
    col = aces_approx(col);
    // Source had a sqrt(col) here — a gamma lift three's renderer would double.

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface WebState {
  /** Flythrough clock, accumulated so a changing rate stays continuous. */
  fly: number
  /**
   * When the last kick landed. The shader cannot remember this on its own, so
   * the JS half holds the clock and the GPU half turns it into a wavefront.
   * Replaces the old decaying `shock` scalar outright — that value was the
   * same everywhere at once, which is precisely what a propagation is not.
   */
  kick: ImpulseClock
  /** How hard that kick was, held until the next one. */
  hitAmp: number
}

export const OversaturatedWebScene = createShaderScene<WebState>({
  id: 'web',
  frag: FRAG,
  // travellingPulse(): one exp and one divide per plane per pixel (<= 6), set
  // against 36 cubic-bezier solves. Immeasurable next to what this scene
  // already spends — SCENE_COST_MS is unchanged and deliberately so.
  include: TRAVELLING_PULSE_GLSL,
  blending: THREE.NoBlending,
  // Aggressive — inverse-distance glow upscales invisibly. Tier-sensitive
  // like MazeFlightScene. Estimate; replace with a /bench sweep.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 0.8 : 0.5),
  uniforms: () => ({
    uFly: { value: 0 },
    // 1e4 = sinceImpulse()'s "never fired" sentinel, so the very first frame
    // has an already-spent wave rather than one mid-flight.
    uSinceKick: { value: 1e4 },
    uKickAmp: { value: 0 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBass: { value: 0 },
    uFov: { value: 1 },
    uRoll: { value: 0 },
    uExposure: { value: 1 },
    uPlanes: { value: 5 },
    uStrands: { value: 4 },
  }),
  state: () => ({ fly: 0, kick: impulseClock(), hitAmp: 0 }),
  update({ u, s, P, st, dt, ctx }) {
    // Source clock was a raw iTime driving the flythrough + per-strand wobble.
    // Accumulate so a changing rate stays continuous; mids lean on the throttle.
    st.fly += dt * (1 + s.mids * 0.5) * drastic(P.speed)

    // Latch the hit's strength at the moment it fires — the wave it launches
    // outlives the onset frame by most of a second, so the amplitude has to be
    // held rather than read live. Floored at 0.5 because the far half of the
    // lattice sees this hit a third of a second late, by which point the
    // trailing decay has already taken a bite out of it: an unfloored weak
    // onset would propagate to nodes that never visibly move, and a
    // propagation nobody can see is worse than none. Ceiling 1.5 matches the
    // clamp the old `shock` accumulator used, so a run of loud kicks tops out
    // where it always did.
    if (s.onKick > 0) st.hitAmp = Math.min(1.5, Math.max(0.5, s.onKick))
    // ctx.f.time, not the scene-local clock: the wave has to be timed on the
    // engine's seconds, which is what the onset itself was stamped with.
    u.uSinceKick.value = sinceImpulse(st.kick, ctx.f.time, s.onKick > 0)
    u.uKickAmp.value = st.hitAmp

    u.uFly.value = st.fly
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

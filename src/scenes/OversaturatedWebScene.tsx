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
 *   - `pixelBudget` renders offscreen at 4.4 MP (tiers 0-2) / 2.8 MP below —
 *     the output is inverse-distance GLOW, which upscales invisibly (cf. maze).
 *     Re-anchored from 0.8 / 0.5, which were pre-F107 values that pinned the
 *     scene to the offscreen solver's 0.4 clamp above ~1440p; see the
 *     declaration for the arithmetic. Note the step is at tiers 0-2, not 0-1:
 *     the cutoff is `raymarchSteps >= 50` and tier 2 runs 54 steps
 *   - `hash()` swapped for a sine-free version (it was called ~36x/pixel)
 *
 * The `SCENE_COST_MS` row is a documented estimate, not a /bench measurement.
 * Run `/bench`; if tier 0 lands at or above `sceneBudget(0)/2` (5.05 ms), drop
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
 *
 *   The three routings below all read prelude uniforms (SHADER_SCENE_PRELUDE)
 *   that the engine populates every frame for free -- `uSnare`/`uHihat`/
 *   `uBeatSin4` were sitting unused, and every visual dimension they now touch
 *   (hue, lattice rotation, camera roll) was previously static or driven only
 *   by a scene param, never by audio:
 *
 *   uSnare  -> hue-shift POP in `bcol`'s cosine phase. Kick and bass already
 *              own geometry (radius); the color half is what "oversaturated"
 *              is named for, and nothing was driving it. A snare hit visibly
 *              reshuffles the plane's hue for the length of its envelope,
 *              legible as a distinct percussive color flash under the kick's
 *              radial wave rather than a rename of it.
 *   uHihat  -> hex-cell edge glow pop, alongside `uHighs` (Round 5: MOVED off
 *              lattice rotation -- see "Round 5 fix" below. Was extra
 *              ROTATION on top of each plane's existing
 *              `ROT(tau*0.1*n+0.05*TIME)` spin; hihat's envelope is the
 *              shortest-lived of the three drum signals and fires on 8th/
 *              16th notes, so riding a rotation angle read as the whole
 *              lattice juddering on every hit, not a flicker).
 *   uBeatSin4 -> REMOVED from camera roll (Round 3, see below). Originally a
 *              small tempo-locked sway added on top of `uRoll`; turned out to
 *              be the same bug class Round 2 fixed in camera POSITION, just
 *              in ROLL instead.
 *
 * ## Round 2 fixes: camera weave, and denser/deeper/on-beat spawning
 *
 * Reported: "camera movement is bumpy... back and forth, just make the camera
 * movement smooth in one direction" and "change the spawning of the new web
 * fragments more often, deeper and on beat" (lighting/color explicitly called
 * out as good and left untouched).
 *
 *   Camera: `offset(z)` (and its exact derivatives `doffset`/`ddoffset`, which
 *   `main()` needs to build the ww/uu/vv look-basis) used to be a Lissajous
 *   weave -- `vec3(pathB*sin(pathA*z), z)`, two independently-phased sin()
 *   terms on x/y. That is BOUNDED motion: each axis turns around and heads
 *   back the moment its own sin() term crests, no matter how smoothly z
 *   itself advances -- the textbook "back and forth" bug, same class as
 *   GyroidFluxScene's old camera-rotation swing (see that file's header).
 *   Replaced with a helix driven by ONE monotonically-increasing angle
 *   (`pathRadius`/`pathRate`, declared right above `offset()`), which can only
 *   ever revolve one way. `pathA`/`pathB` are gone; see the offset() doc for
 *   the radius/rate derivation.
 *
 *   Spawn rate/depth: the kick-triggered wavefront only fired from a detected
 *   `s.onKick`, so in a passage with a steady beat but a soft or absent bass
 *   transient the web could sit silent for bars. Added a second, independent
 *   wavefront (`uSinceBeat`, its own `ImpulseClock` at `st.beat` in
 *   `update()`, its own fixed `beatPulseAmp` in the shader) charged on every
 *   `ctx.f.beat` instead -- see the pulse block in `plane()` for how the two
 *   combine. "Deeper": `waveSpan` 6->9 and `waveDecay` 8->6 so the same
 *   1/3 s crossing now reaches 1.5x the physical radius with a proportionally
 *   wide ring (not a thin one lost in more distance); `FURTHEST` 6->8 so
 *   distant planes stay drawn long enough to actually show that farther
 *   reach instead of it vanishing past the old visibility cutoff.
 *
 * ## Round 3 fix: camera ROLL was still swinging back and forth
 *
 * Reported (after Round 2 shipped): "camera shake left right, looks very
 * bumpy." Round 2 fixed POSITION (`offset(z)`) but the routing section above
 * had separately wired `uBeatSin4` — a plain -1..1 sine, one cycle per bar
 * (`engine/beatOscillators.ts`) — straight into the roll angle:
 * `p *= ROT(uRoll + uBeatSin4*0.05)`. A sine riding on a rotation angle
 * swings the frame to one side and back to the other every bar by
 * construction — exactly the bug class Round 2 diagnosed and fixed in
 * position, just missed here because it was added in a separate pass and
 * never connected to the same complaint.
 *
 * `GyroidFluxScene`'s header already worked out why the general fix has to be
 * removal, not damping: "ANY term riding on a rotation ANGLE that rises and
 * falls makes the camera swing out and back by definition — no amount of
 * smoothing changes that, only removing it from the angle does." A
 * half-rectified or scaled-down `uBeatSin4` would still rise and fall inside
 * the angle every bar; it would shrink the shake, not remove it. Fixed the
 * same way: `uBeatSin4` is out of the roll entirely, `p *= ROT(uRoll)`,
 * `uRoll` unchanged (still the pure static tilt dial its own doc always
 * said). The "camera roll is the one dimension with zero audio input" gap
 * this term was trying to close is still open — worth closing later with a
 * one-shot decaying pop on a kick (the pattern every other audio-driven
 * angle-adjacent term in this codebase actually uses safely, e.g. this
 * scene's own `uKickAmp`-scaled wavefront), never a continuous oscillator
 * riding on the angle again.
 *
 * ## Round 4 fix: the helix ITSELF was still "the camera", just slower
 *
 * Reported again (after Round 3 shipped, hard refresh confirmed, post-fx off
 * to rule out the lens/mirror racks): "whole view panning/rolling." Round 2's
 * helix is monotonic in POSITION — it can't turn back — but `doffset`/
 * `ddoffset` still trace a full circle every ~180s, and a revolving
 * look-basis reads as "the camera is panning" over any observation window
 * shorter than that period, same as a slow orbit always does. Round 2 fixed
 * the bounded-oscillation bug class; it didn't remove revolution as a
 * category, and revolution is its own member of "the camera visibly turns."
 *
 * Fixed by deleting the revolution outright: `offset`/`doffset`/`ddoffset`
 * are now a dead-straight `+z` path (see the doc right above `offset()`).
 * The only remaining camera motion is forward travel and the static `uRoll`
 * tilt — neither can pan or roll by construction, so there is nothing left
 * in `main()`'s camera setup that a "the camera is moving" report could be
 * describing. (It wasn't: see Round 5.)
 *
 * ## Round 5 fix: it was never `main()` — `plane()`'s own `uHihat` rotation
 *
 * Reported a THIRD time, after Round 4 shipped on a from-scratch dev server
 * with a hard-refreshed, never-before-loaded tab (ruling out every caching
 * explanation too): "still shaking... def some code change, didn't happen
 * before you touched web." That last part was the real clue — checked `git
 * diff` against the last commit, before any of these Rounds, and it doesn't
 * have this bug. So it was introduced somewhere in Round 1-2's own changes,
 * and every "Round" since has been staring at the wrong function.
 *
 * `plane()` — not `main()` — had `p2 *= ROT(tau*0.1*n+0.05*TIME+uHihat*0.15)`,
 * added in the same pass as Round 2 (see the routing section above, at the
 * time it was written). `uHihat` is a fast-attack, fast-decay envelope that
 * fires on 8th/16th notes — far more often than a kick or a beat — and this
 * term is IDENTICAL across every one of the up to 6 depth planes, so every
 * hihat hit snapped the whole composited lattice, every layer at once, by
 * the same few degrees and back. That reads as the camera juddering
 * left-right on the hihat pattern, even though no camera code is anywhere
 * near it — exactly why post-fx off and a from-scratch dev server never
 * ruled it out, and why Rounds 2-4 (all scoped to `main()`'s
 * offset/doffset/ddoffset/uRoll) could not have found it.
 *
 * Same rule as Round 3, same fix shape: removed from the angle, not damped.
 * uHihat's visual channel now lives at the hex-cell edge glow term instead
 * (alongside `uHighs`, see `plane()`) — a brightness pop reads as a hit; a
 * rotation pop reads as a shake. There is now no per-plane, per-frame, or
 * per-pixel term anywhere in this file that adds a live signal into a
 * rotation angle. If that temptation comes up again for some other band,
 * route it into radius or glow instead — never an angle.
 */

export const FRAG = /* glsl */ `
  uniform float uFly;
  uniform float uSinceKick;  // seconds since the last kick (engine/response.ts)
  uniform float uKickAmp;    // strength of that kick, so soft hits make soft waves
  // Round 2: secondary wavefront clock, fired on every tracked beat
  // (ctx.f.beat) rather than only a detected kick -- see beatPulseAmp above
  // and the 'beat' ImpulseClock in update(). Same 1e4 "never fired" sentinel
  // as uSinceKick.
  uniform float uSinceBeat;
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
  // Round 2: FURTHEST raised 6 -> 8 so the fade-out that governs how far down
  // the tunnel a plane stays visible reaches farther before cutting off --
  // paired with the waveSpan increase below, distant planes now stay drawn
  // long enough to actually show the wavefront arriving at them, instead of
  // the far half of its enlarged reach falling past the old cutoff unseen.
  , FURTHEST  = 8.
  , fadeFrom  = 4.
  , cutOff    = .975
  // Kick (and, since round 2, beat) propagation. See the pulse block in
  // plane() for the full reasoning.
  //
  // waveSpan raised 6 -> 9 (the radius, in hex cells, at which pos reaches
  // 1.0) so the SAME 1/3 s axis-to-edge crossing time (waveSpeed unchanged)
  // now covers 1.5x the physical distance -- the wave reaches farther out
  // into the lattice ("deeper") without changing its cadence, because pos is
  // normalised: raising the denominator only rescales how much physical
  // radius one unit of pos covers. waveDecay eased 8 -> 6 so the lit band
  // (width = speed/decay of the span -- see the pulse comment in plane())
  // stays proportionally wide too: a bigger reach with the same relative
  // ring thickness, not a thin ring lost in more distance.
  , waveSpan  = 9.      // hex cells from the axis at which pos reaches 1.0
  , waveSpeed = 3.      // spans per second -- one span in 1/3 s
  , waveDecay = 6.      // trailing falloff behind the front
  // Secondary, beat-locked pulse amplitude (paired with uSinceBeat / update()'s
  // 'beat' clock): fires on every tracked beat, not only a detected kick, so
  // the web keeps visibly conducting through passages with a steady beat but
  // a weak or absent bass transient. Kept well under the kick's up-to-1.5
  // ceiling ('hitAmp') so a real kick landing on a beat still reads as the
  // louder, primary event -- this is the ambient "still conducting" pulse,
  // not a replacement for the kick wave.
  , beatPulseAmp = 0.6
  ;
  const vec3 L = vec3(0.299, 0.587, 0.114);

  // Round 4 fix -- Round 2's helix (see the old comment this replaced, still
  // in git history) turned out to be the same complaint again: "whole view
  // panning/rolling", reported AFTER Round 2 had already shipped and AFTER a
  // hard refresh with post-fx off, which rules out both the old Lissajous
  // bug it replaced and anything outside this shader. A revolving path still
  // revolves -- doffset/ddoffset trace a full circle in the look-basis every
  // ~180s regardless of which direction offset() itself is barred from
  // reversing in, and that reads as exactly the "camera panning" complaint
  // over any viewing window shorter than the full period. There is no
  // magnitude of that revolution that both moves and cannot look like a pan.
  //
  // So the path is no longer a helix at all: dead straight down +z, zero
  // lateral excursion. pathRadius/pathRate are gone along with it --
  // offset/doffset/ddoffset below are the straight-line camera path itself,
  // not parameterised by anything. The only remaining camera motion is
  // forward travel (tm, driven by TIME) and the static uRoll tilt dial;
  // neither can pan or roll on its own by construction. If a "gentle drift"
  // is wanted back later, it has to be a bounded, EXPLICITLY re-centring
  // wobble (e.g. eased toward 0 between kicks), never a revolving angle --
  // see this file's own Round 2/3 history and GyroidFluxScene's header for
  // why a revolving OR oscillating term on camera position/orientation always
  // reads as shake/pan, regardless of speed or amplitude.

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

  // Straight path -- see "Round 4 fix" above. doffset/ddoffset MUST stay the
  // true analytic first/second derivatives of offset (main() uses them to
  // build the camera's ww/uu/vv look-direction basis), which is why all
  // three are kept together here even though two are now trivial constants.
  vec3 offset(float z)   { return vec3(0.0, 0.0, z); }
  vec3 doffset(float z)  { return vec3(0.0, 0.0, 1.0); }
  vec3 ddoffset(float z) { return vec3(0.0, 0.0, 0.0); }

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
    // Round 5 fix -- uHihat USED to ride straight into this rotation angle
    // ("+uHihat*0.15" here). Same bug class Round 3 already fixed for
    // uBeatSin4 in the outer screen roll, just missed here because it lives
    // in a different function: hihat's envelope rises and falls fast (it is
    // the shortest-lived of the three drum signals, firing on 8th/16th notes
    // -- far more often than a kick or a bar), and it was added IDENTICALLY
    // to every one of the up-to-6 depth planes, so every hihat hit snapped
    // the WHOLE composited lattice a few degrees and back, in sync across
    // every layer at once. That reads as the camera juddering left-right on
    // the hihat pattern -- reported as "whole view panning/rolling" -- even
    // though no camera code was involved; Rounds 2-4 never found it because
    // they were all looking at offset()/doffset()/ddoffset()/uRoll in
    // main(), never at this per-plane rotation in plane(). Per Round 3's own
    // rule, the fix is removal from the angle, not damping. uHihat's glow
    // channel lives on now at the hex-cell edge term below instead (see
    // "highs -> hex-cell edge glow" in the routing table above) -- a
    // brightness pop reads as a hit; a rotation pop reads as a shake.
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
    // before the next. decay 6.0 puts the lit band at speed/decay = 0.5 of
    // the span (~4-5 hex rings at the round-2 span of 9): wide enough to read
    // clearly as it now travels farther, narrow enough that it never
    // straddles the whole visible lattice at once.
    //
    // Round 2 adds a second, beat-locked wavefront using the same pos/speed/
    // decay shape but its own clock (uSinceBeat, charged on every ctx.f.beat
    // in update() rather than on a detected kick) and its own, smaller
    // amplitude (beatPulseAmp). The two are combined with max() rather than
    // summed: both read out of the SAME travellingPulse curve, so summing
    // could push the combined value past what the downstream radius/glow
    // math below was tuned for (see uKickAmp's 1.5 ceiling), whereas max()
    // lets a real kick landing on a beat still win as the louder, primary
    // event while the beat pulse alone still fires reliably in between.
    float kickPulse = travellingPulse(uSinceKick, length(hn)/waveSpan, waveSpeed, waveDecay) * uKickAmp;
    float beatPulse = travellingPulse(uSinceBeat, length(hn)/waveSpan, waveSpeed, waveDecay) * beatPulseAmp;
    float pulse = max(kickPulse, beatPulse);

    float h0 = hash(hn+n);
    vec2 p0 = coff(h0);

    // uSnare (prelude uniform, engine-populated): a hue-shift pop on top of
    // the existing phase term. Shared equally across the three channels, so
    // it still reads as a hue ROTATION rather than a flash-to-white -- the
    // "oversaturated" identity's color half finally has an audio driver.
    vec3 bcol = 0.5*(1.0+cos(vec3(0.0, 1.0, 2.0) + 2.0*(p2.x*p2.y+p2.x) - 0.33*n + uSnare*1.6));
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
      // uHihat moved here from the rotation in plane() above (Round 5) --
      // brightness, not angle, so a hit pops the edges instead of spinning
      // the lattice.
      col += 0.0005*bcol*bcol/(gd) * (1.0 + uHighs*1.0 + uHihat*1.5);
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
    // Round 3: uBeatSin4 REMOVED from here -- it was a plain -1..1 sine (one
    // cycle per bar) added straight into the roll angle, which swings the
    // frame to one side and back every bar by construction. See the file's
    // top doc, "Round 3 fix", for why this has to be removal rather than a
    // smaller coefficient. uRoll alone is the pure static tilt dial its own
    // doc always said.
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
  /**
   * Round 2: a second wavefront clock, charged on every `ctx.f.beat` instead
   * of a detected kick, so a wave still fires reliably on the tracked beat
   * grid through passages with a weak or absent bass transient. Fixed
   * amplitude (`beatPulseAmp` in the shader) rather than a held `hitAmp` --
   * a beat crossing has no "how hard" to measure, unlike an onset.
   */
  beat: ImpulseClock
}

export const OversaturatedWebScene = createShaderScene<WebState>({
  id: 'web',
  frag: FRAG,
  // travellingPulse(): one exp and one divide per plane per pixel (<= 6), set
  // against 36 cubic-bezier solves. Immeasurable next to what this scene
  // already spends — SCENE_COST_MS is unchanged and deliberately so.
  include: TRAVELLING_PULSE_GLSL,
  blending: THREE.NoBlending,
  // Inverse-distance glow upscales invisibly, so an offscreen buffer is cheap
  // here in perceptual terms. Tier-sensitive like MazeFlightScene. Estimate;
  // replace with a /bench sweep.
  //
  // Re-anchored 0.8 -> 4.4 / 0.5 -> 2.8. The old pair was a pre-F107 value that
  // was never revisited when the engine's budget table moved to (12.5/16/20) MP
  // plus a 24 MP post chain. A `createShaderScene` spec budget does not go
  // through that table — it is solved by that module's own `solveScale`, which
  // divides the declared megapixels straight into the display's full
  // megapixels and clamps at MIN_RENDER_SCALE (0.4), with no post-chain
  // reciprocal sum and no tier `pixelBudgetScale` factor. 0.8 MP against a
  // 3840x2160 panel solves to sqrt(0.8/8.29) = 0.31 — the lowest solve of the
  // four function-budget scenes, and well below that clamp — so the buffer
  // pinned to 1536x864 and upscaled 2.5x linear on any panel above ~1440p.
  // Because the unclamped size is dpr-invariant on this path, a 4K desktop and
  // a 1080p laptop were handed near-identical buffers, which is why the same
  // build read soft on the larger panel and sharp on the smaller one.
  //
  // 4.4 MP clears the clamp on 4K (0.73 linear -> 2796x1573) and reaches native
  // 1.00 on 1080p at every tier. This scene stays the LOWEST budget of the four
  // by design — the uniform re-anchor preserved the roster's existing ordering,
  // which encodes measured cost differences between the scenes.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 4.4 : 2.8),
  uniforms: () => ({
    uFly: { value: 0 },
    // 1e4 = sinceImpulse()'s "never fired" sentinel, so the very first frame
    // has an already-spent wave rather than one mid-flight.
    uSinceKick: { value: 1e4 },
    uKickAmp: { value: 0 },
    // Same 1e4 "never fired" sentinel as uSinceKick, same reasoning.
    uSinceBeat: { value: 1e4 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uBass: { value: 0 },
    uFov: { value: 1 },
    uRoll: { value: 0 },
    uExposure: { value: 1 },
    uPlanes: { value: 5 },
    uStrands: { value: 4 },
  }),
  state: () => ({ fly: 0, kick: impulseClock(), hitAmp: 0, beat: impulseClock() }),
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

    // Round 2: secondary wavefront on the tracked beat grid itself, not just
    // a detected kick -- see the `beat` field's doc and beatPulseAmp in the
    // shader. `ctx.f.beat` is true the exact frame a beat crosses, which is
    // exactly the "fired" edge sinceImpulse() wants; no amplitude to latch
    // here (unlike the kick) since a beat crossing carries no "how hard".
    u.uSinceBeat.value = sinceImpulse(st.beat, ctx.f.time, ctx.f.beat)

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

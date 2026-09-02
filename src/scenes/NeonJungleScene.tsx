import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'

/**
 * Neon Jungle — recursive portal between a tropical lagoon and a rain-slicked
 * neon city. Seamless 16s loop, first-person flythrough.
 *
 * Ported from glslop "NEON // JUNGLE v7" (ISF), credited in-source to "Craig".
 * CC0-1.0, same provenance basis as `maze` (`gstbkfmm`) and `malachite` —
 * platform generation, no fork lineage — so `license: 'original'`. The
 * in-source credit is preserved here and in the registry comment.
 *
 * ## HELD OUT in DISABLED_SCENES — pending a real /bench
 *
 * This is a full two-world volumetric raymarcher: `STEPS 190` primary march,
 * plus a SECOND `RSTEPS 60` reflection march on every water / puddle pixel,
 * per-step volumetric integration in both, `calcNormal` (4x) + `calcAO` (5x) +
 * `softShadow` (up to 20x) all re-running the entire scene SDF. As-is it will
 * not clear `slotBudget.test.ts`'s tier-0 `< sceneBudget(0)/2 ≈ 4 ms` bar, and
 * there is no way to measure it from CI (`/bench` is manual, in-browser,
 * single-GPU). It stays here until an optimised pass benches under that bar;
 * promotion is then a one-object move into `SCENES` plus a `SCENE_COST_MS` row.
 *
 * ## Port notes (ISF -> AudioVis prelude)
 *
 *   iTime / TIME       -> uClock  (JS speed-scaled accumulator, see update();
 *                                  NOT uTime*speed, which jumps when speed moves)
 *   iResolution / RENDERSIZE -> uRes
 *   fragCoord          -> gl_FragCoord.xy (unchanged)
 *   mainImage()        -> main() / gl_FragColor
 *   iChannel0 audio     -> uBassIn / uMidIn / uHighIn, fed from lilim `s.*`.
 *                          Craig's port already exposed these hooks + an
 *                          internal LFO fallback; the LFO is dropped.
 *   ISF `quality`       -> uQuality, driven off quality.knobs.raymarchSteps —
 *                          breaks the 190 / 60-step loops early (ES-safe:
 *                          constant loop bounds, uniform early-break)
 *   most ISF knobs      -> frozen at Craig's authored defaults as `const`
 *   final * uFade        -> the one edit every ported shader owes the compositor
 *
 * `pow(col, 0.9)` at the end is Craig's mild contrast gamma, NOT a linear->sRGB
 * (1/2.2) encode — three's renderer does that itself. Kept, same reasoning as
 * MazeFlightScene's header (which removed a real 0.4545 double-gamma).
 *
 * ## Band routing
 *
 *   energy  -> flight speed (uClock rate)
 *   onKick  -> transit flash + door-ring pulse (decaying, via BASS terms)
 *   sub     -> BASS: door bloom, volumetric swell, window/sign gain
 *   mids    -> MIDS: facade emissive, ledge glow, ticker
 *   highs   -> HIGH: water sparkle, shoreline foam, lagoon motes, fly-by motes
 */

export const FRAG = /* glsl */ `
  // ---- AudioVis-driven uniforms -----------------------------------------
  uniform float uClock;        // speed-scaled loop clock (replaces TIME*speed)
  uniform float uQuality;      // 0.35..1 march-loop early-break (from tier)
  uniform float uDetail;       // ISF 'detail' -> D1/D2/D3 tiers
  uniform float uNeonGain;     // ISF 'neonGain'
  uniform float uPortalFlash;  // ISF 'portalFlash' (kick-driven)
  uniform float uSunAz;        // ISF 'sunAz'
  uniform float uLensBase;     // ISF 'lensBase'
  uniform float uBassIn;       // lilim s.sub
  uniform float uMidIn;        // lilim s.mids
  uniform float uHighIn;       // lilim s.highs

  // ---- Craig's authored ISF defaults for knobs AudioVis doesn't drive ---
  const float phaseOffset = 0.0;
  const float neonHue     = 0.99;
  const float neonSat     = 0.94;
  const float fogTropic   = 0.0058;
  const float fogCity     = 0.0092;
  const float volAmt      = 1.0;
  const float rainAmt     = 0.7;
  const float wetness     = 0.75;
  const float moteAmt     = 0.35;
  const float partAmt     = 0.9;
  const float partSize    = 1.0;
  const float partDens    = 0.4;
  const float partStreak  = 0.35;
  const float partDrift   = 1.0;
  const float sunEl       = 0.22;
  const float lensPunch   = 1.05;
  const float sway        = 1.0;
  const float camHeight   = 2.6;
  const float exposure    = 1.06;
  const float gammaAmt    = 0.9;
  const float vignette    = 0.32;
  const float grain       = 0.016;
  const bool  doReflect   = true;
  const bool  doShadow    = true;

  #define TAU 6.28318530

  // ---- quality caps (loop bounds must stay constant) ------------------------
  #define STEPS    190
  #define RSTEPS   60
  #define SHSTEPS  20
  #define PSLICES  20           // particle planes marched per pixel

  // ---- layout ---------------------------------------------------------------
  const float L     = 60.0;     // door spacing - how deep each world is
  const float ZPER  = 120.0;    // world content period, even multiple of L
  const float LOOPT = 16.0;     // loop length in seconds

  // the door
  const float PW    = 2.60;     // aperture half width
  const float PHH   = 4.40;     // aperture half height
  const float PCY   = 5.60;     // centre height
  const float PTUBE = 0.075;
  const float PCR   = 0.12;

  // the particle field
  const float PSPACE = 3.0;     // world z between particle planes. 120/3 = 40
  const float PCELL  = 1.75;    // lateral cell size on each plane

  // ---- globals --------------------------------------------------------------
  float PH   = 0.0;
  float BASS = 0.0;
  float MIDS = 0.0;
  float HIGH = 0.0;
  vec3  NEON = vec3(1.60, 0.10, 0.16);
  vec3  SUN  = vec3(0.2540, 0.2235, 0.9410);
  float WOUT = 0.0;             // world the ray ended in, for the overlays
  float TOUT = 1e5;             // distance the ray ended at, for particle occlusion

  // detail tiers off one slider
  bool  D1 = true;              // ledges, shrubs, strata
  bool  D2 = true;              // cables, lanterns, vines
  bool  D3 = true;              // pylons, lily pads, tower signage

  // ---- hashing / noise ------------------------------------------------------
  float hash11(float n){ return fract(sin(n)*43758.5453123); }
  float hash21(vec2 p){ return fract(sin(dot(p, vec2(27.17,113.71)))*43758.5453); }
  float hash3(float x, float y, float z){ return hash11(x + y*57.0 + z*113.0); }

  vec3 hsv2rgb(vec3 c){
      vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0))*6.0 - 3.0);
      return c.z*mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }

  // value noise with its lattice index wrapped in z - exactly periodic, free
  float vnoiseZP(vec3 x, float per){
      vec3 p = floor(x), f = fract(x);
      f = f*f*(3.0-2.0*f);
      float z0 = mod(p.z, per);
      float z1 = mod(p.z + 1.0, per);
      float a = mix(mix(hash3(p.x, p.y,     z0), hash3(p.x+1.0, p.y,     z0), f.x),
                    mix(hash3(p.x, p.y+1.0, z0), hash3(p.x+1.0, p.y+1.0, z0), f.x), f.y);
      float b = mix(mix(hash3(p.x, p.y,     z1), hash3(p.x+1.0, p.y,     z1), f.x),
                    mix(hash3(p.x, p.y+1.0, z1), hash3(p.x+1.0, p.y+1.0, z1), f.x), f.y);
      return mix(a, b, f.z);
  }
  // s0*ZPER must be a whole number so the lattice tiles. 0.025 -> 3 cells.
  float fbmZ2(vec3 p, float s0){
      float per = s0*ZPER;
      return 0.65*vnoiseZP(p*s0, per) + 0.35*vnoiseZP(p*s0*2.0, per*2.0);
  }
  // non-periodic - only ever used on ray directions, never on positions
  float vnoise(vec3 x){
      vec3 p = floor(x), f = fract(x);
      f = f*f*(3.0-2.0*f);
      float n = p.x + p.y*57.0 + 113.0*p.z;
      return mix(mix(mix(hash11(n),hash11(n+1.0),f.x),
                     mix(hash11(n+57.0),hash11(n+58.0),f.x), f.y),
                 mix(mix(hash11(n+113.0),hash11(n+114.0),f.x),
                     mix(hash11(n+170.0),hash11(n+171.0),f.x), f.y), f.z);
  }
  float fbm(vec3 p){
      float a = 0.5, s = 0.0;
      for(int i=0;i<4;i++){ s += a*vnoise(p); p *= 2.03; a *= 0.5; }
      return s;
  }

  vec2 U(vec2 a, vec2 b){ return (a.x < b.x) ? a : b; }

  float sdBox(vec3 p, vec3 b){
      vec3 d = abs(p) - b;
      return min(max(d.x,max(d.y,d.z)),0.0) + length(max(d,0.0));
  }
  float sdBox2(vec2 p, vec2 b){
      vec2 d = abs(p) - b;
      return min(max(d.x,d.y),0.0) + length(max(d,0.0));
  }
  float sdRBox2(vec2 p, vec2 b, float r){ return sdBox2(p, b - r) - r; }
  float sdCapsule(vec3 p, vec3 a, vec3 b, float r){
      vec3 pa = p-a, ba = b-a;
      float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
      return length(pa - ba*h) - r;
  }
  float sdEllipsoid(vec3 p, vec3 r){
      float k0 = length(p/r);
      return k0*(k0 - 1.0)/max(length(p/(r*r)), 1e-5);
  }
  float lineMask(float x, float period, float w){
      float d = abs(fract(x/period - 0.5) - 0.5)*period;
      return smoothstep(w, 0.0, d);
  }
  float doorZ(float z){ return z - floor(z/L + 0.5)*L; }

  // ============================================================================
  //  THE DOOR - a thin emissive tube ring, nothing else
  // ============================================================================
  float doorProfile(vec2 q){ return sdRBox2(q - vec2(0.0, PCY), vec2(PW, PHH), PCR); }

  vec2 mapDoor(vec3 p){
      float ring = abs(doorProfile(p.xy)) - PTUBE;
      return vec2(max(ring, abs(doorZ(p.z)) - PTUBE), 30.0);
  }
  bool insideAperture(vec3 p){ return doorProfile(p.xy) < 0.0; }

  float doorRingDist(vec3 p){
      float a = abs(doorProfile(p.xy));
      float b = doorZ(p.z);
      return sqrt(a*a + b*b);
  }

  // ============================================================================
  //  WORLD A - TROPICAL LAGOON
  //  mats: 1 water, 2 rock, 2.5 bark, 3 foliage, 3.4 understory, 3.8 vine
  // ============================================================================
  float bankBase(float ax){ return -3.5 + smoothstep(9.0, 32.0, ax)*13.0; }

  // Two-tier heightfield: the coarse landform is always evaluated, the fine
  // detail only within a band of the surface.
  float lagoonH(vec3 p){
      float ax   = abs(p.x);
      float bank = smoothstep( 9.0,  32.0, ax);
      float dist = smoothstep(55.0, 150.0, ax);     // distant ridges
      if(bank <= 0.0) return -3.5;                  // open channel floor

      vec3  q  = vec3(p.x, 0.0, p.z);
      float n1 = fbmZ2(q, 0.025);
      float h  = -3.5 + bank*(8.0 + 11.0*n1) + dist*(18.0 + 34.0*n1);

      float k = smoothstep(9.0, 4.0, abs(p.y - h));
      if(k > 0.001){
          float n2 = vnoiseZP(q*0.05, 6.0);
          float rg = 1.0 - abs(2.0*vnoiseZP(q*0.15, 18.0) - 1.0);
          float n3 = vnoiseZP(q*0.40, 48.0);
          h += k*(bank*((n2 - 0.5)*5.5 + rg*2.2) + (n3 - 0.5)*0.6);
      }
      return h;
  }

  vec2 mapTropic(vec3 p){
      vec2 res = vec2(p.y, 1.0);                     // water plane

      if(p.y > 78.0) return U(res, vec2(p.y - 78.0, 2.0));

      res = U(res, vec2((p.y - lagoonH(p))*0.42, 2.0));

      // one lattice, five jobs: trunks, canopy, islets, understory, vines
      const vec2 CELL = vec2(20.0, 20.0);            // 120/20 = 6 cells, tiles
      vec2 uv   = vec2(p.x, p.z)/CELL;
      vec2 base = floor(uv);
      vec2 sg   = sign(fract(uv) - 0.5);
      sg += 1.0 - abs(sg);                           // guard: never 0

      float bestT = 1e5, bestF = 1e5, bestI = 1e5, bestU = 1e5, bestV = 1e5;
      for(int j=0;j<2;j++)
      for(int k=0;k<2;k++){
          vec2 id  = base + vec2(float(j)*sg.x, float(k)*sg.y);
          vec2 idw = vec2(id.x, mod(id.y, ZPER/CELL.y));
          float r1 = hash21(idw*1.70 +  1.0);
          float r2 = hash21(idw*3.10 +  7.0);
          float r3 = hash21(idw*5.30 + 13.0);
          float r4 = hash21(idw*7.90 + 23.0);

          float cx = (id.x + 0.5)*CELL.x + (r1-0.5)*8.0;
          float cz = (id.y + 0.5)*CELL.y + (r2-0.5)*8.0;
          float ax = abs(cx);

          // --- palms on the bank
          if(r3 < 0.80 && ax > 14.0 && ax < 46.0){
              vec3  c   = vec3(cx, bankBase(ax) + 0.5, cz);
              float H   = 5.0 + 6.0*r1;
              vec3  top = c + vec3((r2-0.5)*2.4, H, (r3-0.5)*2.4);
              bestT = min(bestT, sdCapsule(p, c - vec3(0.0,9.0,0.0), top, 0.26 + 0.11*r2));
              bestF = min(bestF, length((p - top - vec3(0.0,1.2,0.0))*vec3(1.0,1.25,1.0))
                                 - (2.1 + 1.5*r1));
              bestF = min(bestF, length((p - c - vec3(1.8*(r2-0.5), 0.7, 1.8*(r1-0.5)))
                                        *vec3(1.0,1.6,1.0)) - (1.4 + 0.9*r3));

              // --- vines off the canopy. thin, vertical, and they read hard
              //     against a lit door behind them
              if(D2 && r1 > 0.45){
                  vec3 vt = top + vec3(1.5*(r3-0.5), 0.9, 1.5*(r4-0.5));
                  bestV = min(bestV, sdCapsule(p, vt,
                              vt - vec3(0.25*(r2-0.5), 3.0 + 4.5*r2, 0.0), 0.070));
              }
          }

          // --- understory: shrubs and fern clumps down at the waterline, which
          //     is where v5 had a bare mud gap between water and trunks
          if(D1 && r2 < 0.80){
              float sxp = cx + (r3 - 0.5)*9.0;
              float axs = abs(sxp);
              if(axs > 8.0 && axs < 34.0){
                  vec3 c2 = vec3(sxp, bankBase(axs) + 0.35 + 1.1*r4, cz + 8.0*(r4-0.5));
                  bestU = min(bestU, sdEllipsoid(p - c2,
                              vec3(1.7 + 1.6*r2, 1.1 + 1.5*r1, 1.7 + 1.6*r4)));
                  if(r1 > 0.55){
                      vec3 c3 = c2 + vec3(3.2*(r1-0.5), -0.35, 3.4*(r2-0.5));
                      bestU = min(bestU, sdEllipsoid(p - c3,
                                  vec3(1.2 + 1.0*r3, 0.85 + 0.9*r4, 1.2 + 1.0*r1)));
                  }
              }
          }

          // --- rock islets standing in the water. these sweep past close to
          //     the lens and are the strongest near-field parallax cue.
          if(r4 < 0.55 && ax > 7.0 && ax < 34.0){
              vec3 ic = vec3(cx, -1.2 + 2.6*r4, cz + 6.0*(r3-0.5));
              vec3 ir = vec3(1.4 + 2.6*r1, 1.6 + 3.4*r4, 1.4 + 2.6*r2);
              bestI = min(bestI, sdEllipsoid(p - ic, ir));
          }
      }
      bestF -= (fbmZ2(p, 0.80) - 0.40)*0.65;
      bestI -= (fbmZ2(p, 0.40) - 0.45)*0.85;
      bestU -= (fbmZ2(p, 0.70) - 0.42)*0.95;

      res = U(res, vec2(bestT*0.85, 2.5));
      res = U(res, vec2(bestF*0.62, 3.0));
      res = U(res, vec2(bestI*0.60, 2.0));
      res = U(res, vec2(bestU*0.58, 3.4));
      res = U(res, vec2(bestV*0.85, 3.8));
      return res;
  }

  // ============================================================================
  //  WORLD B - FLOODED NEON CITY
  //  mats: 11 street, 12 tower, 13 sign, 14 skybridge, 15 mast,
  //        16 cable, 17 lamp head, 18 post, 19 pavement
  // ============================================================================
  vec2 rowTowers(vec3 p, float xc, float cz, float seed, float sx, float bw, float hmax){
      float best = 1e5, bestS = 1e5;
      float zf  = p.z/cz + 0.5;
      float zi  = floor(zf);
      float sgz = sign(fract(zf) - 0.5);
      sgz += 1.0 - abs(sgz);

      for(int k=0;k<2;k++){
          float id  = zi + float(k)*sgz;
          float idw = mod(id, ZPER/cz);
          float h1 = hash21(vec2(idw*1.13 + seed*7.7, sx*3.3 + seed));
          float h2 = hash21(vec2(idw*2.71 + seed*3.1, sx*9.1 + seed*2.0));
          float h3 = hash21(vec2(idw*4.37 + seed*5.3, sx*1.7 + seed*3.0));
          float H  = mix(12.0, hmax, h1);
          float dz = cz*0.5 - 1.2 - 1.8*h2;
          float dx = bw*(0.70 + 0.55*h2);
          vec3  q  = p - vec3(xc + 2.2*h2, 0.0, id*cz);

          // shaft + crown
          best = min(best, sdBox(vec3(q.x, q.y - H*0.5,   q.z), vec3(dx,      H*0.5, dz)));
          best = min(best, sdBox(vec3(q.x, q.y - H - 2.8, q.z), vec3(dx*0.55, 2.8,   dz*0.55)));

          if(D1){
              // podium: the street-level mass. breaks the flat extrusion and
              // gives the water something to reflect other than a plain wall
              float ph = 2.6 + 3.4*h3;
              best = min(best, sdBox(vec3(q.x - dx*0.30, q.y - ph*0.5, q.z),
                                     vec3(dx*0.92, ph*0.5, dz*1.02)));

              // ledge slabs repeating up the shaft, clamped to the roofline
              float per = 6.0 + 3.0*h3;
              float nid = clamp(floor(q.y/per + 0.5), 1.0, max(floor((H - 2.0)/per), 1.0));
              float ly  = q.y - nid*per;
              best = min(best, sdBox(vec3(q.x, ly, q.z), vec3(dx + 0.34, 0.17, dz + 0.34)));

              // rooftop tank
              best = min(best, sdBox(vec3(q.x - dx*0.30, q.y - H - 6.4, q.z + dz*0.25),
                                     vec3(0.85, 0.85, 0.85)));
          }

          if(h2 > 0.55){
              bestS = min(bestS, sdCapsule(q, vec3(0.0, H + 5.2, 0.0),
                                              vec3(0.0, H + 5.2 + 6.0*h1, 0.0), 0.17));
          }
      }
      return U(vec2(best, 12.0), vec2(bestS, 15.0));
  }

  // stripped-down version for the far rows - one box, no crown, no mast
  vec2 rowFar(vec3 p, float xc, float cz, float seed, float sx, float bw, float hmax){
      float best = 1e5;
      float zf  = p.z/cz + 0.5;
      float zi  = floor(zf);
      float sgz = sign(fract(zf) - 0.5);
      sgz += 1.0 - abs(sgz);
      for(int k=0;k<2;k++){
          float id  = zi + float(k)*sgz;
          float idw = mod(id, ZPER/cz);
          float h1 = hash21(vec2(idw*1.13 + seed*7.7, sx*3.3 + seed));
          float h2 = hash21(vec2(idw*2.71 + seed*3.1, sx*9.1 + seed*2.0));
          float H  = mix(16.0, hmax, h1);
          vec3  q  = p - vec3(xc + 4.0*h2, 0.0, id*cz);
          best = min(best, sdBox(vec3(q.x, q.y - H*0.5, q.z),
                                 vec3(bw*(0.7 + 0.6*h2), H*0.5, cz*0.5 - 2.0 - 3.0*h2)));
      }
      return vec2(best, 12.0);
  }

  // Lantern cables. A sagging span across the street with beads of light
  // repeating along it. Period 12 (10 per loop), offset 6 so it never lands on
  // a door plane. The curve is extended flat past the span so it buries itself
  // inside the tower rows instead of ending in mid-air.
  vec2 cityCables(vec3 p, float px){
      const float per = 12.0;
      float cid = floor((p.z - 6.0)/per + 0.5);
      float zo  = p.z - (cid*per + 6.0);
      float h   = hash21(vec2(mod(cid, 10.0), 4.7));
      float h2  = hash21(vec2(mod(cid, 10.0), 8.3));
      float y0  = 14.0 + 5.5*h;
      float sag = 2.2 + 2.0*h2;
      float u   = clamp(px/12.5, 0.0, 1.0);
      float yc  = y0 - sag*(1.0 - u*u);

      float cab = length(vec2(p.y - yc, zo)) - 0.075;
      float lx  = px - floor(px/1.70 + 0.5)*1.70;
      float lan = length(vec3(lx, p.y - (yc - 0.42), zo)) - 0.195;

      return U(vec2(cab*0.70, 16.0), vec2(lan*0.80, 17.0));
  }

  // Street furniture: lamp posts along the kerb, arms reaching over the road.
  vec2 cityPosts(vec3 p, float sx){
      const float per = 8.0;                          // 120/8 = 15 cells
      float zf  = p.z/per + 0.5;
      float zi  = floor(zf);
      float sgz = sign(fract(zf) - 0.5);
      sgz += 1.0 - abs(sgz);

      float best = 1e5, bestL = 1e5;
      for(int k=0;k<2;k++){
          float id  = zi + float(k)*sgz;
          float idw = mod(id, 15.0);
          float h1 = hash21(vec2(idw*1.71, sx*2.3 + 1.0));
          float h2 = hash21(vec2(idw*3.37, sx*5.7 + 2.0));
          float h3 = hash21(vec2(idw*7.13, sx*9.1 + 3.0));
          if(h1 < 0.42) continue;

          float cx = 9.9 + 1.7*h2;                    // standing on the pavement
          vec3  q  = p - vec3(cx, 0.0, id*per + (h3 - 0.5)*3.0);
          float H  = 4.2 + 2.6*h1;

          best = min(best, sdCapsule(q, vec3(0.0, -0.4, 0.0), vec3(0.0, H, 0.0),
                                        0.115 + 0.05*h2));
          // arm over the roadway + the lit head on the end of it
          vec3 hd = vec3(-1.10 - 0.85*h2, H - 0.22, 0.0);
          best = min(best, sdCapsule(q, vec3(0.0, H, 0.0), hd, 0.085));
          bestL = min(bestL, sdEllipsoid(q - hd - vec3(0.0, 0.10, 0.0),
                                         vec3(0.32, 0.19, 0.24))*0.70);
          // kerbside bollard
          if(h2 > 0.55)
              best = min(best, sdCapsule(q + vec3(0.75, 0.0, 1.9),
                                         vec3(0.0, -0.3, 0.0), vec3(0.0, 0.85, 0.0), 0.11));
      }
      return U(vec2(best*0.88, 18.0), vec2(bestL*0.88, 17.0));
  }

  vec2 mapCity(vec3 p){
      float px = abs(p.x);
      float sx = sign(p.x + 0.0001);
      vec3  pf = vec3(px, p.y, p.z);

      // ROAD SURFACE. Crowned down the centreline and dipping into the gutters
      // at the kerb, so rain has a low line to pool along.
      float ys = -0.11*smoothstep(5.4, 9.2, px);
      vec2 res = vec2((p.y - ys)*0.90, 11.0);

      if(p.y > 86.0) return U(res, vec2(p.y - 86.0, 12.0));

      // raised pavement either side, kerb face included. 2D box extruded in z,
      // so this is exact and costs almost nothing.
      res = U(res, vec2(sdBox2(vec2(px - 11.6, p.y - 0.14), vec2(2.20, 0.15))*0.95, 19.0));

      res = U(res, rowTowers(pf,  13.0, 15.0, 1.0, sx,  3.6, 34.0));
      res = U(res, rowTowers(pf,  29.0, 20.0, 2.0, sx,  5.0, 44.0));
      res = U(res, rowTowers(pf,  50.0, 24.0, 3.0, sx,  6.5, 52.0));
      res = U(res, rowFar   (pf,  78.0, 30.0, 4.0, sx,  9.0, 60.0));
      res = U(res, rowFar   (pf, 115.0, 40.0, 5.0, sx, 13.0, 72.0));

      // skybridges: period 15, offset 7.5 - never lands on a door plane
      float bo = p.z - (floor((p.z - 7.5)/15.0 + 0.5)*15.0 + 7.5);
      res = U(res, vec2(sdBox(vec3(p.x, p.y - 18.0, bo), vec3(16.0, 0.9, 1.8)), 14.0));

      // hanging signage: period 10, offset 4
      float sid = floor((p.z - 4.0)/10.0 + 0.5);
      float so  = p.z - (sid*10.0 + 4.0);
      float sh  = 5.0 + 6.0*hash21(vec2(mod(sid, 12.0), sx*5.0));
      res = U(res, vec2(sdBox(vec3(px - 9.5, p.y - sh, so), vec3(0.20, 2.2, 0.90)), 13.0));

      if(D2) res = U(res, cityCables(pf, px));
      if(D1) res = U(res, cityPosts(pf, sx));

      return res;
  }

  // ---- dispatch -------------------------------------------------------------
  vec2 mapWorld(vec3 p, float w){ return (w < 0.5) ? mapTropic(p) : mapCity(p); }
  vec2 mapAll  (vec3 p, float w){ return U(mapDoor(p), mapWorld(p, w)); }

  vec3 calcNormal(vec3 p, float w){
      vec2 e = vec2(1.0,-1.0)*0.0030;
      return normalize( e.xyy*mapAll(p+e.xyy,w).x + e.yyx*mapAll(p+e.yyx,w).x +
                        e.yxy*mapAll(p+e.yxy,w).x + e.xxx*mapAll(p+e.xxx,w).x );
  }
  float calcAO(vec3 p, vec3 n, float w){
      float o = 0.0, sca = 1.0;
      for(int i=0;i<5;i++){
          float h = 0.06 + 0.36*float(i);
          o += (h - mapAll(p + n*h, w).x)*sca;
          sca *= 0.70;
      }
      return clamp(1.0 - 0.80*o, 0.0, 1.0);
  }
  float softShadow(vec3 ro, vec3 rd, float w){
      if(!doShadow) return 1.0;
      float res = 1.0, t = 0.30;
      for(int i=0;i<SHSTEPS;i++){
          float h = mapWorld(ro + rd*t, w).x;
          res = min(res, 10.0*h/t);
          t += clamp(h, 0.30, 4.5);
          if(res < 0.02 || t > 65.0) break;
      }
      return clamp(res, 0.0, 1.0);
  }

  // ============================================================================
  //  SKIES
  // ============================================================================
  vec3 skyTropic(vec3 rd){
      float h = max(rd.y, 0.0);
      vec3 c = mix(vec3(1.20,0.55,0.32), vec3(0.09,0.21,0.50), pow(h,0.45));
      float s = max(dot(rd, SUN), 0.0);
      c += vec3(3.00,1.70,0.80)*pow(s, 900.0);
      c += vec3(1.50,0.64,0.28)*pow(s, 7.0)*0.70;

      float iy = 1.0/max(rd.y, 0.075);
      vec3  cp = vec3(rd.x*iy, 0.0, rd.z*iy)*0.34 + vec3(0.7*sin(TAU*PH), 0.0, 0.0);
      float cl = fbm(cp);
      vec3  cc = mix(vec3(0.30,0.19,0.24), vec3(1.65,1.05,0.75), 0.35 + 0.6*pow(s,1.5));
      c = mix(c, cc, smoothstep(0.40,0.88,cl)*smoothstep(0.0,0.17,rd.y)*0.88);

      // high cirrus, a second cloud deck so the sky has depth of its own
      if(D1){
          vec3 hp = vec3(rd.x*iy, 0.0, rd.z*iy)*0.11 + vec3(1.4*sin(TAU*PH), 0.0, 0.0);
          float hc = fbm(hp*vec3(1.0,1.0,3.0));
          c = mix(c, mix(vec3(0.85,0.62,0.58), vec3(1.45,1.02,0.80), pow(s,1.2)),
                  smoothstep(0.52,0.86,hc)*smoothstep(0.05,0.35,rd.y)*0.40);
      }
      return c;
  }

  vec3 skyCity(vec3 rd){
      float h = max(rd.y, 0.0);
      vec3 c = mix(vec3(0.11,0.045,0.16), vec3(0.012,0.016,0.042), pow(h,0.55));
      c += vec3(0.62,0.13,0.52)*pow(1.0-h, 9.0)*0.9;
      c += vec3(0.06,0.30,0.52)*pow(1.0-h, 3.0)*0.30;
      c += vec3(0.35,0.10,0.30)*exp(-h*7.0)*0.55;
      float st = smoothstep(0.9986, 1.0, hash21(floor(rd.xz*430.0)));
      c += st*vec3(0.80,0.85,1.0)*smoothstep(0.15,0.6,rd.y);

      // low overcast catching the city glow from underneath
      if(D1){
          float iy = 1.0/max(rd.y, 0.09);
          float cl = fbm(vec3(rd.x*iy, 0.0, rd.z*iy)*0.22 + vec3(0.5*sin(TAU*PH),0.0,0.0));
          c = mix(c, vec3(0.16,0.055,0.19), smoothstep(0.42,0.85,cl)
                                            *smoothstep(0.0,0.30,rd.y)*0.75);
      }

      // far skyline behind the marched rows
      float ang    = atan(rd.x, max(rd.z, 0.001));
      float slope  = rd.y/max(length(rd.xz), 0.001);
      float prof   = 0.055 + 0.110*fbm(vec3(ang*7.0, 0.0, 0.0));
      float inside = smoothstep(prof + 0.004, prof - 0.004, slope);
      vec3  far    = vec3(0.024,0.019,0.044);
      far += step(0.80, hash21(floor(vec2(ang*260.0, slope*900.0))))*vec3(0.55,0.42,0.25)*0.5;
      return mix(c, far, inside);
  }
  vec3 skyFor(vec3 rd, float w){ return (w < 0.5) ? skyTropic(rd) : skyCity(rd); }

  // Aerial perspective. Cheap stand-in for the sky so distance desaturates and
  // shifts hue instead of washing to one flat colour.
  vec3 fogColor(vec3 rd, float w){
      float up = smoothstep(-0.05, 0.40, rd.y);
      if(w < 0.5){
          float s = max(dot(rd, SUN), 0.0);
          return mix(vec3(0.66,0.48,0.38), vec3(0.34,0.40,0.54), up)
               + vec3(0.95,0.48,0.22)*pow(s, 4.0)*0.55;
      }
      return mix(vec3(0.090,0.048,0.120), vec3(0.028,0.024,0.055), up)
           + vec3(0.30,0.09,0.28)*0.30;
  }
  vec3 applyFog(vec3 col, vec3 rd, float t, float w){
      float den = (w < 0.5) ? fogTropic : fogCity;
      return mix(col, fogColor(rd, w), 1.0 - exp(-t*den));
  }

  // ============================================================================
  //  PORTAL-AWARE MARCH
  // ============================================================================
  vec3 trace(vec3 ro, vec3 rd, float w0, float tmax, int maxSteps,
             out vec3 vol, float volScale)
  {
      float t = 0.03, w = w0, mat = -1.0;
      vol = vec3(0.0);

      for(int i=0;i<STEPS;i++){
          if(i >= maxSteps) break;
          vec3 p = ro + rd*t;
          vec2 h = mapAll(p, w);

          // hit resolves before any world toggle, so mat and w always agree
          if(h.x < 0.0014*t + 0.0015){ mat = h.y; break; }

          // floor the step first, then test the plane against the step actually
          // taken - otherwise small steps jump a plane without testing it
          float st = max(h.x*0.66, 0.014);

          if(abs(rd.z) > 0.001){
              float zn = (rd.z > 0.0) ? (floor(p.z/L) + 1.0)*L : floor(p.z/L)*L;
              float dp = (zn - p.z)/rd.z;
              if(dp > 0.0 && dp < st){
                  st = dp + 0.004;
                  if(insideAperture(ro + rd*(t + dp))) w = 1.0 - w;
              }
          }

          if(volScale > 0.0){
              float tr = exp(-t*0.0075);
              if(w < 0.5){
                  float g  = exp(-max(p.y,0.0)*0.13);
                  float fs = pow(max(dot(rd,SUN),0.0), 6.0);
                  vol += (vec3(0.30,0.27,0.28) + vec3(1.50,0.88,0.46)*fs)
                         *g*st*0.0060*tr*volScale;
              }else{
                  float g = exp(-max(p.y,0.0)*0.19);
                  vec3  c = mix(vec3(0.55,0.10,0.45), vec3(0.08,0.34,0.60),
                                0.5 + 0.5*sin(p.z*0.10472));
                  vol += c*g*st*0.0058*tr*volScale*(0.8 + 0.5*BASS);
              }
              // three-lobe door bloom: tight core, mid halo, wide wash. the wide
              // term is what lets far doors in the chain still read through haze.
              float dr = doorRingDist(p);
              vol += NEON*( 1.00/(1.0 +  6.0*dr*dr)
                          + 0.22/(1.0 +  0.30*dr*dr)
                          + 0.05/(1.0 +  0.02*dr*dr) )
                     *st*0.060*tr*volScale*(0.85 + 0.75*BASS);
          }

          t += st;
          if(t > tmax) break;
      }
      return vec3(t, mat, w);
  }

  // ============================================================================
  //  MATERIALS
  // ============================================================================
  float wave(vec2 q){
      float t = TAU*PH;
      return 0.055*( sin(q.x*2.10   + 1.5*sin(t))
                   + sin(q.y*2.7227 + 1.3*cos(t))
                   + 0.5*sin((q.x + q.y)*4.2935 + 2.0*sin(t)) )
           + 0.020*sin(q.x*7.30 + q.y*5.1313 + 3.0*sin(t));
  }
  // rain chop: integer multipliers on PH keep it loop-exact
  float ripple(vec2 q){
      return 0.010*sin(q.x*9.10 + TAU*PH*40.0)*sin(q.y*8.30 - TAU*PH*33.0)
           + 0.006*sin((q.x - q.y)*15.7 + TAU*PH*57.0);
  }
  vec3 waterNormal(vec3 p, float w){
      float e = 0.28;
      float r = (w > 0.5) ? rainAmt*0.9 : 0.0;
      float h0 = wave(p.xz)                    + r*ripple(p.xz);
      float hx = wave(p.xz + vec2(e,0.0))      + r*ripple(p.xz + vec2(e,0.0));
      float hz = wave(p.xz + vec2(0.0,e))      + r*ripple(p.xz + vec2(0.0,e));
      return normalize(vec3(-(hx - h0)/e, 1.0, -(hz - h0)/e));
  }

  // Puddle field for the city street. Periodic in z via fbmZ2, biased toward
  // the gutters where the camber sends the water.
  float puddleMask(vec3 p){
      float d = fbmZ2(vec3(p.x, 0.0, p.z), 0.40);
      float m = smoothstep(0.46, 0.62, d);
      m = max(m, smoothstep(6.2, 9.2, abs(p.x))*0.85);      // gutter pooling
      return clamp(m*mix(0.35, 1.0, wetness), 0.0, 1.0);
  }
  // shallow standing water: rain rings only, no swell
  vec3 puddleNormal(vec3 p){
      float e = 0.20;
      float a = 0.45 + 1.1*rainAmt;
      float h0 = a*ripple(p.xz)               + 0.30*wave(p.xz*0.55);
      float hx = a*ripple(p.xz + vec2(e,0.0)) + 0.30*wave((p.xz + vec2(e,0.0))*0.55);
      float hz = a*ripple(p.xz + vec2(0.0,e)) + 0.30*wave((p.xz + vec2(0.0,e))*0.55);
      return normalize(vec3(-(hx - h0)/e, 1.0, -(hz - h0)/e));
  }

  vec3 doorLight(vec3 p, vec3 n, vec3 alb){
      vec3  lv = vec3(0.0, PCY, floor(p.z/L + 0.5)*L) - p;
      float d  = length(lv);
      return alb*NEON*max(dot(n, lv/max(d,0.001)), 0.0)
           / (1.0 + 0.045*d*d)*(16.0 + 11.0*BASS);
  }

  vec3 shadeTropic(vec3 p, vec3 n, vec3 rd, float mat){
      vec3 alb;
      bool water = (mat < 1.5);
      bool leafy = (mat > 2.7);
      float foam = 0.0;

      if(water){
          // depth shading off the actual channel floor: shallows read turquoise,
          // the channel reads deep, and the crossing point foams
          float gh  = lagoonH(vec3(p.x, 0.0, p.z));
          float dep = clamp(-gh, 0.0, 9.0);
          alb = mix(vec3(0.060,0.210,0.195), vec3(0.011,0.033,0.038),
                    smoothstep(0.35, 4.5, dep));
          float fn = fbmZ2(vec3(p.x, 0.0, p.z), 0.90);
          foam = smoothstep(1.00, 0.02, abs(gh))*smoothstep(0.30, 0.72, fn);

          if(D3){
              // lily-pad rafts, surface only
              vec2 lc  = vec2(p.x, mod(p.z, ZPER))/2.40;
              vec2 lid = floor(lc);
              vec2 lf  = fract(lc) - 0.5;
              vec2 jit = (vec2(hash21(lid*2.13 + 1.0), hash21(lid*3.71 + 5.0)) - 0.5)*0.42;
              float pad = smoothstep(0.36, 0.25, length(lf - jit));
              pad *= step(0.58, hash21(lid*1.31 + 9.0));
              pad *= smoothstep(5.0, 11.0, abs(p.x))*smoothstep(31.0, 21.0, abs(p.x));
              alb = mix(alb, mix(vec3(0.055,0.150,0.045), vec3(0.11,0.24,0.06),
                                 hash21(lid*5.9)), pad*0.92);
              n = normalize(mix(n, vec3(0.0,1.0,0.0), pad*0.85));
              water = (pad < 0.5);
          }
      }
      else if(mat < 2.7){                                     // rock / bark
          float m   = fbmZ2(p, 0.40);
          vec3  dry = mix(vec3(0.21,0.16,0.12), vec3(0.36,0.30,0.23), m);
          vec3  wet = mix(vec3(0.06,0.05,0.04), vec3(0.12,0.10,0.08), m);
          alb = mix(wet, dry, smoothstep(0.05, 2.4, p.y));

          if(D1){
              // stratification: horizontal banding so the rock stops reading as
              // one noise blob and gains a sense of scale
              float band = 0.5 + 0.5*sin(p.y*1.55 + fbmZ2(p, 0.10)*7.0);
              alb *= 0.80 + 0.40*smoothstep(0.35, 0.75, band);
              alb += vec3(0.05,0.04,0.03)*smoothstep(0.80, 0.98, band);
          }

          alb = mix(alb, vec3(0.62,0.60,0.55),
                    smoothstep(0.60, 0.0, abs(p.y - 0.10))*smoothstep(0.35,0.70,m)*0.55);
          float moss = smoothstep(0.50,0.92,n.y)*smoothstep(0.40,0.72,fbmZ2(p,0.20))
                     * smoothstep(0.90, 3.5, p.y);
          alb = mix(alb, mix(vec3(0.06,0.14,0.045), vec3(0.15,0.29,0.075), m), moss*0.85);
      }
      else if(mat < 3.6){                                     // foliage + shrubs
          float v = fbmZ2(p, 0.80);
          alb = mix(vec3(0.05,0.16,0.04), vec3(0.20,0.42,0.09), v);
          alb = mix(alb, vec3(0.30,0.36,0.10), smoothstep(0.62,0.95,v)*0.45);
          if(mat > 3.2){                                      // understory is
              alb *= 0.72;                                    // darker, cooler
              alb = mix(alb, vec3(0.09,0.20,0.10), 0.35);
          }
      }
      else{                                                   // vine
          alb = mix(vec3(0.10,0.14,0.05), vec3(0.19,0.26,0.08), fbmZ2(p, 0.90));
      }

      float sh  = softShadow(p + n*0.09, SUN, 0.0);
      float dif = max(dot(n, SUN), 0.0);
      vec3  sky = skyTropic(vec3(0.0,1.0,0.0));

      vec3 col  = alb*dif*sh*vec3(2.60,1.80,1.18);
      col += alb*sky*(0.30 + 0.42*max(n.y,0.0));
      col += alb*vec3(0.16,0.13,0.09)*max(-n.y,0.0)*0.5;
      if(leafy) col += alb*max(dot(-n,SUN),0.0)*sh*vec3(1.20,1.50,0.48)*0.85;

      if(water){
          vec3 hv = normalize(SUN - rd);
          col += vec3(2.8,2.1,1.5)*pow(max(dot(n,hv),0.0), 260.0)*(0.6 + 1.4*HIGH);
          col += vec3(0.55,0.62,0.58)*foam*(0.9 + 0.5*HIGH);   // shoreline foam
      }
      return col + doorLight(p, n, alb);
  }

  vec3 shadeCity(vec3 p, vec3 n, vec3 rd, float mat){
      vec3 alb = vec3(0.05), emi = vec3(0.0);
      bool street = (mat < 11.5);
      float pud = 0.0;

      if(street){
          // --- asphalt
          float px2  = abs(p.x);
          float zz   = mod(p.z, ZPER);
          float grit = fbmZ2(vec3(p.x, 0.0, p.z), 0.90);
          float wear = fbmZ2(vec3(p.x, 0.0, p.z), 0.20);
          alb = mix(vec3(0.028,0.028,0.032), vec3(0.058,0.056,0.060), grit);
          alb *= 0.80 + 0.35*wear;                       // patching and repairs

          // --- lane paint. dashes are period 4 (30 per loop), so they tile
          float dash = step(0.5, fract(zz/4.0));
          float ctr  = smoothstep(0.14, 0.09, abs(px2 - 0.24));
          float lane = smoothstep(0.12, 0.07, abs(px2 - 4.60))*dash;
          float edge = smoothstep(0.13, 0.08, abs(px2 - 8.60));
          float paint = clamp(ctr + lane + edge, 0.0, 1.0)*(0.55 + 0.45*grit);
          alb = mix(alb, vec3(0.36,0.33,0.20), paint*0.90);

          // --- crosswalk under every cable span (period 12, offset 6)
          float ccid = floor((p.z - 6.0)/12.0 + 0.5);
          float czo  = p.z - (ccid*12.0 + 6.0);
          float cw   = smoothstep(2.05, 1.60, abs(czo))
                     * step(0.5, fract(px2/1.30))
                     * step(px2, 8.9);
          alb = mix(alb, vec3(0.40,0.39,0.35), cw*0.80*(0.6 + 0.4*grit));

          // --- manhole covers and gutter drains
          vec2 mid = floor(vec2(p.x, zz)/9.0);
          vec2 mc  = (mid + 0.5)*9.0 + (vec2(hash21(mid*1.7), hash21(mid*3.3)) - 0.5)*5.0;
          float man = smoothstep(0.62, 0.50, length(vec2(p.x, zz) - mc));
          alb = mix(alb, vec3(0.075,0.068,0.058)*(0.7 + 0.6*grit), man);
          float drain = smoothstep(0.35, 0.20, abs(px2 - 8.95))
                      * step(0.55, fract(zz/16.0))*step(0.5, fract(zz/1.6));
          alb *= 1.0 - 0.55*drain;

          // --- wet. puddles darken the asphalt and go specular in render()
          pud = puddleMask(p);
          alb *= 1.0 - 0.62*pud;
          alb *= 1.0 - 0.22*wetness;                     // damp sheen everywhere
      }
      else if(mat < 12.5){                                    // tower
          alb = vec3(0.045,0.048,0.060)
              * (0.7 + 0.6*hash21(floor(vec2(p.x, mod(p.z, ZPER))*0.10)));

          float vert = 1.0 - abs(n.y);
          float u    = (abs(n.x) > 0.5) ? mod(p.z, ZPER) : p.x;
          vec2  cid  = vec2(floor(u/2.0), floor(p.y/2.30));
          vec2  fq   = vec2(fract(u/2.0), fract(p.y/2.30));
          float pane = smoothstep(0.10,0.18,fq.x)*smoothstep(0.90,0.82,fq.x)
                     * smoothstep(0.15,0.24,fq.y)*smoothstep(0.86,0.78,fq.y);
          float on   = step(0.46, hash21(cid + floor(p.x*0.02)));
          float flk  = step(0.985, hash21(cid + floor(PH*8.0)));
          vec3  wc   = mix(vec3(1.00,0.72,0.34), vec3(0.35,0.85,1.35), hash21(cid*1.7 + 3.0));
          emi += vert*pane*on*(1.0-flk)*wc*(1.7 + 1.3*MIDS);

          float spine = lineMask(u, 10.0, 0.10)*vert;
          emi += spine*mix(vec3(1.4,0.15,0.7), vec3(0.15,1.0,1.4),
                           step(0.5, hash21(floor(vec2(u/10.0, 0.0)))))*1.7;

          if(D1){
              // strip lighting tucked under every ledge slab
              float led = lineMask(p.y - 0.35, 6.8, 0.09);
              emi += led*vert*vec3(0.35,0.80,1.20)*1.15;
              // top-of-podium wash where the street light pools
              emi += vert*smoothstep(6.5, 0.0, p.y)*vec3(0.90,0.35,0.55)*0.55;
          }

          if(D3){
              // blocky sign panels bolted to the facade
              vec2 sid2 = vec2(floor(u/7.0), floor(p.y/9.0));
              float sgn = step(0.72, hash21(sid2*3.17 + 11.0));
              vec2  sf  = vec2(fract(u/7.0), fract(p.y/9.0));
              float box = smoothstep(0.26,0.32,sf.x)*smoothstep(0.74,0.68,sf.x)
                        * smoothstep(0.30,0.36,sf.y)*smoothstep(0.70,0.64,sf.y);
              float glyph = step(0.45, hash21(floor(vec2(u*4.0, p.y*4.0))
                                              + floor(PH*6.0)*0.0));
              vec3  sc2 = mix(vec3(1.60,0.20,0.55), vec3(0.20,1.10,1.45),
                              hash21(sid2*7.7 + 2.0));
              emi += vert*sgn*box*glyph*sc2*(1.4 + 1.6*MIDS);

              // scrolling ticker band, loop-locked (integer cycles per loop)
              float tb = smoothstep(0.45, 0.0, abs(p.y - 8.6));
              float tk = step(0.55, hash21(floor(vec2(u*3.0 - PH*120.0, 0.0))));
              emi += vert*tb*tk*vec3(1.30,0.55,0.10)*1.5;
          }

          emi += vert*exp(-max(p.y,0.0)*0.36)*vec3(0.55,0.12,0.45)*0.85;
      }
      else if(mat < 13.5){                                    // signage
          vec3 sc = mix(vec3(1.7,0.15,0.70), vec3(0.15,1.15,1.60), step(0.5, fract(p.z*0.05)));
          emi += sc*(2.8 + 2.2*BASS);
          alb = vec3(0.02);
      }
      else if(mat < 14.5){                                    // skybridge
          alb = vec3(0.06,0.065,0.08);
          emi += smoothstep(0.38,0.0,abs(p.y - 17.55))*vec3(0.25,0.9,1.3)*1.6;
      }
      else if(mat < 15.5){                                    // mast + beacon
          alb = vec3(0.05,0.05,0.06);
          emi += vec3(1.6,0.15,0.12)*smoothstep(0.4,1.0,sin(TAU*PH*4.0))*1.4;
      }
      else if(mat < 16.5){                                    // cable
          alb = vec3(0.03,0.03,0.035);
      }
      else if(mat < 17.5){                                    // lantern / lamp
          float f = hash21(vec2(floor(abs(p.x)/1.7), floor(mod(p.z, ZPER))));
          vec3  lc2 = mix(vec3(1.70,0.62,0.20), vec3(1.30,0.25,0.55), f);
          emi += lc2*(2.6 + 2.0*BASS)*(0.85 + 0.15*sin(TAU*PH*6.0 + f*9.0));
          alb = vec3(0.04);
      }
      else if(mat < 18.5){                                    // lamp post, bollard
          alb = vec3(0.050,0.048,0.052)*(0.7 + 0.6*fbmZ2(p, 0.60));
          alb = mix(alb*0.55, alb, smoothstep(0.0, 1.4, p.y));   // road grime
      }
      else{                                                   // pavement
          alb = vec3(0.078,0.076,0.082)*(0.72 + 0.55*fbmZ2(p, 0.90));
          // paving joints, 1.6 grid, z folded so it tiles
          float j = max(lineMask(p.x, 1.6, 0.045), lineMask(mod(p.z, ZPER), 1.6, 0.045));
          alb *= 1.0 - 0.42*j;
          // kerb face catches the road lighting harder than the top does
          alb *= 0.80 + 0.45*(1.0 - abs(n.y));
          alb *= 1.0 - 0.18*wetness;
      }

      vec3 col = alb*vec3(0.045,0.035,0.085);
      for(int i=0;i<2;i++){
          float side = (i==0) ? 1.0 : -1.0;
          vec3  lv = vec3(side*8.9, 5.1, p.z) - p;
          float d  = length(lv);
          vec3  lc = (i==0) ? vec3(1.45,0.20,0.80) : vec3(0.15,0.85,1.50);
          col += alb*lc*max(dot(n, lv/max(d,0.001)),0.0)/(1.0 + 0.09*d*d)*(11.0 + 7.0*BASS);
      }
      col += alb*skyCity(vec3(0.0,1.0,0.0))*max(n.y,0.0)*0.55;

      if(street){
          // sheen: sharp where there is standing water, broad and dull on damp
          // asphalt. this is what sells "wet road" even before the reflection.
          vec3 hv = normalize(vec3(0.0,1.0,0.2) - rd);
          float sp = max(dot(n,hv), 0.0);
          col += vec3(0.55,0.30,0.65)*pow(sp, 90.0)*(0.25 + 0.85*pud);
          col += vec3(0.30,0.22,0.38)*pow(sp, 12.0)*0.12*wetness;
          // rain hitting the road throws a fine sparkle
          col += vec3(0.45,0.38,0.60)*rainAmt
               * pow(max(dot(n, normalize(vec3(0.0,1.0,0.0) - rd)),0.0), 30.0)*0.18;
      }
      return col + emi + doorLight(p, n, alb);
  }

  vec3 shadeDoor(vec3 p){
      float prof = doorProfile(p.xy);
      float core = smoothstep(PTUBE, 0.0, abs(prof));
      float puls = 0.90 + 0.18*sin(TAU*PH*8.0 + p.y*2.2) + 1.1*BASS;

      // chase segments running the perimeter - free frame detail, no geometry.
      // 12 cycles per loop keeps it seamless.
      float s = (p.x + p.y)*1.30 - PH*12.0*TAU*0.16;
      float chase = 0.55 + 0.45*sin(s*TAU);
      puls *= mix(1.0, 0.55 + 0.85*chase, 0.45);

      return mix(NEON*3.4, vec3(2.7,2.3,2.3), core*0.75)*puls;
  }

  vec3 shadeHit(vec3 p, vec3 n, vec3 rd, float mat, float w){
      if(mat > 29.5) return shadeDoor(p);
      return (w < 0.5) ? shadeTropic(p, n, rd, mat) : shadeCity(p, n, rd, mat);
  }

  // ============================================================================
  //  RENDER
  // ============================================================================
  vec3 render(vec3 ro, vec3 rd, float w0, int steps, int rsteps){
      vec3 vol;
      vec3 hit = trace(ro, rd, w0, 520.0, steps, vol, volAmt);
      float t = hit.x, mat = hit.y, w = hit.z;
      WOUT = w;
      TOUT = (mat < 0.0) ? 1e5 : t;          // depth for the particle field
      vec3 col;

      if(mat < 0.0){
          col = skyFor(rd, w);
      }else{
          vec3 p = ro + rd*t;
          vec3 n = calcNormal(p, w);

          // lagoon water is a full mirror surface; the city street only mirrors
          // where puddles have collected
          bool  isWater  = (mat < 1.5);
          bool  isStreet = (mat > 10.5 && mat < 11.5);
          float pud = isStreet ? puddleMask(p) : 0.0;

          if(isWater)       n = normalize(mix(n, waterNormal(p, w), 0.88));
          else if(pud > 0.01) n = normalize(mix(n, puddleNormal(p), 0.80*pud));

          if(mat > 29.5) col = shadeDoor(p);
          else           col = shadeHit(p, n, rd, mat, w)*calcAO(p, n, w);

          if(doReflect && (isWater || pud > 0.03)){
              float k = 0.14 + 0.86*pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
              if(isStreet) k *= pud*0.92;
              vec3 rvol, rr = reflect(rd, n);
              vec3 rh = trace(p + n*0.06, rr, w, 300.0, rsteps, rvol, volAmt*0.75);
              vec3 rc;
              if(rh.y < 0.0) rc = skyFor(rr, rh.z);
              else{
                  vec3 p2 = p + n*0.06 + rr*rh.x;
                  rc = (rh.y > 29.5) ? shadeDoor(p2)
                                     : shadeHit(p2, calcNormal(p2, rh.z), rr, rh.y, rh.z);
                  rc = applyFog(rc, rr, rh.x, rh.z);      // reflections fade too
              }
              col = mix(col, rc + rvol, clamp(k, 0.0, 1.0));
          }
          col = applyFog(col, rd, t, w);
      }
      return col + vol;
  }

  vec3 aces(vec3 x){
      return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0);
  }

  // ---- screen-space weather / air ------------------------------------------
  // Both are locked to PH with integer cycle counts so they survive the loop.
  float rainLayer(vec2 q, float sc, float cyc, float seed){
      vec2 g  = vec2(q.x*sc, q.y*sc*0.16 - PH*cyc);
      vec2 id = floor(g);
      vec2 f  = fract(g) - 0.5;
      float h = hash21(id + seed);
      float streak = smoothstep(0.5, 0.0, abs(f.x - (h - 0.5)*0.55)*11.0)
                   * smoothstep(0.5, 0.0, abs(f.y)*1.25);
      return streak*step(0.62, h);
  }
  float moteLayer(vec2 q, float sc, float cyc, float seed){
      vec2 g  = vec2(q.x*sc + sin(PH*TAU + seed)*0.35, q.y*sc - PH*cyc);
      vec2 id = floor(g);
      vec2 f  = fract(g) - 0.5;
      float h = hash21(id + seed);
      return smoothstep(0.16, 0.0, length(f - (vec2(h, fract(h*7.3)) - 0.5)*0.6))
           * step(0.78, h);
  }

  // ============================================================================
  //  FLY-BY PARTICLE FIELD
  // ============================================================================
  vec3 particleField(vec3 ro, vec3 rd, float hitT, float pxScale){
      if(partAmt < 0.001 || rd.z < 0.05) return vec3(0.0);

      vec3  acc = vec3(0.0);
      float z0  = (floor(ro.z/PSPACE) + 1.0)*PSPACE;   // first plane ahead of us
      float cut = 1.0 - partDens;                      // density thinning

      for(int i=0;i<PSLICES;i++){
          float zw = z0 + float(i)*PSPACE;
          float t0 = (zw - ro.z)/rd.z;
          if(t0 > hitT) break;                         // planes only recede

          vec2 gp = (ro.xy + rd.xy*t0)/PCELL;
          vec2 id = floor(gp);

          // wrapped plane index - this is what makes the field loop
          float sid = mod(floor(zw/PSPACE), ZPER/PSPACE);

          float h1 = hash21(id*1.31 + vec2(sid*0.71, sid*1.93) +  3.0);
          if(h1 < cut) continue;
          float h2 = hash21(id*2.17 + vec2(sid*1.37, sid*0.53) + 11.0);
          float h3 = hash21(id*3.71 + vec2(sid*0.29, sid*2.11) + 23.0);

          // scatter the point in z inside its slab, so points cross the lens
          // continuously instead of arriving in flat waves
          float t = t0 + (h3 - 0.5)*PSPACE*0.36/max(rd.z, 0.25);
          if(t < 0.35 || t > hitT) continue;

          // cell-local coords at the jittered depth
          vec2 pf = (ro.xy + rd.xy*t)/PCELL - id;

          vec2 c = vec2(0.30 + 0.40*h2, 0.30 + 0.40*fract(h2*7.13));
          c += partDrift*vec2(0.10*sin(TAU*(PH*2.0 + h1)),
                              0.12*sin(TAU*(PH*3.0 + h2)));       // loop-exact bob

          vec2 d = (pf - c)*PCELL;

          // streak along the on-screen travel direction, which for forward
          // flight is radially away from the vanishing point
          vec2  dir = normalize(rd.xy*t + vec2(1e-4, 0.0));
          float al  = dot(d, dir);
          float pe  = dot(d, vec2(-dir.y, dir.x));
          float sk  = 1.0 + partStreak*3.5;
          float r   = length(vec2(al/sk, pe));

          float core = (0.020 + 0.045*h2)*partSize;
          float rr   = max(core, t*pxScale*1.15);      // never thinner than a pixel

          float s = 1.0 - smoothstep(0.0, rr, r);
          s += 0.30*exp(-(r*r)/(rr*rr*9.0));           // soft halo

          // colour by the world this plane sits in, so points beyond a doorway
          // already wear the next world's palette
          float w = mod(floor(zw/L), 2.0);
          vec3  pc = (w < 0.5) ? vec3(1.00,0.80,0.42)*(0.70 + 0.90*HIGH)   // pollen
                               : vec3(0.55,0.78,1.25)*(0.70 + 0.90*MIDS);  // spray
          float dz = doorZ(zw);
          pc = mix(pc, NEON*1.4, exp(-dz*dz*0.02)*0.75);   // gate light spill

          float fade = smoothstep(0.5, 3.0, t)             // no blobs on the lens
                     * exp(-t*((w < 0.5) ? fogTropic : fogCity)*1.6)
                     * (0.55 + 0.65*hash21(id + sid));
          acc += pc*s*fade;
      }
      return acc*partAmt*0.30;
  }

  // ============================================================================
  //  MAIN
  // ============================================================================
  void main(){
      vec2 fragCoord = gl_FragCoord.xy;

      // uClock is the JS-side speed-scaled accumulator (see update()) — NOT
      // uTime*speed, which would jump whenever the speed dial moves.
      PH = fract(uClock / LOOPT + phaseOffset);

      D1 = uDetail > 0.05;
      D2 = uDetail > 0.40;
      D3 = uDetail > 0.72;

      int steps  = int(float(STEPS)*uQuality);
      int rsteps = int(float(RSTEPS)*uQuality);

      NEON = hsv2rgb(vec3(neonHue, neonSat, 1.0))*1.6*uNeonGain;

      float ca = uSunAz*1.4;
      SUN = normalize(vec3(sin(ca)*0.97, sunEl, cos(ca)*0.97));

      // ---- audio ----------------------------------------------------------
      // Straight from the engine (lilim s.*) via uBassIn/uMidIn/uHighIn.
      // Craig's ISF port also carried an internal loop-locked LFO fallback
      // (audioMix) — AudioVis always has real audio, so it is dropped.
      vec3 lvl = vec3(uBassIn, uMidIn, uHighIn);
      BASS = clamp(lvl.x, 0.0, 2.0);
      MIDS = clamp(lvl.y, 0.0, 2.0);
      HIGH = clamp(lvl.z, 0.0, 2.0);

      // ---- forward motion -----------------------------------------------
      // g maps 0..1 onto exactly one loop, but its derivative PEAKS at PH = 0.25
      // and 0.75 - where the doors are. So the camera lingers in each world and
      // accelerates through the doorway.
      const float EASE = 0.45;
      float g  = PH + EASE*sin(TAU*2.0*(PH - 0.25))/(TAU*2.0);
      float cz = ZPER*g + 30.0;                       // starts mid-room
      float dz = doorZ(cz);

      // all camera character damps to zero near a door, so every transit is
      // dead-centre through the aperture
      float open = smoothstep(0.0, 10.0, abs(dz))*sway;

      vec3 ro = vec3(0.70*sin(TAU*PH*2.0)*open,
                     camHeight + 0.28*sin(TAU*PH*3.0)*open,
                     cz);
      vec3 ta = ro + vec3(0.85*sin(TAU*PH*2.0 + 1.0)*open,
                          0.55*sin(TAU*PH)*open + 0.55,
                          4.0);

      vec2 uv = (fragCoord - 0.5*uRes.xy)/uRes.y;
      float rl = 0.050*sin(TAU*PH*2.0)*open;
      uv = mat2(cos(rl), -sin(rl), sin(rl), cos(rl))*uv;

      vec3 fw = normalize(ta - ro);
      vec3 rt = normalize(cross(vec3(0.0,1.0,0.0), fw));
      vec3 up = cross(fw, rt);

      // wide lens for perspective, tightening hard at each transit. the tighten
      // also pushes the frame edges off screen sooner, keeping the swap seamless
      float lens = uLensBase + lensPunch*exp(-0.06*dz*dz);
      vec3 rd = normalize(uv.x*rt + uv.y*up + lens*fw);

      float w0 = mod(floor(cz/L), 2.0);
      vec3 col = render(ro, rd, w0, steps, rsteps);

      // ---- fly-by particles, depth-tested against the primary hit ---------
      // pxScale is the world size of one pixel per unit of distance, so points
      // stay at least a pixel wide instead of aliasing into fireflies far off.
      col += particleField(ro, rd, TOUT, 1.0/(lens*uRes.y));

      // ---- weather / air, masked by the world the ray actually ended in ----
      if(WOUT > 0.5){
          if(rainAmt > 0.001){
              float r = rainLayer(uv, 42.0, 26.0, 1.0)*0.60
                      + rainLayer(uv, 76.0, 41.0, 7.0)*0.35
                      + rainLayer(uv, 22.0, 17.0, 3.0)*0.30;
              col += vec3(0.55,0.60,0.85)*r*rainAmt*0.16;
          }
      }else{
          if(moteAmt > 0.001){
              float m = moteLayer(uv, 26.0, 3.0, 2.0)*0.7
                      + moteLayer(uv, 44.0, 5.0, 9.0)*0.4;
              col += vec3(1.00,0.82,0.52)*m*moteAmt*0.22*(0.6 + 0.8*HIGH);
          }
      }

      // transit flash
      col += NEON*exp(-2.0*dz*dz)*(0.09 + 0.26*BASS)*uPortalFlash;

      col = aces(col*exposure);
      col = pow(col, vec3(gammaAmt));
      col *= 1.0 - vignette*dot(uv,uv);
      col += (hash21(fragCoord + PH*137.0) - 0.5)*grain;

      gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface NeonJungleState {
  /** Loop clock, accumulated so a changing flight rate stays continuous. */
  clock: number
  /** Transit flash, kick-charged, decaying. */
  flash: number
}

export const NeonJungleScene = createShaderScene<NeonJungleState>({
  id: 'neonjungle',
  frag: FRAG,
  // Paints every pixel including its own sky — replace, not blend, for the
  // offscreen buffer (BlendedLayer forces `add` on the on-screen primary).
  blending: THREE.NoBlending,
  // Deliberately aggressive: this is a two-world volumetric raymarcher with a
  // second reflection march. Renders offscreen well below native and upscales
  // (neon + haze + grain hide it). Tier-sensitive like MazeFlightScene.
  // These numbers are a STARTING POINT — replace with a real /bench sweep
  // before this scene is considered for promotion into SCENES.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.2 : 0.7),
  uniforms: () => ({
    uClock: { value: 0 },
    uQuality: { value: 1 },
    uDetail: { value: 1 },
    uNeonGain: { value: 1 },
    uPortalFlash: { value: 1 },
    uSunAz: { value: 0.26 },
    uLensBase: { value: 1.15 },
    uBassIn: { value: 0 },
    uMidIn: { value: 0 },
    uHighIn: { value: 0 },
  }),
  state: () => ({ clock: 0, flash: 0 }),
  update({ u, s, P, st, dt }) {
    // Source cruise was TIME*speed on a 16s loop. Accumulate so a changing
    // rate stays continuous; energy leans on the throttle.
    st.clock += dt * (1 + s.energy * 0.5) * drastic(P.speed)
    // A kick is a transit flash + a door-ring pulse (through the BASS terms),
    // decaying — not a sustained value.
    if (s.onKick > 0) st.flash = Math.min(1.5, st.flash + s.onKick)
    st.flash *= Math.exp(-dt * 3.0)

    u.uClock.value = st.clock
    u.uPortalFlash.value = 1 + st.flash * 1.4

    u.uBassIn.value = s.sub
    u.uMidIn.value = s.mids
    u.uHighIn.value = s.highs

    // NOTE: linear maps, NOT yet piecewise-anchored to Craig's authored ISF
    // defaults (detail 1.0, neonGain 1.0, lensBase 1.15, sunAz 0.26). Anchor
    // them so slider-centre reproduces the tuned look before any promotion to
    // SCENES — see MazeFlightScene.update for the pattern.
    u.uDetail.value = 0.15 + P.complexity * 0.85
    u.uNeonGain.value = 1.0 + (P.contrast - 0.5) * 1.6
    u.uLensBase.value = 1.15 + (P.fill - 0.5) * 1.4
    u.uSunAz.value = 0.26 + (P.tilt - 0.5) * 1.5

    // The only quality lever wired for this scene as-is: break the 190/60-step
    // march loops early. quality.knobs.raymarchSteps peaks at 96 (tier 0), so
    // map that onto the shader's own 0..1 `quality` control (min 0.35).
    u.uQuality.value = Math.max(0.35, Math.min(1, quality.knobs.raymarchSteps / 96))
  },
})

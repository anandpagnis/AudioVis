import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { slew } from '../engine/response'
import { drastic } from '../engine/sceneParams'
import { SIMPLEX3D_GLSL } from '../engine/shaderLib'
import { useStore } from '../store'

/**
 * Limitless — the image trip engine. A user-supplied photo is the raw material;
 * the `mode` setting picks the physics applied to it.
 *
 * Ported from lilim's `scenes/limitless.js` (vanilla three.js) onto
 * `createShaderScene`. Same provenance basis as the other lilim-branch ports in
 * this roster (`malachite`, `kifs`, `maze`, `wingfold`) — written on the lilim
 * branch of this same project, so `license: 'original'`.
 *
 * ## Scope: 17 of lilim's 21 modes
 *
 * 15 of the 17 are **single-pass** — they read only `tSrc`, the source
 * photo, and nothing else. They ported onto this engine's single-quad model
 * with no engine work at all.
 *
 * `melt` and `mosh` are different: each needs an auxiliary ping-pong
 * simulation buffer that evolves frame over frame (lilim's own `tSim` +
 * `simQuad` + `ensureSim`) rather than being recomputed fresh every frame
 * from just the current photo — this is what actually makes them feel
 * "fluid"/"alive" rather than a per-frame distortion, and it did require
 * real engine work: `createShaderScene.tsx` gained a generic, optional
 * `ShaderSceneSpec.sim` hook (a second, self-contained fragment shader the
 * engine ping-pongs through its own history buffer once per frame, before
 * the scene's main `update()` runs, writing the fresh result into `tSim` on
 * the main material) specifically to carry these two. See that file's own
 * doc on `sim` for the mechanism; see {@link LIMITLESS_SIM_FRAG} below for
 * what runs inside it.
 *
 * Full display order (lilim's own authored order, six modes removed):
 *
 *   none, smear, droste, infinite, corridor, cube, planet, melt,
 *   shatter, prism, breathe, mosh, sort, thresh, solar, halftone, vhs
 *
 * Four are still deliberately NOT ported — F212 in `docs/ISSUES.md` covers
 * what a further phase needs. `coral` and `scanline`/`windows` could reuse
 * the SAME `sim` plumbing melt/mosh now use (lilim's own sim shader already
 * shares one buffer pair across all of them) at much lower incremental cost
 * than melt/mosh paid to establish it, but are left out of this pass on
 * purpose — coral's reaction-diffusion and windows/scanline's per-cell/
 * per-row time-lag are a different character than the "fluid/reactive photo"
 * ask that motivated this port. `terrain` is not a fragment-shader mode at
 * all but a separate 3D scene graph (its own `THREE.Scene`,
 * `PerspectiveCamera` and displaced heightfield mesh) — a materially larger,
 * different piece of work, not a `sim`-shaped one.
 *
 * ## Mode renumbering — this port does NOT use lilim's branch indices
 *
 * lilim pinned its GLSL branch numbers in a sparse `MODE_IDX`
 * (`none:0, melt:1, smear:2, … cube:21, planet:22, windows:23`) so that cutting
 * a mode never renumbered a branch. That constraint does not survive a fresh
 * port: this engine sets `uMode` to the **plain array index** into the
 * `modes` list declared in `SceneMetadata.contract` (see
 * `sceneParams.ts`'s `resolveSceneParams`), so the branch numbers here are
 * sequential 0..16 into {@link LIMITLESS_MODES} and bear no relation to
 * lilim's own numbering.
 *
 * {@link LIMITLESS_MODES} keeps lilim's authored DISPLAY order with the four
 * still-excluded modes removed, which is why it reads `none, smear, droste,`
 * then the spatial batch, then the rest — lilim's own file header calls that
 * order "smear and droste lead, the spatial batch follows, everything else
 * after". `limitless.modes.test.ts` asserts the array's length, uniqueness,
 * and that every index 0..16 has a matching `uMode ==` branch in the shader
 * source.
 *
 * ## Uniform collisions with SHADER_SCENE_PRELUDE — five, not one
 *
 * `limitless.js` declared FIVE uniforms the prelude already declares, and each
 * one would have been a duplicate-declaration compile failure rendering a
 * silent black frame (exactly F181a, which shipped live in `beats` and was
 * invisible to typecheck/lint/build/vitest). All five declarations are deleted
 * here and the prelude's are consumed directly:
 *
 *   - `uAspect` — identical meaning (viewport aspect); lilim wrote it from its
 *     own `resize(w,h)`, the prelude writes it from the render-buffer size.
 *   - `uMode`   — the prelude declares it `int` and the engine writes
 *     `P.modeIndex` into it every frame. Consumed, never written here.
 *   - `uAccent`, `uGlow` — lilim bound these to its own `PAL`; the prelude
 *     binds them to the live AudioVis palette (same five slot names,
 *     `bg/shadow/mid/accent/glow`), so the palette port is free.
 *   - `uKick` — see the note below, this one is not a pure rename.
 *
 * `uPhase` is NOT a collision and is kept scene-owned: it is lilim's own
 * speed-scaled, audio-reactive phase accumulator
 * (`phase += dt * (0.035 + s.mids*0.09) * drastic(P.speed)`), not the prelude's
 * unscaled `uTime`.
 *
 * ### The one substitution that changes a signal
 *
 * lilim wrote `uKick` from `s.kick` (the bass BAND envelope). The prelude
 * declares `uKick` itself and writes it from `ctx.f.percussion.kick.env` (the
 * dedicated per-drum onset envelope) every frame, before `update()` runs. Since
 * the declaration has to go either way, the prelude's value is taken rather
 * than overwritten — it is a truer decaying impulse than the band level, and
 * the only place `uKick` is read is `smear`'s small centre-punch term
 * (`- uv * uKick * 0.1 * exp(-r*2.0)`), where either reads as a punch. The
 * JS-side `s.kick` is still used, unchanged, for `uFringe`.
 *
 * ## What else was dropped, and why it is not a loss
 *
 * `uFlipX` and `uLive` both existed for lilim's camera feed, which is not
 * ported (see F213 — a live `MediaStream` has no way across this codebase's
 * two-window boundary yet). Rather than ship two uniforms permanently pinned at
 * zero, both are removed and their effect folded out algebraically:
 *
 *   - every `mix(a, b, uFlipX)` collapses to `a`, and `p.x *= 1.0 - 2.0*uFlipX`
 *     disappears from `fit()`;
 *   - `float liveF = max(uLive, uMode == 0 ? 1.0 : 0.0)` collapses to
 *     `uMode == 0 ? 1.0 : 0.0`, which is exactly lilim's behaviour for a
 *     non-camera source and preserves the authored rule that `none` alone runs
 *     at full brightness ("the plain source at full brightness … a clean canvas
 *     for the lens rack").
 *
 * ## Determinism
 *
 * A recorded show must replay identically, so there is no `Math.random()` in
 * this file. Two places in lilim's source had one and both are reseeded:
 *
 *   - the `droste` twist leap used `Math.random()` TWICE per kick (magnitude
 *     and sign). Both now come from {@link hash11} off `st.seed`, the kick
 *     counter the scene already keeps for `uSeed` — same distribution
 *     (magnitude 0.25..0.75, either sign), same feel, replayable.
 *   - `defaultPhoto()` scattered 22 blobs at random positions, so every call
 *     produced a different placeholder. It now runs a fixed-seed LCG, which
 *     additionally fixes a problem lilim documented but could not solve: it
 *     kept the boot texture alive by reference precisely because
 *     "regenerating would hand back a different picture than the one the scene
 *     booted with". A deterministic generator makes regeneration free, so
 *     clearing a dropped photo just rebuilds the identical placeholder.
 *
 * `sort`, `shatter`, `halftone` and `vhs` already used deterministic GPU-side
 * `hash2()` off scene state rather than any random source; those port as-is.
 *
 * ## Photo input
 *
 * The photo arrives as a data URL in the non-persisted store field
 * `limitlessPhoto`, mirrored to the output window through `LOOK_FIELDS`. This
 * scene compares that string against the one it last uploaded, once per frame,
 * and only decodes on an actual change. See `syncPhoto` below and the
 * `PhotoDrop` panel in `src/ui/Console.tsx`.
 *
 * ## Band routing
 *
 *   onKick  -> shock (smear ripple / sort stretch / thresh level knock / solar
 *              widen / vhs tracking slam), shatter break, prism tear, droste
 *              twist leap, the infinite/corridor/cube light pulse, and the
 *              sort/halftone/planet reseed
 *   sub     -> smear displacement, dive rate, sort stretch, solar depth,
 *              halftone dot swell, vhs wobble, planet radius, breathe lung
 *   mids    -> the phase accumulator's own rate
 *   highs   -> smear/coral accent, prism separation, vhs speckle, breathe wobble
 *   energy  -> the final exposure sweep, breathe crawl/fringe, seam and halo
 *              brightness, and shatter's reassembly rate (it reassembles in
 *              QUIET — `exp(-dt * (0.4 + (1 - s.energy) * 1.6))`)
 */

/**
 * The declared modes, in display order, and the shader's branch order.
 *
 * **Index IS the `uMode` branch number** — `modes[3] === 'infinite'` and the
 * shader's `uMode == 3` is the infinity mirror. Exported so
 * `limitless.modes.test.ts` can assert that correspondence against the shader
 * source rather than trusting it by eye; the failure it guards against
 * (a user picks "shatter" and sees "prism") is silent, and nothing else in this
 * repo's tooling can see it.
 *
 * Order is lilim's own authored display order with the four still-unported
 * modes (`windows`, `terrain`, `coral`, `scanline`) removed. `none` leads, so
 * it is also the default mode: a photo scene whose first frame is the photo,
 * undistorted, is the right thing to open on.
 */
export const LIMITLESS_MODES = [
  'none', // 0
  'smear', // 1
  'droste', // 2
  'infinite', // 3
  'corridor', // 4
  'cube', // 5
  'planet', // 6
  'melt', // 7
  'shatter', // 8
  'prism', // 9
  'breathe', // 10
  'mosh', // 11
  'sort', // 12
  'thresh', // 13
  'solar', // 14
  'halftone', // 15
  'vhs', // 16
] as const

// Photo resize/encode constants (`PHOTO_MAX_EDGE`, `PHOTO_JPEG_QUALITY`) and
// the encoder itself live in `engine/limitlessPhoto.ts`, not here — this file
// is a `createShaderScene` chunk (see `scenes/index.ts`'s own header on code
// splitting), and `Console.tsx` is a different bundle entry point that needs
// the SAME constants to build its drop/picker panel. Neither window can
// import the other's module for this without pulling three.js or React
// across a boundary that does not want either. See that file's own header.

/**
 * Deterministic 0..1 hash of one number — the stand-in for `Math.random()`.
 *
 * Same `fract(sin(x) * 43758.5453)` shape the shader's own `hash2` uses, so the
 * JS and GLSL sides of this scene randomise the same way. See the header on why
 * there is no real random source anywhere in this file.
 */
function hash11(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/**
 * The generated placeholder the scene boots with, so it draws something real
 * before anyone has dropped a photo.
 *
 * Deterministic (see the header): every call produces a byte-identical canvas,
 * which is what makes "clear the photo" able to simply regenerate rather than
 * having to hold the boot texture alive forever the way lilim's did.
 *
 * Called from `uniforms()`, never at module top level — this touches the DOM,
 * and every scene in this roster is a lazily-imported chunk that must cost
 * nothing merely by being imported.
 */
function defaultPhoto(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 512
  const g = c.getContext('2d')
  // A 2D context is absent in a headless/jsdom import. Returning the blank
  // canvas keeps this total rather than throwing inside a uniforms factory.
  if (!g) return c
  g.fillStyle = '#0a0718'
  g.fillRect(0, 0, 512, 512)
  const cols = ['#7b3ff2', '#2fd6a8', '#ffb46b', '#d4537e', '#378add']
  // Fixed-seed LCG (Numerical Recipes constants) — see the header.
  let seed = 0x9e3779b9
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < 22; i++) {
    const x = rnd() * 512
    const y = rnd() * 512
    const r = 40 + rnd() * 130
    const grad = g.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, `${cols[i % cols.length]}cc`)
    grad.addColorStop(1, `${cols[i % cols.length]}00`)
    g.fillStyle = grad
    g.fillRect(0, 0, 512, 512)
  }
  return c
}

/**
 * Wrap an image or canvas as the source texture.
 *
 * lilim's `makeTexture`, minus its `VideoTexture` branch — no video source can
 * reach this window yet (F213). `MirroredRepeatWrapping` is load-bearing rather
 * than decorative: `fit()` deliberately samples outside 0..1 at most `fill`
 * settings, and mirroring is what makes that read as a continuation of the
 * picture instead of a smeared edge clamp.
 */
function makeTexture(source: HTMLImageElement | HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.Texture(source)
  tex.wrapS = THREE.MirroredRepeatWrapping
  tex.wrapT = THREE.MirroredRepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/**
 * The one `tSrc` texture object, shared between the main material's
 * `uniforms()` and the sim's `sim.uniforms()`.
 *
 * Both factories are called exactly once each — `getSceneMaterial` and
 * `getSimRT` (`createShaderScene.tsx`) both cache per (renderer, scene id),
 * same as everything else this file relies on for `tSrc`'s own cross-mount
 * persistence (see `syncPhoto`'s own doc). Handing both factories THE SAME
 * texture OBJECT, rather than two separate ones pointed at the same image,
 * means `syncPhoto` only ever has to mutate one thing — its `.image` swap
 * (and, per F218, its `.dispose()`) reaches the sim shader for free, with no
 * second sync path to keep correct.
 *
 * A plain module-level singleton rather than keyed by renderer: this app
 * only ever has one live output-window renderer at a time by construction
 * (see `outputLink.ts`'s own header), and a `THREE.Texture` is safe to share
 * across renderer instances regardless — three tracks each renderer's own
 * GPU-side upload for a texture object independently, so even the rare
 * context-loss-remount case uploads correctly to the new renderer without
 * this needing to change.
 */
let sharedPhotoTex: THREE.Texture | null = null
function sharedPhotoTexture(): THREE.Texture {
  if (!sharedPhotoTex) sharedPhotoTex = makeTexture(defaultPhoto())
  return sharedPhotoTex
}

/**
 * Fragment shader.
 *
 * Exported so the mode test can read the branch numbers out of the real source
 * rather than a copy of it, and so the shader can be compiled outside the app —
 * the roster convention (see `MalachiteScene` / `MatrixRainScene`). Full source
 * is `SHADER_SCENE_PRELUDE + SIMPLEX3D_GLSL + FRAG`.
 *
 * Every uniform declared below is (a) created in `uniforms()`, (b) written in
 * `update()`, and (c) read in this body — audited one at a time, since a
 * mismatch is either a stuck-at-zero or a hard compile error and no tool in
 * this repo catches either. The prelude's `uAspect`, `uMode`, `uKick`,
 * `uAccent`, `uGlow`, `uFade` and `vUv` are consumed here and deliberately NOT
 * redeclared; see the header.
 */
export const FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  // Written by the engine's own sim step (spec.sim, createShaderScene.tsx)
  // whenever melt/mosh's sim actually rendered this frame — see that
  // field's own doc. Only melt/mosh sample it.
  uniform sampler2D tSim;
  uniform float uPhotoAspect, uPhase, uSub, uHighs, uEnergy;
  uniform float uShock, uFall, uTwist, uBreak, uSep, uCells;
  uniform float uComplex, uFill, uContrast;
  uniform float uBreathe, uCrawl, uWobble, uFringe, uRecurse;
  uniform float uSeed, uPulse, uShape;

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * snoise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 4.1);
      a *= 0.5;
    }
    return v;
  }

  // Maps a frame-space point onto the photo. Samples outside 0..1 on purpose --
  // the texture is MirroredRepeat, so the picture continues rather than smears.
  vec2 fit(vec2 p) {
    return p * vec2(1.0 / uPhotoAspect, 1.0) * uFill + 0.5;
  }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(uv);
    vec3 col = vec3(0.0);

    if (uMode == 0) {
      // none: the plain source at full brightness. The whole point is a clean
      // canvas for the lens rack, symmetry, and tiles.
      col = texture2D(tSrc, fit(uv)).rgb;

    } else if (uMode == 1) {
      // smear: domain-warped liquid (the old mirage recipe)
      vec3 P = vec3(uv * 1.3 * uComplex, uPhase);
      float q = fbm(P);
      float w = fbm(P + vec3(q * 1.4 * uComplex, q * 0.9, 0.4));
      float ripple = uShock * 0.12 * sin(r * 9.0 - uPhase * 40.0) * exp(-r * 1.2);
      vec2 duv = uv + (0.16 + uSub * 0.45 + uShock * 0.25) * vec2(q, w)
        + normalize(uv + 1e-4) * ripple
        - uv * uKick * 0.1 * exp(-r * 2.0);
      col = texture2D(tSrc, fit(duv)).rgb;
      col += uAccent * exp(-abs(w) * 5.0) * (0.08 + 0.3 * uHighs);

    } else if (uMode == 2) {
      // droste: log-polar spiral into the image
      float L = 1.1;
      float lr = log(max(r, 1e-4));
      float ang = atan(uv.y, uv.x);
      float k = fract((lr + uFall) / L);
      float rr = exp(k * L) * 0.32;
      float a2 = ang + lr * uTwist;
      vec2 q = rr * vec2(cos(a2), sin(a2));
      q += 0.02 * uComplex * vec2(
        snoise(vec3(q * 3.0, uPhase)),
        snoise(vec3(q * 3.0 + 7.0, uPhase)));
      col = texture2D(tSrc, fit(q)).rgb;
      col *= 0.6 + 0.4 * smoothstep(0.0, 0.35, r);

    } else if (uMode == 3) {
      // infinite: the infinity mirror. Box-nested reflections recede toward the
      // centre, each layer dimmer and pulled toward the palette, a neon frame at
      // every boundary. This exact form is the one locked in lilim ("put it
      // back") -- the translucent-pileup rework lost the look and was reverted.
      // Complexity tightens layer spacing, speed dives (uFall), and a kick sends
      // a light pulse down the tunnel (uPulse is its depth in layers).
      // Depth is measured from the frame edge and stays put; only the layer grid
      // rides uFall, so the dive never darkens the whole tunnel (uFall grows
      // without bound).
      float kk = mix(0.86, 0.72, clamp((uComplex - 0.3) / 1.5, 0.0, 1.0));
      // shape morphs the frame: superellipse norm, 14 reads as a crisp
      // rectangle, 2 is a true circle (the sand plate trick).
      float nrm = mix(14.0, 2.0, clamp(uShape, 0.0, 1.0));
      float axn = abs(uv.x) / (0.5 * uAspect);
      float ayn = abs(uv.y) / 0.5;
      float bt = max(pow(pow(axn, nrm) + pow(ayn, nrm), 1.0 / nrm), 1e-4);
      float L = log(bt) / log(kk);
      float A = L + uFall;
      float li = floor(A);
      float lf = A - li;
      vec2 suv = uv / pow(kk, li - uFall);
      col = texture2D(tSrc, fit(suv)).rgb;
      float depth = max(L, 0.0);
      col *= pow(0.80, depth);
      col = mix(col, uAccent * luma(col) * 1.3, clamp(depth * 0.09, 0.0, 0.55));
      vec3 ink = mix(uGlow, uAccent, mod(li, 2.0));
      col += ink * exp(-lf * 9.0) * (0.30 + 0.5 * uEnergy);
      col += ink * exp(-abs(L - uPulse) * 0.8) * 0.9;

    } else if (uMode == 4) {
      // corridor: one-point perspective hallway, the source papering every wall.
      // z runs away from the camera, a slow sway keeps the eye human, corner
      // seams glow, and kicks send the same light pulse down the hall that
      // infinite uses (uPulse).
      vec2 qn = vec2(uv.x / (0.5 * uAspect), uv.y / 0.5);
      qn.x += sin(uPhase * 0.4) * 0.06;
      float ax2 = max(abs(qn.x), 1e-3);
      float ay2 = max(abs(qn.y), 1e-3);
      bool sideWall = ax2 > ay2;
      float z = 1.0 / max(sideWall ? ax2 : ay2, 1e-3);
      float across = (sideWall ? qn.y : qn.x) * z;
      float along = z * 0.35 + uFall;
      float acrossT = across * 0.5 + 0.5;
      col = texture2D(tSrc, vec2(along, acrossT)).rgb;
      col *= exp(-max(z - 1.0, 0.0) * 0.22);
      float seam = 1.0 - smoothstep(0.0, 0.10, abs(ax2 - ay2));
      col += uAccent * seam * (0.10 + 0.25 * uEnergy);
      vec3 inkC = mix(uGlow, uAccent, mod(floor(along), 2.0));
      col += inkC * exp(-abs(z * 0.35 - uPulse * 0.6) * 1.6) * 0.7;

    } else if (uMode == 5) {
      // cube: flying through closed rooms. The side walls run like the corridor;
      // the back wall approaches, lights up as you reach it, and you pass
      // through into the next room.
      vec2 qn = vec2(uv.x / (0.5 * uAspect), uv.y / 0.5);
      float ax3 = max(abs(qn.x), 1e-3);
      float ay3 = max(abs(qn.y), 1e-3);
      float zSide = 1.0 / max(max(ax3, ay3), 1e-3);
      float roomLen = 2.2;
      float backZ = roomLen * (1.0 - fract(uFall * 0.45)) + 0.35;
      vec3 inkB = mix(uGlow, uAccent, mod(floor(uFall * 0.45), 2.0));
      if (backZ < zSide) {
        vec2 suv = qn * backZ * 0.5;
        col = texture2D(tSrc, fit(suv)).rgb * exp(-(backZ - 0.35) * 0.45);
      } else {
        bool sideWall = ax3 > ay3;
        float across = (sideWall ? qn.y : qn.x) * zSide;
        float along = zSide * 0.35 + uFall;
        float acrossT = across * 0.5 + 0.5;
        col = texture2D(tSrc, vec2(along, acrossT)).rgb * exp(-max(zSide - 1.0, 0.0) * 0.25);
      }
      col += inkB * exp(-(backZ - 0.35) * 9.0) * 0.5;
      col += inkB * exp(-abs(zSide * 0.35 - uPulse * 0.6) * 1.6) * 0.55;

    } else if (uMode == 6) {
      // planet: the picture wrapped on a turning sphere, lit from a bearing each
      // kick moves, palette halo around it. Sub breathes the radius.
      float R = 0.42 * (1.0 + uSub * 0.08);
      vec2 p2 = uv / R;
      float rr2 = dot(p2, p2);
      if (rr2 < 1.0) {
        float z2 = sqrt(1.0 - rr2);
        float lon = atan(p2.x, z2) / 3.14159 * 0.5 + uFall * 0.15;
        float lat = asin(clamp(p2.y, -1.0, 1.0)) / 3.14159 + 0.5;
        float u2 = lon + 0.5;
        col = texture2D(tSrc, vec2(u2, lat)).rgb;
        float bear = uSeed * 2.399963;
        vec3 nrm3 = vec3(p2.x, p2.y, z2);
        vec3 key = normalize(vec3(cos(bear), 0.45, sin(bear)));
        float diff = clamp(dot(nrm3, key), 0.0, 1.0);
        col *= 0.18 + 1.05 * diff;
        col += uAccent * pow(1.0 - z2, 3.0) * (0.2 + 0.4 * uEnergy);
      } else {
        float rlen = sqrt(rr2);
        col = uAccent * exp(-(rlen - 1.0) * 7.0) * (0.12 + 0.25 * uEnergy);
      }

    } else if (uMode == 7) {
      // melt: display the advection simulation. The actual flow/re-stamp
      // physics live in the sim shader (LIMITLESS_SIM_FRAG, via tSim) --
      // this branch only shows its output.
      col = texture2D(tSim, vUv).rgb;

    } else if (uMode == 8) {
      // shatter: voronoi cells fly apart on uBreak
      float cells = uCells;
      vec2 g = uv * cells;
      float f1 = 1e9, f2 = 1e9;
      vec2 bid = vec2(0.0);
      for (int dx = -1; dx <= 1; dx++)
      for (int dy = -1; dy <= 1; dy++) {
        vec2 cid = floor(g) + vec2(float(dx), float(dy));
        vec2 site = cid + hash2(cid);
        float d = length(g - site);
        if (d < f1) { f2 = f1; f1 = d; bid = cid; }
        else if (d < f2) { f2 = d; }
      }
      vec2 h = hash2(bid + 31.7) * 2.0 - 1.0;
      float rotA = (hash2(bid + 57.3).x - 0.5) * (uBreak * 1.6 + sin(uPhase * 3.0 + bid.x + bid.y) * 0.25);
      vec2 ctr = (bid + 0.5) / cells;
      float cs = cos(rotA), sn = sin(rotA);
      vec2 local = ctr + mat2(cs, -sn, sn, cs) * (uv - ctr) - h * uBreak * 0.3;
      col = texture2D(tSrc, fit(local)).rgb;
      float border = smoothstep(0.02, 0.14, f2 - f1);
      col *= 0.3 + 0.7 * border;
      col += uGlow * (1.0 - border) * uBreak * 0.5;

    } else if (uMode == 9) {
      // prism: RGB channels tear apart along the image's own edges
      vec2 e = vec2(0.005, 0.0);
      vec2 grad = vec2(
        luma(texture2D(tSrc, fit(uv + e.xy)).rgb) - luma(texture2D(tSrc, fit(uv - e.xy)).rgb),
        luma(texture2D(tSrc, fit(uv + e.yx)).rgb) - luma(texture2D(tSrc, fit(uv - e.yx)).rgb));
      vec2 disp = grad * uSub * 0.9 * uComplex
        + 0.02 * uComplex * vec2(snoise(vec3(uv * 2.0, uPhase)), snoise(vec3(uv * 2.0 + 5.0, uPhase)));
      vec2 sep = vec2(uSep, uSep * 0.6);
      col.r = texture2D(tSrc, fit(uv + disp + sep)).r;
      col.g = texture2D(tSrc, fit(uv + disp)).g;
      col.b = texture2D(tSrc, fit(uv + disp - sep)).b;

    } else if (uMode == 10) {
      // breathe: the realistic trip. The image never stops being the image;
      // everything is small, slow, and tied to what the picture already contains.
      // slow breathing: the centre swells gently and settles
      vec2 buv = uv * (1.0 - uBreathe * exp(-r * 0.8));
      // the image's own luminance gradient steers everything
      vec2 e2 = vec2(0.006, 0.0);
      vec2 g2 = vec2(
        luma(texture2D(tSrc, fit(buv + e2.xy)).rgb) - luma(texture2D(tSrc, fit(buv - e2.xy)).rgb),
        luma(texture2D(tSrc, fit(buv + e2.yx)).rgb) - luma(texture2D(tSrc, fit(buv - e2.yx)).rgb));
      float gm = length(g2);
      // pattern crawl: flow ALONG iso-luminance contours, phase oscillates so
      // the texture never walks away from itself
      vec2 tang = vec2(-g2.y, g2.x) / max(gm, 1e-4);
      float crawlPh = snoise(vec3(buv * 3.0 * uComplex, uPhase * 0.6));
      vec2 crawl = tang * uCrawl * crawlPh * smoothstep(0.005, 0.06, gm);
      // edge wobble: contours shimmy where contrast is high
      vec2 wob = vec2(
        snoise(vec3(buv * 6.0, uPhase * 0.8)),
        snoise(vec3(buv * 6.0 + 11.0, uPhase * 0.8)))
        * uWobble * smoothstep(0.01, 0.12, gm);
      vec2 duv = buv + crawl + wob;
      // the occasional slide toward recursion and back
      vec2 fuv = mix(duv, duv * 0.62, uRecurse);
      // chromatic fringe across the gradient, rides the energy
      vec2 fr = (g2 / max(gm, 1e-4)) * uFringe;
      col.r = texture2D(tSrc, fit(fuv + fr)).r;
      col.g = texture2D(tSrc, fit(fuv)).g;
      col.b = texture2D(tSrc, fit(fuv - fr)).b;

    } else if (uMode == 11) {
      // mosh: the sim accumulates where the source moves (tSim.rg is a
      // displacement field); sampling tSrc through that field drags the
      // picture's own motion into smears. A little chromatic dispersion
      // rides the drag direction, the same move the lens rack's own
      // dispersion makes.
      vec2 off = texture2D(tSim, vUv).rg;
      float dm = length(off);
      vec2 dir = dm > 1e-5 ? off / dm : vec2(0.0);
      vec2 duv2 = uv + off;
      col.r = texture2D(tSrc, fit(duv2 + dir * dm * 0.08)).r;
      col.g = texture2D(tSrc, fit(duv2)).g;
      col.b = texture2D(tSrc, fit(duv2 - dir * dm * 0.08)).b;
      col += uAccent * min(1.0, dm * 5.0) * (0.06 + 0.22 * uHighs);

    } else if (uMode == 12) {
      // sort: bright runs stretch into sorted streaks down their columns.
      // Threshold and cut points re-roll per kick (uSeed).
      float cols = 22.0 + 70.0 * clamp((uComplex - 0.3) / 1.5, 0.0, 1.0);
      float id = floor(vUv.x * cols);
      vec2 hh = hash2(vec2(id, uSeed));
      float th = 0.20 + 0.45 * hh.x;
      float dir = hh.y < 0.85 ? 1.0 : -1.0;
      float run = 0.0;
      vec3 mx = vec3(0.0);
      float mxl = -1.0;
      for (int i = 0; i < 24; i++) {
        vec2 q = uv + vec2(0.0, dir * float(i) * 0.016);
        vec3 sv = texture2D(tSrc, fit(q)).rgb;
        float l = luma(sv);
        if (l > th) {
          run += 1.0;
          if (l > mxl) { mxl = l; mx = sv; }
        } else { break; }
      }
      float stretch = run / 24.0;
      vec2 duv = uv + vec2(0.0, dir * stretch * (0.08 + 0.30 * uSub + 0.30 * uShock));
      col = texture2D(tSrc, fit(duv)).rgb;
      col = mix(col, mx, stretch * 0.55);
      col += uGlow * stretch * 0.10;

    } else if (uMode == 13) {
      // thresh: screen-print posterize. Luminance slams into flat bands while
      // every pixel keeps its own hue, with an inked contour where bands meet.
      // Complexity sweeps the level count; a kick knocks it toward two for a
      // beat, the hard poster snap.
      vec3 s = texture2D(tSrc, fit(uv)).rgb;
      float l = luma(s);
      float lv = floor(2.0 + clamp((uComplex - 0.3) / 1.5, 0.0, 1.0) * 5.0);
      lv = max(2.0, lv - floor(uShock * 3.0));
      float ql = (floor(l * lv) + 0.5) / lv;
      col = s * (ql / max(l, 1e-3));
      float band = fract(l * lv);
      float ew = fwidth(l * lv) * 1.5 + 1e-4;
      float line = 1.0 - smoothstep(0.0, ew, min(band, 1.0 - band));
      col *= 1.0 - line * 0.65;

    } else if (uMode == 14) {
      // solar: solarize. Everything past the threshold flips negative; the
      // threshold wanders slowly so the flipped territory breathes, sub pulls it
      // deeper, and a kick widens the flip for a beat.
      vec3 s = texture2D(tSrc, fit(uv)).rgb;
      float th = 0.5 + 0.18 * sin(uPhase * 0.5) - uSub * 0.12 - uShock * 0.2;
      vec3 m = smoothstep(th - 0.06, th + 0.06, s);
      col = mix(s, 1.0 - s, m);

    } else if (uMode == 15) {
      // halftone: a rotated dot screen, every dot carrying the image's own
      // colour at its cell. Complexity is the pitch, sub swells the dots, kicks
      // click the screen angle.
      float pitch = mix(110.0, 40.0, clamp((uComplex - 0.3) / 1.5, 0.0, 1.0));
      float hAng = 0.26 + uSeed * 2.399963;
      float hc = cos(hAng), hs = sin(hAng);
      vec2 gp = mat2(hc, -hs, hs, hc) * uv * pitch;
      vec2 cellC = floor(gp) + 0.5;
      vec2 cuv = (mat2(hc, hs, -hs, hc) * cellC) / pitch;
      vec3 s = texture2D(tSrc, fit(cuv)).rgb;
      float l = luma(s);
      float rdot = sqrt(max(l, 0.0)) * 0.62 * (1.0 + uSub * 0.22);
      float d = length(fract(gp) - 0.5);
      float m = 1.0 - smoothstep(rdot - 0.09, rdot + 0.03, d);
      col = s * m * 1.18;

    } else {
      // vhs (uMode == 16): tape damage -- tracking wobble, a scrolling tear
      // band, chroma bleeding sideways off a sharp luma, tape speckle, and the
      // head-switch mess at the bottom of the frame. Kicks slam the tracking.
      //
      // The final else rather than an explicit test, matching lilim's own
      // structure (where prism held this position). uMode is written from
      // resolveSceneParams, which clamps an unknown mode to 0, so an
      // out-of-range index cannot reach here.
      float bandV = fract(vUv.y - uPhase * 0.11);
      float trackingB = smoothstep(0.0, 0.05, bandV) * (1.0 - smoothstep(0.07, 0.12, bandV));
      float wob = sin(vUv.y * 700.0 + uPhase * 9.0) * 0.0012 * (1.0 + uSub * 2.0);
      float tear = trackingB * (0.02 + uShock * 0.06)
        * (hash2(vec2(floor(vUv.y * 220.0), floor(uPhase * 7.0))).x - 0.3);
      vec2 vuv = uv + vec2(wob + tear, 0.0);
      vec3 sV = texture2D(tSrc, fit(vuv)).rgb;
      float y0 = luma(sV);
      vec3 cb = (texture2D(tSrc, fit(vuv + vec2(0.006, 0.0))).rgb
               + texture2D(tSrc, fit(vuv + vec2(0.012, 0.0))).rgb
               + texture2D(tSrc, fit(vuv - vec2(0.006, 0.0))).rgb) / 3.0;
      col = vec3(y0) + (cb - vec3(luma(cb))) * 1.15;
      float sp = hash2(floor(vUv * vec2(320.0, 240.0)) + floor(uPhase * 13.0)).x;
      col += vec3(step(0.996 - uHighs * 0.004, sp)) * 0.5;
      float hsw = step(vUv.y, 0.035);
      float hoff = 0.03 * hash2(vec2(floor(uPhase * 11.0), 2.0)).x;
      col = mix(col, texture2D(tSrc, fit(vuv + vec2(hoff, 0.0))).rgb, hsw * 0.9);
      col = col * 0.92 + 0.015;
    }

    // The photo keeps its own colours: never remap the image toward the palette
    // here. The palette rides only the additive accents above. (A riso print
    // mode broke this rule deliberately for one day in lilim and was cut on
    // feel; the rule stands.)
    //
    // liveF was max(uLive, uMode == 0 ? 1.0 : 0.0) in lilim, where uLive marked
    // a camera feed holding a normal-exposure baseline at rest. No camera source
    // can reach this window (F213), so uLive is gone and this is what it
    // collapses to: 'none' alone keeps full brightness, every physics mode takes
    // the full energy sweep.
    float liveF = uMode == 0 ? 1.0 : 0.0;
    col *= mix(0.55 + 0.75 * uEnergy, 1.0 + 0.22 * uEnergy, liveF);
    vec3 hi = col * col * (3.0 - 2.0 * col);
    vec3 lo = pow(max(col, 0.0), vec3(0.72));
    col = mix(col, hi, max(0.0, uContrast - 0.5) * 1.6);
    col = mix(col, lo, max(0.0, 0.5 - uContrast) * 1.6);
    col *= 1.0 - 0.2 * smoothstep(0.6, 1.15, r);
    gl_FragColor = vec4(clamp(col, 0.0, 1.15) * uFade, 1.0);
  }
`

/**
 * melt/mosh's sim shader — ported near-verbatim from lilim's own `simQuad`
 * fragment (`lilim/scenes/limitless.js:592-704`, the `uSimMode == 0`/`== 1`
 * branches only; lilim's `scanline`/`windows`/`coral` branches from that
 * same shader are not ported, see the header on why).
 *
 * Fully self-contained — see `ShaderSceneSpec.sim`'s own doc in
 * `createShaderScene.tsx` on why: no prelude, so every uniform (including
 * `tPrev`, which the engine auto-binds to last frame's result before this
 * runs) is declared here.
 *
 * `fitS()` is `fit()` from the main shader, copied rather than shared (a
 * separate `ShaderMaterial` cannot `#include` a sibling's GLSL function) —
 * kept in sync by hand, same discipline `PostFXChain`'s own duplicated
 * helpers already require in this codebase. lilim's own version of this
 * function also multiplied in a `uFlipX` term; dropped here for the same
 * reason the main shader's `fit()` already dropped it (see the header — no
 * camera source reaches this window, F213).
 */
export const LIMITLESS_SIM_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tPrev, tSrc;
  uniform float uPhotoAspect, uAspect, uPhase, uFlow, uStamp, uFill;
  uniform int uSimMode;
  varying vec2 vUv;

  vec2 fitS(vec2 p) {
    return p * vec2(1.0 / uPhotoAspect, 1.0) * uFill + 0.5;
  }
  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    // A slow, drifting flow field both modes below read from — ported
    // verbatim from lilim, which is where the constants come from.
    vec2 fl = vec2(
      sin(p.y * 3.1 + uPhase * 1.3) + 0.6 * cos(p.x * 4.7 - uPhase),
      sin(p.x * 3.7 - uPhase) + 0.6 * cos(p.y * 4.1 + uPhase * 0.8));

    if (uSimMode == 0) {
      // melt: advect history toward the flow, stamp the source back in on
      // kicks (uStamp). The 0.997 decay keeps the advected image from
      // building unbounded contrast over many frames of repeated blending.
      vec3 prev = texture2D(tPrev, vUv - fl * 0.0016 * uFlow).rgb * 0.997;
      vec3 src = texture2D(tSrc, fitS(p)).rgb;
      gl_FragColor = vec4(mix(prev, src, uStamp * 0.35 + 0.0025), 1.0);

    } else {
      // mosh (uSimMode == 1): normal-flow accumulation. rg holds a
      // displacement field, b remembers last frame's luminance. Where the
      // source's own luminance is changing, its local luminance gradient
      // steers a small optical-flow estimate that accumulates into the
      // field; a kick (uStamp) zeroes it back to a clean keyframe. A
      // whisper of the melt flow field keeps a still photo faintly alive.
      vec4 prev = texture2D(tPrev, vUv);
      float ln = lum(texture2D(tSrc, fitS(p)).rgb);
      vec2 e = vec2(0.006, 0.0);
      vec2 g = vec2(
        lum(texture2D(tSrc, fitS(p + e.xy)).rgb) - lum(texture2D(tSrc, fitS(p - e.xy)).rgb),
        lum(texture2D(tSrc, fitS(p + e.yx)).rgb) - lum(texture2D(tSrc, fitS(p - e.yx)).rgb));
      float It = ln - prev.b;
      vec2 v = -It * g / (dot(g, g) + 0.015);
      vec2 off = prev.rg * 0.985
        + clamp(v, vec2(-0.06), vec2(0.06)) * uFlow * 0.35
        + fl * 0.00035 * uFlow;
      off *= 1.0 - uStamp;
      off = clamp(off, vec2(-0.45), vec2(0.45));
      gl_FragColor = vec4(off, ln, 1.0);
    }
  }
`

/**
 * Per-instance mutable state.
 *
 * Every field here was a module-level `let` in lilim, which is single-instance
 * by construction. This engine can mount the same scene twice at once (as a
 * layer while it is also the outgoing half of a crossfade, or in two slots), and
 * a shared accumulator would have both instances advancing one phase at double
 * rate — see `ShaderSceneContext.st`'s own doc.
 *
 * lilim's `stamp`, `simOwner`, `scroll`, `ripplePos`, `rippleAmt`, `splatAng`
 * and `splat` are all absent: every one of them existed only to drive the sim
 * or terrain modes, which are not ported (F212).
 */
interface LimitlessState {
  /** Speed-scaled, audio-reactive phase. lilim's `phase`. */
  phase: number
  /** Slewed `s.mids` — feeds `phase`'s own reactive swing. Found in a
   *  systematic audit (2026-09-11) for the "raw band drives an accumulating
   *  rate" pattern already fixed live twice this session (GyroidFluxScene,
   *  JavaZoneLatticeScene). */
  midsEnv: number
  /** Kick shock, decaying — smear ripple, sort stretch, thresh/solar/vhs. */
  shock: number
  /** The dive, unbounded — droste, infinite, corridor, cube. */
  fall: number
  /** Slewed `s.sub` — feeds `fall`'s swing and `pulseDepth`'s dive rate,
   *  same audit as `midsEnv` above. Shared between the two since both read
   *  the same band. */
  subEnv: number
  /** droste twist, and the target it eases toward. */
  twist: number
  twistTarget: number
  /** shatter explode envelope. Reassembles in QUIET, not on a fixed decay. */
  breakEnv: number
  /** prism tear burst. */
  sepBurst: number
  /** breathe: the slow lung. */
  lungPhase: number
  /** breathe: the rare recursion slide, and the target that drains into it. */
  recurse: number
  recurseTgt: number
  /** breathe: when the last slide fired, so it stays an occasion, not a tic. */
  lastSlide: number
  /** Kick counter. Feeds `uSeed` (sort cuts, halftone angle, planet bearing)
   *  and the deterministic droste twist leap. lilim's `sortSeed`. */
  seed: number
  /** infinite/corridor/cube's travelling light, parked far below zero. */
  pulseDepth: number
  /** melt/mosh's shared re-stamp/reset envelope. 1.5 forces a fresh re-seed
   *  from `tSrc`; decays toward 0 the same way `st.shock` does. lilim's
   *  `stamp`, shared across every sim-buffer mode there — here it is only
   *  ever melt or mosh, which is why one field (not a map) is enough. */
  stamp: number
  /** Which mode ('melt' | 'mosh' | '') last owned the sim buffer — a
   *  mismatch forces a re-stamp so switching between them (or away and
   *  back) never blends into whatever state the buffer was left holding.
   *  lilim's `simOwner`. */
  simOwner: string
  /**
   * The `limitlessPhoto` value this instance last acted on.
   *
   * `undefined` — not `null` — before the first frame, so the first frame
   * always syncs. That matters because the material (and therefore `tSrc`) is
   * cached across mounts by `getSceneMaterial`, so a remount can inherit a
   * texture from a previous mount's photo, and comparing against `null` would
   * skip the resync and leave a stale picture on screen.
   */
  photoUrl: string | null | undefined
  /** Bumped per decode so a slow image that resolves late cannot overwrite a
   *  newer one. */
  photoToken: number
}

/**
 * Take the photo from the store onto the GPU, if it changed.
 *
 * Runs every frame; on an unchanged photo that is one string comparison and
 * nothing else. `useStore.getState()` rather than a subscription because this
 * is a per-frame callback outside React — the same one-shot read
 * `GradePass`/`PostFXChain` use for palette state.
 *
 * The texture OBJECT is created once in `uniforms()` and then REUSED — only
 * its `.image` is swapped. That is deliberate: `tSrc` lives in a material
 * shared across simultaneous mounts, so allocating a replacement TEXTURE
 * OBJECT per photo raises an ownership question (which instance may dispose
 * the outgoing one, and is the other still pointing at it) that swapping the
 * image simply does not have.
 *
 * `tex.dispose()` right before every swap IS still required, though, and for
 * a completely different reason than object ownership: found live (F218) by
 * dropping a real, non-square photo and watching the browser's own GL log,
 * not by reading the code. Once a WebGL2 texture has been uploaded once, three
 * reuses its EXISTING, FIXED-SIZE GPU storage on every later `needsUpdate` —
 * `texSubImage2D` into the old allocation — rather than reallocating for the
 * new image's own size. That is a legitimate fast path for something like a
 * same-resolution video frame; it silently breaks the moment the swapped-in
 * image is a DIFFERENT size than whatever was uploaded before, which for a
 * user-dropped photo is the common case, not the exception — the placeholder
 * this starts on is a fixed 512x512 (`defaultPhoto()`), and almost no real
 * photo shares that. The old, now-too-small allocation cannot hold the new
 * pixels, the driver logs `GL_INVALID_VALUE: ...Offset overflows texture
 * dimensions` and drops the write, and — because a failed GPU upload throws
 * nothing catchable — `tex.image` and `uPhotoAspect` both update correctly
 * while the SCREEN keeps showing whatever was uploaded last, looking exactly
 * like the sync never happened at all. `dispose()` clears three's cached GPU
 * handle for this texture, forcing the next upload to allocate fresh at the
 * new image's real size instead of writing into the old one.
 */
function syncPhoto(u: Record<string, THREE.IUniform>, st: LimitlessState): void {
  const url = useStore.getState().limitlessPhoto
  if (url === st.photoUrl) return
  st.photoUrl = url
  const token = ++st.photoToken
  const tex = u.tSrc.value as THREE.Texture | null
  if (!tex) return

  if (!url) {
    // Back to the generated placeholder. Deterministic, so this is byte-for-byte
    // the picture the scene booted with — see defaultPhoto()'s own note.
    tex.dispose()
    tex.image = defaultPhoto()
    tex.needsUpdate = true
    u.uPhotoAspect.value = 1
    return
  }

  const img = new Image()
  img.onload = () => {
    // A newer photo (or a clear) landed while this one was decoding.
    if (st.photoToken !== token) return
    tex.dispose()
    tex.image = img
    tex.needsUpdate = true
    const w = img.naturalWidth || img.width || 1
    const h = img.naturalHeight || img.height || 1
    u.uPhotoAspect.value = w / h
  }
  // A corrupt or oversized data URL leaves the previous picture up rather than
  // blanking the show. The console is the surface that reports a bad file.
  img.onerror = () => {}
  img.src = url
}

export const LimitlessScene = createShaderScene<LimitlessState>({
  id: 'limitless',
  frag: FRAG,
  // `snoise(vec3)` — the same signature lilim's own NOISE_GLSL provided, so
  // `fbm()`, droste, breathe and prism port with no call-site edits. This
  // repo's shared `NOISE_GLSL` is 2D-only and could not have served them.
  include: SIMPLEX3D_GLSL,
  // The scene paints every pixel including its own ground, so replace rather
  // than blend — same as `malachite`/`snowflake`. Governs the OFFSCREEN
  // material here (the budgeted path); `BlendedLayer` owns the on-screen one.
  blending: THREE.NoBlending,
  // NOT /bench-measured. The dominant mode is `smear`: two fbm(vec3) calls =
  // EIGHT true simplex-3D evaluations per pixel, and `SIMPLEX3D_GLSL`'s own doc
  // prices one of those well above a cheap hash-noise sample. Against
  // `malachite`'s measured 0.76 ms for up to 25 hash-noise samples at a 1.3 MP
  // budget, smear lands in the same order of magnitude but above it. The other
  // expensive mode is `sort` (up to 24 texture taps in a bounded loop, but
  // cache-coherent — it walks 0.016 in y — and it breaks early on most pixels);
  // `shatter` does a 3x3 voronoi search (~11 hash2); everything else is one to
  // seven texture fetches and closed-form maths. No mode raymarches.
  //
  // So: cheap relative to `maze`/`beats`, but NOT cheap enough to justify
  // omitting a budget — at a native 8.29 MP the smear estimate runs to several
  // milliseconds on its own. 1.8 MP is deliberately generous (above
  // `malachite`'s 1.3 and `nebula`'s 1.6) because this is a PHOTO scene and
  // softness is more visible on a photograph than on a noise field; it still
  // holds the worst mode well inside the tier-0 admission bar. See the
  // SCENE_COST_MS row for the arithmetic.
  //
  // A per-mode function budget is the obvious refinement — `none`/`solar`/
  // `halftone` are one texture fetch and would happily run at native
  // resolution while `smear` would not — and `createShaderScene` supports it
  // (see `MazeFlightScene`). Deliberately not done tonight: it cannot be
  // tuned without looking at it. Logged as F214.
  //
  // Also NOT accounted for here: melt/mosh's own sim pass (`spec.sim`,
  // added this session for F212) is a SEPARATE fullscreen render, sized off
  // lilim's own 0.6x-drawing-buffer choice independently of this budget —
  // see `createShaderScene.tsx`'s own doc on `sim`. Only pays its cost while
  // melt or mosh is the actual active mode (`sim.update` returns `false`
  // otherwise, skipping the render entirely), so it does not raise the
  // estimate above for the other 15 modes — but a real `/bench` pass should
  // measure melt/mosh specifically with this in mind, not assume the same
  // number covers every mode.
  pixelBudget: 1.8,
  uniforms: () => ({
    // Lazily created (touches the DOM, allocates a texture — a
    // lazily-imported scene chunk must cost nothing merely by being
    // imported) and shared with `sim.uniforms()` below — see
    // `sharedPhotoTexture`'s own doc for why they must be the SAME object.
    tSrc: { value: sharedPhotoTexture() },
    // Written every frame by the engine's own sim step (createShaderScene's
    // `spec.sim` support) whenever melt/mosh actually rendered this frame —
    // see `sim.update` below, which skips the render (and leaves this at
    // its last value) on every other mode.
    tSim: { value: null },
    uPhotoAspect: { value: 1 },
    uPhase: { value: 0 },
    uSub: { value: 0 },
    uHighs: { value: 0 },
    uEnergy: { value: 0 },
    uShock: { value: 0 },
    uFall: { value: 0 },
    uTwist: { value: 0.4 },
    uBreak: { value: 0 },
    uSep: { value: 0.005 },
    uCells: { value: 8 },
    uComplex: { value: 1 },
    uFill: { value: 0.75 },
    uContrast: { value: 0.5 },
    uBreathe: { value: 0 },
    uCrawl: { value: 0.012 },
    uWobble: { value: 0.004 },
    uFringe: { value: 0.002 },
    uRecurse: { value: 0 },
    uSeed: { value: 0 },
    uPulse: { value: -30 },
    uShape: { value: 0 },
  }),
  sim: {
    frag: LIMITLESS_SIM_FRAG,
    uniforms: () => ({
      // The SAME texture object `uniforms()` above uses — see
      // `sharedPhotoTexture`'s own doc.
      tSrc: { value: sharedPhotoTexture() },
      uPhotoAspect: { value: 1 },
      uAspect: { value: 1 },
      uPhase: { value: 0 },
      uFlow: { value: 1 },
      uStamp: { value: 1.5 },
      uFill: { value: 0.75 },
      uSimMode: { value: 0 },
    }),
    update({ u, mainU, s, P, st, dt }) {
      // Only melt/mosh ever sample tSim — every other mode pays nothing for
      // this pass beyond the uniform writes below, `false` skips the actual
      // render (see createShaderScene.tsx's own doc on the return value).
      const isMosh = P.mode === 'mosh'
      if (!isMosh && P.mode !== 'melt') return false

      // Switching modes — including melt <-> mosh, which share one buffer —
      // always re-stamps from tSrc, the same reseed lilim's own `ensureSim`/
      // `simOwner` check does, so stale state from whichever mode last owned
      // the buffer never bleeds into the other.
      if (st.simOwner !== P.mode) {
        st.simOwner = P.mode
        st.stamp = 1.5
      }
      if (s.onKick) st.stamp = Math.min(1.5, st.stamp + 1.2 * s.onKick) // re-stamp / keyframe
      st.stamp *= Math.exp(-dt * 4.5)

      const spF = drastic(P.speed)
      const cxF = 0.3 + 1.5 * P.complexity
      u.uSimMode.value = isMosh ? 1 : 0
      // mainU's own uPhotoAspect/uAspect, not re-derived: `uPhotoAspect` is
      // set once per photo by `syncPhoto` (main `update`, below) and
      // `uAspect` by the engine from the render-buffer size — both already
      // correct on mainU, and re-reading them here (rather than duplicating
      // the write) can only ever lag by the one frame this same-tick photo
      // swap ordering already costs elsewhere in this file.
      u.uPhotoAspect.value = mainU.uPhotoAspect.value
      u.uAspect.value = mainU.uAspect.value
      // lilim's sim ran its own phase 6x the main one — a faster flow field
      // than the rest of the scene's motion, ported as-is.
      u.uPhase.value = st.phase * 6.0
      u.uFlow.value = (0.5 + s.sub * 2.2) * spF * cxF
      u.uStamp.value = Math.min(1, st.stamp)
      u.uFill.value = 1.15 - 0.8 * P.fill
      return true
    },
  },
  state: () => ({
    phase: 0,
    midsEnv: 0,
    shock: 0,
    fall: 0,
    subEnv: 0,
    twist: 0.4,
    twistTarget: 0.4,
    breakEnv: 0,
    sepBurst: 0,
    lungPhase: 0,
    recurse: 0,
    recurseTgt: 0,
    lastSlide: -30,
    seed: 0,
    pulseDepth: -30,
    stamp: 1.5,
    simOwner: '',
    photoUrl: undefined,
    photoToken: 0,
  }),
  update({ u, s, P, st, dt, t }) {
    const spF = drastic(P.speed)
    const cxF = 0.3 + 1.5 * P.complexity
    // Both bands slewed before they multiply into an accumulator — see
    // `midsEnv`/`subEnv`'s own doc for why.
    st.midsEnv = slew(st.midsEnv, s.mids, dt, 3, 3)
    st.subEnv = slew(st.subEnv, s.sub, dt, 3, 3)
    st.phase += dt * (0.035 + st.midsEnv * 0.09) * spF

    syncPhoto(u, st)

    // uMode is NOT written here — the engine writes P.modeIndex into it every
    // frame (see useShaderCore's runFrame), which is the whole reason this
    // port's branch numbers are array indices rather than lilim's MODE_IDX.
    u.uPhase.value = st.phase
    u.uComplex.value = cxF
    u.uFill.value = 1.15 - 0.8 * P.fill
    u.uContrast.value = P.contrast
    u.uShape.value = P.shape
    u.uSub.value = s.sub
    u.uHighs.value = s.highs
    u.uEnergy.value = s.energy

    // Per-mode structural state.
    if (s.onKick) {
      st.shock = Math.min(1.2, st.shock + 0.9 * s.onKick) // smear
      st.seed += 1 // sort re-cut / halftone angle / planet bearing
      // droste twist leap. lilim rolled magnitude and sign with two
      // Math.random() calls; both are hashed off the kick counter instead so a
      // recorded show replays identically. Same range and sign distribution.
      const hMag = hash11(st.seed)
      const hSign = hash11(st.seed + 101.7)
      st.twistTarget += (0.25 + hMag * 0.5) * s.onKick * (hSign < 0.5 ? -1 : 1)
      st.breakEnv = Math.min(1, st.breakEnv + 0.7 * s.onKick) // shatter explode
      st.sepBurst = Math.min(1, st.sepBurst + 0.8 * s.onKick) // prism tear
      st.pulseDepth = 0 // infinite/corridor/cube light dive
    }
    st.shock *= Math.exp(-dt * 2.2)
    st.breakEnv *= Math.exp(-dt * (0.4 + (1 - s.energy) * 1.6)) // reassembles in quiet
    st.sepBurst *= Math.exp(-dt * 3.5)
    st.fall += dt * (0.1 + st.subEnv * 0.45) * spF
    st.twist += (st.twistTarget - st.twist) * (1 - Math.exp(-dt * 4))

    // breathe: the lung follows a slow LFO, sub deepens each inhale. A strong
    // accent after a long rest starts the recursion slide; the target then
    // drains so the frame eases back out on its own.
    st.lungPhase += dt * (0.5 + s.sub * 0.35) * spF
    if (P.mode === 'breathe' && s.onKick > 0.55 && t - st.lastSlide > 9) {
      st.lastSlide = t
      st.recurseTgt = 0.45
    }
    st.recurseTgt *= Math.exp(-dt * 0.22)
    st.recurse += (st.recurseTgt - st.recurse) * (1 - Math.exp(-dt * 0.9))
    u.uBreathe.value = (0.018 + s.sub * 0.045) * (0.5 + 0.5 * Math.sin(st.lungPhase))
    u.uCrawl.value = (0.008 + 0.02 * P.complexity) * (0.5 + s.energy * 0.8)
    u.uWobble.value = 0.003 + s.highs * 0.007
    u.uFringe.value = 0.0015 + s.energy * 0.005 + s.kick * 0.002
    u.uRecurse.value = st.recurse

    u.uShock.value = st.shock
    u.uFall.value = st.fall
    u.uTwist.value = st.twist * (0.3 + 1.7 * P.complexity)
    u.uBreak.value = st.breakEnv
    u.uSep.value = (0.003 + s.highs * 0.014 + st.sepBurst * 0.02) * cxF
    u.uCells.value = 4 + Math.round(P.complexity * 10)
    u.uSeed.value = st.seed
    if (st.pulseDepth > -30) {
      st.pulseDepth += dt * (4 + st.subEnv * 4) * spF
      if (st.pulseDepth > 40) st.pulseDepth = -30
    }
    u.uPulse.value = st.pulseDepth
  },
})

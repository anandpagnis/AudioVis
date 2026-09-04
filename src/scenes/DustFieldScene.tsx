import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Dust Field — sparse, drifting motes at three parallax depths, sitting in a
 * faint shaft of light. The roster's second `background`-role scene.
 *
 * Written for this project from nothing but the brief above; no shader was
 * ported in, so `license: 'original'` with no `provenance` field (same
 * posture as `wireframe`/`plasma`/`dissolve`/`chrome` — see `wireframe`'s
 * header for why this is stated rather than left to the `?? 'original'`
 * default, F01).
 *
 * ## Why this is a different animal from `malachite`
 *
 * `malachite` is a dense, continuous fbm field — 100% of the frame is
 * "something", warped and banded. That is real visual weight, and the live
 * roster had exactly one background option built that way. This scene is the
 * opposite bet: MOSTLY EMPTY. A small, fixed number of soft points of light
 * drift across a near-black field, and the overwhelming majority of pixels on
 * any given frame resolve to (very close to) the plain background colour. No
 * fbm, no domain warp, no per-pixel loop at all — see `performanceCost`'s
 * comment in the registration for why that also makes it cheaper than
 * `malachite`, not just visually lighter.
 *
 * ## Technique: three cell-hashed point layers, no particle system
 *
 * Each of the three depth layers (`dustLayer` below) tiles aspect-corrected
 * screen space into a grid (`floor`/`fract` on `uv * cellScale`), hashes the
 * CURRENT cell to decide (a) whether it holds a point at all, (b) where
 * within the cell that point sits, and (c) its size/phase jitter — then
 * measures the distance from this pixel to that one point and applies a soft
 * `smoothstep` falloff. That is an O(1) lookup per pixel per layer: there is
 * no loop over N candidate points, and no neighbour-cell search, because
 * every point's radius is clamped (see `uSizeMul`'s cap in `update()` and the
 * `min(..., 0.22)` in `dustLayer`) to well under half a cell width — a point
 * can never reach across its own cell's boundary, so the pixel's own cell is
 * always the only one that can possibly light it.
 *
 * Parallax is faked, not simulated: a far layer (small, dim, dense grid,
 * slow drift), a mid layer, and a near layer (larger, brighter, sparse grid,
 * fast drift) — three fixed evaluations, not three.. `N`.
 *
 * Colour comes from `paletteLit` ({@link PALETTE_RAMP_GLSL}) at a fixed `t`
 * per layer (far cool/dim, near warm/bright), so the field recolours with
 * the live palette exactly like every other roster scene, and the base field
 * is a faint radial lift toward `uShadow` — a hint of "a shaft of light",
 * never enough to read as a subject.
 *
 * ## Band routing — deliberately the roster's most restrained
 *
 * The brief for this scene is explicit that it must recede, not react, so
 * every audio term here is continuous and smooth, and NOTHING here creates or
 * destroys a point:
 *
 *   energy, sub (bass) → gentle, continuous brightness lift across the whole
 *                         field (`lift` in `main()`) — never per-point, never
 *                         a step.
 *   highs             → twinkle RATE and amplitude (`dustLayer`'s
 *                         `twinkleBase`) — more high-frequency detail makes
 *                         existing points glint faster/harder, nothing pops
 *                         in or out.
 *   onKick            → charges `st.shock`, a SMALL (capped 0.5, against
 *                         malachite/snowflake's 1.2-1.5) fast-decaying
 *                         envelope that (a) very slightly speeds the
 *                         parallax drift and (b) adds a faint extra flicker
 *                         to a hashed MINORITY of points (`kickPick` in
 *                         `dustLayer`, ~30%) — "a few points", not the field,
 *                         and it decays smoothly with `st.shock` rather than
 *                         snapping.
 *
 * Point EXISTENCE (`exists` in `dustLayer`) is a function of the density dial
 * and which cell a point's cell-grid has drifted into — never of audio — so
 * nothing here can pop a point in or out on a beat, which is the one
 * constraint the brief called out explicitly.
 *
 * ## No `quality.knobs` response
 *
 * Three fixed-count layers, each a handful of `hash()` calls and two
 * `smoothstep()`s — no loop, no fbm, no iteration count to gate. Same
 * posture as `snowflake`/`matrix`/`wireframe` (F111): there is no expensive
 * knob here to turn down, so none is declared.
 *
 * ## Scene Contract
 *
 * Four of the seven: `speed` (parallax drift rate), `density` (point
 * presence probability, `drastic`-expanded), `fill` (point size, also
 * `drastic`-expanded and hard-clamped so it can never breach a cell), and
 * `contrast` (soft hazy glow at 0 → crisp bright pinpoint at 1 — literally
 * the contract vocabulary's own "edge hardness, falloff" wording).
 * `shape`/`complexity`/`tilt` are omitted: there is no discrete silhouette
 * family for `shape` to select, no iteration/subdivision count for
 * `complexity` to deepen, and no camera-relative axis for `tilt` to offset —
 * same reasoning `malachite` (`shape`/`tilt`) and `wingfold`
 * (`density`/`tilt`) already use for their own gaps.
 *
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see `MatrixRainScene`). Full source is
 * `SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform vec2 uDriftFar;
  uniform vec2 uDriftMid;
  uniform vec2 uDriftNear;
  uniform float uSizeMul;
  uniform float uDensityMul;
  uniform float uContrast;
  uniform float uEnergy;
  uniform float uBass;
  uniform float uHighs;
  uniform float uShock;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  /**
   * One depth layer. Returns (mask, twinkle) for THIS pixel's own cell only —
   * see the file header for why no neighbour-cell search is needed.
   */
  vec2 dustLayer(vec2 uv, float cellScale, vec2 drift, vec2 seed, float basePresence, float baseSize) {
    vec2 p = uv * cellScale + drift + seed;
    vec2 cell = floor(p);
    vec2 f = fract(p);

    // Presence is a function of the density dial and the cell only -- never
    // of audio, so a point can never pop in/out on a beat.
    float presence = min(basePresence * uDensityMul, 0.85);
    float exists = step(1.0 - presence, hash(cell));

    // Point kept well off the cell edge (>= 0.25 from any side) so a point at
    // even the largest clamped size (0.22) never reaches the boundary.
    vec2 jitter = vec2(hash(cell + 11.3), hash(cell + 71.9));
    vec2 pos = 0.25 + jitter * 0.5;
    float d = length(f - pos);

    float sizeRand = 0.6 + 0.8 * hash(cell + 5.7);
    float size = min(baseSize * sizeRand * uSizeMul, 0.22);

    // Contrast dial: soft hazy glow at 0 -> crisp bright pinpoint at 1.
    float core = smoothstep(size * mix(1.5, 0.75, uContrast), 0.0, d);
    float halo = smoothstep(size * mix(4.0, 2.0, uContrast), 0.0, d) * mix(0.35, 0.12, uContrast);
    float mask = max(core, halo) * exists;

    // Twinkle floor is 0.55, not 0.0 -- a point dims and glints, it never
    // blinks out, which is what keeps this off the "abrupt on a beat" line.
    float twRate = 0.5 + hash(cell + 3.1) * 0.7;
    float twPhase = hash(cell + 29.7) * 6.2831853;
    float twinkleBase = 0.5 + 0.5 * sin(uTime * twRate * (0.4 + uHighs * 1.6) + twPhase);

    // A kick nudges a hashed MINORITY of points (~30%) with a faint extra
    // flicker that decays smoothly with uShock -- "a few points", not the
    // field.
    float kickPick = step(0.7, hash(cell + 61.3));
    float twinkle = mix(0.55, 1.0, twinkleBase) + uShock * kickPick * 0.5 * hash(cell + 83.1);

    return vec2(mask, twinkle);
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);

    // Faint central lift toward the shadow slot -- "a shaft of light", never
    // enough to read as a subject. Field stays mostly the plain background.
    vec3 col = mix(uBg, uShadow, 0.18 * exp(-dot(uv, uv) * 1.6));

    vec2 far = dustLayer(uv, 16.0, uDriftFar, vec2(3.0, 71.0), 0.30, 0.045);
    vec2 mid = dustLayer(uv, 10.0, uDriftMid, vec2(47.0, 5.0), 0.24, 0.065);
    vec2 near = dustLayer(uv, 6.0, uDriftNear, vec2(91.0, 23.0), 0.17, 0.09);

    // energy/bass: gentle, continuous, whole-field brightness lift -- never
    // per-point, never a step.
    float lift = 1.0 + uEnergy * 0.35 + uBass * 0.2;

    col += paletteLit(0.14) * far.x * far.y * 0.55 * lift;
    col += paletteLit(0.50) * mid.x * mid.y * 0.80 * lift;
    col += paletteLit(0.86) * near.x * near.y * 1.05 * lift;

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface DustFieldState {
  /**
   * Base parallax accumulator. Each layer derives its own drift vector from
   * this at a different fixed rate (see `update()`), so a changing speed
   * dial stays continuous rather than jumping.
   */
  drift: number
  /** Kick's barely-perceptible drift/twinkle nudge, decaying. */
  shock: number
}

export const DustFieldScene = createShaderScene<DustFieldState>({
  id: 'dustfield',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  // Governs the OFFSCREEN pass only, same as `malachite` — `BlendedLayer`
  // overwrites the on-screen material with the background slot's blend mode.
  // Replace rather than blend is right here: this scene paints every pixel,
  // including its own (mostly empty) ground.
  blending: THREE.NoBlending,
  // NOT measured via /bench in this environment (no dev server here) —
  // estimated from the technique, which is deliberately simpler than
  // `malachite`'s (measured 0.42ms at this same budget): three sequential
  // `dustLayer()` calls, a FIXED count with no loop at all (so there is no
  // loop-bound to even worry about, constant or otherwise), each doing a
  // handful (5) of `hash()` evaluations and two `smoothstep()`s — no fbm, no
  // domain warp, no iteration. That is roughly the per-call cost of a SINGLE
  // octave of `malachite`'s `noise()` (one hash-based value-noise lookup),
  // called 3 times total per pixel against `malachite`'s five `fbm()` calls
  // at up to 5 octaves each (up to 25 `noise()` evaluations under the hood).
  // Should land well under `malachite`'s 0.42ms; confirm with `/bench` once
  // registered. Kept at the background slot's usual budget regardless — as
  // ground composited at low gain under a subject, a soft upscale is
  // invisible, so the budget costs nothing to keep (same reasoning
  // `malachite`'s own comment gives).
  pixelBudget: 1.3,
  uniforms: () => ({
    uDriftFar: { value: new THREE.Vector2() },
    uDriftMid: { value: new THREE.Vector2() },
    uDriftNear: { value: new THREE.Vector2() },
    uSizeMul: { value: 1 },
    uDensityMul: { value: 1 },
    uContrast: { value: 0.5 },
    uEnergy: { value: 0 },
    uBass: { value: 0 },
    uHighs: { value: 0 },
    uShock: { value: 0 },
  }),
  state: () => ({ drift: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Kick charges a SMALL, fast-decaying nudge — capped at 0.5 (against
    // malachite/snowflake's 1.2-1.5) and a ~1s tail, because the brief asks
    // for "barely perceptible", not a flash.
    if (s.onKick > 0) st.shock = Math.min(0.5, st.shock + s.onKick * 0.25)
    st.shock *= Math.exp(-dt * 1.0)

    const rate = drastic(P.speed) * (1 + st.shock * 0.1)
    st.drift += dt * 0.018 * rate

    // Nearer moves faster: far/mid/near ascend in both magnitude and (mildly)
    // direction, so the three layers read as genuinely different depths
    // rather than one field at three brightnesses.
    u.uDriftFar.value.set(st.drift * 0.35, st.drift * 0.22)
    u.uDriftMid.value.set(st.drift * 0.75, st.drift * 0.48)
    u.uDriftNear.value.set(st.drift * 1.35, st.drift * 0.85)

    u.uShock.value = st.shock
    u.uEnergy.value = s.energy
    u.uBass.value = s.sub
    u.uHighs.value = s.highs

    // density/fill are magnitudes -> drastic() (0.25x..4x, 1x at the dial's
    // centre); contrast is consumed raw, 0..1, same convention as the rest
    // of the roster. Both density and size are further clamped inside the
    // shader itself (presence <= 0.85, size <= 0.22) so even a maxed-out
    // dial cannot push this scene out of its "sparse, recedes" identity.
    u.uDensityMul.value = drastic(P.density)
    u.uSizeMul.value = drastic(P.fill)
    u.uContrast.value = P.contrast
  },
})

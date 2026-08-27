import { createShaderScene } from '../engine/createShaderScene'
import { drastic } from '../engine/sceneParams'

/**
 * Matrix Rain — procedural falling-glyph overlay.
 *
 * Adapted from an ISF generator (`procedural-matrix-digital-rain-falling.fs`,
 * credited "ChatGPT, direction fix by Claude") — original code, not a Shadertoy
 * derivative, so it carries no licence encumbrance. Two things changed on the
 * way in:
 *
 * 1. **Colour now comes from the palette**, not a hardcoded green. The source
 *    shader wrote `vec3 green = vec3(0.05, 1.0, 0.15)` directly; this reads
 *    `uMid`/`uGlow` instead, the same move `HeapCorruptionScene` already makes
 *    for its "healthy phosphor" colour (see `col.a` there). Under most palettes
 *    that still reads green-adjacent, and under the rest it recolors instead of
 *    fighting the mix.
 * 2. **It is now audio-reactive.** The source was pure `TIME`-driven with no
 *    band routing at all. `onKick` now overdrives brightness and glow as a
 *    decaying "byte spike"; `mids` nudges fall speed; `highs` add flicker.
 *
 * ## No `pixelBudget`
 *
 * Every other fullscreen-shader scene in the roster (see `MalachiteScene`) opts
 * into an offscreen render at reduced resolution because a *soft* field reads
 * identically whether it was upscaled or not. Glyphs are the opposite case: they
 * are small hard-edged blocks, and downsampling then upscaling turns crisp
 * characters into a grey mush — the one thing that would visibly break this
 * scene's entire premise. It renders at full display resolution.
 *
 * ## Band routing
 *
 *   density (param)    → column count, centred on the source's authored default
 *   complexity (param) → trail persistence ("trail" in the panel) — longer at 1,
 *                         shorter at 0; the source hardcoded this at one value
 *   contrast (param)   → "glow" in the panel: below 0.5 washes the gaps and
 *                         blooms softer, above 0.5 hardens into a crisp,
 *                         punchier leading edge — the doc-standard bipolar
 *                         reading of `contrast`, just aimed at bloom/edge
 *                         hardness instead of a tone curve
 *   mids               → fall-speed drift
 *   highs              → flicker amount
 *   onKick             → decaying brightness/glow overdrive
 */

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see KifsRoseScene). Full source is
 * \`SHADER_SCENE_PRELUDE + FRAG\` (no shared \`include\`; \`hash\`/\`glyph\` are
 * self-contained).
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uShock;
  uniform float uDensity;
  uniform float uTrailRate;
  uniform float uContrast;
  uniform float uEnergy;
  uniform float uHighs;

  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  // 5x7 procedural glyph.
  float glyph(vec2 uv, float id) {
    uv *= vec2(5.0, 7.0);
    vec2 cell = floor(uv);
    float n = hash(dot(cell, vec2(17.0, 31.0)) + id * 83.0);
    return step(0.55, n);
  }

  void main() {
    vec2 uv = vUv;
    uv.x *= uAspect;

    // 90 columns at uDensity == 1.0, the source shader's authored default.
    float cols = 90.0 * uDensity;
    vec2 grid = vec2(cols, floor(cols * 1.8));
    vec2 g = uv * grid;
    vec2 cell = floor(g);
    vec2 local = fract(g);

    float column = cell.x;
    float rnd = hash(column);
    float speedMul = mix(0.5, 2.2, rnd);
    float t = uPhase * speedMul;

    float y = mod(cell.y + t * 20.0 + rnd * 300.0, grid.y);
    float head = hash(column * 9.0) * grid.y;
    // vUv is y-up (bottom-left origin), same as the source's isf_FragNormCoord,
    // so this needs no flip: cells above the head are the ones the drop has
    // already passed.
    float trail = mod(y - head + grid.y, grid.y);

    float charID = floor(mod(cell.y + floor(uPhase * 7.0) + rnd * 100.0, 96.0));
    float pix = glyph(local, charID);

    // Bipolar around 0: negative = shadow-lifted (softer, more bloom-washed),
    // positive = hardened (crisper leader, tighter trail).
    float harden = uContrast - 0.5;
    float fade = clamp(exp(-trail * uTrailRate) - harden * 0.08, 0.0, 1.0);
    float leader = smoothstep(1.5, 0.0, trail);

    float flicker = 0.6 + 0.4 * sin(uTime * 20.0 + column * 3.1 + cell.y) * (0.5 + 0.5 * uHighs);
    float brightness = (0.75 + 0.5 * uEnergy) * (1.0 + uShock * 0.6);
    float glowAmt = max(0.3, 1.4 - harden * 1.6) * (1.0 + uShock * 1.4);
    float leaderPunch = 1.0 + max(0.0, harden) * 1.3 + uShock;

    vec3 color = uMid * pix * fade * flicker * brightness;
    color += vec3(1.0) * leader * pix * leaderPunch;
    color += uGlow * leader * glowAmt;

    // Fog toward the bottom, where the rain exits the frame.
    color *= 1.0 - smoothstep(0.0, 1.2, 1.0 - uv.y);

    gl_FragColor = vec4(color * uFade, 1.0);
  }
`

interface MatrixRainState {
  /** Fall progress, accumulated so a changing speed stays continuous. */
  phase: number
  /** Kick "byte spike", decaying. */
  shock: number
}

export const MatrixRainScene = createShaderScene<MatrixRainState>({
  id: 'matrix',
  frag: FRAG,
  state: () => ({ phase: 0, shock: 0 }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uShock: { value: 0 },
    uDensity: { value: 1.0 },
    uTrailRate: { value: 0.135 },
    uContrast: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
  }),
  update({ u, s, P, st, dt }) {
    st.phase += dt * (2.2 + s.mids * 1.2) * drastic(P.speed)

    // A kick overdrives brightness and glow like a byte spike, then decays
    // fast — a flash, not a swell, matching the source's flicker aesthetic.
    if (s.onKick > 0) st.shock = Math.min(1.4, st.shock + 0.9 * s.onKick)
    st.shock *= Math.exp(-dt * 4.5)

    u.uPhase.value = st.phase
    u.uShock.value = st.shock
    // Piecewise so the param's neutral 0.5 lands exactly on the source's
    // authored default (1.0) rather than an arbitrary point in [0.5, 3.0].
    u.uDensity.value =
      P.density < 0.5 ? 0.5 + P.density : 1.0 + (P.density - 0.5) * 4.0
    u.uTrailRate.value = 0.22 - 0.17 * P.complexity
    u.uContrast.value = P.contrast
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs
  },
})

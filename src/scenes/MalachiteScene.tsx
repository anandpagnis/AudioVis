import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'

/**
 * Malachite — domain-warped fbm banded into concentric botryoidal veins, like
 * polished mineral stone.
 *
 * Replaces `ink` in the background slot. Sourced from glslop, CC0, credited
 * in-source to "claude-opus-4-8".
 *
 * The technique is two well-known, generic pieces stacked: Quilez's
 * domain-warping (sample an fbm, use it to displace where the next one
 * samples, twice — public technique, no owner) feeding a "ramp" term —
 * `length(p - 0.6*r) * bands` — that would be plain concentric rings on its
 * own, except its own centre is dragged around by the same turbulence field
 * `r` that warped the noise. That single line is what turns rings into
 * swirling botryoidal veins instead of a target pattern.
 *
 * ## Colour
 *
 * The source drove three fixed hardcoded greens (`deep`/`mid`/`light`) picked
 * by a `tox` slider blending between two hand-authored endpoints. Replaced
 * with a direct mix of the five prelude colours (`uShadow`/`uMid`/`uAccent`/
 * `uGlow`) so the stone recolours under the active AudioVis palette — same
 * move as `HeapCorruptionScene`'s phosphor and `MatrixRainScene`'s glyphs.
 * `uTox` still exists, but now blends WHICH prelude colours the mid/light
 * tiers lean toward, rather than picking between two fixed green constants.
 *
 * ## What else changed from the standalone draft
 *
 * The source had no speed control at all (`TIME * 0.08`, fixed) and no audio
 * routing — this is a still image that happens to drift. Added:
 *   - `speed` param + `mids` drift-rate nudge, replacing the fixed rate.
 *   - `onKick` briefly deepens the domain warp (a churn burst through the
 *     stone) and flashes the crest sheen, both decaying.
 *   - `energy` lifts the crest sheen continuously.
 *   - `highs` briefly tightens the vein width, so hats read as the veins
 *     crisping up rather than doing nothing visible.
 *
 * ## Band routing
 *
 *   onKick  → warp churn burst + crest sheen flash, both decaying
 *   mids    → drift rate
 *   energy  → crest sheen brightness
 *   highs   → vein-width tightening
 */

/** Octaves per fbm call. Constant loop bound; `uOctaves` early-breaks inside. */
const MAX_OCTAVES = 5

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see `MatrixRainScene`). Full source is
 * `SHADER_SCENE_PRELUDE + FRAG` (no shared `include`; `hash`/`noise`/`fbm`
 * are self-contained, matching the source).
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uShock;
  uniform float uScale;
  uniform float uWarp;
  uniform float uBands;
  uniform float uTox;
  uniform float uEnergy;
  uniform float uHighs;
  uniform int uOctaves;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < ${MAX_OCTAVES}; i++) {
      if (i >= uOctaves) break;
      s += a * noise(p);
      p = p * 2.02 + 5.0;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    vec2 p = uv * uScale;
    float t = uPhase;

    // Heavy domain warp -> botryoidal swirls. A kick briefly deepens the
    // warp, reading as a churn passing through the stone rather than a flash.
    float warpAmt = uWarp * (1.0 + uShock * 0.5);
    vec2 drift = vec2(0.3 * sin(t), 0.2 * cos(t * 1.1));
    vec2 q = vec2(fbm(p + drift), fbm(p + vec2(5.2, 1.3) - drift));
    vec2 r = vec2(
      fbm(p + warpAmt * q + vec2(1.7, 9.2) + drift),
      fbm(p + warpAmt * q + vec2(8.3, 2.8))
    );
    float f = fbm(p + warpAmt * r);

    // Agate/malachite banding: a concentric ring ramp whose own centre is
    // dragged by the turbulence field r -- this is what turns plain rings
    // into swirling botryoidal veins.
    float ramp = length(p - 0.6 * r) * uBands;
    float phase = ramp + (f - 0.5) * 9.0;
    float band = sin(phase);
    float litness = 0.5 + 0.5 * band;
    // Base hardness from toxicity; highs briefly tighten it further, so hats
    // read as the veins crisping up rather than doing nothing visible.
    float veinW = max(0.02, mix(0.20, 0.06, uTox) - uHighs * 0.04);
    float vein = smoothstep(veinW, 0.0, abs(band));
    float crest = pow(litness, 2.5);

    // Walk shadow -> mid -> a tox-blended lean toward glow, so higher
    // toxicity reads as more vivid/vitreous rather than just "more green".
    vec3 midCol = mix(uMid, uAccent, uTox * 0.4);
    vec3 lightCol = mix(uAccent, uGlow, uTox);

    vec3 col = mix(uShadow, midCol, litness);
    col = mix(col, lightCol, crest);
    col += uGlow * pow(crest, 2.0) * (0.25 + uEnergy * 0.35 + uShock * 0.4);
    col *= 1.0 - (0.5 + 0.4 * uTox) * vein;

    col *= 1.0 - 0.3 * dot(uv, uv);
    // Mild tone curve, matching the source's own 0.9 -- not a linear->sRGB
    // encode (that would be 0.4545 and would double-gamma under three's own
    // renderer encode; see MazeFlightScene's header for why that matters).
    col = pow(max(col, 0.0), vec3(0.9));

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface MalachiteState {
  /** Field drift, accumulated so a changing rate stays continuous. */
  phase: number
  /** Kick churn burst, decaying. */
  shock: number
}

export const MalachiteScene = createShaderScene<MalachiteState>({
  id: 'malachite',
  frag: FRAG,
  // Governs the OFFSCREEN pass only — `BlendedLayer` overwrites the on-screen
  // material with the background slot's user-selected blend mode. Replace
  // rather than blend is right for the offscreen buffer: the scene paints
  // every pixel including its own ground.
  blending: THREE.NoBlending,
  // Measured 0.42ms at this budget on an M1 (see index.ts's metadata comment
  // for the full numbers) — genuinely cheap despite five fbm calls, because
  // this shader's hash-based value noise is far lighter per-sample than
  // `ink`'s simplex noise was. As ground composited under a subject, a soft
  // upscale is invisible regardless, so the budget still costs nothing to keep.
  pixelBudget: 1.3,
  uniforms: () => ({
    uPhase: { value: 0 },
    uShock: { value: 0 },
    uScale: { value: 2.4 },
    uWarp: { value: 3.5 },
    uBands: { value: 9.0 },
    uTox: { value: 0.5 },
    uEnergy: { value: 0 },
    uHighs: { value: 0 },
    uOctaves: { value: MAX_OCTAVES },
  }),
  state: () => ({ phase: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Source was a fixed TIME*0.08 with no speed control at all.
    st.phase += dt * 0.08 * (1 + s.mids * 0.5) * drastic(P.speed)

    if (s.onKick > 0) st.shock = Math.min(1.2, st.shock + 0.7 * s.onKick)
    st.shock *= Math.exp(-dt * 3.0)

    u.uPhase.value = st.phase
    u.uShock.value = st.shock

    // Piecewise so each param's neutral 0.5 lands exactly on the source's
    // authored default (scale 2.4, warp 3.5, bands 9.0) rather than an
    // arbitrary linear-scale midpoint.
    u.uScale.value = P.fill < 0.5 ? 1.0 + P.fill * 2.8 : 2.4 + (P.fill - 0.5) * 5.2
    u.uWarp.value = P.complexity < 0.5 ? 1.0 + P.complexity * 5.0 : 3.5 + (P.complexity - 0.5) * 5.0
    u.uBands.value = P.density < 0.5 ? 3.0 + P.density * 12.0 : 9.0 + (P.density - 0.5) * 22.0
    u.uTox.value = P.contrast
    u.uEnergy.value = s.energy
    u.uHighs.value = s.highs

    // Dropping an octave removes the finest turbulence detail — the
    // least-missed thing in a soft field, same reasoning `ink` used.
    u.uOctaves.value = Math.max(2, Math.min(MAX_OCTAVES, quality.knobs.noiseOctaves))
  },
})

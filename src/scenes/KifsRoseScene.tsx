import { createShaderScene } from '../engine/createShaderScene'
import { drastic } from '../engine/sceneParams'
import { PALETTE_RAMP_GLSL } from '../engine/shaderLib'

/**
 * Fractal Rose Window — polar-kaleidoscope KIFS mandala, orbit-trap laser lines.
 *
 * Sourced from glslop (shader `fkdh866z`, "Fractal Rose Window" by `ufffd`),
 * CC0-1.0, `provenance_type: "witnessed_generation"`, `parents: []` — the
 * platform's own generation log, not a claimed upload, and no fork lineage to
 * audit. Credited in-source as "glslop agent (Claude)" / model `claude-opus-4-8`.
 * https://glslop.com/api/v1/shaders/fkdh866z carries the record.
 *
 * Two things changed on the way in, same pattern as MatrixRainScene:
 *
 * 1. **Colour now walks the five-slot palette ramp** (`paletteRamp()`, shared
 *    via `PALETTE_RAMP_GLSL`) instead
 *    of the source's own HSV-cosine `pal()`. The original's `hue` input rotated
 *    a self-contained rainbow that never once looked at what palette AudioVis
 *    had active — every mood and every palette would have rendered the exact
 *    same colour cycle. `hue` is gone as a user param for that reason; the
 *    three orbit-trap layers keep their original fixed offsets into the ramp
 *    (was: into the hue wheel) so they still read as three distinct colours.
 * 2. **Audio-reactive.** The source was pure `TIME`-driven. `onKick` now
 *    punches the fold rotation and glow as a decaying burst; `mids` nudges
 *    rotation speed; `highs` spread the three orbit-trap layers apart in the
 *    ramp for a shimmer on hats. Continuous audio-driven accumulation replaces
 *    the source's `fract(TIME/16s)` seamless-loop framing — this scene is
 *    never rendered to a looping clip, so exact loop closure isn't a
 *    constraint worth keeping, and dropping it is what lets speed be reactive
 *    at all.
 *
 * No `pixelBudget`: the orbit-trap terms are already soft/glow-edged by
 * construction (unlike MatrixRainScene's hard glyph blocks), so downsampling
 * is a real option later, but this is the roster's first primary built on the
 * shader-scene factory and it has not been benchmarked either way yet — full
 * resolution until `/bench` says otherwise.
 */

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see InkFieldScene). Full source is
 * \`SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG\`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uShock;
  uniform int uSymmetry;
  uniform int uIterCount;
  uniform float uMorph;
  uniform float uFill;
  uniform float uContrast;
  uniform float uHighs;
  uniform float uEnergy;

  const int MAXI = 20;

  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }


  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;
    uv *= 1.7 / uFill;

    float th = uPhase;

    // Kaleidoscope: fold the plane into N mirrored wedges, slowly spinning.
    float a = atan(uv.y, uv.x) + th;
    float r = length(uv);
    float segAngle = 6.28318530718 / float(uSymmetry);
    a = mod(a, segAngle);
    a = abs(a - 0.5 * segAngle);
    vec2 z = vec2(cos(a), sin(a)) * r;

    // Iterated Kaliset fold (abs + inversion) -> ornate nested fractal webs;
    // orbit traps drive the thin laser lines. Kick briefly overdrives the
    // fold's own rotation, so a hit reads as the mandala flinching.
    mat2 R = rot(0.08 * sin(th) * (1.0 + uShock * 0.6));
    vec2 off = vec2(0.74 + 0.10 * uMorph * sin(th), 0.56 + 0.10 * uMorph * cos(th));
    float t1 = 1.0e9, t2 = 1.0e9, t3 = 1.0e9;
    for (int i = 0; i < MAXI; i++) {
      if (i >= uIterCount) break;
      z = abs(z) / (dot(z, z) + 0.0008);
      z = R * z;
      z -= off;
      t1 = min(t1, dot(z, z));
      t2 = min(t2, abs(z.x));
      t3 = min(t3, length(z - vec2(0.45, 0.18)));
    }

    // Thin glowing laser lines from the orbit traps. The fixed 0.05/0.42/0.74
    // offsets keep the three layers visually distinct across the ramp; highs
    // nudge them further apart for a shimmer on hats.
    float hshift = uHighs * 0.08;
    vec3 col = vec3(0.0);
    col += paletteRamp(0.05 + hshift + 0.45 * r) * (0.0060 / (t1 + 0.00060));
    col += paletteRamp(0.42 - hshift * 0.5 + 0.45 * r) * (0.0042 / (t2 * t2 + 0.00035));
    col += paletteRamp(0.74 + hshift + 0.45 * r) * (0.0050 / (t3 * t3 + 0.00060));

    float glowAmt = max(0.3, 1.6 - (uContrast - 0.5) * 1.8) * (1.0 + uEnergy * 0.35 + uShock * 0.9);
    col *= glowAmt;

    // Tone map -> hot cores toward white, saturated halos. Hardening (contrast
    // above 0.5) steepens the curve for punchier cores.
    col = col / (1.0 + col);
    col = pow(col, vec3(mix(0.9, 0.68, max(0.0, uContrast - 0.5) * 2.0)));
    col *= 1.0 - 0.18 * dot(uv, uv) * uFill * uFill;

    gl_FragColor = vec4((uBg + col) * uFade, 1.0);
  }
`

interface KifsRoseState {
  /** Fold rotation phase, accumulated so a changing speed stays continuous. */
  phase: number
  /** Kick "flinch" burst, decaying. */
  shock: number
}

export const KifsRoseScene = createShaderScene<KifsRoseState>({
  id: 'kifs',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({ phase: 0, shock: 0 }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uShock: { value: 0 },
    uSymmetry: { value: 6 },
    uIterCount: { value: 14 },
    uMorph: { value: 0.6 },
    uFill: { value: 1.0 },
    uContrast: { value: 0.5 },
    uHighs: { value: 0 },
    uEnergy: { value: 0 },
  }),
  update({ u, s, P, st, dt }) {
    // Source's authored rate: one full turn every 16s at speed == 1.
    st.phase += dt * ((2 * Math.PI) / 16) * (1 + s.mids * 0.5) * drastic(P.speed)

    if (s.onKick > 0) st.shock = Math.min(1.5, st.shock + s.onKick)
    st.shock *= Math.exp(-dt * 3.2)

    u.uPhase.value = st.phase
    u.uShock.value = st.shock
    u.uSymmetry.value = Math.round(3 + P.shape * 9) // 3..12
    u.uIterCount.value = Math.round(4 + P.complexity * 16) // 4..20
    u.uMorph.value = P.tilt * 1.2 // matches source's 0..1.2 range
    u.uFill.value = 0.4 + P.fill * 2.1 // matches source's 0.4..2.5 zoom range
    u.uContrast.value = P.contrast
    u.uHighs.value = s.highs
    u.uEnergy.value = s.energy
  },
})

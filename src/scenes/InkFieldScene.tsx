import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { drastic } from '../engine/sceneParams'
import { SIMPLEX3D_GLSL } from '../engine/shaderLib'

/**
 * Ink Field — domain-warped fBm, flowing like ink in water.
 *
 * Quilez's domain-warping technique: sample an fBm, use its value to displace
 * where you sample the *next* one, twice. Each warp folds the field into itself,
 * which is what turns smooth noise into something with filaments and eddies. The
 * whole look is three fBm calls and a colour ramp; there is no simulation here.
 *
 * ## Why this is the roster's first BACKGROUND scene
 *
 * The background slot has existed, fully wired, with zero content — no scene
 * declared the role, so the most structural composition slot was permanently
 * empty. This is the right shape to fill it: full-frame, no subject, no hard
 * edges, and it reads at 0.4 gain underneath something else without competing.
 * A subject scene demoted to background is still a subject, just dimmer; this
 * was authored as ground.
 *
 * It is also the reason the five-slot palette had to exist first. The scene's
 * entire image *is* a walk up the palette ramp — `bg` where the field is
 * thinnest through `glow` at the crests — so with three colours and a
 * background there was literally nothing to make the shadows out of.
 *
 * ## Band routing
 *
 *   sub        → WARP DEPTH. The distinguishing mapping; see below.
 *   onKick     → a phase leap plus a decaying warp shockwave.
 *   kick       → glow lift on the crests.
 *   mids       → drift rate.
 *   highs      → how far the accent colour reaches.
 *   energy     → mid-tone coverage.
 *
 * ## Why sub drives the warp rather than the brightness
 *
 * Every other scene in the roster spends its bass on mass or scale — something
 * getting bigger. Warp depth is a different job: the field does not grow, it
 * *reorganises*, so sub-bass reads as the ink being stirred rather than as a
 * pulse. That keeps this separable by eye from the rest of the roster when it is
 * sitting underneath one of them, which is the whole point of a background.
 *
 * The kick shockwave is the same idea on a fast envelope — a hit briefly deepens
 * the warp and jumps the phase, so the field convulses and settles rather than
 * flashing. Ink does not flash.
 */

/** Octaves per fBm call. Constant loop bound; `uOctaves` early-breaks inside. */
const MAX_OCTAVES = 4

/**
 * Exported so the shader can be compiled AND linked outside the app.
 *
 * Shaders are strings: typecheck, lint, the test suite and the build all pass on
 * a shader that will not compile. `docs/HANDOFF.md` §8 mandates compiling any new
 * GLSL in a throwaway WebGL context and reading `getShaderInfoLog`, and this
 * export is what makes that possible — the roster convention for every scene.
 *
 * The full source is `SHADER_SCENE_PRELUDE + SIMPLEX3D_GLSL + FRAG`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  uniform float uKick;
  uniform float uSub;
  uniform float uMids;
  uniform float uHighs;
  uniform float uEnergy;
  /** Decaying warp shockwave from the last kick. */
  uniform float uShock;
  /** Warp and detail amount, from the complexity parameter. */
  uniform float uComplex;
  /** Inverse zoom — LOWER means the pattern fills more of the frame. */
  uniform float uFill;
  uniform float uContrast;
  /** fBm octaves, from the quality governor. */
  uniform int uOctaves;

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < ${MAX_OCTAVES}; i++) {
      if (i >= uOctaves) break;
      v += a * snoise(p);
      // Non-integer lacunarity plus an irrational-ish offset per octave: 2.0
      // and a zero offset would stack every octave's features on the same grid
      // and the fold would show as a lattice.
      p = p * 2.03 + vec3(1.7, 9.2, 4.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);
    float t = uPhase;

    float warp = (1.1 + uSub * 1.4) * uComplex + uShock * 1.4;
    vec3 P = vec3(uv * uFill, t);
    float q = fbm(P);
    float r = fbm(P + vec3(q * warp, q * 0.7 * uComplex, 0.35));
    float v = fbm(P + vec3(r * 1.7 * uComplex, r * 1.05, 0.21));

    // The image is a walk up the palette ramp, thinnest field to crests.
    vec3 col = mix(uBg, uShadow, smoothstep(-0.7, 0.4, q));
    col = mix(col, uMid, smoothstep(-0.2, 0.7, r) * (0.6 + 0.35 * uEnergy));
    col = mix(col, uAccent, smoothstep(0.22, 0.85, v) * (0.3 + 0.55 * uHighs));
    col += uGlow * (uKick * 0.5 + uEnergy * 0.1) * smoothstep(0.4, 0.95, v);

    // Contrast as a bipolar control around an untouched 0.5: above it, an S-curve
    // hardens the midtones; below it, a gamma lift opens the shadows.
    vec3 hi = col * col * (3.0 - 2.0 * col);
    vec3 lo = pow(max(col, 0.0), vec3(0.72));
    col = mix(col, hi, max(0.0, uContrast - 0.5) * 1.6);
    col = mix(col, lo, max(0.0, 0.5 - uContrast) * 1.6);

    // Corner falloff, so a full-frame scene still has a centre of attention.
    float rad = length(uv);
    col *= 1.0 - 0.35 * smoothstep(0.55, 1.2, rad);

    gl_FragColor = vec4(clamp(col, 0.0, 1.1) * uFade, 1.0);
  }
`

interface InkState {
  /** Field drift, accumulated so a changing rate stays continuous. */
  phase: number
  /** Kick shockwave, decaying. */
  shock: number
}

export const InkFieldScene = createShaderScene<InkState>({
  id: 'ink',
  frag: FRAG,
  include: SIMPLEX3D_GLSL,
  // Governs the OFFSCREEN pass only — `BlendedLayer` overwrites the on-screen
  // material with the background slot's user-selected blend mode (`add` by
  // default). Replace rather than blend is right for the offscreen buffer: the
  // scene paints every pixel including its own ground, so there is nothing
  // underneath it to combine with.
  blending: THREE.NoBlending,
  // Three fBm calls at up to four octaves is twelve simplex samples per pixel —
  // the most expensive thing per-pixel in the roster. As ground being composited
  // under a subject, a soft upscale is invisible, so this buys back most of the
  // cost for nothing. Measure with /bench before changing it.
  pixelBudget: 1.5,
  uniforms: () => ({
    uPhase: { value: 0 },
    uKick: { value: 0 },
    uSub: { value: 0 },
    uMids: { value: 0 },
    uHighs: { value: 0 },
    uEnergy: { value: 0 },
    uShock: { value: 0 },
    uComplex: { value: 1 },
    uFill: { value: 1.5 },
    uContrast: { value: 0.5 },
    uOctaves: { value: MAX_OCTAVES },
  }),
  state: () => ({ phase: 0, shock: 0 }),
  update({ u, s, P, st, dt }) {
    // Deliberately slow: at ~0.011/s the field takes about a minute and a half
    // to turn over on its own. Almost all the visible motion comes from the kick
    // leaps below, which is what makes it read as ink being disturbed rather
    // than as a looping animation.
    st.phase += dt * 0.011 * (1 + s.mids * 0.5) * drastic(P.speed)

    // A kick reorganises the whole field: a phase leap plus a warp shockwave.
    if (s.onKick > 0) {
      st.phase += 0.15 * s.onKick
      st.shock = Math.min(1.2, st.shock + 0.8 * s.onKick)
    }
    // Frame-rate independent decay — a fixed per-frame multiplier would decay
    // twice as fast at 120 Hz.
    st.shock *= Math.exp(-dt * 2.6)

    u.uPhase.value = st.phase
    u.uShock.value = st.shock
    u.uComplex.value = 0.3 + 1.5 * P.complexity
    // Inverted on purpose: `fill` 0→1 maps to 2.6→0.4, so a higher parameter
    // zooms IN (fewer, larger features filling the frame).
    u.uFill.value = 2.6 - 2.2 * P.fill
    u.uContrast.value = P.contrast
    u.uKick.value = s.kick
    u.uSub.value = s.sub
    u.uMids.value = s.mids
    u.uHighs.value = s.highs
    u.uEnergy.value = s.energy

    // Dropping an octave removes the finest filaments — the least-missed detail
    // in a soft field, and this scene's only complexity lever.
    u.uOctaves.value = Math.max(2, Math.min(MAX_OCTAVES, quality.knobs.noiseOctaves))
  },
})

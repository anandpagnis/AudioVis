import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { quality } from '../engine/quality'
import { bipolar, drastic } from './contract'

/**
 * Butterfly Field — a solid, luminous butterfly ringed by sharp point sparks
 * that stream along its field lines like iron filings around a magnet, the
 * whole thing flapping on the beat.
 *
 * ## Provenance
 *
 * Supplied directly by the requester as a shader paste with NO title, author or
 * licence header. The `common` + `buffer a` (self-sampling `iChannel0`
 * feedback) + `image` structure identifies it as a **Shadertoy multipass
 * shader**. No upstream record to cite — same provenance class as `lattesfold`
 * ("the requester's direct statement is the entire basis") and `snowflake`, so
 * `license: 'original'` follows the roster's convention for requester-supplied
 * pastes; `provenance.spdx` is SPDX `NOASSERTION`. A source URL, if one turns
 * up, goes in this header.
 *
 * ## The look
 *
 *   1. a SOLID bright butterfly body — the source's `image` pass is
 *      `feedbackTex * smoothstep(-5.0, -1.0, b.w) * vec4(1.0 + b.xy, 0.0, 1.0)`;
 *      that `smoothstep` is 1 across the whole interior and fades only at the
 *      rim, so it is a FILL mask, not an outline;
 *   2. the wings are a cloud of fine SHARP points — not a noise haze — that
 *      stream along curved field lines around the body;
 *   3. the fixed colour identity `vec3(1.0 + c.x, 1.0 + c.y, 0.0)` — yellow in
 *      the body (field `c` = 0), green on the left (`c.x < 0`), red on the
 *      right / bottom (`c.x > 0`, `c.y < 0`);
 *   4. black everywhere else; a slow wing flap; no camera.
 *
 * ## How the single-pass port builds it
 *
 * `createShaderScene` is single-pass, so the source's `buffer a` feedback (an
 * unbounded advect-and-accumulate) is gone. In its place:
 *
 *   - **Field.** `bField()` returns the source's `but()` scalar `b` AND its
 *     analytic gradient `∇b` (one `atan` + the Fourier sum and its derivative —
 *     no finite differencing). Flow direction = a 2-D magnetic **dipole**
 *     centred on the body, `vec2(2xy, y²−x²)/r⁴` (classic bar-magnet loops),
 *     blended toward the butterfly's own iso-contour tangent `perp(∇b)` by
 *     `uContour` so the lines hug the wing outline as they wrap.
 *   - **Sharp points.** `sparkGrid()` is a jittered cell grid; each cell holds
 *     ONE point rendered with a razor `1.0 - smoothstep(uSharp, uSharp+ε, d)`
 *     plus a sub-pixel `exp(-d²·k)` core. `uSharp` is a few percent of a cell —
 *     as hard as it can be without aliasing. No value noise anywhere.
 *   - **Flow.** From each pixel, walk the streamline (`Pq -= dir·uStep`, `dir`
 *     re-evaluated every step so it CURVES), sampling `sparkGrid` at each point
 *     with a geometric-decay weight. A travelling `fract(hash − phase)` blink
 *     makes each point's lit moment sweep ALONG the line = visible flow. The
 *     decay gives every point a short sharp comet tail in the flow direction.
 *
 * ## Reactivity — FLOWY, not twitchy (explicit requirement)
 *
 * Nothing is wired to `ctx.b.transient` or a raw onset. Every response is a
 * tempo-locked oscillator or a slewed envelope:
 *
 *   wing flap   uFlapPhase advances at `dt · FLAP_RATE · (1 + energyEnv·0.3)
 *               · drastic(speed)`; the shader folds in `uBeatSin2` (one cycle
 *               per two beats) so the wingbeat sits ON the bar. `energyEnv` is
 *               `s.energy` slewed (~0.8 s).
 *   flow drift  uFlowPhase advances with `s.mids` folded in — the blink travels
 *               along the field lines faster in busy sections, eases in quiet
 *               ones, never lurches.
 *   kick        st.bloom = decaying envelope, `exp(-dt·2.4)` — a small tail +
 *               brightness SWELL, not a snap.
 *   hihat       uHihat (prelude) lifts point twinkle only.
 *   energy      body + spark brightness, flap depth, halo reach — all slewed.
 *
 * ## Scene Contract
 *
 *   speed       flap + flow clock rate
 *   shape       wing harmonic amount — rounded blob (0) to full butterfly (1)
 *   complexity  spark density (grid fineness) — "sparks"
 *   density     how far the spark halo reaches past the body — "spread"
 *   fill        zoom / how much of the frame the wings fill
 *   tilt        static roll of the whole field — "roll"
 *   contrast    exposure hardness + point sharpness + body-fill edge — "ink"
 */

export const FRAG = /* glsl */ `
  uniform float uFlapPhase; // JS accumulator; wing squeeze phase
  uniform float uFlowPhase;  // JS accumulator; blink travel along field lines
  uniform float uFlapDepth; // energy-slewed wing squeeze amount, source 0.3
  uniform float uZoom;      // fill dial -> coord scale, source const 1.5
  uniform float uRot;       // tilt dial -> static field roll
  uniform float uWing;      // shape dial -> harmonic amount (1.0 = source exactly)
  uniform float uSpread;    // density dial (+energy) -> spark-halo reach
  uniform float uEdge;      // contrast dial -> body-fill inner edge
  uniform float uContour;   // dipole <-> butterfly-contour blend for the flow
  uniform float uGrid;      // complexity dial -> spark cells per unit
  uniform float uSharp;     // contrast dial -> point radius (tiny = katana)
  uniform float uStep;      // streamline step length (q space)
  uniform float uDecay;     // per-step comet-tail falloff
  uniform float uCoreBright;// energy -> solid body brightness
  uniform float uFurBright; // energy + kick bloom -> spark brightness
  uniform float uExposure;  // contrast dial -> exposure tonemap hardness
  uniform float uPalStrength;// how hard the live palette tints the fixed colour
  uniform int   uMaxSteps;  // quality-gated streamline step count

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  // The source's \`but()\` scalar field \`b\` (b > 0 inside the butterfly) PLUS its
  // analytic gradient. \`b = 7 - r + uWing * harm(theta)\`, so
  //   grad b = -rhat  +  uWing * harm'(theta) * grad(theta),
  // with grad(theta) = (-y, x) / r^2. One atan, no finite differencing.
  // \`p\` is the source's post-scale coordinate (its \`uv * 20.0\`).
  void bField(vec2 p, out float b, out vec2 grad) {
    float r = length(p) + 1e-4;
    float t = atan(p.y, p.x);

    float harm =
        -0.5 * sin(t)       + 2.5 * sin(3.0 * t) + 2.0 * sin(5.0 * t)
      -  1.7 * sin(7.0 * t) + 3.0 * cos(2.0 * t) - 2.0 * cos(4.0 * t)
      -  0.4 * cos(16.0 * t);
    float dharm =
        -0.5 * cos(t)        + 7.5 * cos(3.0 * t) + 10.0 * cos(5.0 * t)
      - 11.9 * cos(7.0 * t)  - 6.0 * sin(2.0 * t) +  8.0 * sin(4.0 * t)
      +  6.4 * sin(16.0 * t);

    b = 7.0 - r + uWing * harm;
    vec2 rhat = p / r;
    vec2 gtheta = vec2(-p.y, p.x) / (r * r);
    grad = -rhat + uWing * dharm * gtheta;
  }

  // The source's \`c\`: radial unit vector, hard-gated to b > -5, faded past b=10
  // so the deep interior is pure yellow (c = 0).
  vec2 fieldTintVec(vec2 p, float b) {
    return normalize(p + 1e-4) * step(-5.0, b) * smoothstep(10.0, -10.0, b);
  }

  // 2-D magnetic dipole (moment along +y): field lines are bar-magnet loops
  // that wrap around the origin — i.e. around the butterfly's body.
  vec2 dipoleDir(vec2 q) {
    vec2 d = vec2(2.0 * q.x * q.y, q.y * q.y - q.x * q.x);
    return normalize(d + 1e-5);
  }

  // Flow direction at a point: the dipole, bent toward the butterfly's own
  // iso-contour tangent so the lines hug the wing edge as they curl around.
  vec2 flowDir(vec2 q, vec2 gradB) {
    vec2 tangent = normalize(vec2(-gradB.y, gradB.x) + 1e-5);
    vec2 dir = mix(dipoleDir(q), tangent, uContour);
    return normalize(dir + 1e-5);
  }

  // One SHARP point per jittered cell. No noise field — a hard-edged disc with a
  // sub-pixel bright core, plus a travelling on/off blink so the lit moment
  // sweeps along the streamline the caller is walking.
  float sparkGrid(vec2 x, float blinkPh) {
    vec2 g = x * uGrid;
    vec2 id = floor(g);
    vec2 h = hash2(id);
    vec2 fr = fract(g) - 0.5 - (h - 0.5) * 0.72;  // jittered point, stays in cell
    float d = length(fr);

    float hardDot = 1.0 - smoothstep(uSharp, uSharp + 0.014, d);
    float core = exp(-d * d * 1400.0);
    float blink = fract(h.x * 17.13 + h.y * 4.7 - blinkPh);
    float lit = smoothstep(0.5, 0.34, blink) * smoothstep(0.0, 0.16, blink);
    return lit * (hardDot + 0.5 * core);
  }

  void main() {
    vec2 uv = vUv;
    // Wing-flap: JS accumulator + a bar-locked term (uBeatSin2 = one cycle per
    // two beats) so the wingbeat sits ON the music.
    float flap = sin(uFlapPhase) * 0.75 + uBeatSin2 * 0.25;

    // Centred / rolled / squeezed coord = the source's own working space just
    // before its \`p = uv * 20.0\`. Everything below runs here.
    vec2 q = (uv - 0.5) * uZoom;
    float cs = cos(uRot), sn = sin(uRot);
    q = mat2(cs, -sn, sn, cs) * q;
    q.x *= 1.5 * (1.0 - flap * uFlapDepth);

    float b0;
    vec2 grad0;
    bField(q * 20.0, b0, grad0);
    vec2 c = fieldTintVec(q * 20.0, b0);

    // --- sparks: walk the field-line streamline through this pixel ---------
    float sparks = 0.0;
    float w = 1.0;
    vec2 Pq = q;
    float tw = 0.72 + 0.28 * uHihat;
    for (int i = 0; i < 44; i++) {
      if (i >= uMaxSteps) break;
      float bi;
      vec2 gi;
      bField(Pq * 20.0, bi, gi);
      vec2 dir = flowDir(Pq, gi);
      // blink phase advances with time AND with i, so a lit point's moment
      // travels along the line (flow), not just blinks in place.
      sparks += w * tw * sparkGrid(Pq, uFlowPhase - float(i) * 0.085);
      Pq -= dir * uStep;
      w *= uDecay;
    }

    // --- masks (source's image pass) -----------------------------------
    // Fill mask: 1 across the interior, fading only at the rim. uSpread pushes
    // the outer edge out so the spark halo reaches past the body.
    float halo = smoothstep(-5.0 - uSpread, -1.0, b0);
    float core = smoothstep(uEdge, uEdge + 3.5, b0);

    // --- colour: source's vec3(1.0 + c.xy, 0.0), then palette-tinted -------
    vec3 tint = vec3(1.0 + c.x, 1.0 + c.y, 0.0);
    vec3 palN = uGlow / max(1e-3, max(uGlow.r, max(uGlow.g, uGlow.b)));
    tint *= mix(vec3(1.0), palN * 1.4, uPalStrength);

    vec3 col = vec3(0.0);
    col += core * tint * uCoreBright * (0.9 + 0.2 * sparks);
    col += sparks * halo * tint * uFurBright;
    col = 1.0 - exp(-col * uExposure);

    gl_FragColor = vec4(col * uFade, 1.0);
  }
`

interface ButterflyState {
  /** Wing-flap clock. Accumulated so a speed/energy change never jumps it. */
  flapPhase: number
  /** Blink-travel clock (the flow). Its own accumulator, same reason. */
  flowPhase: number
  /** Slewed `s.energy` — opens flap depth / brightness / halo smoothly. */
  energyEnv: number
  /** Slewed `s.mids` — see `update()`'s own note; `flowPhase` below was the
   *  one clock in this file that missed the "flowy not twitchy" treatment
   *  its neighbour already gets. */
  midsEnv: number
  /** Decaying kick swell — tail length + brightness. `exp(-dt*2.4)` tail. */
  bloom: number
}

const FLAP_RATE = 2.0

export const ButterflyFieldScene = createShaderScene<ButterflyState>({
  id: 'butterfly',
  frag: FRAG,
  blending: THREE.NoBlending,
  // One fullscreen pass, but the streamline walk re-evaluates the analytic
  // butterfly field (one `atan` + ~14 trig) every step, up to `uMaxSteps` — the
  // heaviest term, and the main tier lever. A mild offscreen budget covers the
  // low tiers. NOT /bench-measured; see SCENE_COST_MS.butterfly.
  pixelBudget: () => (quality.knobs.raymarchSteps >= 50 ? 1.6 : 1.0),
  uniforms: () => ({
    uFlapPhase: { value: 0 },
    uFlowPhase: { value: 0 },
    uFlapDepth: { value: 0.3 },
    uZoom: { value: 1.5 },
    uRot: { value: 0 },
    uWing: { value: 1 },
    uSpread: { value: 3 },
    uEdge: { value: 0 },
    uContour: { value: 0.4 },
    uGrid: { value: 46 },
    uSharp: { value: 0.05 },
    uStep: { value: 0.007 },
    uDecay: { value: 0.87 },
    uCoreBright: { value: 2.6 },
    uFurBright: { value: 2.2 },
    uExposure: { value: 1 },
    uPalStrength: { value: 0.32 },
    uMaxSteps: { value: 36 },
  }),
  state: () => ({ flapPhase: 0, flowPhase: 0, energyEnv: 0, midsEnv: 0, bloom: 0 }),
  update({ u, s, P, st, dt }) {
    // --- slewed envelopes: the whole "flowy not twitchy" contract ---------
    st.energyEnv += (s.energy - st.energyEnv) * Math.min(1, dt / 0.8)
    // `flowPhase` below read raw `s.mids` directly — the one clock in this
    // file that missed the smoothing its own neighbour (`flapPhase`, via
    // `energyEnv`) already gets, found in a systematic audit for this exact
    // pattern (2026-09-11) after the same bug was reported live twice
    // elsewhere (GyroidFluxScene, JavaZoneLatticeScene). Same one-pole shape
    // this file already uses for `energyEnv`, not `slew()` — matching the
    // convention already established here rather than mixing two idioms in
    // one file.
    st.midsEnv += (s.mids - st.midsEnv) * Math.min(1, dt / 0.8)
    if (s.onKick > 0) st.bloom = Math.min(1.4, st.bloom + s.onKick)
    st.bloom *= Math.exp(-dt * 2.4)

    // --- clocks: accumulators, never `elapsed * rate` -------------------
    const spd = drastic(P.speed)
    st.flapPhase += dt * FLAP_RATE * (1 + st.energyEnv * 0.3) * spd
    st.flowPhase += dt * (0.3 + st.midsEnv * 0.5) * spd

    u.uFlapPhase.value = st.flapPhase
    u.uFlowPhase.value = st.flowPhase

    // --- contract dials ----------------------------------------------
    // shape 0 -> rounded blob, 0.5 -> ~source, 1 -> exaggerated butterfly
    u.uWing.value = 0.35 + 1.3 * P.shape
    // complexity -> spark density: finer grid, more points
    u.uGrid.value = 24 + 52 * P.complexity
    // density -> how far the spark halo reaches past the body; energy widens it
    u.uSpread.value = 3.0 + bipolar(P.density, 3.0) + st.energyEnv * 2.0
    // fill 0.5 -> 1.5 (source const); lower zoom = wings fill more of the frame
    u.uZoom.value = 2.3 - P.fill * 1.3
    // tilt -> static roll of the field
    u.uRot.value = bipolar(P.tilt, Math.PI)
    // contrast -> exposure hardness, point sharpness (higher = tinier point),
    // and where the solid body begins
    u.uExposure.value = 0.7 + 1.5 * P.contrast
    u.uSharp.value = 0.085 - 0.06 * P.contrast
    u.uEdge.value = bipolar(P.contrast, 2.5)

    // flap depth: source const 0.3, opened a little by the energy envelope
    u.uFlapDepth.value = 0.24 + 0.1 * st.energyEnv
    // dipole <-> contour blend: mostly the magnet, drifting slowly so the lines
    // breathe between "pure loops" and "hugging the wing edge"
    u.uContour.value = 0.4 + 0.15 * Math.sin(st.flapPhase * 0.5)
    // comet tail: a touch longer on a kick
    u.uDecay.value = 0.86 + st.bloom * 0.04
    // brightness: baselines carry what the source's unbounded feedback used to
    // build; energy + kick bloom ride on top, slewed.
    u.uCoreBright.value = 2.4 + st.energyEnv * 1.6
    u.uFurBright.value = (2.0 + st.energyEnv * 1.4) * (1 + st.bloom * 0.5)

    // uGlow is bound live by the factory — nothing to copy for the palette tint.

    // Step count is the real tier lever (the per-step analytic field eval is
    // the cost). Floored at 12/44 so the streamlines never collapse.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(12, Math.min(44, Math.round(44 * qFrac)))
  },
})

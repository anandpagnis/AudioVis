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
 *   3. the ORIGINAL source's fixed colour identity `vec3(1.0 + c.x, 1.0 + c.y,
 *      0.0)` — yellow in the body (field `c` = 0), green on the left
 *      (`c.x < 0`), red on the right / bottom (`c.x > 0`, `c.y < 0`). **This
 *      hard-coded hue is gone as of the round-2 rework — see "Colour rework,
 *      round 2" below** — but the `c` field itself (a 0..1 "how far from the
 *      body core toward the wing edge" scalar) is unchanged and still shapes
 *      the new palette-driven colour;
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
 * Nothing is wired to `ctx.b.transient` or a raw onset directly as a flash.
 * Every response is a tempo-locked oscillator or a slewed envelope — but a
 * live audit (2026-09-16, live report "fix reactivity") found the whole
 * cluster of visible effects — flap rate, flap depth, halo reach, body
 * brightness AND spark brightness — routed through one signal (`energyEnv`),
 * the exact "one band times everything" pattern `MalachiteScene`'s header
 * documents removing. Two changes fix that without touching the "flowy, not
 * twitchy" identity:
 *
 *   wing flap   uFlapPhase advances at `dt · FLAP_RATE · (1 + energyEnv·0.55)
 *               · drastic(speed)`; the shader folds in `uBeatSin2` (one cycle
 *               per two beats) so the wingbeat sits ON the bar. `energyEnv` is
 *               `s.energy` slewed (~0.8 s). The coefficient was 0.3 — close to
 *               the 0.15 Malachite's own header names as "barely distinguishable
 *               from silence" before ITS coefficient was raised to 0.55; raised
 *               here to the same figure for the same reason.
 *   flow drift  uFlowPhase advances with `s.mids` folded in — the blink travels
 *               along the field lines faster in busy sections, eases in quiet
 *               ones, never lurches.
 *   kick        st.bloom = decaying envelope, `exp(-dt·2.4)` — a small tail +
 *               brightness SWELL, not a snap. Previously reached ONLY the spark
 *               brightness; the solid body — the most visually dominant part of
 *               the frame — never pulsed on a hit at all. Now nudges both.
 *   hihat       uHihat (prelude) lifts point twinkle instantaneously (per-hit).
 *   highs       NEW: `highsEnv` (`s.highs` slewed ~0.5 s) now carries the spark
 *               brightness on its own dedicated band instead of borrowing
 *               `energyEnv` — sustained high-frequency energy reads as a
 *               shimmering wing-dust, distinct from the hihat's per-hit twinkle
 *               and from the body's energy-driven brightness.
 *   energy      body brightness, flap rate/depth, halo reach — still one
 *               signal, but now the ONLY thing riding it is "how hard is the
 *               track hitting overall", which is what `energy` means; the
 *               texture/highlight layers (sparks, background) now have their
 *               own bands.
 *   loud        NEW: `bgLift` (`s.loud` slewed ~1.5 s) — see "Background" below.
 *
 * ## Background — was pure black, now a deliberate ambient field
 *
 * The whole frame outside the body's halo used to be literal `vec3(0.0)`:
 * nothing added `uBg`/`uShadow` under the picture the way this roster's other
 * full-bleed primaries do (`kifs`: `uBg + col`; `wingfold`: `mix(uBg, uShadow,
 * ...)` for its unescaped interior). Against a scene that IS one, that reads as
 * "no background" rather than "black background", especially since the primary
 * slot is forced to additive blending on-screen (`createShaderScene.tsx`'s
 * `blending` doc) — a `col` of exactly zero contributes nothing, so nothing was
 * ever composited there at all.
 *
 * Fixed with `beyond` — the halo mask's complement, so it costs nothing extra
 * (`b0`/`halo` are already computed) and by construction fades to zero exactly
 * where the body/spark halo begins, never muddying either — filled with
 * concentric "flux shell" rings (`sin(length(q) * 9.0 - uFlowPhase * 0.12)`
 * as first shipped — round 2 below retunes the frequency and decouples the
 * sampling coordinate from the wing flap; read "Round 2" for the current
 * numbers), the same field vocabulary the streamline sparks already ride (a magnetic
 * field extends everywhere, not just near the source), just far too slow and
 * far too faint to resolve into points. Tinted `mix(uBg, uShadow,
 * shell)` — the two darkest palette slots, so it recolours under the live
 * palette like everything else in this shader but never competes with the
 * body/sparks for brightness. Lifted by `uBgLift` (`s.loud`, this scene's one
 * genuinely slow signal — `lilimState.ts` names it explicitly for "scale a
 * whole look, not a hit") so the ambience breathes with the track's overall
 * level across a phrase, not with any single band or hit.
 *
 * ## Round 2 — full visual rework (2026-09-17, user: "butterfly looks ass,
 * fix completely" / "a lot of the scenes are wasted potential")
 *
 * A strong, mechanism-free aesthetic complaint after the reactivity pass
 * above already shipped — so this round touches ONLY how the scene is
 * coloured, lit and balanced, not the technique (dipole flow field,
 * streamline-walking sharp points, analytic butterfly field all unchanged;
 * they were never the complaint). Four independent problems, diagnosed by
 * re-reading the render maths cold rather than guessing at one number:
 *
 *   1. Colour was hue-LOCKED, not palette-driven. `vec3(1.0 + c.x, 1.0 + c.y,
 *      0.0)` can only ever produce yellow/green/red combinations — the B
 *      channel is a hard-coded zero, full stop — with the live palette only
 *      allowed a 0.32-strength tint on TOP of that fixed hue. Every other
 *      palette-reactive scene in the roster looks different per palette; this
 *      one always looked like the same yellow-green-red bug regardless of
 *      which of the ~30 palettes was active, which reads as broken/dated next
 *      to the rest of the show. Fixed by dropping the fixed RGB literal
 *      entirely — colour is now built from `uAccent`/`uMid`/`uGlow` directly
 *      (see "Colour rework" below), the same live-palette slots the rest of
 *      the roster draws its identity from.
 *   2. The background "flux shell" rings (added in the prior pass to fix a
 *      literal-black background) sampled `length(q)` where `q` already had
 *      the wing-flap squeeze (`q.x *= 1.5 * (1 - flap * uFlapDepth)`) baked
 *      in — so the concentric rings stretched and un-stretched every wingbeat,
 *      turning a meant-to-be-subtle ambient field into a warping, moiré-prone
 *      pulse synced to the flap. Fixed by sampling the rings from a coordinate
 *      frame taken BEFORE the flap squeeze (zoom + tilt only) — the ambience
 *      now only drifts with `uFlowPhase`, never breathes with the wingbeat —
 *      and the ring frequency was cut 9.0 -> 3.5 (fewer, calmer bands; the old
 *      figure put several full cycles across the frame, which reads as a
 *      grid/moiré rather than an ambient field at this resolution).
 *   3. Sparks defaulted toward maximum fineness/hardness: `uGrid` topped out
 *      at 76 cells/unit and `uSharp` bottomed out at 0.025 cell-radii — a
 *      cloud of near-invisible, razor-edged, independently-blinking dots at
 *      that end of the dial reads as TV static, not "iron filings streaming
 *      along a field line," especially stacked 44-deep along each pixel's
 *      streamline walk. Both ranges were pulled in (`uGrid` 22..64,`uSharp`
 *      0.04..0.09 — still sharp at the harsh end of `contrast`, just not
 *      sub-pixel) and the comet-tail decay raised (0.87 -> 0.90 baseline) so
 *      each point's trail is longer and reads as a visible streak of flow
 *      rather than a lone blip — legibility over sheer point count.
 *   4. Brightness could blow the body to a flat white disc: `uCoreBright`
 *      reached 2.4+1.6(energy)+0.6(bloom) = 4.6, run through
 *      `uExposure` up to 2.2, i.e. `1 - exp(-4.6*2.2)` ≈ 1.0 on every colour
 *      channel simultaneously — the moment the track got loud, the carefully
 *      built colour identity clipped to white and disappeared. Both the
 *      brightness ceilings and the exposure curve were pulled down (see
 *      "Brightness rework" below) so a loud/kick moment reads as MORE colour
 *      (saturated, punchy) rather than LESS (clipped to white).
 *
 * ### Colour rework, round 2
 *
 * `tint` is now built entirely from live palette slots — no fixed RGB
 * literal, no post-hoc palette "tint" fighting a hard-coded hue underneath:
 *
 *   - `uAccent` is the core colour (where `c` -> 0, i.e. deep inside the
 *     body) — the palette's "second voice," reused here as this scene's one
 *     dominant hue, matching how `mid`/`accent` read as "what the subject
 *     mostly is" across the roster (see `palettes.ts`'s slot doc).
 *   - a `wingHue` term mixes `uMid` (`c.x - c.y*0.6` negative — was the
 *     source's green wing) toward `uGlow` (positive — was the source's red
 *     wing/underside), preserving the ORIGINAL shader's left/right + top/
 *     bottom structural identity as a blend axis instead of a literal colour
 *     channel.
 *   - `tint = mix(uAccent, wingHue, length(c) * uPalStrength)` — `length(c)`
 *     is exactly the same 0-at-core, 1-at-wing-edge scalar the source's fixed
 *     scheme used, just now driving a PALETTE blend instead of a hard-coded
 *     one.
 *   `uPalStrength` is repurposed (was "how hard the palette fights the fixed
 *   hue," now moot since there is no fixed hue to fight): it is now "wing
 *   colour SPREAD" — at 0 the whole butterfly is a single glowing `uAccent`
 *   silhouette (no left/right identity at all); at 1 the wingtips fully
 *   saturate toward `uMid`/`uGlow`. Default raised 0.32 -> 0.85 since this is
 *   now the PRIMARY colour mechanism, not a marginal tint on top of one.
 *
 * ### Brightness rework, round 2
 *
 * `uCoreBright` (1.7 base, was 2.4), `uFurBright` (1.3 base, was 2.0) and
 * `uExposure` (0.55..1.5, was 0.7..2.2) were all pulled down together so their
 * PRODUCT stays under the clip point through ordinary energy/bloom swings and
 * only approaches full-white on a genuinely hard, loud, kick-locked peak —
 * exposure's job is to make loud moments feel harder-edged and more saturated
 * (the "ink" contract dial), not to erase colour by flooding every channel to
 * 1.0. The spark layer's own bloom leverage was trimmed to match (0.7 -> 0.45)
 * for the same reason.
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
  uniform float uGrid;      // complexity dial -> spark cells per unit (round 2: ceiling pulled 76 -> 64, see header)
  uniform float uSharp;     // contrast dial -> point radius (round 2: floor raised 0.025 -> 0.04, less static)
  uniform float uStep;      // streamline step length (q space)
  uniform float uDecay;     // per-step comet-tail falloff (round 2: baseline 0.87 -> 0.90, longer visible trails)
  uniform float uCoreBright;// energy -> solid body brightness (round 2: ceilings pulled down, see "Brightness rework")
  uniform float uFurBright; // highs + kick bloom -> spark brightness (round 2: ceilings pulled down, see "Brightness rework")
  uniform float uExposure;  // contrast dial -> exposure tonemap hardness (round 2: range pulled 0.7..2.2 -> 0.55..1.5)
  uniform float uPalStrength;// round 2: repurposed as "wing colour spread" now colour is palette-first, see header
  uniform float uBgLift;    // s.loud (slow) -> background ambience strength
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
  // so the deep interior is c = 0 (round 2: this now selects the CORE palette
  // colour rather than a literal "pure yellow" -- see main()'s colour block).
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
    // Round 2: the background "flux shell" rings below sample THIS pre-squeeze
    // frame (zoom + tilt only), never the flap-squeezed \`q\`, so the ambient
    // rings never stretch/un-stretch every wingbeat -- see header's "Round 2"
    // point 2 for why that used to read as a moire pulse.
    vec2 qAmbient = q;
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

    // --- colour: round 2 -- palette-first, no fixed hue -- see header's
    // "Colour rework, round 2" for the full reasoning. \`c\` still carries the
    // ORIGINAL source's structural identity (0 at the body core, unit length
    // toward the wing edge, signed by which side/quadrant of the wing), it
    // just now blends live palette slots instead of literal R/G/B channels.
    vec3 wingHue = mix(uMid, uGlow, clamp(0.5 + 0.5 * (c.x - c.y * 0.6), 0.0, 1.0));
    vec3 tint = mix(uAccent, wingHue, clamp(length(c), 0.0, 1.0) * uPalStrength);

    // --- background: the field's own ambience, not empty black ------------
    // \`beyond\` is the halo mask's complement -- free (halo is already
    // computed) and, by construction, zero exactly where the body/spark halo
    // begins, so this never muddies either. Filled with slow concentric
    // "flux shell" rings -- the same field vocabulary the streamline sparks
    // ride, just far too slow/faint to resolve into points -- tinted toward
    // the two darkest palette slots so it recolours with the live palette
    // without ever competing with the body/sparks for brightness. uBgLift
    // (s.loud, slewed) breathes the whole ambience with the track's overall
    // level across a phrase; see the header's "Background" section. Round 2:
    // sampled from \`qAmbient\` (pre-flap-squeeze) at a lower frequency (9.0 ->
    // 3.5) and a slightly tighter lift range -- both changes exist purely to
    // stop the rings reading as a warping moiré grid; see header point 2.
    float beyond = 1.0 - halo;
    float shell = 0.5 + 0.5 * sin(length(qAmbient) * 3.5 - uFlowPhase * 0.12);
    vec3 bg = mix(uBg, uShadow, shell) * beyond * (0.04 + 0.13 * uBgLift);

    vec3 col = bg;
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
  /** Slewed `s.energy` — opens flap rate/depth, body brightness, halo reach. */
  energyEnv: number
  /** Slewed `s.mids` — see `update()`'s own note; `flowPhase` below was the
   *  one clock in this file that missed the "flowy not twitchy" treatment
   *  its neighbour already gets. */
  midsEnv: number
  /** Slewed `s.highs` (~0.5s) — the spark/fur brightness's OWN band, split
   *  out from `energyEnv` in the 2026-09-16 reactivity pass (see header) so
   *  the fine spark texture reads sustained high-frequency energy instead of
   *  just re-aping the body's overall-intensity signal. */
  highsEnv: number
  /** Slewed `s.loud` (~1.5s) — background ambience lift. `loud` is this
   *  scene's one genuinely slow signal (see `lilimState.ts`'s own doc on it),
   *  fit for scaling the whole background rather than reacting to a hit. */
  bgLift: number
  /** Decaying kick swell — tail length + body/spark brightness. `exp(-dt*2.4)`
   *  tail. Now nudges `uCoreBright` too, not just `uFurBright`: the solid
   *  body is the most visually dominant part of the frame and previously
   *  never pulsed on a hit at all. */
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
    uGrid: { value: 40 },
    uSharp: { value: 0.06 },
    uStep: { value: 0.007 },
    uDecay: { value: 0.9 },
    uCoreBright: { value: 2.1 },
    uFurBright: { value: 1.7 },
    uExposure: { value: 0.9 },
    // Round 2: repurposed + raised 0.32 -> 0.85 -- now the PRIMARY colour
    // mechanism (wing-vs-core spread), not a marginal tint on a fixed hue.
    // See header's "Colour rework, round 2".
    uPalStrength: { value: 0.85 },
    uBgLift: { value: 0 },
    uMaxSteps: { value: 36 },
  }),
  state: () => ({
    flapPhase: 0,
    flowPhase: 0,
    energyEnv: 0,
    midsEnv: 0,
    highsEnv: 0,
    bgLift: 0,
    bloom: 0,
  }),
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
    // NEW (2026-09-16 reactivity pass, see header): `highsEnv` gives the spark
    // layer its own band instead of re-reading `energyEnv` — a bit faster than
    // the 0.8s energy/mids time constant (sparks are the fine-detail layer, so
    // a touch more responsive reads as "shimmer" rather than "swell") but still
    // one-pole smoothed, same idiom as its neighbours, never a raw sample.
    st.highsEnv += (s.highs - st.highsEnv) * Math.min(1, dt / 0.5)
    // NEW: `bgLift` is `s.loud` slewed hard (~1.5s) — `lilimState.ts` names
    // `loud` explicitly as the field for "scale a whole look, not a hit", so
    // the background ambience (see shader) is the one thing in this file tied
    // to it rather than to `energy`/`mids`/`highs`.
    st.bgLift += (s.loud - st.bgLift) * Math.min(1, dt / 1.5)
    if (s.onKick > 0) st.bloom = Math.min(1.4, st.bloom + s.onKick)
    st.bloom *= Math.exp(-dt * 2.4)

    // --- clocks: accumulators, never `elapsed * rate` -------------------
    const spd = drastic(P.speed)
    // 0.3 -> 0.55: the old figure was close to the 0.15 Malachite's own header
    // names as "barely distinguishable from silence" before being raised to
    // 0.55 for the same reason — see header.
    st.flapPhase += dt * FLAP_RATE * (1 + st.energyEnv * 0.55) * spd
    st.flowPhase += dt * (0.3 + st.midsEnv * 0.5) * spd

    u.uFlapPhase.value = st.flapPhase
    u.uFlowPhase.value = st.flowPhase

    // --- contract dials ----------------------------------------------
    // shape 0 -> rounded blob, 0.5 -> ~source, 1 -> exaggerated butterfly
    u.uWing.value = 0.35 + 1.3 * P.shape
    // complexity -> spark density: finer grid, more points. Round 2: ceiling
    // pulled 76 -> 64 -- max fineness at max complexity, stacked 44-deep along
    // every pixel's streamline walk, was reading as static rather than
    // "iron filings"; see header's "Round 2" point 3.
    u.uGrid.value = 22 + 42 * P.complexity
    // density -> how far the spark halo reaches past the body; energy widens it
    u.uSpread.value = 3.0 + bipolar(P.density, 3.0) + st.energyEnv * 2.0
    // fill 0.5 -> 1.5 (source const); lower zoom = wings fill more of the frame
    u.uZoom.value = 2.3 - P.fill * 1.3
    // tilt -> static roll of the field
    u.uRot.value = bipolar(P.tilt, Math.PI)
    // contrast -> exposure hardness, point sharpness (higher = tinier point),
    // and where the solid body begins. Round 2: `uExposure`'s range pulled
    // 0.7..2.2 -> 0.55..1.5 and `uSharp`'s floor raised 0.025 -> 0.04 -- the
    // old ranges could blow the body to flat white (see "Brightness rework")
    // and reduce points to sub-pixel noise at the harsh end of the dial; see
    // header's "Round 2" points 3-4.
    u.uExposure.value = 0.55 + 0.95 * P.contrast
    u.uSharp.value = 0.09 - 0.05 * P.contrast
    u.uEdge.value = bipolar(P.contrast, 2.5)

    // flap depth: source const 0.3, opened by the energy envelope. Coefficient
    // raised 0.1 -> 0.18 alongside the flap-rate bump above, for the same reason.
    u.uFlapDepth.value = 0.24 + 0.18 * st.energyEnv
    // dipole <-> contour blend: mostly the magnet, drifting slowly so the lines
    // breathe between "pure loops" and "hugging the wing edge"
    u.uContour.value = 0.4 + 0.15 * Math.sin(st.flapPhase * 0.5)
    // comet tail: a touch longer on a kick. Round 2: baseline raised 0.86 ->
    // 0.90 so every point's trail is a visible streak along the flow instead
    // of a near-invisible blip -- see header's "Round 2" point 3.
    u.uDecay.value = 0.90 + st.bloom * 0.035
    // brightness: baselines carry what the source's unbounded feedback used to
    // build. `uCoreBright` (the solid body) now also gets a kick-bloom nudge —
    // it used to be the one visible element in the frame a hit never reached at
    // all, which is why the body could read as inert even on a hard kick.
    // `uFurBright` (the sparks) is driven by `highsEnv`, its own dedicated band,
    // instead of re-reading `energyEnv` — see header.
    // Round 2: all three coefficients pulled down (2.4->1.7 / +1.6->+1.0 /
    // +0.6->+0.4 for the body; 2.0->1.3 / +1.8->+1.0 for the sparks; bloom's
    // spark leverage 0.7->0.45) so the brightest realistic frame (loud +
    // kick + high contrast) lands well short of `1 - exp(-x)` saturating
    // every channel to white -- a hit should read as MORE colour, not a flash
    // of white that erases the palette; see header's "Brightness rework".
    u.uCoreBright.value = 1.7 + st.energyEnv * 1.0 + st.bloom * 0.4
    u.uFurBright.value = (1.3 + st.highsEnv * 1.0) * (1 + st.bloom * 0.45)
    // background ambience lift — see shader's `bg` term and the header's
    // "Background" section. Slow (`bgLift`) on purpose: this breathes with the
    // track's overall level, not with any single band or hit.
    u.uBgLift.value = st.bgLift

    // uBg/uShadow/uMid/uAccent/uGlow are all bound live by the factory — the
    // shader's colour/background blocks read them directly every frame,
    // nothing to copy here.

    // Step count is the real tier lever (the per-step analytic field eval is
    // the cost). Floored at 12/44 so the streamlines never collapse.
    const qFrac = Math.min(1, quality.knobs.raymarchSteps / 96)
    u.uMaxSteps.value = Math.max(12, Math.min(44, Math.round(44 * qFrac)))
  },
})

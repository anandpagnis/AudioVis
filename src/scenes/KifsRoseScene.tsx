import { createShaderScene } from '../engine/createShaderScene'
import { barPhase, isDownbeat, slew } from '../engine/response'
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
 * 2. **Audio-reactive.** The source was pure `TIME`-driven. `mids` nudge
 *    rotation speed; `highs` spread the three orbit-trap layers apart in the
 *    ramp for a shimmer on hats; the drum response is structural rather than
 *    per-hit (see **The bar is the unit** below). Continuous audio-driven
 *    accumulation replaces the source's `fract(TIME/16s)` seamless-loop framing
 *    — this scene is never rendered to a looping clip, so exact loop closure
 *    isn't a constraint worth keeping, and dropping it is what lets speed be
 *    reactive at all.
 *
 * ## The bar is the unit — this scene's identity
 *
 * This scene answers the music **once per bar, and then sits with its answer**.
 * That is the whole point of it, and it is deliberately the only thing in the
 * roster shaped this way.
 *
 * The roster audit that produced `engine/response.ts` measured the problem: all
 * 22 live scenes drove brightness from an audio envelope, ten of the twelve
 * `createShaderScene` scenes shared a near-identical `mids`→rate /
 * `highs`→detail / `energy`→brightness / `onKick`→`exp()`-decay→glow mapping,
 * and — the finding this scene exists to answer — only three of 22 read any
 * musical structure above per-frame level, with **zero** readers of
 * `f.beatInBar`. The engine has tracked bar position since it had a beat
 * tracker and nothing had ever asked for it. Everything reacted to every kick,
 * identically, forever, which is what made a roster of visually distinct scenes
 * read as one strobe.
 *
 * This scene used to be part of that: a single `uShock` charged by every
 * `onKick` and decayed at `exp(-dt*3.2)`, wired into the fold rotation and the
 * glow multiplier. Four twitches a bar, all the same size, all the same shape.
 *
 * Now the significant change lands on the **downbeat only** (`isDownbeat`) and
 * is **held** for the rest of the bar:
 *
 *   - `uSymmetry` — the kaleidoscope wedge count, the literal fold count —
 *     targets the next entry of {@link BAR_SYMMETRY} and eases there over
 *     {@link FOLD_STEP_RATE} (~100ms), same as `uFoldStep` below. This used to
 *     be a hard integer cut on the grounds that a petal count is an integer
 *     and the cut *is* the event; in practice that meant the wedge count and
 *     the fractal web changed shape on the same frame the accent envelope
 *     also popped (see `KifsRoseState.accent`) — three discontinuities
 *     stacked on one downbeat, which is what read as "jerky" rather than "on
 *     beat." `segAngle = TAU / uSymmetry` is just an angle, so it is
 *     perfectly continuous in a fractional wedge count — easing this costs
 *     nothing structurally, it only removes a pop.
 *   - `uFoldStep` — the Kaliset offset and the per-iteration rotation bias —
 *     steps to the next entry of {@link BAR_FOLDS} and eases in over ~100 ms,
 *     so the fractal web morphs in behind the petal count instead of both
 *     snapping together and reading as a dropped frame.
 *
 * Beats 2, 3 and 4 get one quarter of the accent (see {@link OFFBEAT_ACCENT})
 * and it reaches exactly one term — the orbit-trap line width. A mandala that
 * reconfigures once per bar and is otherwise still is musically legible; one
 * that flinches on all four beats is noise.
 *
 * ### Why it does not read as frozen
 *
 * This codebase's standing rule (see `KaleidoPulseScene`, and `HoldScene`'s
 * self-sustaining breath) is that a scene which visibly stops between triggers
 * reads as broken, not as restrained. Three things run continuously underneath
 * the held configuration and none of them wait for a beat:
 *
 *   - `uPhase` never stops accumulating — the mandala is always turning, at a
 *     rate `mids` modulates.
 *   - `uBarSweep` is `barPhase()`, a continuous 0..1 ramp across the bar, read
 *     in the shader as `sin(2*pi*sweep)` so it is smooth across the bar line
 *     rather than a sawtooth that would snap a second time on the downbeat. It
 *     drives a ~2% radial breath and a slow drift of the ramp position, which
 *     is what fills the three beats the structural response deliberately
 *     leaves empty.
 *   - `uBeatSin` (prelude, one cycle per beat, free — no JS beat-tracking of
 *     its own) drives a deliberate ~6% outward-growth swell on top of the bar
 *     breath (see `BEAT_GROWTH` in `FRAG`, and "Round 2" below — this
 *     used to be a much smaller ~1% pulse, before the fold's own chaotic
 *     sensitivity to `cfg` got tamed and this became the real feature instead
 *     of an accident). It phase-locks to all four beats, not just the
 *     downbeat, so the "on beat" feel does not depend on a kick being
 *     detected at all — pure beat-grid motion, always continuous, never a
 *     reset.
 *   - `highs` still shimmer the trap layers apart per frame.
 *
 * ## Band routing
 *
 *   downbeat crossing → retargets uSymmetry (fold count) + uFoldStep, both
 *                       eased in over ~100ms and then HELD for the bar. Fires
 *                       off the beat GRID, not off a detected kick, so the
 *                       mandala keeps reconfiguring through a passage with no
 *                       drums in it.
 *   onKick on beat 1  → full uBeatAccent: narrows the orbit-trap line width
 *                       AND hardens the tone curve
 *   onKick on 2/3/4   → quarter uBeatAccent: line width only. The contrast
 *                       term's smoothstep floor sits above anything an
 *                       off-beat accent can reach, so it never engages there.
 *   barPhase          → continuous radial breath + ramp-position drift
 *   mids              → rotation speed
 *   highs             → orbit-trap ramp spread (shimmer on hats)
 *   energy            → overall brightness
 *
 * ### One term deliberately off brightness
 *
 * All 22 scenes drove brightness from an audio envelope, so the drum response
 * here now drives **none** of it. `uShock`'s old `* (1.0 + ... + uShock * 0.9)`
 * term is gone from `glowAmt` entirely and nothing replaced it; `energy` is the
 * only thing left that brightens. The accent went to two axes the roster barely
 * uses instead:
 *
 *   - **line width.** The orbit-trap numerator and its epsilon scale by the
 *     same factor, so the value at the trap centre is algebraically unchanged
 *     (`k*n / (0 + k*e)` is `n/e` for any `k`) and only the falloff narrows.
 *     That is a width control with *zero* gain component, not a dimmed flash.
 *   - **contrast.** The downbeat raises the tone-curve exponent, which pulls
 *     the halos back and leaves the cores. The mandala *tightens* on the
 *     downbeat rather than flaring — counter-motion, which the audit found in
 *     exactly one of 22 scenes.
 *
 * ## Parameter neutrality
 *
 * The roster invariant is that every contract dial at 0.5 reproduces the
 * scene's authored constants, and this survives the rewrite: `uFoldStep` is
 * centred on 0.5 (`BAR_FOLDS[0]`), `BAR_SYMMETRY[0]` is 0, and `uBeatAccent`
 * and `sin(2*pi*uBarSweep)` are both 0 with no audio and no beat grid — so a
 * silent, un-dialled frame is bit-for-bit the shader that was here before.
 *
 * No `pixelBudget`: the orbit-trap terms are already soft/glow-edged by
 * construction (unlike MatrixRainScene's hard glyph blocks), so downsampling
 * is a real option later, but this is the roster's first primary built on the
 * shader-scene factory and it has not been benchmarked either way yet — full
 * resolution until `/bench` says otherwise.
 *
 * Nothing added here costs an iteration: `kifs` is `performanceCost: 'high'`
 * and the loop bound is untouched. `uSymmetry` is a divisor, `uFoldStep` is two
 * multiply-adds outside the loop and one inside a `rot()` that already ran.
 *
 * ## Round 2 — taming the fold's chaotic sensitivity, and a real growth feature
 *
 * User complaint: "fractal rose window ... I dont want it bumping out of the
 * screen, theres like outward growth as well right? maybe put that on the
 * beat, just stop the bumping." Investigation: `uFoldStep` (and the `cfg`
 * derived from it) already eases smoothly between bar-held `BAR_FOLDS` entries
 * via `slew()` — but the Kaliset fold it feeds (`z = abs(z)/dot(z,z); z =
 * R*z; z -= off`, iterated up to `MAXI`=20 times) is a CHAOTIC map. A smooth
 * INPUT to a chaotic iterated system does not guarantee a smooth OUTPUT: the
 * fractal's own geometry can swing outward non-monotonically mid-ease even
 * though `uFoldStep` itself never jumps. That is almost certainly what read
 * as "bumping out of the screen" during a bar transition — an artifact of the
 * map's sensitivity to `cfg`, not a discontinuity anywhere in the JS-side
 * easing (which really was, and still is, continuous).
 *
 * Two levers control how hard `cfg` leans on the fold: `BAR_FOLDS`' spread
 * around its neutral 0.5, and the coefficients that scale `cfg` into the
 * fold's rotation (`R`) and offset (`off`) inside `FRAG`'s `main()`. Both are
 * now reduced to roughly 60% of their original magnitude — taming the
 * worst-case mid-ease excursion by more than half while keeping each bar's
 * fold recognisably different from the last (the cycle's relative ordering
 * and spacing are preserved, only its amplitude is turned down).
 *
 * Separately, the "outward growth" the complaint names is now a deliberate,
 * controlled feature instead of an accidental side effect of the chaos above:
 * see `BEAT_GROWTH` in `FRAG` — a real, continuous, beat-locked radial swell
 * (`uBeatSin`, already free from the prelude) large enough to read clearly,
 * replacing the old +/-1% pulse that shared its phase and was too small to
 * register as "growth" at all.
 *
 * Also removed: a dead `ACCENT_FOLLOW_RATE` constant, documented for a
 * `slew()`-chases-`s.kick` accent design that was never actually wired up —
 * see the note above `st.accent`'s decay in `update()`.
 */

/**
 * Held fold configurations, one per bar, walked in order.
 *
 * A fixed cycle rather than a hash: `kifs` owns the *bar* as its unit and
 * `wingfold` owns the probabilistic gate, and keeping those two identities
 * apart is the point of doing this work at all. A five-entry cycle against a
 * four-bar phrase means the mandala does not land on the same configuration at
 * the same point of two consecutive phrases, so it reads as composed rather
 * than as a loop, without any randomness to replay.
 *
 * Entry 0 is 0.5 — the shader reads this as `uFoldStep - 0.5`, so the cycle
 * starts at exactly the authored fold and a scene that has not seen a downbeat
 * yet renders the original picture.
 *
 * Round 2: the spread between entries is compressed to ~60% of its original
 * amplitude (was `[0.5, 0.86, 0.22, 0.68, 0.34]`) — see "Round 2" in the
 * file's top doc comment. The cycle's length, order and relative spacing are
 * unchanged; only how far `cfg` (= `uFoldStep - 0.5`) can swing is turned
 * down, because that swing is exactly what the chaotic Kaliset fold in `FRAG`
 * amplifies during a bar-transition ease.
 */
const BAR_FOLDS = [0.5, 0.72, 0.33, 0.61, 0.4] as const

/**
 * Wedge-count offset applied on top of the `shape` dial, one per bar, in step
 * with {@link BAR_FOLDS}.
 *
 * Entry 0 is 0 for the same neutrality reason. The result is clamped back into
 * the dial's authored 3..12 range, which means the variation compresses at the
 * ends of the dial — a performer who has pinned `shape` to maximum is asking
 * for a twelve-petal rose and gets one, with only the negative offsets still
 * visible. That is the right way round: the dial wins, the bar decorates.
 */
const BAR_SYMMETRY = [0, 2, -1, 1, -2] as const

/**
 * How fast `uFoldStep` AND `uSymmetry` ease to a newly stepped configuration,
 * in `slew` rate. Shared between the two so the wedge count and the fractal
 * web arrive together instead of one visibly lagging the other.
 *
 * ~100 ms to most of the way — under a fifth of a beat at 120 BPM, so it still
 * reads as landing *on* the downbeat, but long enough that both morph rather
 * than cut.
 */
const FOLD_STEP_RATE = 11

/**
 * Fraction of the full accent a kick on beat 2, 3 or 4 is worth.
 *
 * The brief this scene was rebuilt against: the other three beats should do
 * "something much smaller or nothing". A quarter is small enough that the
 * contrast term's `smoothstep(0.45, ...)` floor is unreachable from an
 * off-beat — see the shader — so those beats genuinely reach one axis and one
 * only, rather than reaching everything at reduced volume.
 */
const OFFBEAT_ACCENT = 0.25

/**
 * How far into the last beat of a bar a kick still counts as the downbeat.
 *
 * `isDownbeat(f.beatInBar)` on its own is the honest structural test, but a
 * kick does not land exactly on the grid: detector latency and a drummer
 * pushing the beat both routinely put the bar's first hit tens of milliseconds
 * AHEAD of the crossing, where `beatInBar` still reads 3. Without this window
 * that hit scores as an off-beat and the bar's most important accent is the one
 * that reads weakest — the exact opposite of the intent. At 120 BPM this is the
 * last ~60 ms of the bar.
 */
const DOWNBEAT_LEAD = 0.88

/** Is this frame close enough to the bar line to count as the downbeat? */
function onDownbeat(beatInBar: number, beatProgress: number): boolean {
  if (isDownbeat(beatInBar)) return true
  return Math.floor(beatInBar) === 3 && beatProgress >= DOWNBEAT_LEAD
}

/** The dial's wedge count with this bar's held offset, clamped to 3..12. */
function symmetryForBar(shape: number, barStep: number): number {
  const base = Math.round(3 + shape * 9) // the authored 3..12 range, unchanged
  return Math.min(12, Math.max(3, base + BAR_SYMMETRY[barStep]))
}

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see MatrixRainScene). Full source is
 * \`SHADER_SCENE_PRELUDE + PALETTE_RAMP_GLSL + FRAG\`.
 */
export const FRAG = /* glsl */ `
  uniform float uPhase;
  // uBeatAccent, NOT uAccent -- uAccent is a vec3 palette slot in
  // SHADER_SCENE_PRELUDE. Redeclaring any prelude uniform at global scope is a
  // GLSL link error the engine surfaces as a silently BLACK scene, which has
  // already cost this project a session; see BeatsScene's note on uKick.
  uniform float uBeatAccent;
  uniform float uFoldStep;
  uniform float uBarSweep;
  // Float, not int: it now EASES between bar-held wedge counts (see
  // FOLD_STEP_RATE) instead of cutting, and segAngle = TAU / uSymmetry is
  // continuous in a fractional value -- fine to interpolate through.
  uniform float uSymmetry;
  uniform int uIterCount;
  uniform float uMorph;
  uniform float uFill;
  uniform float uContrast;
  uniform float uHighs;
  uniform float uEnergy;

  const int MAXI = 20;
  const float TAU = 6.28318530718;
  // Round 2: the deliberate on-beat outward swell (see the uv scale line in
  // main()) -- a real, controlled feature now, replacing what used to read as
  // an uncontrolled "bumping out of the screen" side effect of the fold's own
  // chaotic sensitivity to cfg (see the note above 'off'/'R' below). Shrinking
  // uv zooms the whole mandala IN (visually larger, same convention as the
  // uFill dial above); growing uv zooms it back out. 0.06 reads clearly as a
  // swell at a glance without needing any change to uFill's own zoom range.
  const float BEAT_GROWTH = 0.06;

  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }


  void main() {
    // Smooth bar-long breath, read as a sine so it is continuous ACROSS the bar
    // line. uBarSweep is a 0..1 sawtooth; using it raw would snap back on the
    // downbeat, adding a second discontinuity on the one frame that already has
    // the petal-count cut on it.
    float sweep = sin(uBarSweep * TAU);

    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;
    // Bar-long breath (sweep, ~2%) plus a deliberate beat-locked outward swell
    // (BEAT_GROWTH * uBeatSin, one cycle per beat, free from the prelude) --
    // continuous life on all four beats, not only the one the structural
    // response below reacts to. The minus sign is deliberate: uBeatSin is
    // positive for the first half of each beat, and SHRINKING uv there zooms
    // the mandala IN, so the rose visibly grows right after every hit and
    // recedes before the next one -- this is the "outward growth ... on the
    // beat" the complaint asked for, now intentional rather than an artifact.
    uv *= (1.7 / uFill) * (1.0 + 0.020 * sweep - BEAT_GROWTH * uBeatSin);

    float th = uPhase;

    // Kaleidoscope: fold the plane into N mirrored wedges, slowly spinning.
    // uSymmetry now STEPS on the downbeat and holds for the bar -- the fold
    // count is the scene's largest structural response and it is deliberately
    // an integer cut, not an eased ramp.
    float a = atan(uv.y, uv.x) + th;
    float r = length(uv);
    float segAngle = TAU / float(uSymmetry);
    a = mod(a, segAngle);
    a = abs(a - 0.5 * segAngle);
    vec2 z = vec2(cos(a), sin(a)) * r;

    // Iterated Kaliset fold (abs + inversion) -> ornate nested fractal webs;
    // orbit traps drive the thin laser lines. The held bar configuration biases
    // both the per-iteration rotation and the fold offset, so each bar solves a
    // visibly different web and then keeps it. Centred on uFoldStep == 0.5, so
    // the authored constants are exactly reproduced at the cycle's entry 0.
    float cfg = uFoldStep - 0.5;
    // Round 2: both cfg coefficients below were reduced to ~60% of their
    // original magnitude (rotation: was 0.060; offset: was vec2(0.052,
    // -0.038)). The Kaliset fold is a CHAOTIC map, so even though uFoldStep
    // eases smoothly bar-to-bar (see FOLD_STEP_RATE) and cfg's own range is
    // now smaller too (see BAR_FOLDS), the fractal's geometry could still
    // swing outward non-monotonically mid-ease. Cutting how hard cfg leans on
    // the fold tames that swing directly, without touching the easing itself,
    // which was never where the discontinuity actually was.
    mat2 R = rot(0.08 * sin(th) + 0.036 * cfg);
    vec2 off = vec2(0.74 + 0.10 * uMorph * sin(th), 0.56 + 0.10 * uMorph * cos(th))
             + vec2(0.031, -0.023) * cfg;
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

    // Orbit-trap line WIDTH, not gain. Numerator and epsilon scale by the same
    // factor, so the trap-centre value (k*n)/(0 + k*e) == n/e is untouched for
    // any k and only the falloff narrows: a beat reads as the laser lines
    // drawing thinner, with no brightness component at all. This is the axis
    // the old uShock->glow term was moved onto.
    float lw = 1.0 - 0.40 * uBeatAccent;

    // Ramp position. Highs shimmer per frame; the held bar configuration walks
    // all three trap layers to a new place in the palette and keeps them there;
    // the bar sweep drifts them slowly while it does. The fixed 0.05/0.42/0.74
    // offsets still keep the three layers visually distinct.
    float hshift = uHighs * 0.08 + cfg * 0.14 + sweep * 0.030;
    vec3 col = vec3(0.0);
    col += paletteRamp(0.05 + hshift + 0.45 * r) * (0.0060 * lw / (t1 + 0.00060 * lw));
    col += paletteRamp(0.42 - hshift * 0.5 + 0.45 * r) * (0.0042 * lw / (t2 * t2 + 0.00035 * lw));
    col += paletteRamp(0.74 + hshift + 0.45 * r) * (0.0050 * lw / (t3 * t3 + 0.00060 * lw));

    // No drum term here any more. 22 of 22 scenes drove brightness from an
    // audio envelope; this one now drives none of it, and energy is the only
    // thing left that brightens.
    float glowAmt = max(0.3, 1.6 - (uContrast - 0.5) * 1.8) * (1.0 + uEnergy * 0.35);
    col *= glowAmt;

    // Tone map -> hot cores toward white, saturated halos. Hardening (contrast
    // above 0.5) steepens the curve for punchier cores.
    //
    // The downbeat RAISES the exponent, pulling the halos back and leaving the
    // cores: the mandala tightens on the bar line instead of flaring, which is
    // counter-motion (audit: 1 of 22 scenes). The smoothstep floor is above
    // OFFBEAT_ACCENT's ceiling by construction, so beats 2-4 cannot reach this
    // term at any kick strength.
    float hard = smoothstep(0.45, 1.0, uBeatAccent);
    col = col / (1.0 + col);
    col = pow(col, vec3(mix(0.9, 0.68, max(0.0, uContrast - 0.5) * 2.0) + 0.14 * hard));
    col *= 1.0 - 0.18 * dot(uv, uv) * uFill * uFill;

    gl_FragColor = vec4((uBg + col) * uFade, 1.0);
  }
`

interface KifsRoseState {
  /** Fold rotation phase, accumulated so a changing speed stays continuous. */
  phase: number
  /**
   * Beat accent, decaying. Charged in full by a kick on the downbeat and at
   * {@link OFFBEAT_ACCENT} by a kick anywhere else — one envelope with two
   * amplitudes, which is what makes "much smaller" literal rather than a second
   * hand-tuned decay to keep in sync with the first.
   */
  accent: number
  /** Index into {@link BAR_FOLDS} / {@link BAR_SYMMETRY}. Steps once per bar. */
  barStep: number
  /** Eased, held fold configuration — the rendered value of `BAR_FOLDS[barStep]`. */
  fold: number
  /**
   * Eased, held wedge count — the rendered value of `symmetryForBar(P.shape,
   * barStep)`. See the "still bumping" note above `st.symmetry`'s assignment
   * in `update()`.
   */
  symmetry: number
  /**
   * `beatIndex` of the downbeat already stepped on.
   *
   * `f.beat` is documented as true for exactly one frame, so this is belt and
   * braces — but a long frame (a shader compile, a tab returning) is exactly
   * when the flag could be observed twice, and a double step would silently
   * skip a configuration and desynchronise the cycle from the bar for the rest
   * of the session.
   */
  lastStepBeat: number
}

export const KifsRoseScene = createShaderScene<KifsRoseState>({
  id: 'kifs',
  frag: FRAG,
  include: PALETTE_RAMP_GLSL,
  state: () => ({
    phase: 0,
    accent: 0,
    barStep: 0,
    fold: BAR_FOLDS[0],
    symmetry: symmetryForBar(0.5, 0),
    lastStepBeat: -1,
  }),
  uniforms: () => ({
    uPhase: { value: 0 },
    uBeatAccent: { value: 0 },
    uFoldStep: { value: BAR_FOLDS[0] },
    uBarSweep: { value: 0 },
    uSymmetry: { value: 6 },
    uIterCount: { value: 14 },
    uMorph: { value: 0.6 },
    uFill: { value: 1.0 },
    uContrast: { value: 0.5 },
    uHighs: { value: 0 },
    uEnergy: { value: 0 },
  }),
  update({ u, s, P, st, dt, ctx }) {
    const f = ctx.f

    // Source's authored rate: one full turn every 16s at speed == 1. Never
    // gated — this is what keeps the scene alive across the three beats the
    // structural response deliberately ignores.
    st.phase += dt * ((2 * Math.PI) / 16) * (1 + s.mids * 0.5) * drastic(P.speed)

    // --- Once per bar, on the downbeat, and nowhere else.
    //
    // Deliberately driven by the beat GRID (`f.beat`) rather than by a detected
    // kick: a bar with no kick drum in it is still a bar, and a mandala that
    // stopped reconfiguring through a breakdown would read as the scene having
    // died rather than as the music having thinned.
    if (f.beat && isDownbeat(f.beatInBar) && f.beatIndex !== st.lastStepBeat) {
      st.lastStepBeat = f.beatIndex
      st.barStep = (st.barStep + 1) % BAR_FOLDS.length
    }
    // Symmetrical rates: this is a step to a held target, not an attack-release
    // envelope, so there is no rise/fall asymmetry to express. `slew` is still
    // the right primitive over a hand-rolled lerp because it is exponential in
    // `dt` and so cannot snap or change shape with frame rate.
    st.fold = slew(st.fold, BAR_FOLDS[st.barStep], dt, FOLD_STEP_RATE, FOLD_STEP_RATE)
    // "Still bumping out of the screen" (Round 3): every doc comment on
    // `uSymmetry` and `FOLD_STEP_RATE` above claims the wedge count eases
    // alongside the fold — but this line was reading `symmetryForBar()`'s
    // integer result straight into the uniform below with no `slew()` at all,
    // so the wedge count actually SNAPPED on every downbeat while the prose
    // said otherwise. `segAngle = TAU / uSymmetry` then jumped hard, and
    // folding `a = mod(a, segAngle)` through a hard angle change is exactly
    // what re-buckets the whole kaleidoscope into a visibly different wedge
    // shape in one frame — indistinguishable, at a glance, from the fold's
    // own chaotic mid-ease excursion Round 2 already dampened. Fixed the same
    // way `fold` is: hold a slewed state value and read that into the
    // uniform, not the raw target.
    st.symmetry = slew(st.symmetry, symmetryForBar(P.shape, st.barStep), dt, FOLD_STEP_RATE, FOLD_STEP_RATE)

    // --- Beat accent. One envelope, two amplitudes.
    if (s.onKick > 0) {
      const weight = onDownbeat(f.beatInBar, f.beatProgress) ? 1 : OFFBEAT_ACCENT
      st.accent = Math.min(1.2, st.accent + s.onKick * weight)
    }
    // Round 2 cleanup: an earlier pass left a dead `ACCENT_FOLLOW_RATE`
    // constant here, documented for a `slew()`-chases-`s.kick` design that was
    // never actually wired in. That design doesn't match what this envelope
    // is: a single-frame `onKick` SPIKE charges it above (not a continuous
    // chase of `s.kick`), and it free-decays afterwards — there is no
    // "target" for `slew` to chase, so `slew` was never the right primitive
    // here. Removed the constant rather than force-fit it; this exponential
    // decay is the real, working design and matches `KifsRoseState.accent`'s
    // own doc comment ("one envelope with two amplitudes").
    st.accent *= Math.exp(-dt * 3.2)

    u.uPhase.value = st.phase
    u.uBeatAccent.value = st.accent
    u.uFoldStep.value = st.fold
    // Continuous 0..1 across the bar. `beatInBar` is `beatIndex % 4` upstream
    // (AudioEngine), so this ramp and `isDownbeat` above agree on where the bar
    // line is by construction rather than by coincidence.
    u.uBarSweep.value = barPhase(f.beatIndex, f.beatProgress)
    u.uSymmetry.value = st.symmetry
    // Fold count no longer reads the quality tier (F129 reverts F111 here):
    // the tier's job is resolution, via the global pixelBudget/performanceCost
    // system (engine/renderScale.ts) — it already scales this scene's canvas
    // resolution with `high` cost. Letting the tier also cap `uIterCount`
    // doubled up on that and thinned the fractal itself at low tiers, which
    // reads as the rose losing petals rather than just getting softer.
    // Complexity's own 4..20 range is unaffected — only the performer's
    // dial, not the governor, decides how many folds run.
    u.uIterCount.value = Math.round(4 + P.complexity * 16) // 4..20
    u.uMorph.value = P.tilt * 1.2 // matches source's 0..1.2 range
    u.uFill.value = 0.4 + P.fill * 2.1 // matches source's 0.4..2.5 zoom range
    u.uContrast.value = P.contrast
    u.uHighs.value = s.highs
    u.uEnergy.value = s.energy
  },
})

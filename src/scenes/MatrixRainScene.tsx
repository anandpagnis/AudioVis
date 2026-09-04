import { bandClocks } from '../engine/bandClocks'
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
 *    band routing at all. What it is driven *by* is the point of this scene —
 *    see "Identity" below.
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
 * ## Identity: the signals nobody else listens to
 *
 * The roster-wide audit found the reaction vocabulary had collapsed onto one
 * idea — 22 of 22 scenes drove brightness from an audio envelope, and ten of
 * the twelve shader scenes shared a near-identical `mids`→rate, `highs`→detail,
 * `energy`→brightness, `onKick`→`exp(-dt*k)`→glow mapping. This scene was a
 * textbook instance of it. It now deliberately reads the signals the engine
 * computes every frame and **nothing else in the roster reads at all**:
 * `uMidClock`, `uHighClock` and `uHihat` (see `SHADER_SCENE_PRELUDE`).
 *
 * Two consequences worth stating, because both are deliberate:
 *
 * 1. **Nothing here drives brightness or glow from an audio envelope.** Not a
 *    reduction for its own sake — it is the one property all 22 scenes shared,
 *    so it is the one worth spending. Everything the music does to this scene
 *    it does through *motion* (fall rate, glyph churn, flicker rate) and
 *    *structure* (per-column glyph density) instead.
 * 2. **The band clocks stall.** They advance only while their band is loud, so
 *    the rain genuinely stops between mid phrases rather than drifting on. The
 *    small `uTime` floors on glyph churn and flicker (and `IDLE_CREEP_RATE` on
 *    the fall) exist only so true silence reads as *nearly* stopped rather than
 *    as a frozen still image — `HoldScene`'s header records why a scene that
 *    goes static the moment the music does looks broken rather than restrained.
 *    At full mids the burst rate reproduces the previously authored speed
 *    exactly; what changed is what happens in the quiet.
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
 *   uMidClock          → fall rate, as the clock's per-frame DELTA (JS side,
 *                         off `bandClocks.mid`) — bursts while the mids play,
 *                         stalls to a creep between them
 *   uMidClock          → glyph churn rate (shader side) — characters
 *                         re-scramble in the same bursts the rain falls in
 *   uHighClock         → flicker RATE (not amount) — the shimmer runs while the
 *                         highs are playing and stills when they stop
 *   uHihat             → per-column glyph DENSITY, staggered per column (see
 *                         `colTrig` in the shader) — a hat crosses the field
 *                         column by column instead of flashing all of it
 *
 * Nothing reads `s.energy`, `s.onKick`, `s.mids` or `s.highs` any more; all
 * four were the template's own terms.
 */

/**
 * Exported so the shader can be compiled AND linked outside the app — the
 * roster convention (see KifsRoseScene). Full source is
 * \`SHADER_SCENE_PRELUDE + FRAG\` (no shared \`include\`; \`hash\`/\`glyph\` are
 * self-contained).
 */
export const FRAG = /* glsl */ `
  // uMidClock, uHighClock and uHihat are NOT declared here -- they come from
  // SHADER_SCENE_PRELUDE, which the factory concatenates ahead of this source
  // as plain strings with no dedup. A second declaration compiles fine as JS
  // but GLSL rejects it as a duplicate at global scope, and the scene renders
  // a silent black frame; see BeatsScene's note on the session that cost.
  uniform float uPhase;
  uniform float uDensity;
  uniform float uTrailRate;
  uniform float uContrast;

  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  // 5x7 procedural glyph. thresh is the lit-dot cutoff: lower it and more of
  // the 35 cells switch on, so the character reads as DENSER rather than
  // brighter. Driven per column from uHihat in main().
  float glyph(vec2 uv, float id, float thresh) {
    uv *= vec2(5.0, 7.0);
    vec2 cell = floor(uv);
    float n = hash(dot(cell, vec2(17.0, 31.0)) + id * 83.0);
    return step(thresh, n);
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

    // Per-column hat response. uHihat is a decaying 1 -> 0 envelope, so after
    // every hit it sweeps DOWN through the whole range; giving each column its
    // own trigger level inside that sweep makes the response cross the field
    // in column order (high levels first, near the hit; low levels last, in
    // the tail) instead of flashing every column at the same instant. This is
    // the per-element differentiation the roster almost entirely lacks.
    //
    // The gate matters: without it a column whose trigger level sits near zero
    // would read as permanently responding while the envelope rests at zero.
    float colTrig = 0.15 + 0.80 * hash(column * 4.7 + 11.0);
    float hatGate = smoothstep(0.03, 0.12, uHihat);
    float colHat = hatGate * smoothstep(0.24, 0.0, abs(uHihat - colTrig));

    // Glyph churn rides uMidClock, so characters re-scramble in bursts with
    // the mids and hold between them. 24.0 reproduces the previously authored
    // churn rate at full mids (the clock advances at 1.0/sec there, against a
    // fall phase that ran ~3.4/sec through a 7.0 multiplier). The small uTime
    // term is a floor, not a drift: through true silence the field keeps
    // mutating slowly rather than freezing into a still image.
    float charID = floor(mod(cell.y + floor(uMidClock * 24.0 + uTime * 1.2) + rnd * 100.0, 96.0));
    // A responding column thickens its glyphs. Audio moves STRUCTURE here,
    // not brightness -- at rest this is exactly the source's authored 0.55.
    float pix = glyph(local, charID, 0.55 - colHat * 0.20);

    // Bipolar around 0: negative = shadow-lifted (softer, more bloom-washed),
    // positive = hardened (crisper leader, tighter trail).
    float harden = uContrast - 0.5;
    float fade = clamp(exp(-trail * uTrailRate) - harden * 0.08, 0.0, 1.0);
    float leader = smoothstep(1.5, 0.0, trail);

    // Flicker RATE, not amount, comes from the high clock: the shimmer runs
    // while the highs play and stills when they stop. uTime keeps a slow
    // baseline shimmer alive through silence, same reasoning as charID.
    float flicker = 0.6 + 0.3 * sin(uHighClock * 22.0 + uTime * 2.0 + column * 3.1 + cell.y);
    float glowAmt = max(0.3, 1.4 - harden * 1.6);
    float leaderPunch = 1.0 + max(0.0, harden) * 1.3;

    vec3 color = uMid * pix * fade * flicker;
    color += vec3(1.0) * leader * pix * leaderPunch;
    color += uGlow * leader * glowAmt;

    // Fog toward the bottom, where the rain exits the frame.
    color *= 1.0 - smoothstep(0.0, 1.2, 1.0 - uv.y);

    gl_FragColor = vec4(color * uFade, 1.0);
  }
`

/**
 * Fall rate per second of MID-CLOCK advance.
 *
 * `bandClocks.mid` advances at 1.0/sec while the mids are at full level, so
 * this plus {@link IDLE_CREEP_RATE} reproduces the previously authored
 * full-mids rate (`2.2 + s.mids * 1.2` = 3.4) exactly at that point. The
 * change is entirely in the quiet, which is the property `bandClocks`'s own
 * header calls out as what makes the substitution safe to drop into a scene
 * tuned against a smooth band level.
 */
const MID_BURST_RATE = 3.05

/**
 * Fall rate that survives total silence, per second.
 *
 * Deliberately ~10% of the burst rate: enough that the field never becomes a
 * frozen JPEG (see `HoldScene`'s header on why a scene going static the moment
 * the music does reads as broken), far too little to read as the continuous
 * drift this scene is being moved off. The stall is the effect; a dead frame
 * is not.
 */
const IDLE_CREEP_RATE = 0.35

interface MatrixRainState {
  /** Fall progress, accumulated so a changing speed stays continuous. */
  phase: number
  /**
   * Previous `bandClocks.mid` reading, for this frame's delta.
   *
   * Negative means "not yet sampled". The clock is a session singleton that
   * may already be minutes old when this scene mounts, so the first frame must
   * contribute zero rather than teleporting the field by the whole session's
   * accumulated mid time. Per instance, not module scope — two mounted copies
   * (a layer plus the outgoing half of a crossfade) each need their own.
   */
  prevMidClock: number
}

export const MatrixRainScene = createShaderScene<MatrixRainState>({
  id: 'matrix',
  frag: FRAG,
  state: () => ({ phase: 0, prevMidClock: -1 }),
  // uMidClock / uHighClock / uHihat are bound by the factory itself — a scene
  // must not list them here either (the spread would replace the prelude's own
  // uniform objects).
  uniforms: () => ({
    uPhase: { value: 0 },
    uDensity: { value: 1.0 },
    uTrailRate: { value: 0.135 },
    uContrast: { value: 0.5 },
  }),
  update({ u, P, st, dt }) {
    // Fall advances on the mid clock's DELTA rather than a smooth s.mids term.
    // The clock only moves while the mids are actually playing, so the rain
    // runs in bursts tied to the instrument and stalls to a creep between
    // them, instead of drifting continuously the way it used to.
    //
    // Integrating the delta here rather than reading uMidClock directly for
    // the fall position in the shader is what keeps the speed dial usable:
    // the phase accumulator absorbs a changing rate continuously, whereas
    // multiplying a monotonic clock by a live dial teleports the whole field
    // the instant a performer touches the slider.
    const midClock = bandClocks.mid
    const dClock = st.prevMidClock < 0 ? 0 : Math.max(0, midClock - st.prevMidClock)
    st.prevMidClock = midClock
    st.phase += (dClock * MID_BURST_RATE + dt * IDLE_CREEP_RATE) * drastic(P.speed)

    u.uPhase.value = st.phase
    // Piecewise so the param's neutral 0.5 lands exactly on the source's
    // authored default (1.0) rather than an arbitrary point in [0.5, 3.0].
    u.uDensity.value =
      P.density < 0.5 ? 0.5 + P.density : 1.0 + (P.density - 0.5) * 4.0
    u.uTrailRate.value = 0.22 - 0.17 * P.complexity
    u.uContrast.value = P.contrast
  },
})

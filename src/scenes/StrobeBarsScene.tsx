import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'
import { effectEnvelope } from './effectEnvelope'

/**
 * Strobe Bars — hard monochrome bar wipes for a drop, in the techno/DnB
 * idiom the rest of the roster has no equivalent for.
 *
 * Original content, written directly for the `effect` slot (same posture as
 * `ShockRingScene`/`SectionFlareScene`/`TransientSparkScene` — see
 * `ShockRingScene`'s header for why that slot needed a licensed scene rather
 * than a ported one). This is the one scene in the roster with a genuine
 * physical risk (photosensitive seizure triggers), so the design below reads
 * as hard safety requirements, not visual preferences — where the two were
 * in tension, safety won. See the plan's own framing: "must ship with a
 * photosensitivity gate and a rate ceiling — a deliberate design constraint,
 * not an afterthought."
 *
 * ## Why `effect`, not `overlay`
 *
 * `effect` gets two guarantees enforced by `EffectDirector`/`SceneManager`
 * that `overlay` does not: a per-scene `cooldownSec` (a hard minimum gap
 * between firings, `advanceEffects` in EffectDirector.tsx) and a hard
 * `durationSec` lifetime cap (a firing CANNOT run indefinitely — it is
 * retired the instant `slotProgress` reaches 1). An `overlay` has neither.
 * For a scene whose whole premise is "flashes hard," giving up the engine's
 * own pacing guarantee would be the wrong trade, so this is `effect`-only.
 *
 * `durationSec: 1.5` — under 2s total lifetime per firing, and noticeably
 * shorter than `shock`'s 4.0s (a strobe reads its whole idea in under a
 * second; anything longer is just more exposure for no more picture).
 * `cooldownSec: 16` — higher than `shock`'s 12s, because this is the more
 * visually aggressive of the two `drop`-triggered effects and firing it
 * back-to-back with itself is exactly the pattern flash-rate guidance warns
 * about at the level of a whole set, not just one firing.
 *
 * ## Two independent safety layers, not one
 *
 * 1. **`effectEnvelope(slotProgress)`** (imported below, same contract as
 *    every effect scene) guarantees the WHOLE firing ramps up from zero and
 *    back down to zero — it can never pop on at full intensity or snap off.
 *    This is necessary but not sufficient: it says nothing about what
 *    happens to brightness *inside* one firing, where a fast section (high
 *    BPM, `uKick`/beat pulse) could still toggle several times a second.
 * 2. **A hard flash-rate floor, enforced in JS in `update()` below**,
 *    independent of (1) and independent of `cooldownSec`. This is the one
 *    that actually bounds how often a full-contrast event can happen
 *    WITHIN a single ~1.5s firing. See `FLASH_MIN_GAP_SEC` below.
 *
 * ## The picture: bar wipe (primary) + restrained full-field pulse (rare)
 *
 * Per the plan's explicit constraint (#3): no full-field pure white-on-black
 * flicker as the primary look. The dominant visual here is a row of vertical
 * bars that cascade on left-to-right as `slotProgress` advances — a
 * `floor`/`fract` bar pattern gated by a `smoothstep` reveal edge, entirely
 * deterministic and driven by `slotProgress`, not by any beat oscillator.
 * This spatial wipe carries no flicker risk at all: it is monotonic across
 * the firing's own timeline, never toggles on/off, and reaches zero
 * everywhere by construction once `effectEnvelope` closes it out.
 *
 * On top of that (additive, same as every effect scene — `AdditiveBlending`
 * means "off" is literal zero, not a rendered dark colour, so the bars punch
 * through whatever primary scene is running rather than replacing it), an
 * occasional full-field pulse fires on a real kick/snare hit — but ONLY when
 * the hard floor below allows it, and its own peak brightness is capped well
 * under pure white (`FLASH_PEAK_CAP`, blended through `uColorBright`, i.e.
 * the palette's glow tone — never `vec3(1.0)`).
 *
 * ## Monochrome by construction
 *
 * Exactly one non-black colour drives the whole shader: `col.glow`. Bars and
 * the full-field pulse both scale the same `uColorBright` — no hue ever
 * changes within a firing, let alone rapidly. Per the plan's brief (#4),
 * rapid colour cycling is its own photosensitivity concern, independent of
 * luminance flicker, so this scene simply never does it. "Off" is true
 * black (zero contribution, not `uBg`/`uShadow` painted in) because the
 * scene is additive — see the paragraph above.
 *
 * ## Band routing: bass + energy, captured once
 *
 * Same discipline as every effect scene: `bass`+`energy` set how hard THIS
 * drop reads (the bars' overall brightness, `uStrength`), sampled once on
 * the rising edge into the `effect` role and held for the whole firing — not
 * how the bars move (that is `slotProgress`, deterministic) and not what
 * gates a hard flash (that is kick/snare edges, see below — a fundamentally
 * different question: "how loud" vs "is a flash allowed right now").
 *
 * ## Performance
 *
 * No `uRes`/aspect correction (unlike the other three effect scenes) — bar
 * position only needs `vUv.x`, which is already 0..1 across the screen
 * regardless of aspect, so there is nothing to divide by `min(uRes.x,
 * uRes.y)` for. The whole shader is a `floor`/`fract` and three
 * `smoothstep`s, no loop, no noise, no division — cheaper than the other
 * three effect scenes' `exp()`-based falloffs, hence `performanceCost:
 * 'low'`.
 */

/** Vertical bar count for the cascade wipe. */
const BAR_COUNT = 8.0
/** Softness of each bar's edges, as a fraction of one bar's cell width. */
const BAR_EDGE = 0.12
/** Softness of the cascade reveal's leading edge, in slotProgress units. */
const REVEAL_EDGE = 0.16
/** How much the beat pulse may brighten the bars — a small, smooth (never
 *  on/off) shimmer, kept low-amplitude deliberately; see FLASH_MIN_GAP_SEC's
 *  comment for why a smooth modulation is a different risk class entirely
 *  from a hard flash, and why this stays modest anyway. */
const PULSE_BREATH = 0.15
/** Hard ceiling on the full-field pulse's own brightness — blended through
 *  the palette's glow tone, deliberately never allowed near pure white. */
const FLASH_PEAK_CAP = 0.55

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  /** Single monochrome drive colour — the palette's glow tone. */
  uniform vec3 uColorBright;
  /** 0..1 slotProgress — drives the bar cascade's wipe position. */
  uniform float uProgress;
  /** Smooth (non-binary) beat-pulse shimmer, 0..~1. */
  uniform float uPulse;
  /** Captured bass+energy hit strength, held for the whole firing. */
  uniform float uStrength;
  /** JS-side, floor-gated decaying flash amount — see update() below. */
  uniform float uFlashAmt;
  uniform float uFade;

  void main(){
    // Bar cell: BAR_COUNT vertical bars across the full screen width.
    // vUv.x is already 0..1 regardless of aspect, so no uRes divide needed.
    float barCoord = vUv.x * ${BAR_COUNT.toFixed(1)};
    float barId = floor(barCoord);
    float barLocal = fract(barCoord);
    float barShape = smoothstep(0.0, ${BAR_EDGE.toFixed(2)}, barLocal)
                    * smoothstep(1.0, 1.0 - ${BAR_EDGE.toFixed(2)}, barLocal);

    // Cascade reveal: bar barId switches on as uProgress sweeps past its
    // own staggered threshold — deterministic, monotonic, no flicker: once
    // a bar is on it stays on (smoothstep saturates) for the rest of the
    // firing, and effectEnvelope (applied below, outside this shader) is
    // what closes the whole thing back down to zero at the end.
    float stagger = barId / ${BAR_COUNT.toFixed(1)};
    float reveal = smoothstep(stagger - ${REVEAL_EDGE.toFixed(2)}, stagger + ${REVEAL_EDGE.toFixed(2)}, uProgress);

    // Smooth, continuous, low-amplitude — never a hard on/off, so this is
    // not subject to (and does not need) the flash-rate floor below.
    float shimmer = 1.0 + uPulse * ${PULSE_BREATH.toFixed(2)};

    vec3 barTerm = uColorBright * barShape * reveal * uStrength * shimmer;

    // The one hard-contrast term in this shader. uFlashAmt already carries
    // its own rate limit and decay from JS (update() below); this only adds
    // the brightness cap so even a fully-charged flash never reads as pure
    // white — it reads as an intensified wash of the same glow colour.
    vec3 flashTerm = uColorBright * min(uFlashAmt, 1.0) * ${FLASH_PEAK_CAP.toFixed(2)};

    vec3 color = barTerm + flashTerm;
    gl_FragColor = vec4(color * uFade, 1.0);
  }
`

/**
 * Minimum seconds between two "hard" (full-contrast) flash events, enforced
 * in JS regardless of how often the beat clock pulses underneath.
 *
 * The broadly-cited broadcast safe-harbour threshold is **no more than 3
 * full-contrast flashes per second** (ITU-R BT.1702 / Ofcom guidance on
 * photosensitive epilepsy — the same ~3 Hz figure cited in WCAG 2.3.1's
 * general flash threshold). At 180 BPM a quarter note already lands at 3 Hz,
 * and `uKick`+`uSnare` combined (a kick AND a snare within one beat) can
 * exceed it comfortably — so the beat clock alone cannot be trusted to stay
 * under the ceiling at the tempos this scene is meant to fire at (peak /
 * aggressive moods skew fast). `cooldownSec` (16s, in the effect metadata)
 * bounds how often the WHOLE EFFECT can fire; it says nothing about how many
 * hard-contrast pulses happen inside one ~1.5s firing, which is what this
 * floor bounds instead.
 *
 * 1 / 0.333 ≈ 3.003 Hz — deliberately AT the safe-harbour figure, not
 * padded above it, because this is the ceiling on registered flashes, not a
 * target rate: most 333ms windows during a firing register zero or one
 * flash (a real kick/snare edge has to actually land in the window), this
 * is only the floor that prevents two from landing closer together than
 * that.
 */
const FLASH_MIN_GAP_SEC = 0.333
/** Rising-edge thresholds on the (already reactivity-scaled) kick/snare
 *  envelopes — low enough to catch a real hit, high enough to ignore noise
 *  floor between hits. */
const KICK_ON = 0.35
const SNARE_ON = 0.35
/** Individual flash pulse decay rate — chosen so a registered flash has
 *  mostly decayed (~1.5%) again by the time the next one is even eligible
 *  (FLASH_MIN_GAP_SEC later), so consecutive flashes read as discrete pops
 *  rather than fusing into one longer, brighter-for-longer flash. */
const FLASH_DECAY = 14.0

export function StrobeBarsScene() {
  const wasEffect = useRef(false)
  /** Captured bass+energy hit strength, held for the whole firing — see header. */
  const strength = useRef(1)

  /** Wall-clock (features.time) of the last REGISTERED hard flash. -Infinity
   *  until one occurs, so nothing can flash before the floor has anything to
   *  measure against. */
  const lastFlashAt = useRef(-Infinity)
  /** Peak brightness of the most recently registered flash, decayed each
   *  frame in update() from lastFlashAt. */
  const flashPeak = useRef(0)
  const prevKick = useRef(0)
  const prevSnare = useRef(0)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColorBright: { value: new THREE.Color('#ffffff') },
          uProgress: { value: 0 },
          uPulse: { value: 0 },
          uStrength: { value: 1 },
          uFlashAmt: { value: 0 },
          uFade: { value: 0 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
  useDispose(material, geometry)

  useSceneFrame(({ f, b, col, vis, role, slotProgress }) => {
    const u = material.uniforms
    u.uColorBright.value.copy(col.glow)

    const isEffect = role === 'effect'

    if (isEffect && !wasEffect.current) {
      // Rising edge into the firing — reset every piece of per-firing state
      // fresh. Guards two things at once: a flash charge left over from a
      // firing songs ago bleeding into this one, and `f.time` having
      // rewound across a source restart (EffectDirector's own `now` is
      // `features.time`, documented there as restarting at 0 on a new
      // source) — a stale, large `lastFlashAt` after such a rewind would
      // otherwise make `f.time - lastFlashAt` deeply negative and simply
      // suppress every flash for the rest of the set, which is safe but not
      // intended; resetting on the edge avoids relying on that accident.
      lastFlashAt.current = -Infinity
      flashPeak.current = 0
      prevKick.current = b.kick
      prevSnare.current = b.snare

      // Captured once, held for the whole firing — same discipline as
      // ShockRingScene/SectionFlareScene/TransientSparkScene. bass + energy
      // are the declared bands: how hard THIS drop reads, not how the bars
      // move (slotProgress-driven) or when a hard flash is allowed (kick/
      // snare edges, below) — three different questions answered three
      // different ways on purpose.
      const raw = Math.min(1, b.bass * 0.6 + b.energy * 0.6)
      strength.current = 0.7 + raw * 0.7
    }
    wasEffect.current = isEffect
    u.uStrength.value = strength.current

    if (isEffect) {
      // ---- HARD FLASH-RATE CEILING (independent of cooldownSec) --------
      // A candidate flash is a rising edge on either drum envelope — kick
      // OR snare, deliberately combined, since it is exactly a fast
      // kick+snare alternation that can exceed 3 Hz even when neither drum
      // alone would. Every candidate is evaluated; only ones that clear the
      // 333ms gap since the last REGISTERED (not merely candidate) flash
      // are allowed through. A candidate that arrives too soon is silently
      // dropped — no queueing, no "catch up later" — which is the point:
      // the beat can propose a flash far more often than 3 Hz, this is what
      // keeps the SCREEN from doing it.
      const kickEdge = b.kick > KICK_ON && prevKick.current <= KICK_ON
      const snareEdge = b.snare > SNARE_ON && prevSnare.current <= SNARE_ON
      if (kickEdge || snareEdge) {
        if (f.time - lastFlashAt.current >= FLASH_MIN_GAP_SEC) {
          lastFlashAt.current = f.time
          const hit = Math.max(kickEdge ? b.kick : 0, snareEdge ? b.snare : 0)
          flashPeak.current = 0.5 + Math.min(1, hit) * 0.5
        }
        // else: a real beat-grid pulse arrived under the floor — skipped,
        // by design. This is the ceiling actually being enforced, not just
        // documented.
      }
      prevKick.current = b.kick
      prevSnare.current = b.snare
    }

    // Decaying brightness since the last registered flash — always
    // computed from the captured `lastFlashAt`/`flashPeak`, never
    // accumulated frame-to-frame, so it is a pure function of state exactly
    // like the deterministic-placement discipline TransientSparkScene uses
    // for its spark seed (no drift, replays identically for a recorded show).
    const sinceFlash = f.time - lastFlashAt.current
    u.uFlashAmt.value = isEffect && sinceFlash >= 0 ? flashPeak.current * Math.exp(-sinceFlash * FLASH_DECAY) : 0

    // Smooth shimmer only while actually firing — see PULSE_BREATH's doc
    // for why this is a different (and much lower) risk than the hard
    // flash term above.
    u.uPulse.value = isEffect ? b.pulse : 0

    u.uProgress.value = slotProgress

    // Same contract as every effect scene: effectEnvelope is zero at both
    // slotProgress 0 and 1, so the whole firing ramps in and back out
    // rather than popping on or snapping off — the second, independent
    // safety layer on top of the flash-rate floor above (see header).
    u.uFade.value = isEffect ? vis * effectEnvelope(slotProgress) : vis
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

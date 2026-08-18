import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality } from '../engine/quality'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/**
 * Heap Corruption — an allocator grid rotting in real time. Healthy blocks glow
 * cold phosphor teal; corruption spreads from a wandering epicenter, turning
 * cells hot magenta and ember as they decay, with row-tearing and stray memcpy
 * glitches on top.
 *
 * Adapted from "Heap Corruption" by Tor Ringstad, 2026.
 * Licensed CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
 * Source: https://www.pvv.ntnu.no/~torhr/shaders/
 *
 * CC BY requires attribution and that modifications be indicated, so plainly:
 * the field maths (`h12`/`h11`, `vnoise`, `corruption`, the `cells` glyph grid,
 * the memcpy/tear displacement shapes) is the original author's, ported
 * unchanged in structure. What this port changes is listed below.
 *
 * ## What was replaced, and why
 *
 * The source is entirely TIME-driven: `pressure()` manufactured its spikes from
 * `step(0.72, h11(floor(t*0.8)))` — a hash on a time slot — and the tear and
 * memcpy events ran on fixed-rate timers with their own RNG. Ported literally,
 * this would have been another audio-dead fullscreen scene: technically
 * animated, but glitching to its own schedule with no relationship to the
 * music. The five earlier ported scenes in this roster all landed that way and
 * it is the thing worth not repeating.
 *
 * So every one of those fake-RNG event generators is gone, replaced by the
 * real envelope that should have been driving it:
 *
 *   energy + transient → corruption PRESSURE. The time-slot spike generator is
 *                        deleted outright; a real hit now causes the rot.
 *   pulse             → row-tear rate AND threshold, so tearing is tempo-locked
 *                        rather than free-running at the source's fixed 7 Hz.
 *   snare + transient → misdirected-memcpy gating, replacing the fixed-rate
 *                        `step(0.6, h11(slot))` coin flip.
 *   anim.explode      → the solid-cell slam. This is the scene's natural
 *                        "everything goes at once" moment, and `explode` is the
 *                        only route by which the director's `visualTension`
 *                        reaches a scene — so the bar BEFORE a drop already
 *                        starts slamming cells, and the drop itself completes
 *                        it. Tension is not in any band envelope.
 *   hihat             → per-cell reroll rate, the frantic seethe.
 *   bass              → allocation block size, so the grid breathes.
 *   mid               → clock rate; a dense harmonic passage rots faster.
 *   spectralFlatness  → live/rot bias. Noisy, distorted material reads as decay
 *                        even where the corruption field has not spread yet.
 *
 * Chromatic aberration is left exactly as authored (`corruption × pressure`).
 * It needed no wiring of its own — both of its inputs are now audio-driven, so
 * it inherits the reactivity for free.
 *
 * The wandering epicenter stays on wall-clock, deliberately. It is a ~30 s
 * drift, and coupling a slow ambient movement to a fast envelope reads as
 * jitter rather than as response — the same reasoning that keeps
 * `keyPalette`'s dwell slow.
 */

/**
 * Overall brightness.
 *
 * The source already tonemaps (`col / (1 + 0.35*col)` then a `pow(col, 0.92)`
 * lift), so it arrives roughly in 0..1 and far hotter than the near-black
 * raymarch scenes — glyphs, chunk boundaries and the sweep all add. 0.22 keeps
 * it legible while staying inside the roster's additive exposure budget
 * (docs/09_Rendering_Engine.md); it reads as bright phosphor because coverage
 * is sparse, not because the whole frame is lifted.
 */
const BRIGHTNESS = 0.22

export const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};

  uniform vec2 uRes;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uTransient;
  uniform float uPulse;
  uniform float uSnare;
  uniform float uHihat;
  uniform float uBass;
  uniform float uExplode;
  uniform float uFlatness;
  uniform vec3 uColLive;
  uniform vec3 uColRot;
  uniform vec3 uColAccent;
  uniform float uFade;
  /** Cells per vertical unit. Quality-governed — see the component. */
  uniform float uGridSize;
  /** 1 = single evaluation, 3 = full chromatic-aberration taps. */
  uniform int uCaTaps;

  #define TEAR_ROWS  (26.0)
  #define TEAR_RATE  (7.0)
  #define MEMCPY_RATE (1.6)
  #define SWEEP_SPEED (0.13)
  #define CA_BASE    (0.002)
  #define CA_SCALE   (0.010)

  // ---- hashes & noise (original) -------------------------------------------
  float h12(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float h11(float n){ return fract(sin(n*127.1)*43758.5453); }

  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    float a = h12(i), b = h12(i+vec2(1,0)), c = h12(i+vec2(0,1)), d = h12(i+vec2(1,1));
    return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  }

  // ---- global corruption pressure ------------------------------------------
  // The source's spike term was a hash on a time slot. Deleted: transients and
  // energy ARE the spikes now. The slow breathe is kept so the grid still has
  // life during a quiet passage rather than going inert.
  float pressure(){
    float breathe = 0.5 + 0.5*sin(uTime*0.45);
    return clamp(0.15 + 0.30*breathe + 0.75*uTransient + 0.50*uEnergy, 0.0, 1.4);
  }

  // ---- corruption field (original shape) -----------------------------------
  float corruption(vec2 p, float t){
    float pr = pressure();
    float n = vnoise(p*2.3 + vec2(t*0.18, -t*0.11));
    n = 0.65*n + 0.35*vnoise(p*6.1 - vec2(t*0.07, t*0.23));
    // Wandering epicenter — deliberately still wall-clock, see the header.
    vec2 c = vec2(0.9 + 0.55*sin(t*0.21), 0.5 + 0.42*cos(t*0.16));
    float blob = smoothstep(0.75, 0.05, length(p - c));
    return clamp(smoothstep(0.72 - 0.35*pr, 0.95, n + 0.35*blob*pr), 0.0, 1.0);
  }

  // ---- glitch displacements ------------------------------------------------
  vec2 displace(vec2 p, float t){
    float pr = pressure();

    // Row tearing, tempo-locked. The source re-rolled tear slots at a fixed
    // 7 Hz; the beat envelope now drives BOTH how fast slots turn over and how
    // many rows qualify, so tears land on the beat instead of drifting against
    // it. The 0.35 floor keeps a trickle of tearing between beats.
    float row = floor(p.y*TEAR_ROWS);
    float rr = h12(vec2(row, floor(t*TEAR_RATE*(0.35 + uPulse*1.9))));
    float tearOn = step(0.965 - 0.12*pr - 0.22*uPulse, rr);
    p.x += tearOn * (rr - 0.5) * 0.7 * (pr + uPulse*0.5);

    // Misdirected memcpy: a rectangle reads from elsewhere. The source gated
    // this on a fixed-rate coin flip; snare and transient open the gate now, so
    // the big rectangular jumps belong to hits rather than to a timer. Kept on
    // different bands from the tearing above so the two glitch mechanisms stay
    // legibly separate events at different scales.
    float slot = floor(t*MEMCPY_RATE);
    float go = step(0.72 - 0.45*uSnare - 0.30*uTransient, h11(slot+13.7))
             * step(fract(t*MEMCPY_RATE), 0.4);
    vec2 bmin = vec2(h11(slot+1.1)*1.4, h11(slot+2.2)*0.8);
    vec2 bsz  = vec2(0.25+0.5*h11(slot+3.3), 0.06+0.18*h11(slot+4.4));
    float inbox = step(bmin.x, p.x)*step(p.x, bmin.x+bsz.x)
                * step(bmin.y, p.y)*step(p.y, bmin.y+bsz.y);
    p += go * inbox * (vec2(h11(slot+5.5), h11(slot+6.6)) - 0.5) * 0.9 * (0.45 + uSnare*0.8);
    return p;
  }

  // ---- the heap ------------------------------------------------------------
  vec3 cells(vec2 p, float t, out float corrOut){
    float corr = corruption(p, t);
    corrOut = corr;

    // Bass breathes the allocation block size. Clamped either side: below ~12
    // the glyphs turn to mush, above ~30 they alias into noise at 1080p.
    float gs = clamp(uGridSize * (1.0 - uBass*0.22), 12.0, 30.0);
    vec2 g  = p * gs;
    vec2 id = floor(g);
    vec2 f  = fract(g);

    // Hi-hats drive the reroll rate — a busy hat pattern makes corrupted cells
    // seethe, while a kick-only passage leaves them comparatively still.
    float flick = floor(t*(2.0 + 26.0*corr)*(1.0 + uHihat*2.2));
    float val = h12(id + flick*0.1731*step(0.18, corr));

    float chunk = h12(floor(id/vec2(5.0, 3.0)));

    vec2 pad0 = vec2(0.16, 0.14), pad1 = vec2(0.84, 0.86);
    float inpad = step(pad0.x,f.x)*step(f.x,pad1.x)*step(pad0.y,f.y)*step(f.y,pad1.y);
    vec2 sub = floor((f - pad0)/(pad1 - pad0)*vec2(3.0, 4.0));
    float bit = step(0.62 - 0.34*val, h12(id*3.17 + sub*vec2(0.71, 1.33) + flick*0.031));
    float glyph = bit*inpad;

    // Palette-driven rather than the source's fixed teal/magenta, so this
    // recolours with the rest of the roster. The live/rot grammar is preserved:
    // col.a reads as the healthy phosphor, col.b/col.c as the rot.
    vec3 live = mix(uColLive*0.18, uColLive, val) * (0.75 + 0.5*chunk);
    vec3 rot  = mix(uColRot, uColAccent, h12(id + 7.7 + flick*0.07));
    float sick = smoothstep(0.15, 0.65, corr + uFlatness*0.18);
    vec3 ink = mix(live, rot, sick);

    vec3 col = ink * (0.10 + 1.05*glyph);

    // THE SLAM. Fully-corrupted cells go solid; uExplode lowers both gates at
    // once, so the bar before a drop starts throwing solid blocks and the drop
    // itself takes most of the grid.
    float solid = step(0.72 - 0.42*uExplode, corr) * step(0.55 - 0.35*uExplode, h12(id + flick + 3.3));
    col = mix(col, rot*1.15, solid*0.9);

    vec2 e = min(f, 1.0-f);
    float line = 1.0 - smoothstep(0.0, 0.06, min(e.x, e.y));
    col += line * mix(uColLive*0.12, uColRot*0.10, sick) * 2.0;

    float free_ = smoothstep(0.35, 0.0, vnoise(id*0.13 + 4.2));
    col *= 1.0 - 0.55*free_*(1.0-sick);

    return col;
  }

  vec3 sceneCol(vec2 p, float t){
    p = displace(p, t);
    float corr;
    vec3 col = cells(p, t, corr);
    float sweep = fract(p.y*0.5 - t*SWEEP_SPEED);
    col += uColLive * 0.22 * smoothstep(0.12, 0.0, sweep) * (1.0-corr);
    return col;
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    vec2 uv = fragCoord.xy / uRes.y;   // aspect-true, y in [0,1]
    float t = uTime;

    // Unchanged from the source. Both inputs are audio-driven now, so this
    // inherits its reactivity without needing a term of its own.
    float ca = CA_BASE + CA_SCALE*corruption(uv, t)*pressure();

    vec3 col;
    if (uCaTaps > 1) {
      col.r = sceneCol(uv + vec2( ca, 0.0), t).r;
      col.g = sceneCol(uv,                  t).g;
      col.b = sceneCol(uv - vec2( ca, 0.0), t).b;
    } else {
      // Survival tiers evaluate the field once instead of three times — this
      // is by far the dominant cost, so it is the real complexity knob.
      col = sceneCol(uv, t);
    }

    col *= 0.92 + 0.08*sin(fragCoord.y*3.14159*0.5);
    vec2 q = vUv;
    col *= 0.55 + 0.45*pow(16.0*q.x*q.y*(1.0-q.x)*(1.0-q.y), 0.28);
    col *= 0.97 + 0.03*h11(floor(t*60.0));

    col = col / (1.0 + 0.35*col);
    col = pow(col, vec3(0.92));

    gl_FragColor = vec4(col * U_BRIGHTNESS * uFade, 1.0);
  }
`

export function HeapCorruptionScene() {
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const clock = useRef(0)

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
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uEnergy: { value: 0 },
          uTransient: { value: 0 },
          uPulse: { value: 0 },
          uSnare: { value: 0 },
          uHihat: { value: 0 },
          uBass: { value: 0 },
          uExplode: { value: 0 },
          uFlatness: { value: 0 },
          uColLive: { value: new THREE.Color('#45f5b8') },
          uColRot: { value: new THREE.Color('#f21a7a') },
          uColAccent: { value: new THREE.Color('#ff8c1f') },
          uFade: { value: 0 },
          uGridSize: { value: 21 },
          uCaTaps: { value: 3 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  useDispose(material, geometry)

  useEffect(() => {
    material.uniforms.uRes.value.set(size.width * dpr, size.height * dpr)
  }, [material, size, dpr])

  useSceneFrame(({ f, dt, b, anim, col, vis, params }) => {
    const u = material.uniforms

    clock.current += dt * (1 + b.mid * 0.35) * params.speed

    u.uTime.value = clock.current
    u.uEnergy.value = b.energy
    u.uTransient.value = b.transient
    u.uPulse.value = b.pulse
    u.uSnare.value = b.snare
    u.uHihat.value = b.hihat
    u.uBass.value = b.bass
    u.uExplode.value = anim.explode
    u.uFlatness.value = Math.min(1, f.spectralFlatness)
    u.uColLive.value.copy(col.a)
    u.uColRot.value.copy(col.b)
    u.uColAccent.value.copy(col.c)
    u.uFade.value = vis

    // Two knobs, in cost order. The chromatic-aberration taps evaluate the
    // whole field three times, so dropping to one is worth roughly 3x — far
    // more than thinning the grid, which is why it goes first.
    u.uCaTaps.value = quality.tier <= 3 ? 3 : 1
    const qualityFraction = quality.knobs.raymarchSteps / 96
    u.uGridSize.value = Math.max(12, Math.round(21 * qualityFraction))
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </mesh>
  )
}

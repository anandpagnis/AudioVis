import * as THREE from 'three'
import { Pass } from 'postprocessing'
import { FULLSCREEN_VERT } from './glsl'
import {
  isLensActive,
  lensBeatMode,
  resolveLensStyle,
  RIP_SLOTS,
  type LensRackState,
} from './opticalRack'

/**
 * The lens rack: one pass, seven interchangeable optical materials that refract
 * the whole composite.
 *
 * Ported from lilim's `LensShader` (`web/main.js`), maths unchanged. Shared
 * traits across every material, which are what make them read as one rack
 * rather than seven unrelated filters:
 *
 *  - a slight per-channel refraction difference, so edges disperse prismatically
 *  - a specular sheen where the surface is steep
 *  - kicks cause a **structural re-seat** of the material, never a flash
 *
 * The materials: reeded glass (`glass ribs`), the same flutes radiating from
 * bottom centre (`glass fan`), cinema glass with real streak flares
 * (`anamorphic`), a liquefying pane with kick-spawned heat plumes (`melt`),
 * horizontal slice tears (`glitch`), an LED-wall mosaic (`pixels`), and a hex
 * lattice of convex lenslets (`fly eye`).
 *
 * ## Where it sits, and why
 *
 * **After** bloom, matching lilim (`mirror → feedback → bloom → lens`). That is
 * the difference between glass and a filter: bloom's glow is refracted by the
 * material, the way light smears through real optics, instead of being laid on
 * top of an already-refracted image.
 *
 * In this chain that means it sits after the merged Bloom/CA/Vignette
 * `EffectPass` rather than before it — so it is the last thing in the composer.
 *
 * ## Never mounted, never unmounted
 *
 * A raw `Pass`, constructed once and left in the chain for the session; the
 * pass-level `enabled` flag is the only branch, so an inert rack costs nothing
 * at all. See opticalRack.ts for why the list's shape has to stay fixed.
 *
 * This pass used to be unable to do that. It was last in the chain, and
 * `EffectComposer` flags the LAST pass added as the one that renders to screen
 * while skipping disabled passes before that happens — so switching itself off
 * left nothing writing to the framebuffer and the canvas froze on its last
 * presented frame. It carried the duty by staying enabled and degrading to a
 * straight copy, at the cost of one unconditional fullscreen blit.
 *
 * `GradePass` now sits after it and is genuinely always-on (it applies the
 * exposure servo's gain), so the duty belongs to something that earns it and
 * this rack is free again. Net frame cost is unchanged — the blit moved rather
 * than being added.
 *
 * **Whatever is last in the chain inherits that duty.** The final child of
 * `<EffectComposer>` must never be conditionally skipped.
 */

const LENS_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uAmt;
  uniform float uStyle;
  uniform float uAspect;
  uniform float uKick;
  uniform float uAux;
  uniform float uDrift;
  uniform float uTime;
  uniform float uSeed;
  uniform vec4 uRip[${RIP_SLOTS}];
  varying vec2 vUv;

  vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i).x, hash2(i + vec2(1.0, 0.0)).x, f.x),
      mix(hash2(i + vec2(0.0, 1.0)).x, hash2(i + vec2(1.0, 1.0)).x, f.x), f.y);
  }

  void main() {
    vec2 off = vec2(0.0);
    float shade = 1.0;
    float sheen = 0.0;
    vec3 glow = vec3(0.0);

    if (uStyle < 1.5) {
      // glass ribs / glass fan: semicircular flutes. The surface slope across
      // one flute is what refracts, so the whole material is a single
      // inversesqrt of the distance from the flute's centre line.
      float c;
      vec2 dirAcross; // screen-space width vector of one flute
      if (uStyle < 0.5) {
        float ribs = 78.0;
        c = vUv.x * ribs + uDrift;
        dirAcross = vec2(1.0 / ribs, 0.0);
      } else {
        float ribs = 44.0; // flutes across the half-turn
        vec2 d = vec2((vUv.x - 0.5) * uAspect, vUv.y + 0.06);
        c = atan(d.x, d.y) / 3.14159265 * ribs + uDrift;
        float r = max(length(d), 1e-3);
        vec2 tang = normalize(vec2(d.y, -d.x));
        dirAcross = tang * vec2(1.0 / uAspect, 1.0) * (3.14159265 / ribs) * r;
      }
      float f = fract(c) - 0.5;
      float slope = f * inversesqrt(max(0.25 - f * f, 0.02));
      float amt = uAmt * (0.55 + 0.25 * uKick);
      off = dirAcross * slope * amt * 0.9;
      shade = 1.0 - 0.35 * amt * smoothstep(0.15, 0.5, abs(f));
      sheen = pow(max(0.0, 1.0 - abs(abs(f) - 0.32) * 9.0), 3.0) * amt * (0.10 + 0.18 * uKick);
    } else if (uStyle < 2.5) {
      // anamorphic: horizontal squeeze that breathes (uDrift clicks a
      // quarter-phase per kick, which reads as a focus rack), cubic edge smear,
      // and streak flares gathered along x from the hot parts of the frame. The
      // streaks carry the source pixel's own colour, lightly cooled, so the
      // palette stays in charge rather than the flare inventing a hue.
      float breathe = 0.5 + 0.5 * sin(uDrift * 6.2831853);
      float squeeze = uAmt * (0.06 + 0.16 * breathe + 0.08 * uKick);
      float cx = vUv.x - 0.5;
      off.x = cx * squeeze + cx * cx * cx * 0.5 * uAmt;
      off.y = -(vUv.y - 0.5) * squeeze * 0.22;
      shade = 1.0 - 0.22 * uAmt * smoothstep(0.28, 0.5, abs(cx));
      float fl = uAmt * (0.5 + 0.6 * uKick);
      vec3 st = vec3(0.0);
      for (int i = 1; i <= 12; i++) {
        float d = float(i) / 12.0;
        float w = exp(-d * 5.0);
        vec2 sp = vec2(d * 0.55, 0.0);
        // Fade taps that fall off-frame: a clamped read repeats the edge column
        // and paints a flat band instead of a streak.
        float xr = vUv.x + sp.x, xl = vUv.x - sp.x;
        float wr = w * smoothstep(0.0, 0.05, 1.0 - xr);
        float wl = w * smoothstep(0.0, 0.05, xl);
        st += max(texture2D(tDiffuse, clamp(vUv + sp, 0.0, 1.0)).rgb - 0.55, 0.0) * wr;
        st += max(texture2D(tDiffuse, clamp(vUv - sp, 0.0, 1.0)).rgb - 0.55, 0.0) * wl;
      }
      glow = st * fl * 0.22 * vec3(0.8, 0.95, 1.15);
    } else if (uStyle < 3.5) {
      // melt: columnar runnels (anisotropic scrolling noise) drag the image
      // downward; kicks spawn rising heat plumes (uRip slots) that hard-liquefy
      // their region.
      vec2 q = vec2(vUv.x * uAspect * 6.0, vUv.y * 2.0 + uTime * 0.12);
      float n = vnoise(q) * 0.65 + vnoise(q * 2.7 + 13.7) * 0.35;
      vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
      float plume = 0.0;
      for (int i = 0; i < ${RIP_SLOTS}; i++) {
        float age = uTime - uRip[i].z;
        if (uRip[i].w > 0.001 && age > 0.0 && age < 3.0) {
          vec2 d = p - uRip[i].xy;
          d.y -= age * 0.22; // the hot zone rises as it fades
          plume += exp(-dot(d, d) * 12.0) * exp(-age * 1.1) * uRip[i].w;
        }
      }
      float drip = n * n * (0.4 + 0.6 * n); // sharpen: few strong runnels
      float m = uAmt * (0.02 + drip * 0.16 + plume * 0.24);
      off.y = m; // sample above -> the image drags downward
      off.x = (vnoise(q * 3.1 + 51.3) - 0.5) * m * 0.7;
      shade = 1.0 - 0.28 * uAmt * smoothstep(0.55, 1.0, n + plume * 0.7);
      sheen = (pow(max(0.0, n - 0.6), 2.0) * 4.0 + plume * 0.2) * uAmt;
    } else if (uStyle < 4.5) {
      // glitch: coarse slice tears re-rolled by uSeed, plus fine micro-tears
      // gated on the highs.
      float bid = floor(vUv.y * 26.0);
      vec2 h = hash2(vec2(bid, uSeed));
      float on = step(1.0 - 0.5 * uAmt, h.x);
      float shift = (h.y - 0.5) * 0.25 * uAmt * on * (0.4 + 0.6 * uKick);
      vec2 h2 = hash2(vec2(floor(vUv.y * 160.0), uSeed * 1.31));
      shift += (h2.x - 0.5) * 0.05 * uAmt * step(0.93 - 0.2 * uAux, h2.y);
      off = vec2(shift, 0.0);
      shade = 1.0 - (0.08 + 0.22 * uAux) * uAmt * (0.5 + 0.5 * sin(vUv.y * 1100.0));
      vec2 hb = hash2(floor(vec2(vUv.x * 8.0, vUv.y * 5.0)) + vec2(uSeed * 0.7, uSeed * 1.13));
      shade *= 1.0 - 0.85 * uAmt * on * step(0.96, hb.x); // block dropouts
    } else if (uStyle < 5.5) {
      // pixels: LED-wall mosaic, snapping sampling to cell centres.
      //
      // The cell grid is FIXED, and lilim's comment records why: sizing it off
      // the kick moved every cell boundary on every hit, and the kick envelope
      // has no accent gate, so at fast tempo the wall never settled and the
      // whole effect read as jitter. Kicks light the panel instead, which holds
      // the geometry still and keeps the wall alive.
      float n = mix(140.0, 30.0, uAmt);
      vec2 g = vec2(n, n / uAspect);
      vec2 center = (floor(vUv * g) + 0.5) / g;
      off = center - vUv;
      vec2 fp = fract(vUv * g);
      float gap = step(0.08, fp.x) * step(fp.x, 0.92) * step(0.08, fp.y) * step(fp.y, 0.92);
      shade = mix(1.0, gap, min(1.0, uAmt * 2.0)); // hard black grid
      shade *= 1.0 + 0.18 * uKick;                 // lamps brighten on the hit
    } else {
      // fly eye: hex lattice of convex lenslets, each refracting its
      // neighbourhood like a glass bead — the radial cousin of the flute slope.
      // Amount sweeps bead count 26 -> 5; kicks click the lattice rotation.
      float n = mix(26.0, 5.0, uAmt);
      float ca = cos(uDrift), sa = sin(uDrift);
      vec2 p = mat2(ca, -sa, sa, ca) * vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5) * n;
      vec2 r = vec2(1.0, 1.7320508);
      vec2 a = mod(p, r) - r * 0.5;
      vec2 b = mod(p - r * 0.5, r) - r * 0.5;
      vec2 g = dot(a, a) < dot(b, b) ? a : b;
      float rr = length(g) * 1.55; // ~1 at the bead rim
      float slope = inversesqrt(max(1.0 - rr * rr * 0.82, 0.06));
      vec2 o = -g * slope * (0.5 + 0.2 * uKick) * uAmt / n;
      off = mat2(ca, sa, -sa, ca) * o;
      off.x /= uAspect;
      shade = 1.0 - 0.45 * uAmt * smoothstep(0.72, 1.05, rr);
      sheen = pow(max(0.0, 1.0 - length(g - vec2(0.16, 0.2)) * 3.2), 3.0) * uAmt * (0.10 + 0.22 * uKick);
    }

    // The shared traits, applied to every material: prismatic dispersion (each
    // channel refracts by a slightly different amount), then shade, sheen, glow.
    vec3 col;
    col.r = texture2D(tDiffuse, clamp(vUv + off * 0.92, 0.0, 1.0)).r;
    col.g = texture2D(tDiffuse, clamp(vUv + off, 0.0, 1.0)).g;
    col.b = texture2D(tDiffuse, clamp(vUv + off * 1.08, 0.0, 1.0)).b;
    if (uStyle > 4.5 && uStyle < 5.5) col = floor(col * 6.0 + 0.5) / 6.0; // posterise the wall
    col *= shade;
    col += sheen * (col + 0.25);
    col += glow;
    gl_FragColor = vec4(col, 1.0);
  }
`

export class LensPass extends Pass {
  private readonly material: THREE.ShaderMaterial
  private readonly fsScene: THREE.Scene
  private readonly quadGeometry: THREE.PlaneGeometry
  private readonly orthoCamera: THREE.OrthographicCamera

  /** Slow phase for the flute/anamorphic/fly-eye materials. */
  private drift = 0
  /** Integer re-roll for `glitch`. */
  private seed = 0
  /** Monotonic clock for `melt`'s noise scroll and plume ages. */
  private time = 0
  /** Ring cursor into the plume slots. */
  private ripSlot = 0
  private readonly rip: THREE.Vector4[]


  constructor() {
    super('LensPass')
    this.needsSwap = true
    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    // `z = -1e3` parks every slot far enough in the past that its `age` is well
    // past the 3 s cutoff, so an untouched slot contributes nothing on frame one.
    this.rip = Array.from({ length: RIP_SLOTS }, () => new THREE.Vector4(0, 0, -1e3, 0))
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: LENS_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        tDiffuse: { value: null },
        uAmt: { value: 0 },
        uStyle: { value: 0 },
        uAspect: { value: 1 },
        uKick: { value: 0 },
        uAux: { value: 0 },
        uDrift: { value: 0 },
        uTime: { value: 0 },
        uSeed: { value: 0 },
        uRip: { value: this.rip },
      },
    })
    this.fsScene = new THREE.Scene()
    this.fsScene.add(new THREE.Mesh(this.quadGeometry, this.material))
  }

  /**
   * Push this frame's rack settings and advance whichever beat mechanism the
   * selected material uses.
   *
   * `onKick` is a rising-edge strength (0 on a frame that is not a beat), not a
   * level — the three re-seat mechanisms are all events, and driving them from a
   * continuous envelope is what turns a structural re-seat into a flicker.
   *
   * Sets {@link Pass.enabled}; an inert rack is skipped by the composer rather
   * than rendering an identity transform. Allocation-free.
   */
  advance(
    l: LensRackState,
    dt: number,
    audio: { kick: number; highs: number; mids: number; onKick: number },
  ): void {
    const active = isLensActive(l)
    this.enabled = active
    if (!active) return

    const step = isFinite(dt) ? dt : 0
    this.time += step
    const style = resolveLensStyle(l.style)
    const u = this.material.uniforms
    u.uStyle.value = style
    u.uAmt.value = l.amount
    u.uKick.value = audio.kick
    u.uAux.value = audio.highs
    u.uTime.value = this.time

    switch (lensBeatMode(style)) {
      case 'seed':
        // Every kick re-rolls the tears; the slow auto-mutation term keeps them
        // moving between beats so a held note does not freeze the glitch.
        if (audio.onKick > 0) this.seed += 1
        u.uSeed.value = this.seed + Math.floor(this.time * 3) * 0.017
        break
      case 'drift':
        this.drift += step * (0.02 + audio.mids * 0.05) + audio.onKick * 0.25
        u.uDrift.value = this.drift
        break
      case 'plume':
        if (audio.onKick > 0) this.spawnPlume(audio.onKick)
        break
      case 'none':
        break
    }
  }

  /** Place one rising heat plume low in the frame, in the next ring slot. */
  private spawnPlume(strength: number): void {
    const h = Math.sin(this.time * 131.3) * 43758.5453
    const slot = this.rip[this.ripSlot % RIP_SLOTS]
    this.ripSlot++
    const aspect = this.material.uniforms.uAspect.value as number
    slot.set(
      ((h - Math.floor(h)) * 2 - 1) * 0.4 * aspect,
      ((((h * 7.13) % 1) + 1) % 1 - 0.75) * 0.55,
      this.time,
      Math.min(1, strength * 1.2),
    )
  }

  render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    if (!inputBuffer) return
    this.material.uniforms.tDiffuse.value = inputBuffer.texture
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.fsScene, this.orthoCamera)
  }

  setSize(width: number, height: number): void {
    this.material.uniforms.uAspect.value = Math.max(1, width) / Math.max(1, height)
  }

  dispose(): void {
    this.material.dispose()
    this.quadGeometry.dispose()
    super.dispose()
  }
}

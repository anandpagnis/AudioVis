/**
 * Reusable GLSL building blocks for the new art direction — raymarched SDF
 * scenes (Angel Core, Cyber Cathedral, Infinite Tunnel, …). Drop these string
 * chunks into a fullscreen-quad ShaderMaterial the same way scenes already use
 * NOISE_GLSL / FULLSCREEN_VERT from ./glsl.
 *
 * All chunks target GLSL ES 1.00 (Three.js ShaderMaterial default), so loops
 * use constant bounds and functions are declared before use. Raymarched scenes
 * follow this order inside their fragment shader:
 *
 *   ${NOISE3D_GLSL}
 *   ${SDF_GLSL}
 *   ${RAYMARCH_GLSL}      // declares `float map(vec3);` as a prototype
 *   float map(vec3 p) { ...your field... }
 *   void main() { ...set up ro/rd, call raymarch()... }
 */

/**
 * Divergence-free curl of a cheap sine field — the transport both
 * PlasmaFilamentScene and DissolveCageScene advect their particles through.
 *
 * Each scene previously carried a byte-for-byte copy of this inline in its own
 * vertex shader. Two copies of the same field is two places to fix a bug and
 * two chances to drift — and they HAD drifted: Plasma sampled the central
 * difference at e=0.15, Dissolve at e=0.2, with nothing recording why.
 *
 * `e` is therefore a parameter rather than a constant, and each scene passes
 * the epsilon it was authored and tuned with. That is the important detail:
 * this consolidation is exactly source-level, so both scenes produce
 * bit-identical output to before. The epsilon difference was never a bug to
 * reconcile — it is a per-scene tuning value that simply had nowhere to live.
 *
 * The curl of a vector field is divergence-free, which is what makes particles
 * ride streamlines instead of collapsing into sinks.
 */
export const CURL_NOISE_GLSL = /* glsl */ `
  vec3 snoiseVec3(vec3 x) {
    return vec3(
      sin(x.y * 1.7 + x.z * 0.9),
      sin(x.z * 1.3 + x.x * 1.1),
      sin(x.x * 1.9 + x.y * 0.7)
    );
  }

  vec3 curlNoise(vec3 p, float e) {
    vec3 dx = vec3(e, 0.0, 0.0);
    vec3 dy = vec3(0.0, e, 0.0);
    vec3 dz = vec3(0.0, 0.0, e);
    vec3 x1 = snoiseVec3(p + dx), x0 = snoiseVec3(p - dx);
    vec3 y1 = snoiseVec3(p + dy), y0 = snoiseVec3(p - dy);
    vec3 z1 = snoiseVec3(p + dz), z0 = snoiseVec3(p - dz);
    return vec3(
      (y1.z - y0.z) - (z1.y - z0.y),
      (z1.x - z0.x) - (x1.z - x0.z),
      (x1.y - x0.y) - (y1.x - y0.x)
    ) / (2.0 * e);
  }
`

/**
 * True 3D simplex noise — Ashima Arts / Ian McEwan, MIT licensed.
 *
 * Deliberately alongside `snoiseVec3` in {@link CURL_NOISE_GLSL} rather than
 * replacing it. That one is a three-sine pseudo-noise: cheap, periodic, and
 * entirely adequate as a transport field to advect particles through. This is
 * the real thing — gradient noise with no visible axis alignment — and it is
 * what a domain-warped fBm needs, because warping a periodic field with itself
 * makes the periodicity the dominant feature of the image.
 *
 * Provides `float snoise(vec3)` plus the `mod289`/`permute`/`taylorInvSqrt`
 * helpers it is built from. Watch for collisions: `NOISE3D_GLSL` also declares
 * an `fbm3`, so a scene including both must not declare a third.
 *
 * Roughly an order of magnitude more expensive per sample than `snoiseVec3`.
 * A scene calling it in a loop should gate the octave count on
 * `quality.knobs.noiseOctaves`.
 */
export const SIMPLEX3D_GLSL = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 nrm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= nrm.x; p1 *= nrm.y; p2 *= nrm.z; p3 *= nrm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`

/**
 * Sample the active five-slot palette as a continuous gradient.
 *
 * **Only valid inside a `createShaderScene` scene** — it reads `uBg`/`uShadow`/
 * `uMid`/`uAccent`/`uGlow` from `SHADER_SCENE_PRELUDE`, so it will not compile
 * in a hand-written scene that does not declare those.
 *
 * Two variants, because emissive and non-emissive want different sub-ranges:
 *
 * - `paletteRamp(t)` walks the WHOLE ramp, `bg` through `glow`. Right for
 *   anything that should be able to go dark — fields, fog, orbit traps.
 * - `paletteLit(t)` walks only the three LIT slots, `mid` through `glow`. Right
 *   for neon, highlights, and light sources, which must never resolve to a
 *   near-black `bg` no matter where `t` lands.
 *
 * Both **wrap** with a triangle wave rather than clamping, and that is
 * load-bearing. Ported shaders habitually feed these an unbounded value like
 * `hue + 0.45 * radius`, which is safe against the cosine palettes they were
 * written for (a cosine oscillates forever) but not against a clamped lookup:
 * anywhere past the first unit of range flattens to a single colour and washes
 * the image out. This was a real bug in `kifs` before the wrap went in. A
 * triangle rather than `mod` alone keeps the gradient continuous across the
 * seam — `mod` would jump from `glow` back to `bg` on a hard edge.
 */
export const PALETTE_RAMP_GLSL = /* glsl */ `
  /** Triangle-wrapped 0..1, so an unbounded input is always safe. */
  float _rampWrap(float t) {
    float m = mod(t, 1.0);
    return (m < 0.5 ? m : 1.0 - m) * 2.0;
  }

  /** Full ramp: bg -> shadow -> mid -> accent -> glow. */
  vec3 paletteRamp(float t) {
    float w = _rampWrap(t) * 4.0;
    float seg = floor(min(w, 3.0));
    float f = w - seg;
    if (seg < 0.5) return mix(uBg, uShadow, f);
    if (seg < 1.5) return mix(uShadow, uMid, f);
    if (seg < 2.5) return mix(uMid, uAccent, f);
    return mix(uAccent, uGlow, f);
  }

  /** Lit slots only: mid -> accent -> glow. Never resolves to the dark ground. */
  vec3 paletteLit(float t) {
    float w = _rampWrap(t) * 2.0;
    float seg = floor(min(w, 1.0));
    float f = w - seg;
    return seg < 0.5 ? mix(uMid, uAccent, f) : mix(uAccent, uGlow, f);
  }
`

/** Hash + value noise in 3D, plus fbm. Uses Dave Hoskins' hash13. */
export const NOISE3D_GLSL = /* glsl */ `
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Trilinearly-interpolated 3D value noise in [0,1].
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, u.x);
    float nx10 = mix(n010, n110, u.x);
    float nx01 = mix(n001, n101, u.x);
    float nx11 = mix(n011, n111, u.x);
    float nxy0 = mix(nx00, nx10, u.y);
    float nxy1 = mix(nx01, nx11, u.y);
    return mix(nxy0, nxy1, u.z);
  }

  // Fractional Brownian motion. Octave count is capped by uOctaves (the quality
  // governor) via an early break — the loop bound stays constant for GLSL ES
  // 1.00, but under load we execute fewer octaves.
  uniform int uOctaves;
  float fbm3(vec3 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      if (i >= uOctaves) break;
      v += amp * noise3(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return v;
  }
`

/** Signed-distance primitives, smooth boolean ops, and domain transforms. */
export const SDF_GLSL = /* glsl */ `
  mat2 rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
  }

  float sdSphere(vec3 p, float r) {
    return length(p) - r;
  }

  float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
  }

  float sdRoundBox(vec3 p, vec3 b, float r) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
  }

  // Torus lying in the xz-plane; t = (major radius, minor radius).
  float sdTorus(vec3 p, vec2 t) {
    vec2 q = vec2(length(p.xz) - t.x, p.y);
    return length(q) - t.y;
  }

  // Polynomial smooth-min union / subtraction / intersection.
  float opSmoothUnion(float d1, float d2, float k) {
    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) - k * h * (1.0 - h);
  }

  float opSmoothSubtract(float d1, float d2, float k) {
    float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);
    return mix(d2, -d1, h) + k * h * (1.0 - h);
  }

  float opSmoothIntersect(float d1, float d2, float k) {
    float h = clamp(0.5 - 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) + k * h * (1.0 - h);
  }

  // Twist the field around the Y axis (organic curling).
  vec3 opTwist(vec3 p, float k) {
    float c = cos(k * p.y);
    float s = sin(k * p.y);
    mat2 m = mat2(c, -s, s, c);
    return vec3(m * p.xz, p.y).xzy;
  }
`

/**
 * Standard march loop + tetrahedron-normal estimation. Both reference a
 * scene-provided `float map(vec3 p)`, forward-declared here as a prototype so
 * the scene can define the actual field *after* this chunk.
 */
export const RAYMARCH_GLSL = /* glsl */ `
  float map(vec3 p);

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.0015, 0.0);
    return normalize(vec3(
      map(p + e.xyy) - map(p - e.xyy),
      map(p + e.yxy) - map(p - e.yxy),
      map(p + e.yyx) - map(p - e.yyx)
    ));
  }

  // Max march iterations, capped by the quality governor. The loop bound stays
  // a constant (GLSL ES 1.00 requirement); uMaxSteps early-breaks it so heavy
  // frames march fewer, cheaper steps. This is the single biggest runtime lever
  // for raymarched scenes — step count dominates their cost.
  uniform int uMaxSteps;

  // Returns distance to the first hit, or -1.0 on a miss. Also accumulates a
  // soft glow (out param) from how closely rays graze the surface — cheap
  // emissive haze for the bloom pass to pick up.
  float raymarch(vec3 ro, vec3 rd, float maxDist, out float glow) {
    float t = 0.0;
    glow = 0.0;
    for (int i = 0; i < 96; i++) {
      if (i >= uMaxSteps) break;
      vec3 p = ro + rd * t;
      float d = map(p);
      glow += 0.015 / (0.05 + d * d);
      if (d < 0.001 * t + 0.0006) return t;
      t += d;
      if (t > maxDist) break;
    }
    return -1.0;
  }
`

import { useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { scroll } from './scroll'
import { tunnelAudio } from './tunnelAudio'
import { CHAPTERS } from './chapters'

/**
 * Audio-reactive particle tunnel — the landing page's hero. Desktop-only (no
 * mobile handling; the App-level gate keeps mobile visitors out entirely).
 *
 * Four GPU point systems (walls+gates, nodes, trees, motes) built once from a
 * Catmull-Rom path with Frenet frames. All motion happens in vertex shaders —
 * the CPU never touches a particle after construction. Camera travels along
 * the curve, driven by `scroll`'s damped progress; three.js's own bass/mid/
 * treble/beat bands (from `tunnelAudio`) drive size, colour and displacement.
 */

const LENGTH = 1600 // metres of tunnel
const SEG = 1400 // path resolution
const FAR = 900

const REDUCED = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

type Tier = 'mid' | 'high'
const TIER: Tier = (() => {
  if (typeof navigator === 'undefined') return 'mid'
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 4
  const cpu = navigator.hardwareConcurrency || 4
  return mem >= 8 && cpu >= 8 ? 'high' : 'mid'
})()

const QUALITY: Record<Tier, { wall: number; motes: number; trees: number; gates: number; dpr: number }> = {
  mid: { wall: 105000, motes: 14000, trees: 20, gates: 2200, dpr: 1.75 },
  high: { wall: 185000, motes: 24000, trees: 28, gates: 3000, dpr: 2 },
}
const Q = QUALITY[TIER]

const PALETTE = /* glsl */ `
vec3 palette(float t){
  return vec3(0.30,0.24,0.46) + vec3(0.38,0.34,0.46)
       * cos(6.28318*(vec3(1.0,0.97,0.90)*t + vec3(0.02,0.22,0.44)));
}
`

// Landing-tunnel-only dimming — additive blending means colour magnitude
// IS brightness, so scaling it here (once, shared by all four particle
// systems) tones the whole tunnel down without touching density/alpha.
const BRIGHTNESS = 0.90

// Landing-tunnel-only — the tunnel should feel like ambience the music
// plays under, not a meter slaved to it. Scales every audio-driven term
// (particle uniforms, camera shake/fov/roll, the flash/aberration overlay)
// down to a fraction of the raw signal. Deliberately aggressive per explicit
// direction ("less reactive") — does not touch `tunnelAudio` itself,
// so the spectrum readout/track UI still reflect the real signal.
const REACTIVITY = 0.30

const SPRITE_FS = /* glsl */ `
precision highp float;
varying vec3 vCol;
varying float vAlpha;
varying float vCore;
void main(){
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if(d > 0.5) discard;
  float k    = 1.0 - d * 2.0;
  float glow = pow(k, 2.4);
  float core = pow(k, 14.0);
  vec3 col = (vCol * glow + vec3(1.0) * core * vCore) * ${BRIGHTNESS};
  gl_FragColor = vec4(col, glow * vAlpha);
}
`

const SHARED_UNIFORM_DEFS =
  'uniform float uTime,uBass,uMid,uTreble,uBeat,uLevel,uSize,uPR,uFar;\nuniform vec3 uCam;\n'

function sharedUniforms() {
  return {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uLevel: { value: 0 },
    uSize: { value: 1 },
    uPR: { value: 1 },
    uFar: { value: FAR },
    uCam: { value: new THREE.Vector3() },
    uProg: { value: 0 },
  }
}
type SharedUniforms = ReturnType<typeof sharedUniforms>

function makeMaterial(vs: string, uniforms: SharedUniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vs,
    fragmentShader: SPRITE_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  })
}

const WALL_VS = /* glsl */ `
precision highp float;
attribute vec3 aDir;
attribute vec3 aSide;
attribute float aSeed;
attribute float aT;
attribute float aType;
${SHARED_UNIFORM_DEFS}
varying vec3 vCol;
varying float vAlpha;
varying float vCore;
${PALETTE}
void main(){
  vec3 dir = aDir, side = aSide;
  vec3 tang = cross(dir, side);
  float t = uTime;

  float wave = sin(aT*118.0 - t*1.7)*0.55
             + sin(aT*37.0  + t*0.9)*0.34
             + sin(aT*271.0 - t*2.6 + aSeed*3.0)*0.18;
  float radial = wave * (1.5 + uBass*11.0 + uBeat*4.5);

  float dc = length(position - uCam);
  radial += sin(dc*0.30 - t*4.5) * uBass * 5.5 * exp(-dc*0.010);

  float band = pow(max(0.0, sin(aT*46.0 - t*2.35)), 16.0);
  float band2 = pow(max(0.0, sin(aT*29.0 - t*1.55 + 2.1)), 22.0);
  float bandGlow = (band*0.85 + band2*0.65) * (0.35 + uBass*1.5 + uBeat*0.9);
  radial += bandGlow * 1.8;

  float swirl = sin(t*0.55 + aSeed*6.283 + aT*24.0) * (0.9 + uMid*5.5 + uBeat*1.2);
  float drift = sin(t*0.90 + aSeed*17.0) * (0.5 + uTreble*2.4 + uBeat*0.6);
  vec3 p = position + dir*radial + side*swirl + tang*drift;

  if(aType > 0.5){
    p += dir * (sin(t*2.2 + aT*80.0)*1.4 + uBeat*8.0);
  }

  vec4 mv = modelViewMatrix * vec4(p,1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;

  float size = uSize * (0.30 + aSeed*1.05) * (1.0 + uBass*2.3 + uBeat*1.7 + bandGlow*0.8);
  if(aType > 0.5) size *= 2.1;
  gl_PointSize = clamp(size * uPR * (300.0/max(dist,1.0)), 0.5, 64.0);

  float hue = fract(0.04 + aT*0.85 + uMid*0.06 + aSeed*0.045 + bandGlow*0.05);
  vec3 c = palette(hue);
  c = mix(c, vec3(1.0,0.78,0.42), clamp(uBeat*0.55 + bandGlow*0.3, 0.0, 1.0));
  if(aType > 0.5) c = mix(c, vec3(0.55,0.95,1.0), 0.55);

  float near = smoothstep(1.5, 30.0, dist);
  float far  = 1.0 - smoothstep(uFar*0.42, uFar, dist);
  vAlpha = clamp(near*far*(0.30 + aSeed*0.70 + bandGlow*0.35)*(0.55 + uLevel*1.5), 0.0, 1.0);
  vCol   = c;
  vCore  = 0.32 + uBeat*0.95 + uTreble*0.55 + bandGlow*0.5;
}
`

const NODE_VS = /* glsl */ `
precision highp float;
attribute vec3 aDir;
attribute vec3 aSide;
attribute vec3 aTang;
attribute float aSeed;
attribute float aT;
attribute float aOrbit;
${SHARED_UNIFORM_DEFS}
varying vec3 vCol;
varying float vAlpha;
varying float vCore;
${PALETTE}
void main(){
  float t = uTime;
  float pulse = 0.55 + sin(t*1.4 + aT*90.0)*0.25 + uMid*1.4 + uBeat*1.1;
  float ang = aOrbit + t*(0.35 + uMid*0.6);
  vec3 orb = aSide*cos(ang) + aTang*sin(ang);
  vec3 p = position + orb * (0.5 + aSeed*1.6) * pulse;
  p += aDir * sin(t*2.0 + aSeed*11.0) * (0.3 + uBass*1.6);

  vec4 mv = modelViewMatrix * vec4(p,1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;

  float size = uSize * (0.7 + aSeed*1.4) * (1.0 + uMid*2.4 + uBeat*2.0);
  gl_PointSize = clamp(size * uPR * (300.0/max(dist,1.0)), 0.5, 70.0);

  vec3 c = palette(fract(0.5 + aT*0.6 + aSeed*0.08));
  c = mix(c, vec3(1.0,0.55,0.85), uBeat*0.45);

  float near = smoothstep(2.0, 34.0, dist);
  float far  = 1.0 - smoothstep(uFar*0.40, uFar*0.95, dist);
  vAlpha = clamp(near*far*(0.5 + aSeed*0.5)*(0.6 + uLevel*1.3), 0.0, 1.0);
  vCol  = c;
  vCore = 0.5 + uBeat*1.0 + uMid*0.4;
}
`

const TREE_VS = /* glsl */ `
precision highp float;
attribute vec3 aDir;
attribute vec3 aSide;
attribute float aSeed;
attribute float aSway;
attribute float aLeaf;
attribute float aT;
${SHARED_UNIFORM_DEFS}
varying vec3 vCol;
varying float vAlpha;
varying float vCore;
${PALETTE}
void main(){
  float t = uTime;
  float amp = pow(aSway, 1.55) * (0.9 + uMid*9.0 + uBeat*3.0);
  vec3 p = position
         + aSide * sin(t*1.15 + aSeed*6.283 + aT*30.0) * amp
         + aDir  * sin(t*0.70 + aSeed*3.10) * amp * 0.35;

  vec4 mv = modelViewMatrix * vec4(p,1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;

  float base = mix(0.55, 1.75, aLeaf);
  float size = uSize * base * (0.45 + aSeed*0.8) * (1.0 + uMid*2.2 + uBeat*1.4);
  gl_PointSize = clamp(size * uPR * (300.0/max(dist,1.0)), 0.5, 64.0);

  vec3 bark = palette(fract(0.62 + aT*0.35));
  vec3 leaf = palette(fract(0.16 + aT*0.9 + aSeed*0.1));
  vec3 c = mix(bark*0.75, leaf*1.35, aLeaf);
  c = mix(c, vec3(1.0,0.80,0.45), uBeat*0.5*aLeaf);

  float twinkle = 0.55 + 0.45*sin(t*3.2 + aSeed*40.0);
  float near = smoothstep(1.5, 26.0, dist);
  float far  = 1.0 - smoothstep(uFar*0.42, uFar, dist);
  vAlpha = clamp(near*far*(0.40 + aSeed*0.55)*mix(1.0,twinkle,aLeaf*0.75)*(0.5+uLevel*1.6), 0.0, 1.0);
  vCol  = c;
  vCore = 0.30 + uBeat*0.8 + uTreble*0.9*aLeaf;
}
`

const MOTE_VS = /* glsl */ `
precision highp float;
attribute float aSeed;
attribute float aT;
${SHARED_UNIFORM_DEFS}
varying vec3 vCol;
varying float vAlpha;
varying float vCore;
${PALETTE}
void main(){
  float t = uTime;
  float s = aSeed * 6.283;
  vec3 p = position + vec3(
      sin(t*0.31 + s*3.0),
      cos(t*0.26 + s*5.0),
      sin(t*0.19 + s*7.0)) * (2.4 + uTreble*9.0 + uBass*3.5 + uBeat*3.5);

  vec4 mv = modelViewMatrix * vec4(p,1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;

  float twinkle = 0.35 + 0.65*pow(0.5 + 0.5*sin(t*2.4 + aSeed*57.0), 3.0);
  float size = uSize * (0.25 + aSeed*0.7) * (1.0 + uTreble*2.6 + uBass*1.3 + uBeat*1.6);
  gl_PointSize = clamp(size * uPR * (300.0/max(dist,1.0)), 0.5, 40.0);

  vec3 c = palette(fract(0.28 + aT*0.7 + aSeed*0.25));
  c = mix(c, vec3(0.9,0.95,1.0), clamp(uTreble*0.5 + uBeat*0.35, 0.0, 1.0));
  float near = smoothstep(2.0, 34.0, dist);
  float far  = 1.0 - smoothstep(uFar*0.38, uFar*0.92, dist);
  vAlpha = clamp(near*far*twinkle*(0.45+uLevel*1.4), 0.0, 1.0);
  vCol  = c;
  vCore = 0.4 + uTreble*1.1 + uBeat*0.6;
}
`

/** Path + Frenet-frame helpers, all keyed off one Catmull-Rom curve. */
function buildPath() {
  const anchors: THREE.Vector3[] = []
  for (let i = 0; i <= 30; i++) {
    const t = i / 30
    anchors.push(
      new THREE.Vector3(
        Math.sin(t * Math.PI * 2.2) * 46 + Math.sin(t * Math.PI * 5.7 + 1.3) * 15,
        Math.cos(t * Math.PI * 1.7) * 26 + Math.sin(t * Math.PI * 4.3) * 9,
        -t * LENGTH,
      ),
    )
  }
  const curve = new THREE.CatmullRomCurve3(anchors, false, 'catmullrom', 0.5)
  const frames = curve.computeFrenetFrames(SEG, false)

  // Chambers: the tunnel balloons at two points, then narrows to a throat.
  // No flare-open at the end — the ending should read like the same
  // moderate width the tunnel holds everywhere past the second chamber
  // (~u=0.9, matching the depth-1460m look), not balloon out wide.
  function radiusAt(u: number) {
    let r = 30 + Math.sin(u * Math.PI * 6.0) * 8 + Math.sin(u * Math.PI * 13.0 + 2.0) * 3.5
    r += 26 * Math.exp(-Math.pow((u - 0.34) * 7.5, 2))
    r += 34 * Math.exp(-Math.pow((u - 0.72) * 6.0, 2))
    return r
  }
  function frameAt(u: number) {
    const idx = Math.max(0, Math.min(SEG, Math.round(u * SEG)))
    return { n: frames.normals[idx], b: frames.binormals[idx], t: frames.tangents[idx] }
  }
  function ringDir(u: number, angle: number, out: THREE.Vector3) {
    const f = frameAt(u)
    return out.copy(f.n).multiplyScalar(Math.cos(angle)).addScaledVector(f.b, Math.sin(angle)).normalize()
  }

  return { curve, radiusAt, frameAt, ringDir }
}
type TunnelPath = ReturnType<typeof buildPath>

function buildWalls(path: TunnelPath) {
  const n = Q.wall + Q.gates * CHAPTERS.length
  const pos = new Float32Array(n * 3)
  const dir = new Float32Array(n * 3)
  const sid = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  const tt = new Float32Array(n)
  const type = new Float32Array(n)

  const d = new THREE.Vector3()
  const s = new THREE.Vector3()
  const c = new THREE.Vector3()
  let w = 0

  function write(u: number, angle: number, radius: number, kind: number) {
    const f = path.frameAt(u)
    c.copy(path.curve.getPoint(u))
    path.ringDir(u, angle, d)
    s.crossVectors(f.t, d).normalize()
    pos[w * 3] = c.x + d.x * radius
    pos[w * 3 + 1] = c.y + d.y * radius
    pos[w * 3 + 2] = c.z + d.z * radius
    dir[w * 3] = d.x
    dir[w * 3 + 1] = d.y
    dir[w * 3 + 2] = d.z
    sid[w * 3] = s.x
    sid[w * 3 + 1] = s.y
    sid[w * 3 + 2] = s.z
    seed[w] = Math.random()
    tt[w] = u
    type[w] = kind
    w++
  }

  // wall shell — thickness biased outward so the core stays clear
  for (let i = 0; i < Q.wall; i++) {
    const u = Math.random()
    const thick = 0.9 + Math.pow(Math.random(), 0.65) * 0.34
    write(u, Math.random() * Math.PI * 2, path.radiusAt(u) * thick, 0)
  }

  // gate rings at each chapter marker
  for (let ci = 0; ci < CHAPTERS.length; ci++) {
    const gu = Math.min(0.985, CHAPTERS[ci].at + 0.055)
    for (let g = 0; g < Q.gates; g++) {
      const jitter = (Math.random() - 0.5) * 0.0022
      write(gu + jitter, Math.random() * Math.PI * 2, path.radiusAt(gu) * (0.86 + Math.random() * 0.05), 1)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3))
  geo.setAttribute('aSide', new THREE.BufferAttribute(sid, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  geo.setAttribute('aT', new THREE.BufferAttribute(tt, 1))
  geo.setAttribute('aType', new THREE.BufferAttribute(type, 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -LENGTH / 2), LENGTH)

  const uni = sharedUniforms()
  uni.uSize.value = 1.15
  return { geo, uni, mat: makeMaterial(WALL_VS, uni) }
}

function buildNodes(path: TunnelPath) {
  const NODE_COUNT = Math.round(18 + Q.trees * 0.6)
  const PTS_PER = 70
  const n = NODE_COUNT * PTS_PER
  const pos = new Float32Array(n * 3)
  const dir = new Float32Array(n * 3)
  const sid = new Float32Array(n * 3)
  const tang = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  const tt = new Float32Array(n)
  const orbit = new Float32Array(n)

  const d = new THREE.Vector3()
  const s = new THREE.Vector3()
  const tg = new THREE.Vector3()
  const c = new THREE.Vector3()
  let w = 0
  for (let i = 0; i < NODE_COUNT; i++) {
    const u = 0.05 + (i / Math.max(1, NODE_COUNT - 1)) * 0.9 + (Math.random() - 0.5) * 0.01
    const f = path.frameAt(u)
    const ang = i * 2.399963 + 1.1 // offset from the tree spiral so they interleave
    path.ringDir(u, ang, d)
    s.crossVectors(f.t, d).normalize()
    tg.crossVectors(d, s).normalize()
    c.copy(path.curve.getPoint(u)).addScaledVector(d, path.radiusAt(u) * 0.94)
    for (let k = 0; k < PTS_PER; k++) {
      pos[w * 3] = c.x
      pos[w * 3 + 1] = c.y
      pos[w * 3 + 2] = c.z
      dir[w * 3] = d.x
      dir[w * 3 + 1] = d.y
      dir[w * 3 + 2] = d.z
      sid[w * 3] = s.x
      sid[w * 3 + 1] = s.y
      sid[w * 3 + 2] = s.z
      tang[w * 3] = tg.x
      tang[w * 3 + 1] = tg.y
      tang[w * 3 + 2] = tg.z
      seed[w] = Math.random()
      tt[w] = u
      orbit[w] = Math.random() * Math.PI * 2
      w++
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3))
  geo.setAttribute('aSide', new THREE.BufferAttribute(sid, 3))
  geo.setAttribute('aTang', new THREE.BufferAttribute(tang, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  geo.setAttribute('aT', new THREE.BufferAttribute(tt, 1))
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -LENGTH / 2), LENGTH)

  const uni = sharedUniforms()
  uni.uSize.value = 1.2
  return { geo, uni, mat: makeMaterial(NODE_VS, uni) }
}

function buildTrees(path: TunnelPath) {
  const P: number[] = []
  const D: number[] = []
  const S: number[] = []
  const SW: number[] = []
  const LF: number[] = []
  const SD: number[] = []
  const TU: number[] = []

  function push(p: THREE.Vector3, d: THREE.Vector3, s: THREE.Vector3, sway: number, leaf: number, u: number) {
    P.push(p.x, p.y, p.z)
    D.push(d.x, d.y, d.z)
    S.push(s.x, s.y, s.z)
    SW.push(sway)
    LF.push(leaf)
    SD.push(Math.random())
    TU.push(u)
  }

  function grow(origin: THREE.Vector3, dir: THREE.Vector3, side: THREE.Vector3, len: number, depth: number, u: number) {
    const steps = Math.max(5, Math.round(len * 1.5))
    const end = origin.clone().addScaledVector(dir, len)
    const swayA = depth / 4
    const swayB = (depth + 1) / 4
    for (let i = 0; i < steps; i++) {
      const f = i / steps
      const p = origin.clone().lerp(end, f)
      const j = (1 - f) * 0.5 + depth * 0.25
      p.x += (Math.random() - 0.5) * j
      p.y += (Math.random() - 0.5) * j
      p.z += (Math.random() - 0.5) * j
      push(p, dir, side, swayA + (swayB - swayA) * f, 0, u)
    }

    if (depth < 3) {
      const kids = depth === 0 ? 3 : Math.random() < 0.45 ? 3 : 2
      for (let k = 0; k < kids; k++) {
        const phi = (k / kids) * Math.PI * 2 + Math.random() * 0.9 + depth
        const perp = side.clone().applyAxisAngle(dir, phi).normalize()
        const spread = 0.42 + Math.random() * 0.42
        const nd = dir.clone().applyAxisAngle(perp, spread).normalize()
        grow(end.clone(), nd, perp, len * (0.6 + Math.random() * 0.14), depth + 1, u)
      }
    } else {
      const cluster = 26
      for (let l = 0; l < cluster; l++) {
        const lp = end
          .clone()
          .add(
            new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
              .normalize()
              .multiplyScalar(Math.random() * len * 0.75),
          )
        push(lp, dir, side, 1.0, 1, u)
      }
    }
  }

  const d = new THREE.Vector3()
  for (let n = 0; n < Q.trees; n++) {
    const u = 0.07 + (n / Math.max(1, Q.trees - 1)) * 0.86 + (Math.random() - 0.5) * 0.012
    const f = path.frameAt(u)
    const ang = n * 2.399963 + Math.random() * 0.6 // golden-angle spiral around the wall
    path.ringDir(u, ang, d)
    const R = path.radiusAt(u)
    const root = path.curve.getPoint(u).clone().addScaledVector(d, R * 1.03)
    const up = d.clone().multiplyScalar(-1) // grow inward, toward the traveller
    const side = new THREE.Vector3().crossVectors(f.t, d).normalize()
    grow(root, up, side, R * (0.32 + Math.random() * 0.16), 0, u)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3))
  geo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(D), 3))
  geo.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(S), 3))
  geo.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(SW), 1))
  geo.setAttribute('aLeaf', new THREE.BufferAttribute(new Float32Array(LF), 1))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(SD), 1))
  geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(TU), 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -LENGTH / 2), LENGTH)

  const uni = sharedUniforms()
  uni.uSize.value = 1.3
  return { geo, uni, mat: makeMaterial(TREE_VS, uni) }
}

function buildMotes(path: TunnelPath) {
  const n = Q.motes
  const pos = new Float32Array(n * 3)
  const seed = new Float32Array(n)
  const tt = new Float32Array(n)
  const d = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    const u = Math.random()
    const c = path.curve.getPoint(u)
    path.ringDir(u, Math.random() * Math.PI * 2, d)
    const r = path.radiusAt(u) * (0.1 + Math.pow(Math.random(), 0.6) * 0.86)
    pos[i * 3] = c.x + d.x * r
    pos[i * 3 + 1] = c.y + d.y * r
    pos[i * 3 + 2] = c.z + d.z * r + (Math.random() - 0.5) * 6
    seed[i] = Math.random()
    tt[i] = u
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  geo.setAttribute('aT', new THREE.BufferAttribute(tt, 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -LENGTH / 2), LENGTH)

  const uni = sharedUniforms()
  uni.uSize.value = 1.0
  return { geo, uni, mat: makeMaterial(MOTE_VS, uni) }
}

export interface TunnelFrameState {
  progress: number
  depth: number
  beat: number
  level: number
  freqData: Uint8Array | null
  started: boolean
}

interface SceneProps {
  onFrame: (state: TunnelFrameState) => void
}

/** Lives inside <Canvas> — owns the four particle systems and the per-frame camera/uniform update. */
function Scene({ onFrame }: SceneProps) {
  const { camera, gl } = useThree()
  const path = useMemo(() => buildPath(), [])
  const walls = useMemo(() => buildWalls(path), [path])
  const nodes = useMemo(() => buildNodes(path), [path])
  const trees = useMemo(() => buildTrees(path), [path])
  const motes = useMemo(() => buildMotes(path), [path])
  const systems = useMemo(() => [walls, nodes, trees, motes], [walls, nodes, trees, motes])

  const mouse = useRef({ x: 0, y: 0, tx: 0, ty: 0 })
  const degraded = useRef(false)
  const fpsAcc = useRef(0)
  const fpsN = useRef(0)
  const tmpPos = useRef(new THREE.Vector3())
  const tmpLook = useRef(new THREE.Vector3())
  const camUp = useRef(new THREE.Vector3(0, 1, 0))

  useMemo(() => {
    const onMove = (e: PointerEvent) => {
      mouse.current.tx = (e.clientX / window.innerWidth) * 2 - 1
      mouse.current.ty = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  useFrame((_, dtRaw) => {
    const dt = Math.min(0.05, dtRaw)
    const now = performance.now() / 1000

    tunnelAudio.update(dt, now)
    scroll.update(dt)

    // Dampened copies for anything visual — see REACTIVITY above.
    const rBass = tunnelAudio.bass * REACTIVITY
    const rMid = tunnelAudio.mid * REACTIVITY
    const rTreble = tunnelAudio.treble * REACTIVITY
    const rBeat = tunnelAudio.beat * REACTIVITY
    const rLevel = tunnelAudio.level * REACTIVITY

    // graceful degradation if the device can't hold frame rate
    if (!degraded.current && dt > 0) {
      fpsAcc.current += 1 / dt
      fpsN.current++
      if (fpsN.current >= 150) {
        const avg = fpsAcc.current / fpsN.current
        fpsAcc.current = 0
        fpsN.current = 0
        if (avg < 38) {
          degraded.current = true
          walls.geo.setDrawRange(0, Math.floor(Q.wall * 0.55))
          nodes.geo.setDrawRange(0, Math.floor(nodes.geo.attributes.position.count * 0.6))
          motes.geo.setDrawRange(0, Math.floor(Q.motes * 0.5))
          gl.setPixelRatio(Math.max(1, gl.getPixelRatio() * 0.75))
        }
      }
    }

    const p = Math.max(0, Math.min(1, scroll.value))
    const u = p * 0.985

    const pos = path.curve.getPointAt(u, tmpPos.current)
    const look = path.curve.getPointAt(Math.min(0.999, u + 0.014), tmpLook.current)

    const mk = 1 - Math.exp(-dt * 5)
    mouse.current.x += (mouse.current.tx - mouse.current.x) * mk
    mouse.current.y += (mouse.current.ty - mouse.current.y) * mk

    const f = path.frameAt(u)
    const sway = REDUCED ? 0 : 1
    camera.position
      .copy(pos)
      .addScaledVector(f.n, mouse.current.x * 7 * sway + Math.sin(now * 0.35) * 1.6 * sway)
      .addScaledVector(f.b, -mouse.current.y * 5 * sway + Math.cos(now * 0.27) * 1.4 * sway)

    if (!REDUCED) {
      const shake = rBeat * 1.05 + rBass * 0.5
      camera.position.x += Math.sin(now * 41.0) * shake * 0.5
      camera.position.y += Math.cos(now * 37.0) * shake * 0.5
    }

    camera.up.copy(camUp.current)
    camera.lookAt(look)
    if (!REDUCED && camera instanceof THREE.PerspectiveCamera) {
      camera.rotateZ(Math.sin(u * 21.0) * 0.16 + mouse.current.x * 0.07 + rBeat * 0.02)
      const fov = 66 + rBass * 7.0 + rBeat * 4.0
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
    }

    for (const sys of systems) {
      sys.uni.uTime.value = now
      sys.uni.uBass.value = rBass
      sys.uni.uMid.value = rMid
      sys.uni.uTreble.value = rTreble
      sys.uni.uBeat.value = rBeat
      sys.uni.uLevel.value = tunnelAudio.started ? Math.max(0.18, rLevel) : 0.35
      sys.uni.uProg.value = p
      sys.uni.uPR.value = gl.getPixelRatio()
      sys.uni.uCam.value.copy(camera.position)
    }

    onFrame({
      progress: p,
      depth: Math.round(p * LENGTH),
      // Dampened too — these drive the flash/aberration DOM overlays in
      // Landing.tsx, which are as much "the visuals" as the particles.
      beat: rBeat,
      level: rLevel,
      freqData: tunnelAudio.getFreqData(),
      started: tunnelAudio.started,
    })
  })

  return (
    <>
      <points geometry={walls.geo} material={walls.mat} frustumCulled={false} />
      <points geometry={nodes.geo} material={nodes.mat} frustumCulled={false} />
      <points geometry={trees.geo} material={trees.mat} frustumCulled={false} />
      <points geometry={motes.geo} material={motes.mat} frustumCulled={false} />
    </>
  )
}

export function TunnelScene({ onFrame }: SceneProps) {
  return (
    <Canvas
      className="tunnel-canvas"
      dpr={[1, Q.dpr]}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true }}
      camera={{ fov: 66, near: 0.6, far: FAR + 200 }}
      onCreated={({ gl }) => gl.setClearColor(0x04040b, 1)}
    >
      <Scene onFrame={onFrame} />
    </Canvas>
  )
}

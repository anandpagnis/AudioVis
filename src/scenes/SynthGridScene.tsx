import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FULLSCREEN_VERT } from '../engine/glsl'
import { quality, qualityUniforms, applyQualityUniforms } from '../engine/quality'
import { bufferScale } from '../engine/renderScale'
import { NOISE3D_GLSL } from '../engine/shaderLib'
import { useSceneFrame } from '../engine/sceneFrame'
import { useDispose } from '../engine/useDispose'

/* ==========================================================================
 * ██  NON-COMMERCIAL — DO NOT SHIP  ████████████████████████████████████████
 *
 * This scene is a port of a Shadertoy work licensed under
 *
 *     Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported
 *     https://creativecommons.org/licenses/by-nc-sa/3.0/
 *
 * The NonCommercial term means this file, and any build containing it, MUST
 * NOT be:
 *   - included in a commercial release or paid product,
 *   - listed in a marketplace or asset store,
 *   - shipped in any public distribution intended to generate revenue,
 *
 * without separate written permission from the original author.
 *
 * ShareAlike additionally means any distributed derivative must carry the same
 * licence — which would encumber the rest of this codebase. That is the reason
 * to remove rather than relicense it.
 *
 * Present state: PERSONAL / PRIVATE USE ONLY.
 *
 * Enforcement is not left to memory. The scene declares
 * `license: 'noncommercial'` in its metadata, `nonCommercialSceneIds()` in
 * scenes/index.ts derives the exclusion list from that field, and
 * `sceneLicensing.test.ts` fails if this scene ever stops being marked.
 * See also docs/HANDOFF.md.
 * ========================================================================== */

/**
 * Synth Grid — a retro-futurist raymarched city: a mirrored ground plane, a
 * repeating skyline, and streams of cars running the grid, under a hot magenta
 * horizon with heavy bloom and chromatic flares.
 *
 * ## What differs from the source, and why
 *
 * The original is a four-channel Shadertoy: a noise texture, an FFT texture,
 * a 3D volume texture, and an environment image. None of those assets are
 * available here, so all four are replaced:
 *
 *   iChannel0  2D noise      -> procedural value noise (`tex0`)
 *   iChannel1  FFT row       -> real audio uniforms (see the routing below)
 *   iChannel2  3D volume     -> `windowMask`, a cell-hash window grid
 *   iChannel3  environment   -> procedural synthwave sky gradient (`sky`)
 *
 * The substitutes are chosen to preserve the ROLE each channel played rather
 * than to look identical: `tex0` varies building heights and widths and dithers
 * the time sample, `windowMask` lights the building faces, and `sky` supplies
 * the horizon gradient and the reflected wash.
 *
 * The `iChannel2` substitute was got wrong the first time and is worth
 * recording: `noise3` was used because the call site reads a 3D texture, but
 * the call site is `pow(tex, 20.)`, which depends entirely on the source
 * texture's DISTRIBUTION rather than on it being 3D. Smooth value noise
 * clusters around 0.5, so the exponent annihilated it and the building windows
 * — the dominant feature of the reference image — simply did not appear.
 *
 * ## Loop restructuring was mandatory
 *
 * Every loop in the source is bounded by a runtime variable — `steps`, `cnt`,
 * `int(650.*(...))`. GLSL ES 1.00, which this project targets, requires
 * constant loop bounds, so all four are rewritten as constant-bound loops with
 * an early `break` on a uniform. That form is also what makes them
 * quality-governable, so it is not purely a compatibility tax.
 *
 * ## The shadow march is deliberately shorter than the source
 *
 * The original permits up to 650 shadow steps PER PRIMARY HIT, inside a march
 * of up to 256 steps. That is not viable in a real-time show that also has to
 * budget for a second scene and a post chain, so the ceiling here is 160 and
 * the governor scales it down from there. Shadows terminate slightly earlier
 * in the deep distance as a result; the near field is unaffected because the
 * march breaks on contact regardless.
 *
 * ## Band routing
 *
 *   energy + tempo → forward travel. Accumulated as distance in JS, not
 *                    `time * speed`, so a rate change does not jump the world.
 *   bass           → car size, and the amplitude of the camera's vertical drift.
 *   mid            → skyline height variation.
 *   pulse          → the FFT brightness term the source drove from its audio
 *                    texture. This is the one the shader was already built to
 *                    react to; it now reacts to the actual track.
 *   transient      → chromatic flare width, so hits splay the lens artefacts.
 */

/**
 * Overall brightness.
 *
 * Raised from 0.5 alongside the black-floor subtraction in the post pass: once
 * the lifted grey is removed the frame loses a lot of apparent level, and the
 * source applies no dimming of its own at all. The contrast now comes from the
 * floor and the 1.95 curve rather than from scaling everything down.
 */
const BRIGHTNESS = 0.9

const COMMON_GLSL = /* glsl */ `
  #define sat(a) clamp(a, 0., 1.)
  #define PI 3.141592653
  mat2 r2d(float a){ float c = cos(a), s = sin(a); return mat2(c,-s,s,c); }
  float lenny(vec2 v){ return abs(v.x)+abs(v.y); }
`

/** Procedural stand-ins for the three missing texture channels. */
const CHANNELS_GLSL = /* glsl */ `
  float h21(vec2 p){
    p = fract(p*vec2(123.34, 456.21));
    p += dot(p, p+45.32);
    return fract(p.x*p.y);
  }
  // iChannel0 substitute: smooth 2D value noise in 0..1.
  float tex0(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
               mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
  }
  /**
   * iChannel2 substitute: lit windows.
   *
   * The source sampled a 3D texture as pow(tex, 20.) — an exponent that only
   * lights cells whose texture value is very near 1.0, which on its source
   * texture produced a sparse field of hard bright squares. Substituting
   * noise3 preserved the call but not the DISTRIBUTION: smooth trilinear value
   * noise clusters around 0.5, so pow(n,20) is essentially zero everywhere and
   * the windows vanished — which is most of what the reference image is made
   * of.
   *
   * Cell hashing reproduces the intent directly: quantise to a grid, light a
   * minority of cells hard, vary their brightness per cell.
   */
  float windowMask(vec3 p, float scale){
    vec3 c = floor(p*scale);
    float h = hash13(c);
    return step(0.70, h) * (0.45 + 0.55*hash13(c + 17.3));
  }

  /**
   * iChannel3 substitute: the environment.
   *
   * Deliberately DARK. This is sampled twice — once for the look-up region, and
   * once in screen space where the final line mixes up to 90% of it into the
   * frame edges. The source's environment image was mostly dark there, so that
   * mix acts as a vignette.
   *
   * The first version of this returned a bright magenta gradient (low was
   * vec3(1.0, 0.10, 0.45)), which meant the edge mix LIFTED the corners instead
   * of sinking them. That is what put a grey floor under the whole frame and
   * desaturated it — the port read as hazy where the original reads as
   * black-and-neon.
   */
  vec3 sky(vec2 uv){
    float h = sat(uv.y*0.5+0.5);
    vec3 deep = vec3(0.015, 0.004, 0.040);
    vec3 glow = vec3(0.450, 0.050, 0.260);
    return mix(glow, deep, pow(h, 0.35));
  }
`

const BUFFER_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  ${COMMON_GLSL}
  ${NOISE3D_GLSL}
  ${CHANNELS_GLSL}

  uniform vec2 uRes;
  uniform float uTime;
  /** Accumulated world travel. Replaces the source's _time * _speed. */
  uniform float uDist;
  /** Accumulated car travel, faster than the world (source: an extra _time*20). */
  uniform float uCarDist;
  uniform float uBass;
  uniform float uMid;
  /** Replaces the FFT texture lookup the source brightened everything with. */
  uniform float uFft;
  uniform int uTraceSteps;
  uniform int uShadowSteps;

  float _time;

  float _cube(vec3 p, vec3 s){ vec3 l = abs(p)-s; return max(l.x, max(l.y, l.z)); }
  vec2 _min(vec2 a, vec2 b){ return a.x < b.x ? a : b; }

  float _cars(vec3 op, vec3 s){
    op.z += uCarDist;
    float carStp = 10.5;
    vec3 pcar = op;
    float idxCar = floor((pcar.z+.5*carStp)/carStp);
    pcar.z = mod(pcar.z+.5*carStp, carStp)-.5*carStp;
    pcar.x += sin(idxCar);
    pcar.y += sin(idxCar*5.+_time);
    // Bass swells the cars. Source used a fixed sin(idxCar)*.5+.5.
    return _cube(pcar, s*(sin(idxCar)*.5+.5)*(1.0 + uBass*0.45));
  }

  vec2 map(vec3 p){
    p.z += uDist;
    vec3 op = p;
    p.y = abs(p.y)-100.;   // UPSIDEDOWN branch from the source

    vec2 acc = vec2(100., -1.);
    vec2 ground = vec2(_cube(p, vec3(50., .1, 50.)), 0.);

    vec3 pBat = p;
    vec2 repBat = vec2(10.);
    vec2 idxBat = floor((pBat.xz+repBat*.5)/repBat);
    pBat.xz = mod(pBat.xz+repBat*.5, repBat)-repBat*.5;
    float height = mix(1., 8., (sin(idxBat.x+idxBat.y*10.)*.5+.5));
    // Mid drives how uneven the skyline is.
    height += (tex0(idxBat*.1)-.5)*5.*(1.0 + uMid*1.1);
    float width = tex0(idxBat/10.)*.75;
    pBat.xz += sin(idxBat*10.)*.5;
    vec2 bat = vec2(_cube(pBat, vec3(5.5*width, height*8., 3.7)), 0.);

    acc = _min(acc, ground);
    acc = _min(acc, bat);
    acc = _min(acc, vec2(_cars(op-vec3(0.,10.,0.), vec3(.5,.5,1.5)), 1.));
    acc = _min(acc, vec2(_cars(op-vec3(50.,10.,0.), vec3(.5,.5,1.5)), 1.));

    float repz = 50.;
    float idxz = op.z / repz;
    op.z = mod(op.z+.5*repz, repz)-repz*.5;
    op.xz *= r2d(1.57);
    op.y += sin(idxz)*25.;
    acc = _min(acc, vec2(_cars(op, vec3(.5,.5,2.5)), 1.));
    return acc;
  }

  // Constant bound + early break: GLSL ES 1.00 has no dynamic loop bounds.
  vec3 trace(vec3 ro, vec3 rd){
    vec3 p = ro;
    for (int i = 0; i < 256; ++i){
      if (i >= uTraceSteps) break;
      vec2 res = map(p);
      if (res.x < 0.01) return vec3(res.x, distance(ro, p), res.y);
      p += rd * min(res.x, .5 + (distance(ro, p)/120.));
    }
    return vec3(-1.);
  }

  float traceShadow(vec3 ro, vec3 rd, float dist){
    vec3 p = ro;
    float acc = 1.;
    for (int i = 0; i < 160; ++i){
      if (i >= uShadowSteps) break;
      if (distance(p, ro) >= dist) break;
      vec2 res = map(p);
      if (res.x < 0.01) return 0.;
      float d = min(res.x, 1.5);
      acc = min(acc, 30.*d/distance(p, ro));
      p += rd * d;
    }
    return acc;
  }

  vec3 getCam(vec3 rd, vec2 uv){
    vec3 r = normalize(cross(rd, vec3(0.,1.,0.)));
    vec3 u = normalize(cross(rd, r));
    return normalize(rd + (uv.x*r + uv.y*u)*4.);
  }

  vec3 getNormal(float d, vec3 p){
    vec2 e = vec2(0.04, 0.);
    return normalize(vec3(d) - vec3(map(p-e.xyy).x, map(p-e.yxy).x, map(p-e.yyx).x));
  }

  vec3 rdr(vec2 uv){
    vec3 col = vec3(0.);
    // Camera drift. Bass deepens the vertical swing.
    vec3 ro = vec3(sin(_time*.3)*15., 15.+sin(_time*.15)*15.*(1.0+uBass*0.6), -75.)*.75;
    vec3 ta = vec3(0.,-10.,0.)*.5;

    vec3 rd = normalize(ta-ro);
    rd = getCam(rd, uv);

    vec3 res = trace(ro, rd);
    if (res.y > 0.){
      vec3 p = ro+rd*res.y;
      vec3 n = getNormal(res.x, p);

      float lDist = 550.;
      vec3 shadowO = p+n*0.01;
      vec3 ldir = vec3(1.,-2.,5.)*lDist;

      float shadowRes = traceShadow(shadowO, normalize(ldir), lDist);
      vec3 ambientCol = vec3(0.569,0.675,0.714);
      vec3 diffuseCol = vec3(0.678,0.878,0.902);
      col = ambientCol;
      col *= sat(pow(sat(shadowRes),.5)+.15);

      if (shadowRes > 0.01){
        vec3 h = normalize(ldir+rd);
        col += 500.*sat(dot(n, normalize(ldir)))*diffuseCol/lDist;
        float specPower = mix(1.,.01, sat(sin(p.y*2.)*50.));
        col += (.025/specPower)*100.*vec3(1.000,0.584,0.000)*pow(sat(abs(dot(n,h))),specPower)/lDist;
      }

      col += mix(vec3(0.), mix(vec3(1.000,0.000,0.400), vec3(1.), sat(abs(length(p.xz)*.0025))),
                 1.-sat(exp(-distance(p, ro)/500.)));
      p.z += uDist;

      // iChannel2 (3D volume) substitute.
      col += float(dot(n, vec3(0.,-1.,0.)) < 0.1)*vec3(0.851,0.690,0.506)
           * windowMask(p, 0.55)*2.;
      // Second layer, anisotropic and scrolling, exactly as the source: rows of
      // windows sliding along z with the direction flipping band to band.
      col += .3*vec3(0.729,0.565,0.212)*(sat(p.y*.1+5.))
           * windowMask(vec3(1.,4.,1.)*p + vec3(25.*_time*sign(sin(p.z*5.)), 0., 0.), 0.55);
    } else {
      col = sat(mix(mix(vec3(.75), vec3(1.000,0.000,0.400)*.75, .1),
                    sky(vec2(-rd.x, rd.y)*vec2(2.,-8.)-vec2(0.,.7)),
                    (sat((rd.y-.175)*40.))*.5*sat(length(uv*2.))));
    }

    col += (1.-sat(lenny(rd.xy*vec2(1.,4.)*.5)))*vec3(1.000,0.000,0.400)*.5*float(res.y<0.);
    col += 3.*pow(1.-sat(lenny(rd.xy*.15*vec2(1.,8.))),5.)*vec3(1.000,0.000,0.400)*.5;
    // The source's FFT term, now driven by the real beat envelope.
    col *= mix(.75, 1.5, pow(sat(uFft), 2.));
    return col;
  }

  void main(){
    vec2 fragCoord = vUv * uRes;
    // Source dithered the time sample with its noise texture to soften aliasing.
    _time = uTime + tex0(fragCoord/8.)*.25;

    vec2 uv = (fragCoord - vec2(.5)*uRes)/uRes.xx;
    vec3 col = rdr(uv);

    col = pow(col, vec3(.85));
    col *= (1.-sat(lenny(uv*2.)-.5));
    col = mix(col, sky(fragCoord/uRes), sat(.9)*sat(length(uv*2.)));

    gl_FragColor = vec4(col, 1.0);
  }
`

const POST_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  ${COMMON_GLSL}

  const float U_BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};

  uniform sampler2D uScene;
  uniform vec2 uRes;
  uniform float uFlareSize;
  uniform float uFade;
  uniform int uBloomSamples;
  uniform int uFlareSamples;

  /** Lift removed before the contrast curve — see the note at the use site. */
  #define BLACK_FLOOR (0.045)
  /** >1 pushes colour away from grey. */
  #define SATURATION (1.45)

  vec3 doBloom(vec2 uv, float blur, float threshold){
    vec3 col = vec3(0.);
    float fcnt = float(uBloomSamples);
    for (int i = 0; i < 50; ++i){
      if (i >= uBloomSamples) break;
      float fi = float(i);
      float coef = fi/fcnt;
      float an = (fi/(fcnt/5.))*PI;
      vec2 p = uv - vec2(sin(an), cos(an))*an*blur*.1;
      vec3 smple = texture2D(uScene, p).xyz;
      if (length(smple) > threshold) col += smple;
    }
    return col/max(1., fcnt);
  }

  vec3 chromaFlare(vec2 uv, vec2 ouv, float sz, float id){
    vec3 col = vec3(0.);
    float c = abs(length(ouv)-.3-id*sz*8.-sz*9.)-sz;
    vec3 rgb = vec3(0.);
    float a = atan(ouv.y, ouv.x);
    float cnt = float(uFlareSamples);
    for (int i = 0; i < 16; ++i){
      if (i >= uFlareSamples) break;
      float fi = float(i);
      rgb += vec3(1.)
        * (sat((sin(a*400.)+sin(a*200.)+sin(a*100.))*.2+.5)*.5+.5)
        * texture2D(uScene, vec2(.5)+((uv-vec2(.5))*(fi+1.)*0.01
            * r2d((fi-cnt/2.)*.025)*-1.*sat(length(ouv*2.)))).x;
    }
    col += pow((1.-sat(c*5.))*(rgb/max(1., cnt)), vec3(1.));
    return col*.2;
  }

  void main(){
    vec2 uv = vUv;
    vec2 fragCoord = vUv * uRes;
    vec2 cuv = (fragCoord - vec2(.5)*uRes)/uRes.xx;

    vec3 col = texture2D(uScene, uv).xyz;

    vec3 bloomSample = doBloom(uv, 40./360., 237./640.);
    bloomSample = pow(bloomSample, vec3(0.5));
    col = col + bloomSample*(424./640.);

    // Transient splays the flare rings apart.
    col += chromaFlare(uv, cuv, uFlareSize, 0.)*vec3(1.,0.,0.);
    col += chromaFlare(uv, cuv, uFlareSize, -1.)*vec3(0.,1.,0.);
    col += chromaFlare(uv, cuv, uFlareSize, -2.)*vec3(0.,0.,1.);

    col = mix(col, col.zyx, pow(sat(length(cuv*2.)),4.));

    // Pull the floor back to black BEFORE the contrast curve. Two bloom passes
    // run over this scene — its own 40-tap one above, and then PostFXChain's
    // on the composited frame — and each one lifts the darks a little. Without
    // this the second bloom has a grey base to work from and the result is a
    // wash rather than neon on black.
    col = max(vec3(0.), col - BLACK_FLOOR);
    col = pow(col, vec3(1.95));

    // Resaturate. Additive haze pulls everything toward grey, which costs this
    // palette more than most — the whole look is saturated magenta against
    // black, and a desaturated magenta is just mauve.
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, SATURATION);

    gl_FragColor = vec4(col * U_BRIGHTNESS * uFade, 1.0);
  }
`

/** Base world speed, matching the source's `_speed = 20.` at rest. */
const BASE_SPEED = 20

export function SynthGridScene() {
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  /** Buffer scale the target is currently allocated at; see `sizeBuffer`. */
  const bufScale = useRef(0)
  const clock = useRef(0)
  const dist = useRef(0)
  const carDist = useRef(0)

  const bufferMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: BUFFER_FRAG,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uDist: { value: 0 },
          uCarDist: { value: 0 },
          uBass: { value: 0 },
          uMid: { value: 0 },
          uFft: { value: 0 },
          uTraceSteps: { value: 160 },
          uShadowSteps: { value: 96 },
          ...qualityUniforms(),
        },
      }),
    [],
  )

  const postMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: POST_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uScene: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uFlareSize: { value: 0.01 },
          uFade: { value: 0 },
          uBloomSamples: { value: 32 },
          uFlareSamples: { value: 12 },
        },
      }),
    [],
  )

  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), [])

  /**
   * Single offscreen target — unlike TrailLineScene this needs no ping-pong,
   * because the post pass reads the buffer of the SAME frame rather than the
   * previous one. Rendered well below canvas resolution: this is by a wide
   * margin the heaviest scene in the roster, and the post pass is a heavy blur
   * that hides the resample.
   */
  const rt = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    })
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    scene.add(new THREE.Mesh(geometry, bufferMaterial))
    return { target, scene, camera }
  }, [geometry, bufferMaterial])

  useDispose(bufferMaterial, postMaterial, geometry, rt.target)

  // 0.6x of CSS pixels — the scene's own authored softness, kept — times the
  // engine's {@link bufferScale}, which is the part that was missing.
  //
  // The original comment defended the DPR-independence as avoiding churn on the
  // most expensive scene in the roster, and it was right about the churn. But
  // the effect was that the expensive half of the most expensive scene sat
  // outside the quality governor entirely: the march steps came down with the
  // tier and the number of pixels they marched never did. `bufferScale` keeps
  // the anti-churn property by quantising to quarter steps, so this reallocates
  // a handful of times a session rather than per tier wobble.
  //
  // Driven by the render scale's VALUE rather than by `viewport.dpr`. The DPR is
  // `baseDpr * scale`, so a real scale change can leave it unchanged (2x at 0.5
  // and 1x at 1.0 are both DPR 1) and an effect keyed on it would silently never
  // re-run. Checked once per frame; the guard makes that a float compare.
  const sizeBuffer = () => {
    const scale = 0.6 * bufferScale()
    if (scale === bufScale.current) return
    bufScale.current = scale
    const w = Math.max(1, Math.floor(size.width * scale))
    const h = Math.max(1, Math.floor(size.height * scale))
    rt.target.setSize(w, h)
    bufferMaterial.uniforms.uRes.value.set(w, h)
    postMaterial.uniforms.uRes.value.set(w, h)
  }

  useEffect(() => {
    bufScale.current = 0
    sizeBuffer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, bufferMaterial, postMaterial, size])

  useSceneFrame(({ f, dt, b, vis, params }) => {
    // Before the offscreen march: the engine may have re-solved the budget
    // since the last frame, and that buffer is where this scene spends.
    sizeBuffer()
    const bu = bufferMaterial.uniforms
    const pu = postMaterial.uniforms

    // Nothing this instance draws reaches the frame, so skip all of it — the
    // uniform writes, the world advance, and above all the offscreen march.
    // `node.visible = false` (set by SceneManager for a hidden entry) stops the
    // main traversal but not the manual `gl.render()` below, so the roster's
    // single most expensive scene used to run at full cost while invisible,
    // for as long as it sat warming as a pending candidate.
    //
    // Unlike TrailLine there is no feedback buffer to preserve: the post pass
    // reads the same frame's own render, so a resumed instance is correct on
    // its first visible frame. Freezing `dist` also parks the flythrough where
    // it was rather than teleporting it forward by the whole hidden interval.
    pu.uFade.value = vis
    if (vis <= 0.001) return

    clock.current += dt * params.speed

    // Travel accumulates so a changing rate never jumps the world. Tempo sets
    // the baseline, energy opens it up.
    const tempo = Math.min(1.5, Math.max(0.7, f.bpm / 120))
    const speed = BASE_SPEED * (0.5 + b.energy * 0.9) * tempo * params.speed
    dist.current += dt * speed
    // Cars run faster than the world, as in the source.
    carDist.current += dt * speed * 2

    bu.uTime.value = clock.current
    bu.uDist.value = dist.current
    bu.uCarDist.value = carDist.current
    bu.uBass.value = b.bass
    bu.uMid.value = b.mid
    // The term the shader was already built to react to, now on real audio.
    bu.uFft.value = Math.min(1, b.pulse * 0.7 + b.energy * 0.5)
    applyQualityUniforms(bu)

    // March budgets. The source allowed 256 primary and up to 650 shadow steps
    // per hit; both are governed here, and the shadow ceiling is 160.
    const q = quality.knobs.raymarchSteps / 96
    bu.uTraceSteps.value = Math.max(48, Math.round(200 * q))
    bu.uShadowSteps.value = Math.max(16, Math.round(110 * q))

    pu.uScene.value = rt.target.texture
    pu.uFlareSize.value = 0.01 + b.transient * 0.012
    pu.uFade.value = vis
    pu.uBloomSamples.value = Math.max(8, Math.round(40 * q))
    pu.uFlareSamples.value = Math.max(4, Math.round(14 * q))

    // Offscreen pass, at useFrame priority 0 — before the composer's 1.
    const prevTarget = gl.getRenderTarget()
    gl.setRenderTarget(rt.target)
    gl.render(rt.scene, rt.camera)
    gl.setRenderTarget(prevTarget)
  })

  return (
    <mesh frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={postMaterial} attach="material" />
    </mesh>
  )
}

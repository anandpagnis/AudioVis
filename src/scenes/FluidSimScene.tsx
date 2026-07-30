import { useContext, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { PaletteBlender, getPalette } from '../engine/palettes'
import { SceneFade } from '../engine/SceneManager'
import { getEffectiveParams } from '../engine/moodParams'
import { getAudioResponse } from '../engine/audioResponse'
import { quality } from '../engine/quality'
import { useStore } from '../store'

/**
 * Fluid Reactor — the Phase 6 GPU fluid simulation. A real stable-fluids solver
 * (semi-Lagrangian advection + Jacobi pressure projection) runs across a stack
 * of ping-pong render targets every frame: a swirling emitter injects dye and
 * velocity, and every beat fires a radial SHOCKWAVE from the centre (bigger on
 * drops). The dye field is displayed additively so it also works as an overlay.
 *
 * The sim passes render to off-screen targets via raw gl.render on a private
 * quad scene; the visible mesh just samples the dye. State is saved/restored so
 * it coexists with the post-processing EffectComposer.
 */
const RES_X = 160
const RES_Y = 90
const DT = 0.016

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const HEAD = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uTexel;
`

const ADVECT_FRAG = HEAD + /* glsl */ `
  uniform sampler2D uVel, uSrc;
  uniform float uDt, uDiss;
  void main() {
    vec2 v = texture2D(uVel, vUv).xy;
    vec2 coord = vUv - uDt * v * uTexel;
    gl_FragColor = uDiss * texture2D(uSrc, coord);
  }
`

const DIVERGENCE_FRAG = HEAD + /* glsl */ `
  uniform sampler2D uVel;
  void main() {
    float L = texture2D(uVel, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uVel, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uVel, vUv - vec2(0.0, uTexel.y)).y;
    float T = texture2D(uVel, vUv + vec2(0.0, uTexel.y)).y;
    gl_FragColor = vec4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
  }
`

const JACOBI_FRAG = HEAD + /* glsl */ `
  uniform sampler2D uP, uDiv;
  void main() {
    float L = texture2D(uP, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uP, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uP, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uP, vUv + vec2(0.0, uTexel.y)).x;
    float d = texture2D(uDiv, vUv).x;
    gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
  }
`

const GRADIENT_FRAG = HEAD + /* glsl */ `
  uniform sampler2D uP, uVel;
  void main() {
    float L = texture2D(uP, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture2D(uP, vUv + vec2(uTexel.x, 0.0)).x;
    float B = texture2D(uP, vUv - vec2(0.0, uTexel.y)).x;
    float T = texture2D(uP, vUv + vec2(0.0, uTexel.y)).x;
    vec2 v = texture2D(uVel, vUv).xy - vec2(R - L, T - B);
    gl_FragColor = vec4(v, 0.0, 1.0);
  }
`

const SPLAT_FRAG = HEAD + /* glsl */ `
  uniform sampler2D uTarget;
  uniform vec2 uPoint;
  uniform vec3 uValue;
  uniform float uRadius, uAspect;
  void main() {
    vec2 p = vUv - uPoint;
    p.x *= uAspect;
    float s = exp(-dot(p, p) / uRadius);
    gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + s * uValue, 1.0);
  }
`

const SHOCK_FRAG = HEAD + /* glsl */ `
  uniform sampler2D uVel;
  uniform vec2 uCenter;
  uniform float uStrength, uRadius, uAspect;
  void main() {
    vec2 p = vUv - uCenter;
    p.x *= uAspect;
    float d = length(p);
    float s = exp(-d * d / uRadius);
    vec2 dir = p / (d + 1e-4);
    gl_FragColor = vec4(texture2D(uVel, vUv).xy + dir * s * uStrength, 0.0, 1.0);
  }
`

const DISPLAY_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uDye;
  uniform float uFade;
  uniform float uEnergy;
  void main() {
    vec3 c = texture2D(uDye, vUv).rgb;
    c = c / (1.0 + c * 0.7);           // Reinhard tone-map — no additive blow-out
    c = pow(c, vec3(0.85));
    c *= (0.75 + uEnergy * 0.6);
    gl_FragColor = vec4(c * uFade, 1.0);
  }
`

function makeRT(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(RES_X, RES_Y, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  })
}

function simMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT,
    fragmentShader,
    uniforms: { uTexel: { value: new THREE.Vector2(1 / RES_X, 1 / RES_Y) }, ...uniforms },
    depthTest: false,
    depthWrite: false,
  })
}

export function FluidSimScene() {
  const fade = useContext(SceneFade)
  const time = useRef(0)
  const blender = useMemo(() => new PaletteBlender(getPalette(useStore.getState().paletteId)), [])

  const sim = useMemo(() => {
    const vel = [makeRT(), makeRT()]
    const dye = [makeRT(), makeRT()]
    const pres = [makeRT(), makeRT()]
    const div = makeRT()

    const scene = new THREE.Scene()
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    scene.add(quad)

    const aspect = RES_X / RES_Y
    const mats = {
      advect: simMaterial(ADVECT_FRAG, {
        uVel: { value: null },
        uSrc: { value: null },
        uDt: { value: DT },
        uDiss: { value: 0.998 },
      }),
      divergence: simMaterial(DIVERGENCE_FRAG, { uVel: { value: null } }),
      jacobi: simMaterial(JACOBI_FRAG, { uP: { value: null }, uDiv: { value: null } }),
      gradient: simMaterial(GRADIENT_FRAG, { uP: { value: null }, uVel: { value: null } }),
      splat: simMaterial(SPLAT_FRAG, {
        uTarget: { value: null },
        uPoint: { value: new THREE.Vector2() },
        uValue: { value: new THREE.Vector3() },
        uRadius: { value: 0.0016 },
        uAspect: { value: aspect },
      }),
      shock: simMaterial(SHOCK_FRAG, {
        uVel: { value: null },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uStrength: { value: 0 },
        uRadius: { value: 0.02 },
        uAspect: { value: aspect },
      }),
    }

    return { vel, dye, pres, div, scene, cam, quad, mats, aspect, cleared: false }
  }, [])

  const displayMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: DISPLAY_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uDye: { value: sim.dye[0].texture },
          uFade: { value: 0 },
          uEnergy: { value: 0 },
        },
      }),
    [sim],
  )

  useFrame((state) => {
    const gl = state.gl
    const s = sim

    // Skip the entire solver while the scene is invisible — e.g. the outgoing
    // side of a crossfade, or before it has faded in. Nothing samples the dye,
    // so the ~14 off-screen passes would be pure waste, and this is what keeps
    // two heavy scenes from both simulating during a transition. Cheapest to
    // bail here, before touching any render target. (The one-time clear defers
    // to the first visible frame.)
    const vis = fade.value * getEffectiveParams().intensity
    if (vis < 0.02) {
      displayMat.uniforms.uFade.value = 0
      return
    }

    const run = (mat: THREE.Material, out: THREE.WebGLRenderTarget) => {
      s.quad.material = mat
      gl.setRenderTarget(out)
      gl.render(s.scene, s.cam)
    }
    const swap = (pair: THREE.WebGLRenderTarget[]) => {
      const t = pair[0]
      pair[0] = pair[1]
      pair[1] = t
    }

    // One-time clear of every field.
    if (!s.cleared) {
      for (const rt of [s.vel[0], s.vel[1], s.dye[0], s.dye[1], s.pres[0], s.pres[1], s.div]) {
        gl.setRenderTarget(rt)
        gl.setClearColor(0x000000, 1)
        gl.clear(true, false, false)
      }
      s.cleared = true
    }

    const f = audioEngine.features
    const params = getEffectiveParams()
    const R = params.reactivity
    const response = getAudioResponse(f)
    blender.update(getPalette(useStore.getState().paletteId), f.delta)
    time.current += DT

    const m = s.mats

    // 1) Advect velocity.
    m.advect.uniforms.uVel.value = s.vel[0].texture
    m.advect.uniforms.uSrc.value = s.vel[0].texture
    m.advect.uniforms.uDiss.value = 0.998
    run(m.advect, s.vel[1])
    swap(s.vel)

    // 2) Swirling emitter — injects velocity + dye on a Lissajous path.
    const t = time.current
    const cx = 0.5 + 0.22 * Math.sin(t * 0.7)
    const cy = 0.5 + 0.22 * Math.cos(t * 0.9)
    const ang = t * 3.0
    const force = 120 + response.energy * 260 * R
    m.splat.uniforms.uRadius.value = 0.0016
    m.splat.uniforms.uPoint.value.set(cx, cy)
    m.splat.uniforms.uValue.value.set(Math.cos(ang) * force, Math.sin(ang) * force, 0)
    m.splat.uniforms.uTarget.value = s.vel[0].texture
    run(m.splat, s.vel[1])
    swap(s.vel)

    // Dye colour follows the palette, cycling through its three hues.
    const cyc = Math.floor(t * 0.7) % 3
    const dc = cyc === 0 ? blender.a : cyc === 1 ? blender.b : blender.c
    m.splat.uniforms.uPoint.value.set(cx, cy)
    m.splat.uniforms.uValue.value.set(dc.r * 0.4, dc.g * 0.4, dc.b * 0.4)
    m.splat.uniforms.uTarget.value = s.dye[0].texture
    run(m.splat, s.dye[1])
    swap(s.dye)

    // 3) Beat shockwave from the centre — the bass "shockwave".
    if (f.beat || f.drop) {
      const strength = (260 + response.bass * 500 + (f.drop ? 500 : 0)) * R
      m.shock.uniforms.uStrength.value = strength
      m.shock.uniforms.uRadius.value = 0.02 + response.bass * 0.02
      m.shock.uniforms.uVel.value = s.vel[0].texture
      run(m.shock, s.vel[1])
      swap(s.vel)

      const flash = f.drop ? 1.4 : 0.5 + response.beatPulse
      m.splat.uniforms.uRadius.value = 0.02
      m.splat.uniforms.uPoint.value.set(0.5, 0.5)
      m.splat.uniforms.uValue.value.set(blender.c.r * flash, blender.c.g * flash, blender.c.b * flash)
      m.splat.uniforms.uTarget.value = s.dye[0].texture
      run(m.splat, s.dye[1])
      swap(s.dye)
    }

    // 4) Divergence.
    m.divergence.uniforms.uVel.value = s.vel[0].texture
    run(m.divergence, s.div)

    // 5) Pressure — Jacobi iterations. Count is governed by the quality tier;
    // fewer iterations under load trades a little incompressibility for frames.
    m.jacobi.uniforms.uDiv.value = s.div.texture
    const jacobi = quality.knobs.fluidJacobi
    for (let k = 0; k < jacobi; k++) {
      m.jacobi.uniforms.uP.value = s.pres[0].texture
      run(m.jacobi, s.pres[1])
      swap(s.pres)
    }

    // 6) Subtract the pressure gradient → divergence-free velocity.
    m.gradient.uniforms.uP.value = s.pres[0].texture
    m.gradient.uniforms.uVel.value = s.vel[0].texture
    run(m.gradient, s.vel[1])
    swap(s.vel)

    // 7) Advect the dye by the corrected velocity, fading it slowly.
    m.advect.uniforms.uVel.value = s.vel[0].texture
    m.advect.uniforms.uSrc.value = s.dye[0].texture
    m.advect.uniforms.uDiss.value = 0.992
    run(m.advect, s.dye[1])
    swap(s.dye)

    // Restore the default target so the composer renders to screen.
    gl.setRenderTarget(null)

    displayMat.uniforms.uDye.value = s.dye[0].texture
    displayMat.uniforms.uFade.value = fade.value * params.intensity
    displayMat.uniforms.uEnergy.value = response.energy * R
  })

  // Tear down the (many) GPU resources on unmount.
  useEffect(
    () => () => {
      for (const rt of [sim.vel[0], sim.vel[1], sim.dye[0], sim.dye[1], sim.pres[0], sim.pres[1], sim.div]) rt.dispose()
      for (const mat of Object.values(sim.mats)) mat.dispose()
      sim.quad.geometry.dispose()
      displayMat.dispose()
    },
    [sim, displayMat],
  )

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <primitive object={displayMat} attach="material" />
    </mesh>
  )
}

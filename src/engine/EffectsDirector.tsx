import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, FogExp2, Vector2 } from 'three'
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing'
import type {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer as EffectComposerImpl,
  VignetteEffect,
} from 'postprocessing'
import { FeedbackPass } from './FeedbackPass'
import { GradePass } from './GradePass'
import type { LensRackState, MirrorRackState } from './opticalRack'
import { LensPass } from './LensPass'
import { MirrorPass } from './MirrorPass'
import { getPalette } from './palettes'
import { performanceState } from './performanceState'
import { renderScale } from './renderScale'
import { transitionRack, usesRack } from './transitions'
import { useDispose } from './useDispose'
import { useStore } from '../store'

/** Chromatic-aberration offset at mount — starts at zero so no first-frame flash. */
const CA_INITIAL_OFFSET = new Vector2(0, 0)

/**
 * Owns the post chain. Scenes never touch bloom, aberration, or vignette.
 *
 * This is a pure executor: it reads `performanceState.bloom` / `.glitch` and
 * applies them. It makes no decisions and reads no audio — everything creative
 * happened upstream. That separation is what lets a director dial the look
 * (calmer bloom in a breakdown, glitch on a drop) without any post-chain code
 * knowing what a "breakdown" is.
 *
 * ## Two constraints that are load-bearing, not style
 *
 * 1. **The effect list is structurally FIXED.** Adding or removing an effect
 *    rebuilds the composer's merged shader — a multi-hundred-millisecond stall
 *    that, repeated, has lost the WebGL context outright. Quality tiers and
 *    director decisions modulate by *uniform*, never by changing the list.
 * 3. **This component must not re-render after mount.** Not a preference — a
 *    hard constraint imposed by the library. `@react-three/postprocessing`
 *    memoises each wrapped effect's constructor args on `JSON.stringify(props)`,
 *    and under React 19 `ref` is an ordinary prop, so those props include
 *    `{ current: <the effect instance> }`. Once mounted, that instance carries
 *    R3F's `__r3f` bookkeeping, whose `parent`/`children` form a cycle — so the
 *    stringify throws `Converting circular structure to JSON`, React unwinds,
 *    and the whole Canvas unmounts to a black screen.
 *
 *    It survives the FIRST render only because the refs are still `null` then.
 *    So: no `useThree` selector here that changes (`scene` is stable for the
 *    session), no store subscription that moves, no `useState`. Anything this
 *    component needs to watch must be read inside `useFrame` instead. Entering
 *    fullscreen used to black the app out for exactly this reason — a `size`
 *    selector was added here, and resizing then re-rendered it.
 *
 * 2. **A filmic grade cannot be bolted on here.** It was attempted twice and
 *    reverted; the blocker is that scenes render hot (most of the frame at or
 *    above 1.0), so any tone mapper flattens the image. Scene exposure has to
 *    come down first. Full write-up in docs/09_Rendering_Engine.md — read it
 *    before touching this chain.
 */
export function EffectsDirector() {
  const bloomRef = useRef<BloomEffect>(null)
  const caRef = useRef<ChromaticAberrationEffect>(null)
  const vignetteRef = useRef<VignetteEffect>(null)
  const composerRef = useRef<EffectComposerImpl>(null)
  // Both stable for the session, so subscribing to them cannot re-render this
  // component. See constraint 3 in the header before adding another selector.
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  /** Scratch for the renderer size read below — reused, never allocated in the loop. */
  const sizeVec = useRef(new Vector2())
  const feedbackPass = useMemo(() => new FeedbackPass(), [])
  const mirrorPass = useMemo(() => new MirrorPass(), [])
  const lensPass = useMemo(() => new LensPass(), [])
  const gradePass = useMemo(() => new GradePass(), [])
  const feedbackTint = useRef(new Color(1, 1, 1))
  /** Render scale the composer's buffers were last sized for. */
  const appliedScale = useRef(-1)
  /** Scratch rack states for a transition in flight — reused, never allocated
   *  in the loop, matching this file's no-allocation-per-frame discipline. */
  const txMirror = useRef<MirrorRackState>({ segments: 0, tiles: 0, twist: 0, slice: 0, spin: 0 })
  const txLens = useRef<LensRackState>({ amount: 0, style: 0 })
  useDispose(feedbackPass, mirrorPass, lensPass, gradePass)
  /** F81 guard: warned about a mis-ordered chain at most once per mount. */
  const warnedChainOrder = useRef(false)
  // Exponential fog, mutated in place — swapping the Scene.fog object per frame
  // would invalidate every material's shader cache.
  const fog = useRef(new FogExp2(0x000000, 0))

  /**
   * The zero-density fog is kept attached, and now does nothing at all.
   *
   * `performanceState.fog` moved to the post chain (F46, see GradePass): three
   * applies `scene.fog` only to materials that opt in, `ShaderMaterial.fog`
   * defaults to false, and no scene in the roster sets it — so this reached one
   * scene of sixteen and the dial was steering almost nothing.
   *
   * It stays attached at density 0 rather than being removed, for exactly the
   * reason the original comment gives below: whether a scene has fog at all is
   * part of three's program cache key, so detaching it would recompile every
   * material in the scene. Removing a no-op costs a multi-hundred-millisecond
   * stall; leaving it costs nothing. If a future scene wants real depth fog it
   * sets `fog: true` on its material and this is already here for it.
   *
   * Fog is attached ONCE and never detached.
   *
   * Whether a scene has fog at all is part of Three's shader program cache key,
   * so assigning `scene.fog = null` and back recompiles every material in the
   * scene — a multi-hundred-millisecond stall. The old code did exactly that
   * around a `p.fog > 0.001` threshold, and because `p.fog` eases exponentially
   * (it never actually reaches zero) it crossed that threshold once in each
   * direction per ambient transition. Two whole-scene recompiles, landing on
   * precisely the musical moments that have to stay smooth.
   *
   * `FogExp2` at density 0 gives `1 - exp(-0 * depth) = 0` fog factor, so a
   * permanently-attached zero-density fog is visually identical to no fog while
   * keeping the program key stable for the whole session.
   */
  useEffect(() => {
    // Captured in a local so the cleanup detaches the fog this effect attached,
    // not whatever `fog.current` happens to hold when the component unmounts.
    const instance = fog.current
    instance.density = 0
    scene.fog = instance
    return () => {
      if (scene.fog === instance) scene.fog = null
    }
  }, [scene])

  useFrame((_, delta) => {
    // Resize the post chain when the QUALITY GOVERNOR moves the render scale.
    //
    // The library resizes its own buffers when the canvas's CSS size changes,
    // but that path is keyed on `size` alone and a DPR-only change never
    // touches it. `renderScale` works purely by changing DPR, so without this
    // every render target in the chain — the composer's input/output buffers,
    // Bloom's mip pyramid, the feedback history — stays pinned at whatever an
    // actual window resize last set, and the entire internal-resolution
    // governor never reaches the most fill-bound work in the frame.
    //
    // Fed the renderer's OWN current size on purpose. `EffectComposer.setSize`
    // only forwards to `renderer.setSize()` when the dimensions differ from
    // what the renderer already reports, so handing back its own numbers takes
    // that branch out of play — R3F stays the sole owner of the canvas element
    // and its CSS, and this call does nothing but re-derive the chain's buffers
    // from `getDrawingBufferSize()`, which is where the new DPR shows up.
    //
    // Polled in the frame loop rather than via a selector because this
    // component must not re-render; see constraint 3 in the header. One float
    // compare on a frame where nothing changed, which is nearly every frame.
    if (renderScale.applied !== appliedScale.current) {
      appliedScale.current = renderScale.applied
      gl.getSize(sizeVec.current)
      composerRef.current?.setSize(sizeVec.current.width, sizeVec.current.height)
    }

    // F81: MirrorPass/FeedbackPass/LensPass have no colour-space-conversion
    // include (`colorspace_fragment` — see GradePass), which is only correct
    // because they render to intermediate linear buffers and GradePass is
    // last, doing the one real conversion for the whole chain (F79). Nothing
    // stops a future reorder — or disabling GradePass — from silently
    // reintroducing F79's washed-out image with no compile error to catch it.
    // One O(1) check, on the composer's own resolved pass list rather than
    // the JSX source, so it catches the actual composed chain regardless of
    // how a reorder happened. `console.error` rather than a throw: a wrong
    // chain order is a real bug worth surfacing loudly, not a reason to
    // black out a running show over — see F48 on why this component treats
    // "stay up" as more important than "fail fast".
    if (!warnedChainOrder.current) {
      const passes = composerRef.current?.passes
      const last = passes?.[passes.length - 1]
      if (passes && passes.length > 0 && last !== gradePass) {
        warnedChainOrder.current = true
        console.error(
          '[AudioVis] EffectsDirector: GradePass is no longer the last pass in the ' +
            'composer chain — the colour-space conversion (F79/F81) may be missing ' +
            'or running on the wrong buffer. Check the <EffectComposer> children order ' +
            "in EffectsDirector.tsx; GradePass's own header explains why it must be last.",
        )
      }
    }

    const p = performanceState
    const palette = getPalette(useStore.getState().paletteId)
    // Both racks set their own `enabled` from the values below, which is the
    // ONLY branch either of them has — see engine/opticalRack.ts. At rest both
    // are skipped by the composer entirely, so the chain keeps its shape without
    // charging for two fullscreen passes that would change nothing.
    // A transition may borrow the racks for its duration — `smear` is the
    // feedback pass, `melt` is a lens material, `collapse` is the mirror rack.
    // Layered OVER whatever the director already set rather than replacing it,
    // so a show running a standing lens look does not lose it for two beats
    // every time the scene changes.
    //
    // Additive for the continuous amounts and last-writer for the discrete
    // choices (material, tile count), because those are selections rather than
    // magnitudes — averaging two lens materials is not a lens material.
    const tx = p.transition
    const rack = tx.active && usesRack(tx.style) ? transitionRack(tx.style, tx.progress) : null
    if (rack) {
      txMirror.current.segments = p.mirror.segments
      txMirror.current.tiles = rack.mirrorTiles > 1.5 ? rack.mirrorTiles : p.mirror.tiles
      txMirror.current.twist = p.mirror.twist + rack.mirrorTwist
      txMirror.current.slice = p.mirror.slice
      txMirror.current.spin = p.mirror.spin
      txLens.current.amount = Math.min(1, p.lens.amount + rack.lensAmount)
      txLens.current.style = rack.lensAmount > 0 ? rack.lensStyle : p.lens.style
    }
    mirrorPass.advance(rack ? txMirror.current : p.mirror, delta, p.rackAudio.mids)
    lensPass.advance(rack ? txLens.current : p.lens, delta, p.rackAudio)
    feedbackPass.setTrails(Math.min(1, p.trails + (rack?.trails ?? 0)))
    // `mid` is the body colour, which is what a trail should be tinted toward
    // — glow would make every trail read as a highlight, and shadow would make
    // them vanish into the ground.
    feedbackTint.current.set(palette.slots.mid)
    feedbackPass.setTint(feedbackTint.current)
    if (bloomRef.current) {
      bloomRef.current.intensity = p.bloom
      bloomRef.current.luminanceMaterial.threshold = p.bloomThreshold
    }
    // Same magnitude as before (the old fixed 1.0 : 0.6 ratio has length ~1.166),
    // now steerable — so switching to a directed smear does not also change how
    // strong the aberration reads.
    if (caRef.current) {
      const g = p.glitch * 1.166
      caRef.current.offset.set(Math.cos(p.caAngle) * g, Math.sin(p.caAngle) * g)
    }
    if (vignetteRef.current) vignetteRef.current.darkness = p.vignette

    // Atmospheric depth. Tinted toward the palette's background rather than
    // pure black so it reads as air, not as the subject being clipped away.
    // Density alone carries the whole range now — see the attach effect above
    // for why this must never toggle `scene.fog` itself.
    // Deliberately no longer driven from `p.fog` — atmosphere is a post-chain
    // effect now (F46, see GradePass). Held at 0 so the attached FogExp2 stays
    // a no-op without changing three's program cache key.
    fog.current.density = 0
    if (p.fog > 0.001) fog.current.color.set(palette.slots.bg)
  })

  return (
    <EffectComposer ref={composerRef} multisampling={0}>
      {/*
        A raw Pass, not a merged Effect — see FeedbackPass.ts's header for why
        that distinction is what makes mounting this unconditionally cheap. It
        sits BEFORE the Bloom/CA/Vignette list so bloom picks up the accumulated
        trail, not just the current frame, matching lilim's own chain order.
      */}
      {/*
        Chain order is lilim's, and each position is load-bearing:
        mirror -> feedback -> bloom/CA/vignette -> lens.

        Mirror sits ahead of feedback so the trail accumulates THROUGH the fold
        and the pattern compounds into itself; behind it, symmetry would just be
        a symmetric copy of an asymmetrically-built trail. Lens sits after bloom
        so the glow refracts through the material the way light does through
        real optics — that is the difference between glass and a filter.
      */}
      <primitive object={mirrorPass} />
      <primitive object={feedbackPass} />
      <Bloom ref={bloomRef} intensity={0.8} luminanceThreshold={0.18} mipmapBlur radius={0.75} />
      <ChromaticAberration ref={caRef} offset={CA_INITIAL_OFFSET} />
      <Vignette ref={vignetteRef} eskil={false} offset={0.18} darkness={0.85} />
      <primitive object={lensPass} />
      {/*
        LAST, and always enabled. EffectComposer flags the final pass as the one
        that renders to screen and skips disabled passes before that happens, so
        whatever sits here can never switch itself off — see GradePass's header.
        It applies the exposure servo's gain, which is genuine work rather than
        the straight copy the lens rack was doing to hold this position.
      */}
      <primitive object={gradePass} />
    </EffectComposer>
  )
}

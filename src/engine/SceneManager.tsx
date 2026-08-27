import { Suspense, createContext, useRef, useState, type ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { audioEngine } from '../audio/AudioEngine'
import { LAYER_ROLES, useStore, type LayerBlend, type LayerRole } from '../store'
import { getEffectScenes, getResolvedManifest, getScene, isSceneLoaded, scenePixelBudget } from '../scenes'
import { approach, performanceState, type ActiveEffect } from './performanceState'
import {
  fadeDurationFor,
  resolveTransitionStyle,
  transitionMix,
  usesRack,
  type TransitionStyle,
} from './transitions'
import { quality } from './quality'
import { combinePixelBudgets, POST_CHAIN_PIXEL_BUDGET, renderScale } from './renderScale'
import {
  applyFrameLoad,
  fillScale,
  feedbackMsFor,
  frameLoad,
  lensRackMs,
  mirrorRackMs,
  POST_CHAIN_MS,
} from './frameLoad'
import { canFundOverlap, slotCostMs } from './slotBudget'
import { perf, suspendFrameSampling } from './PerfMonitor'
import { updateAnimationSignals } from './AnimationDirector'
import { sampleAnalytics } from './analyticsMetrics'
import { beginTransition, sampleTransitionFrame } from './transitionMetrics'
import { sceneStreamer } from './streaming/sceneStreamer'
import { prewarmShaders } from './streaming/shaderPrewarm'

/** Every slot a mounted scene instance can occupy. */
export type SlotName = 'primary' | LayerRole | 'effect'

/**
 * Render-order band per slot.
 *
 * Irrelevant while everything blends additively (additive is commutative), but
 * load-bearing the moment a layer is set to `normal`/`multiply`/`screen` — those
 * composite against whatever is already in the buffer, so "background first,
 * effects last" has to be a real ordering rather than an emergent one.
 */
const SLOT_RENDER_ORDER: Record<SlotName, number> = {
  background: 0,
  primary: 10,
  accent: 20,
  overlay: 30,
  effect: 40,
}

/**
 * Gain applied to slots the user has no control over.
 *
 * Background and accent/overlay take theirs from `layerFx`; effects are engine
 * state with no UI, so their level lives here.
 */
const EFFECT_GAIN = 0.85

/**
 * What a mounted scene instance sees about its own slot.
 *
 * Mutated in place each frame and read inside `useFrame` — no React re-renders,
 * same contract the bare fade value had before.
 */
export interface SlotView {
  /** Fade × slot gain. The number scenes multiply their output by. */
  value: number
  /** Which slot this instance occupies. */
  role: SlotName
  /**
   * Which scene is mounted here.
   *
   * Carried on the slot view because a scene component does not otherwise know
   * its own registry id, and `useSceneFrame` needs it to look up the scene's
   * Scene Contract and its stored dial positions. Fixed for the life of an
   * entry — a slot showing a different scene is a different entry.
   */
  sceneId: string
  /**
   * The slot's gain alone, without the crossfade.
   *
   * Separate from `value` because a scene otherwise cannot tell "I am dim
   * because I am mid-crossfade" from "I am dim because I am the background" —
   * and only the second is a reason to change what it draws rather than how
   * brightly.
   */
  gain: number
  /**
   * 0→1 across an effect's lifetime; always 0 for every other slot.
   *
   * An effect scene must reach visual zero by 1: the engine unmounts it there
   * and does not fade it out.
   */
  progress: number
}

/**
 * Per-scene-instance slot view, mutated by the transition manager each frame
 * and read by scenes inside useFrame — no React re-renders.
 */
export const SceneFade = createContext<SlotView>({
  value: 1,
  role: 'primary',
  sceneId: '',
  gain: 1,
  progress: 0,
})

interface Entry {
  key: number
  id: string
  role: SlotName
  /**
   * One firing of an effect scene, or null for a tenancy slot. Effect entries
   * stay mounted for the whole session (pinned, so their shaders never compile
   * on a trigger) and simply become inactive between firings.
   */
  effect: ActiveEffect | null
  /** 1 = fading in, -1 = fading out, 0 = mounted but warming (see WARM_FRAMES). */
  dir: 1 | -1 | 0
  /** Frames this entry has spent warming; drives the compile-then-hide dance. */
  warmFrames: number
  /**
   * True once `compileAsync` has confirmed — on a driver that can actually
   * confirm it — that this entry's programs are ready. When set, the visible
   * warm-render frames are skipped entirely, which is what removes the
   * two-scenes-rendering-at-once frame-time spike.
   */
  prewarmed: boolean
  /** Raw crossfade 0..1. */
  fade: { value: number }
  /** What scenes see: fade × slot gain, plus the slot's identity. */
  out: SlotView
}

/**
 * How many frames a warming scene stays visible (and rendering, to compile its
 * shader) before being hidden. The count only advances once the scene's lazy
 * chunk has loaded (see the aging loop), so it measures frames actually spent
 * rendering after mount — not wall-clock since the request. A shader compiles on
 * its material's first visible render, so a few frames is plenty; keeping it
 * small also shrinks the window where the warming scene renders full-res
 * alongside the current one (a double-heavy frame-time spike).
 */
const WARM_FRAMES = 4

/** How fast the transition complexity discount eases in and out, per second. */
const DISCOUNT_EASE_RATE = 7

/**
 * Classic smoothstep: zero slope at both ends, symmetric about 0.5.
 *
 * The symmetry is load-bearing, not cosmetic — see the call site. Input is
 * assumed already clamped to 0..1 by the caller.
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * Scratch for the per-frame pixel-budget walk below. Module-level and reused,
 * matching this file's no-allocation-in-the-loop discipline — a fresh array per
 * frame at 60fps is exactly the garbage the rest of the render path avoids.
 */
const committedBudgets: number[] = []

let entryKey = 0

function makeEntry(
  id: string,
  role: SlotName,
  dir: 1 | -1 | 0,
  effect: ActiveEffect | null = null,
): Entry {
  return {
    key: entryKey++,
    id,
    role,
    effect,
    dir,
    warmFrames: 0,
    prewarmed: false,
    fade: { value: 0 },
    out: { value: 0, role, sceneId: id, gain: 1, progress: 0 },
  }
}

/** True once this entry's shaders are compiled — either confirmed by
 *  `compileAsync` on a capable driver, or assumed after enough visible frames
 *  on one that cannot confirm. Drives both visibility and the PREWARMING ->
 *  READY transition. */
function isWarmComplete(entry: Entry): boolean {
  return entry.prewarmed || entry.warmFrames > WARM_FRAMES
}

/** Crossfade duration in seconds — roughly two beats, clamped to a sane range. */
function crossfadeDuration(bpm: number): number {
  return Math.min(2, Math.max(0.7, (60 / bpm) * 2))
}

/**
 * What each layer slot should actually hold, given the primary.
 *
 * No scene may occupy two slots at once. The collision check used to guard only
 * entry *creation*, so a layer that mounted legitimately and was then overtaken
 * by the primary switching to that same scene stayed up — rendering the scene
 * twice, the copy compositing additively over itself and everything else.
 * Resolving to null here makes the existing entry fade out instead.
 *
 * With three layer slots instead of one this becomes an ALL-PAIRS rule rather
 * than a check against the primary: two layers can now collide with each other,
 * which was structurally impossible when only one could be occupied. Earlier
 * slots in {@link LAYER_ROLES} win, so the more structural layer keeps the scene
 * and the later one yields — a background outranks an accent.
 *
 * ## It also enforces the budget, every frame
 *
 * The frame budget used to be checked only where decisions were MADE —
 * `composeLayers` at a phrase boundary, `EffectDirector` on a trigger,
 * `canFundOverlap` at a commit. Nothing checked the total before actually
 * drawing it, and two things routinely pushed a legal decision over the line
 * afterwards:
 *
 *  - **A crossfade.** `composeLayers` reserves one primary, so mid-fade it
 *    offers the outgoing scene's share to the layers as if it were free. Two
 *    heavy primaries plus the fixed costs already fill tier 0 exactly; the
 *    layers admitted on top took it to ~15 against 11.
 *  - **A tier drop.** Layers admitted at tier 0 (capacity 11) stay mounted when
 *    the governor steps to tier 2 (capacity 7). Nothing re-examines them until
 *    the next phrase boundary, up to 16 beats later.
 *
 * This function already runs every frame and already decides what is mounted,
 * so it is the natural enforcement point: give it the remaining capacity and it
 * sheds the least structural layers until the frame fits. It is self-correcting
 * in both directions — when capacity returns, the layer is simply admitted
 * again on a later frame, with no state to unwind.
 *
 * Exported for the unit test; SceneManager is the only production caller.
 */
export function resolveLayerIds(
  desired: Record<LayerRole, string | null>,
  sceneId: string,
  pendingSceneId: string | null,
  /**
   * Live budget enforcement. Omit for collision resolution only.
   *
   * `remaining` is the capacity in MILLISECONDS left after everything that is
   * NOT a layer — the subject, any crossfade overlap, live effects, and the
   * fixed per-frame costs. Layers are then admitted in {@link LAYER_ROLES} order
   * while they fit, so the tail (overlay, then accent) is what gets dropped and
   * the ground layer is kept. See the header note on why this belongs here.
   */
  budget?: { remaining: number; msFor: (id: string, role: LayerRole) => number },
): Record<LayerRole, string | null> {
  const taken = new Set<string>([sceneId])
  if (pendingSceneId) taken.add(pendingSceneId)
  const out: Record<LayerRole, string | null> = { background: null, accent: null, overlay: null }
  let left = budget?.remaining ?? Infinity
  for (const role of LAYER_ROLES) {
    const id = desired[role]
    if (id === null || taken.has(id)) continue
    if (budget) {
      const ms = budget.msFor(id, role)
      // Skip rather than break: a cheap overlay may still fit where an
      // expensive accent did not, and refusing it as well would shed more than
      // the frame needs. With measured costs that is now the common case rather
      // than a corner: most of the roster is under 0.2 ms and a handful of
      // scenes are over 10, so the cheap tail almost always still fits.
      if (ms > left) continue
      left -= ms
    }
    taken.add(id)
    out[role] = id
  }
  return out
}

/**
 * Grace period before a drop-triggered switch gives up waiting for the incoming
 * scene's shader and commits anyway. Long enough for `prewarmShaders` to resolve
 * on a normal driver (a few frames), short enough that the cut still reads as
 * part of the drop rather than as a late reaction.
 */
const IMMEDIATE_WARM_GRACE_SEC = 0.35

/**
 * Should the pending switch commit this frame, and should it cut rather than
 * crossfade?
 *
 * Pure and exported for tests: this is the timing of every scene change in the
 * app, it depends on four interacting conditions, and it fails *silently* —
 * a switch that lands a bar late still renders perfectly, which is exactly how
 * the "drops don't switch" bug survived for as long as it did.
 *
 * `incomingWarm` is null when no warm entry exists yet (nothing to wait for).
 */
export function resolveCommit(opts: {
  gridTrusted: boolean
  onDownbeat: boolean
  pendingImmediate: boolean
  incomingWarm: boolean | null
  waited: number
}): { commit: boolean; immediate: boolean } {
  const { gridTrusted, onDownbeat, pendingImmediate, incomingWarm, waited } = opts
  const immediate =
    pendingImmediate &&
    (incomingWarm === null || incomingWarm || waited > IMMEDIATE_WARM_GRACE_SEC)

  /**
   * A downbeat commit ALSO waits for the incoming shader.
   *
   * This gate used to apply only to drop switches, and the omission was the
   * biggest single source of transition stalls. The window is easy to hit:
   * `requestScene` fires whenever AutoPilot sees a mood change, and if the
   * next downbeat lands a frame or two later there has been no time for the
   * chunk to arrive, let alone for the program to link. The commit then
   * promoted a cold entry and the driver compiled it on its first real draw —
   * a multi-hundred-millisecond freeze, landing exactly on the beat. That is
   * the one place the whole warm-up mechanism exists to keep clear, and the
   * normal path walked straight into it.
   *
   * It also explains why the stalls looked random rather than per-scene: it
   * depends only on where in the bar the request happened to land.
   *
   * `null` means no warm entry exists to wait for, so there is nothing to gain
   * by waiting. Skipping a downbeat costs one bar, and `waited > 2.5` remains
   * the backstop, so a scene that never warms still lands rather than hanging.
   */
  const warmEnough = incomingWarm === null || incomingWarm
  return {
    commit: !gridTrusted || (onDownbeat && warmEnough) || immediate || waited > 2.5,
    immediate,
  }
}

/**
 * Flip pinned effect entries between idle and firing to match the director's
 * active list.
 *
 * Mounts and unmounts nothing: every effect scene is mounted once for the whole
 * session (see the entry seeding in SceneManager) precisely so a trigger never
 * pays a shader compile — an effect fires *because* something just happened, so
 * a cold compile would land on the event. Only `dir` and `effect` change here.
 *
 * Matches on the firing `key` rather than the scene id, so re-firing the same
 * effect while it is still fading out restarts it cleanly.
 *
 * Returns true when React needs a re-render (never, currently — dir is read in
 * useFrame — but kept honest so a future change that does need one is visible).
 * Exported for the unit test; SceneManager is the only production caller.
 */
export function syncEffectEntries(entries: Entry[], active: readonly ActiveEffect[]): boolean {
  let changed = false
  for (const e of entries) {
    if (e.role !== 'effect') continue
    const firing = active.find((a) => a.id === e.id)
    if (firing) {
      if (e.effect?.key !== firing.key) {
        e.effect = firing
        e.fade.value = 0
        changed = true
      }
      if (e.dir !== 1) {
        e.dir = 1
        changed = true
      }
    } else if (e.dir === 1) {
      e.dir = -1
      changed = true
    }
  }
  return changed
}

function applyBlend(mat: THREE.Material, blend: LayerBlend) {
  if (!mat.transparent) mat.transparent = true
  switch (blend) {
    case 'add':
      mat.blending = THREE.AdditiveBlending
      break
    case 'normal':
      mat.blending = THREE.NormalBlending
      break
    case 'multiply':
      mat.blending = THREE.MultiplyBlending
      break
    case 'screen':
      // screen = src·(1−dst) + dst — brightens without additive blow-out.
      mat.blending = THREE.CustomBlending
      mat.blendEquation = THREE.AddEquation
      mat.blendSrc = THREE.OneMinusDstColorFactor
      mat.blendDst = THREE.OneFactor
      break
  }
}

/**
 * Wraps a composition layer and rewrites its materials' blending to the
 * user's per-layer choice. Materials are created inside scene useMemo, so we
 * traverse for a few frames after mount (and after each blend change) to
 * catch everything, then go quiet.
 */
function BlendedLayer({ role, children }: { role: SlotName; children: ReactNode }) {
  const group = useRef<THREE.Group>(null)
  const applied = useRef<LayerBlend | null>(null)
  const framesLeft = useRef(0)

  useFrame(() => {
    // Effects have no user-facing look controls, so they always composite
    // additively — the blend that makes a burst read as light rather than as
    // an object occluding the frame.
    const blend: LayerBlend =
      role === 'effect' || role === 'primary' ? 'add' : useStore.getState().layerFx[role].blend
    if (applied.current !== blend) {
      applied.current = blend
      framesLeft.current = 30
    }
    if (framesLeft.current <= 0 || !group.current) return
    framesLeft.current--
    group.current.traverse((obj) => {
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!mat) return
      for (const m of Array.isArray(mat) ? mat : [mat]) applyBlend(m, blend)
    })
  })

  return <group ref={group}>{children}</group>
}

/**
 * Controls whether an entry actually renders, and kicks off shader
 * precompilation for it.
 *
 * A scene's shader compiles the first time its material renders, and that
 * compile can stall for hundreds of milliseconds. Mounting the incoming scene
 * at the downbeat therefore put the stall exactly on the beat — the single
 * worst-timed hitch in the app. Instead we mount it as soon as it's requested,
 * let it render WARM_FRAMES frames (compiling it), then hide it so it costs
 * nothing until the transition promotes it with a shader already warm.
 *
 * `prewarmShaders` runs alongside that, not instead of it. It gives the
 * driver's compile thread a head start, and on drivers exposing
 * `KHR_parallel_shader_compile` it can genuinely confirm the program is ready
 * — at which point `entry.prewarmed` lets the visible warm frames be skipped
 * entirely, removing the double-render spike. Where the extension is absent,
 * three's `isReady()` reports ready immediately whether or not it is, so the
 * visible warm render still has to happen. See shaderPrewarm.ts.
 */
/** Does this subtree contain anything with a material yet? See EntryGroup. */
function hasRenderable(node: THREE.Object3D): boolean {
  let found = false
  node.traverse((child) => {
    if (!found && (child as Partial<THREE.Mesh>).material) found = true
  })
  return found
}

function EntryGroup({ entry, children }: { entry: Entry; children: ReactNode }) {
  const group = useRef<THREE.Group>(null)
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const started = useRef(false)

  useFrame(() => {
    const node = group.current
    if (!node) return

    // Wait for the scene's lazy chunk to actually resolve and mount something
    // renderable. Scenes render inside <Suspense>, so this group is EMPTY for
    // the first frames after mount — and compileAsync on an empty subtree
    // resolves instantly having compiled nothing. Trusting that would set
    // `prewarmed`, skip the warm frames, and hand the real compile stall
    // straight to the first post-promotion draw: the exact failure this whole
    // mechanism exists to prevent, and one that looks like success.
    if (!started.current && hasRenderable(node)) {
      started.current = true
      void prewarmShaders(gl, node, camera).then((result) => {
        entry.prewarmed = result.skippedWarmFrames
      })
    }

    // An idle pinned effect is never visible: unlike a warming candidate it has
    // no promotion coming, so the `!isWarmComplete` escape would leave it
    // rendering forever once it had compiled.
    node.visible =
      entry.role === 'effect' ? entry.dir !== 0 : entry.dir !== 0 || !isWarmComplete(entry)
  })

  // Only meaningful for non-additive layer blends, which composite against
  // whatever is already in the buffer — see SLOT_RENDER_ORDER.
  return (
    <group ref={group} renderOrder={SLOT_RENDER_ORDER[entry.role]}>
      {children}
    </group>
  )
}

/**
 * Scene manager + transition manager.
 *
 * Switches commit musically: on the next downbeat when the beat grid is
 * trusted, immediately otherwise, with a safety timeout. Committing mounts
 * the incoming scene alongside the outgoing one and crossfades them over
 * roughly two beats (all scenes render additively, so overlapping fades
 * blend cleanly). Accent/overlay layers fade independently and carry their
 * own intensity/blend settings.
 */
export function SceneManager() {
  // Lazy initializer so the streamer's bookkeeping is seeded exactly once, in
  // the same breath as the entry it describes. Reset first: this component is
  // remounted (keyed on glEpoch) after a WebGL context loss, and candidates
  // describing the dead context must not survive that.
  const [initialEntries] = useState<Entry[]>(() => {
    const initialId = useStore.getState().sceneId
    sceneStreamer.reset()
    sceneStreamer.promote(initialId, 0, getResolvedManifest(initialId).priority)
    // Effect scenes are PINNED for the session: mounted once here, idle at
    // dir 0, so their shaders compile during startup rather than on the first
    // trigger. An effect that had to compile when fired would stall on exactly
    // the musical event it exists to punctuate. Empty until effect scenes are
    // authored, so this costs nothing today.
    return [
      makeEntry(initialId, 'primary', 1),
      ...getEffectScenes().map((s) => makeEntry(s.id, 'effect', 0)),
    ]
  })
  const entriesRef = useRef<Entry[]>(initialEntries)

  const [, force] = useState(0)
  const pendingSince = useRef(-1)
  /** Eased 0..1 transition discount — see the call to setTransitionDiscount. */
  const discount = useRef(0)

  useFrame(({ clock }) => {
    // Audio feature pipeline runs once per frame, before any scene reads it.
    audioEngine.update()
    const f = audioEngine.features
    sampleAnalytics(f)
    // Animation primitives are derived once, centrally, so N scenes reading
    // them cost the same as one (each scene used to recompute its own).
    updateAnimationSignals()

    // Advance warming entries through their lifecycle. warmFrames only ticks
    // once the lazy chunk has actually resolved, so the warm window is spent
    // rendering (compiling the shader) after mount rather than ticking away
    // while the chunk is still downloading — without that gate a slow load
    // closes the window before the shader compiles and the stall lands back on
    // the beat.
    for (const e of entriesRef.current) {
      if (e.dir !== 0 || !isSceneLoaded(e.id)) continue
      sceneStreamer.noteLoaded(e.id)
      e.warmFrames++
      if (isWarmComplete(e)) sceneStreamer.noteReady(e.id)
    }

    const state = useStore.getState()
    const { pendingSceneId, commitScene } = state
    if (pendingSceneId) {
      if (pendingSince.current < 0) pendingSince.current = clock.elapsedTime

      // Pre-warm: mount the incoming scene the moment it's requested so its
      // shader compiles now, well before the downbeat we actually switch on.
      // How many candidates may be resident at once is the streamer's call, not
      // this loop's — at MAX_PENDING = 1 it evicts whatever else was warming,
      // reproducing the old behaviour exactly.
      sceneStreamer.preload(
        pendingSceneId,
        clock.elapsedTime,
        getResolvedManifest(pendingSceneId).priority,
      )
      const evicted = sceneStreamer.retainPending(pendingSceneId)
      if (evicted.length > 0) {
        entriesRef.current = entriesRef.current.filter(
          (e) => !(e.dir === 0 && evicted.includes(e.id)),
        )
        force((n) => n + 1)
      }
      if (!entriesRef.current.some((e) => e.dir === 0 && e.id === pendingSceneId)) {
        entriesRef.current.push(makeEntry(pendingSceneId, 'primary', 0))
        force((n) => n + 1)
      }

      const waited = clock.elapsedTime - pendingSince.current
      const onDownbeat = f.beat && f.beatInBar === 0
      const gridTrusted = f.confidence > 0.25 && !f.silence

      // Drop-triggered switches do NOT wait for the next downbeat.
      //
      // Drop detection averages a 0.35 s window (see AudioEngine's energyLog),
      // so `f.drop` necessarily rises a beat or so AFTER the transient that
      // caused it — by which point the downbeat the drop landed on has already
      // passed. On a trusted grid that meant waiting almost a full bar (~2 s at
      // 120 BPM) and then easing over two more beats, so the visual change
      // finished ~3 s late. `f.drop` itself is only true for 0.6 s: the flag had
      // long expired before anything moved. That is the "drops don't switch"
      // report — the switch fires correctly, it just lands in the next section.
      //
      // Note the failing case is a TRUSTED grid, not an untrusted one: a
      // confidence dip makes `gridTrusted` false, which already commits on the
      // spot. The downbeat gate is what delays it.
      //
      // Still gated on the incoming scene being shader-warm (or a short grace),
      // because the one thing worse than a late cut is a compile stall exactly
      // on the drop — the very hitch the warm-up machinery exists to prevent.
      // In practice prewarm resolves in a few frames, so this lands ~50 ms in.
      const pendingWarm = entriesRef.current.find((e) => e.dir === 0 && e.id === pendingSceneId)
      const { commit, immediate } = resolveCommit({
        gridTrusted,
        onDownbeat,
        pendingImmediate: state.pendingImmediate,
        incomingWarm: pendingWarm ? isWarmComplete(pendingWarm) : null,
        waited,
      })

      if (commit) {
        commitScene()
        pendingSince.current = -1
        // A commit is the most expensive moment in the app: a shader compile
        // that prewarming did not manage to confirm, plus two primaries
        // rendering at once for the length of the crossfade. All of that is
        // real and the fps meter still reports it — but it is a scheduled,
        // once-per-scene event, not steady-state load, and letting the quality
        // governor treat it as evidence permanently downgraded the show every
        // time the music changed section. See frameSampler.ts.
        suspendFrameSampling(Math.ceil(crossfadeDuration(f.bpm) * 60) + 30)
        // Only replace the primary scene. Composition layers have their own
        // lifetime and must survive a primary crossfade unchanged. (Invariant:
        // at most one primary is fading in at a time.)
        const outgoing = entriesRef.current.find((e) => e.role === 'primary' && e.dir === 1)
        if (outgoing) {
          outgoing.dir = -1
          sceneStreamer.retire(outgoing.id, clock.elapsedTime)
        }
        // Promote the pre-warmed entry rather than mounting a cold one, so the
        // crossfade starts with an already-compiled shader (no hitch on the beat).
        const warm = pendingWarm
        let incoming: Entry
        if (warm) {
          warm.dir = 1
          incoming = warm
        } else {
          // Nothing warm to promote — the commit beat this scene's warm-up
          // (an untrusted grid commits on the spot). Mounting cold can stall;
          // this is the safety net, not the intended path.
          incoming = makeEntry(pendingSceneId, 'primary', 1)
          entriesRef.current.push(incoming)
        }
        sceneStreamer.promote(
          pendingSceneId,
          clock.elapsedTime,
          getResolvedManifest(pendingSceneId).priority,
        )
        // Smoothness guard: overlapping two heavy fullscreen scenes through a
        // crossfade is a major frame-time spike. When the quality governor only
        // permits one heavy layer and both scenes are heavy, hard-cut on the beat
        // instead — snap the outgoing out and the (shader-warm) incoming in. It's
        // cheaper and, per docs/09_Rendering_Engine.md, the more deliberate "Ikeda" look.
        // Can the frame actually carry the overlap?
        //
        // This used to require BOTH scenes to be `high` before it would even
        // consider cutting, and then asked only `incomingUnits * 2 <= budget`.
        // Two things were wrong with that. It ignored the composition layers,
        // which keep rendering right through a primary switch — so `network` +
        // `heap` (4 + 4 = 8 of 8 at tier 0) counted as affordable while
        // `ribbons` and an overlay were also live, i.e. 11 units of real load
        // against a budget of 8. And `bothHeavy` meant a high + medium pair
        // plus layers was never even tested.
        //
        // Now it is a straight sum of everything that will be on screen. The
        // fade does not make either scene cheaper — it is a multiply at the end
        // of the fragment shader, so a scene at 5% opacity costs full price —
        // which is why the honest test is the total, not an average.
        const tier = quality.tier
        const liveLayerMs = entriesRef.current.reduce((sum, e) => {
          if (e.role === 'primary' || e.role === 'effect' || e.dir === 0) return sum
          const meta = getScene(e.id).metadata
          return sum + slotCostMs(e.id, tier, e.role, meta.roleScalable, meta.performanceCost)
        }, 0)
        const fundsOverlap = canFundOverlap(
          quality.knobs.frameBudgetMs,
          outgoing ? slotCostMs(outgoing.id, tier, 'primary') : 0,
          slotCostMs(incoming.id, tier, 'primary'),
          // Layers AND the fixed per-frame costs. `frameBudgetMs` is total frame
          // capacity, so the overlap test has to account for everything the
          // frame carries or it would read the post chain's share as spare.
          liveLayerMs + frameLoad.fixed,
        )
        // A drop always cuts, whatever the two scenes cost. Crossfading a drop
        // over ~two beats is the second half of the "drops don't switch"
        // report: even once the timing above lands it on the transient, a
        // 1 s dissolve reads as the picture slowly changing its mind rather
        // than as an event.
        //
        // The BUDGET is no longer part of this condition, and separating the two
        // is the whole of the fix. They were `immediate || !fundsOverlap`, which
        // let a performance constraint produce an editorial result: on a loaded
        // machine every single change became a hard cut, so the crossfade never
        // ran at all. A drop cutting is a decision; an unaffordable overlap is a
        // cost problem, and the answer to a cost problem is to spend less, not
        // to change the edit. It now shortens the fade instead — see
        // `fadeDurationFor`.
        const hardCut = immediate
        let style = hardCut ? 'cut' : resolveTransitionStyle(performanceState.transitionStyle)
        // A rack style switches on an extra fullscreen pass for the length of the
        // fade. When the budget could not fund the overlap in the first place,
        // that is the worst possible moment to add one — and the fade has been
        // shortened to 0.2 s anyway, which is too brief for a smear or a melt to
        // read as anything but a flicker. Fall back to the mix-only dissolve:
        // the transition still happens, it just stops asking for something the
        // machine already said it could not afford.
        if (!hardCut && !fundsOverlap && usesRack(style as TransitionStyle)) {
          style = 'dissolve'
        }
        performanceState.transition.style = style as TransitionStyle
        // Committed once, here, so a fade cannot change speed while it runs.
        const fadeSec = hardCut
          ? 0
          : fadeDurationFor(crossfadeDuration(f.bpm), !fundsOverlap)
        performanceState.transition.durationSec = Math.max(1e-3, fadeSec)
        if (hardCut) {
          if (outgoing) outgoing.fade.value = 0
          incoming.fade.value = 1
        }
        beginTransition(
          {
            key: incoming.key,
            fromScene: outgoing?.id ?? null,
            toScene: pendingSceneId,
            onDownbeat,
            hardCut,
            // Already resolved just above, so the record cannot disagree with
            // what the fade actually did.
            style: performanceState.transition.style,
            waitedSec: waited,
            // 0 for a hard cut, because that IS its target — it is meant to
            // be instantaneous. Recording the crossfade duration here made the
            // analytics panel compare an actual ~0.0 s against a target of
            // ~0.9 s and flag every single hard cut as a failed transition
            // (`off = 1.0`), including perfectly healthy ones with a 17 ms p95.
            // The instrument was reporting a feature as a fault.
            // The duration actually committed to, not the musical ideal — a
            // budget-shortened fade is doing its job, and the analytics panel
            // flags a transition whose actual length misses its target, so
            // recording the ideal here would flag every constrained fade as a
            // failure. Same class of mistake as F39.
            targetDurationSec: fadeSec,
          },
          clock.elapsedTime,
        )
        force((n) => n + 1)
      }
    } else {
      pendingSince.current = -1
      // No pending switch — discard any orphaned warming entry.
      const dropped = sceneStreamer.clearPending()
      if (dropped.length > 0) {
        // Idle pinned effects also sit at dir === 0 and must survive this —
        // they are not orphaned warm candidates, they are waiting to fire.
        entriesRef.current = entriesRef.current.filter((e) => e.dir !== 0 || e.role === 'effect')
        force((n) => n + 1)
      }
    }

    // Persistent background/accent/overlay layers are composed independently
    // from the primary scene. A layer change gets a short fade, while the
    // primary scene continues to use beat-locked transitions above.
    // Capacity left for layers, measured from what is on screen RIGHT NOW —
    // the subject, any crossfade overlap, live effects, and the fixed costs.
    // Computed here rather than taken from `frameLoad` because that is
    // published below, after this pass decides what the layers are.
    // `trails` is written by the bridge at priority -95 and this runs at -100,
    // so the value read is one frame old. Acceptable for a reservation — the
    // pass cannot switch on and cost a full unit within a single frame of the
    // director deciding to use it — but worth knowing it is not instantaneous.
    const fixedMs =
      POST_CHAIN_MS +
      feedbackMsFor(performanceState.trails) +
      mirrorRackMs(performanceState.mirror) +
      lensRackMs(performanceState.lens)
    const budgetTier = quality.tier
    let nonLayerMs = fixedMs
    for (const e of entriesRef.current) {
      if (e.role === 'background' || e.role === 'accent' || e.role === 'overlay') continue
      if (e.dir === 0 && isWarmComplete(e)) continue // compiled and hidden; free
      const meta = getScene(e.id).metadata
      nonLayerMs += slotCostMs(
        e.id,
        budgetTier,
        e.role === 'primary' ? 'primary' : e.role,
        meta.roleScalable,
        meta.performanceCost,
      )
    }
    const wantedLayers = resolveLayerIds(
      state.layerSceneIds,
      state.sceneId,
      state.pendingSceneId,
      {
        remaining: Math.max(0, quality.knobs.frameBudgetMs - nonLayerMs),
        msFor: (id, role) => {
          const meta = getScene(id).metadata
          return slotCostMs(id, budgetTier, role, meta.roleScalable, meta.performanceCost)
        },
      },
    )
    for (const role of LAYER_ROLES) {
      const wanted = wantedLayers[role]
      const current = entriesRef.current.find((e) => e.role === role && e.dir === 1)
      if ((current?.id ?? null) === wanted) continue
      if (current) current.dir = -1
      if (wanted) {
        // Layers deliberately skip the streamer's lifecycle: they have their
        // own independent fade and never participate in the beat-locked primary
        // commit, so there is no warm slot to arbitrate over.
        entriesRef.current.push(makeEntry(wanted, role, 1))
        force((n) => n + 1)
      }
    }

    // Effects: pinned entries whose ACTIVE firing is owned by EffectDirector.
    // Nothing is mounted or unmounted here — pinning is the whole point, so a
    // trigger never pays a shader compile — only `dir` flips.
    if (syncEffectEntries(entriesRef.current, performanceState.layers.effects)) {
      force((n) => n + 1)
    }

    // Two primaries on screen at once — either a crossfade in progress
    // (`dir === -1` is the outgoing one) or a candidate warming beside the
    // current scene (`dir === 0`, kept visible so its shader compiles). Both
    // mean the frame is carrying twice the scene work it was tiered for, so the
    // governor drops complexity for the duration. See TRANSITION_DISCOUNT_TIERS.
    //
    // Set here, at priority -100, so the scenes that read `quality.knobs` at
    // priority 0 see it on the SAME frame the overlap begins rather than one
    // frame late. Effects are excluded by the role check — a pinned idle effect
    // also sits at `dir === 0` and is not a second subject.
    // Publish what this frame is actually carrying, so every other claimant on
    // the budget reserves against the whole picture instead of its own partial
    // view of it. See frameLoad.ts — this is the only component that knows
    // every mounted entry, which is why it is the one that reports.
    //
    // Two budgets come out of the same walk, over deliberately different subsets
    // of it. `applyFrameLoad` decides what else may be admitted to the frame, so
    // it counts everything DRAWING — the transient overlap included, since that
    // is precisely when nothing more should be admitted. `renderScale` decides
    // the resolution the frame is drawn at, so it counts only what is STAYING;
    // a change there costs a resize. See the setSceneBudget call below.
    committedBudgets.length = 0
    applyFrameLoad(
      entriesRef.current.map((e) => {
        const def = getScene(e.id)
        const meta = def.metadata
        // A warm entry that has finished compiling is hidden and costs nothing;
        // one still warming is genuinely drawing. Same distinction the
        // transition discount makes below.
        const drawing = e.dir !== 0 || !isWarmComplete(e)
        // COMMITTED tenancies only — see the setSceneBudget call below for why
        // this set is narrower than `drawing`.
        if (e.dir === 1 && e.role !== 'effect') committedBudgets.push(scenePixelBudget(def))
        return {
          role: e.role,
          dir: e.dir,
          drawing,
          ms: slotCostMs(
            e.id,
            budgetTier,
            e.role === 'primary' ? 'primary' : e.role,
            meta.roleScalable,
            meta.performanceCost,
          ),
        }
      }),
      // All four are fullscreen draws, so all four are linear in the frame's
      // pixel count and none of them may be reserved as a flat number — see
      // fillScale (F110). `renderScale.applied` is this frame's truth: PerfMonitor
      // writes it before `setDpr`, and this component runs at priority -100.
      (POST_CHAIN_MS +
        feedbackMsFor(performanceState.trails) +
        mirrorRackMs(performanceState.mirror) +
        lensRackMs(performanceState.lens)) *
        fillScale(renderScale.internalMP(renderScale.applied)),
    )
    // Everything on screen shares one framebuffer at one internal resolution, so
    // the budgets combine rather than compete — see combinePixelBudgets. Set at
    // priority -100, which is what lets PerfMonitor treat a budget change as this
    // frame's committed truth and resize immediately instead of holding it.
    //
    // Two exclusions, both for the same reason: a change here costs a renderer
    // resize and a reallocation of the post chain's mip pyramid, so the budget
    // must only follow things that are STAYING.
    //
    //  - The outgoing and warming primaries (`dir !== 1`) are left out, even
    //    though mid-crossfade the frame really is paying for both. Including
    //    them would resize the canvas twice per transition — once when the
    //    overlap begins and once when it is pruned — landing a multi-hundred-ms
    //    stall on each end of a musical transition, which is the exact hitch the
    //    warm-up machinery exists to prevent. This is the same call the tier
    //    discount already makes for the same reason (TRANSITION_DISCOUNT_TIERS
    //    in quality.ts): the overlap is paid for in complexity, which is free to
    //    change, never in resolution, which is not. The consequence is that one
    //    resize happens per scene switch rather than two, and it happens as the
    //    crossfade starts — where it is hidden, exactly as lilim hides it.
    //
    //  - Effects are left out because they are a lifecycle, not a tenancy: a
    //    firing lasts a couple of seconds, and resizing the canvas for it would
    //    cost more than the whole effect. Their per-frame cost is already gated,
    //    on the composition budget above, which is the right instrument for a
    //    transient.
    // The post chain is in every frame and is the most fill-bound thing in it,
    // so it claims against the same budget the scenes do — see
    // POST_CHAIN_PIXEL_BUDGET. Added here rather than inside
    // `combinePixelBudgets` because that stays a pure function of what it is
    // handed: `/bench` composes scene budgets with the post chain deliberately
    // absent, and baking a fixed cost into the primitive would silently change
    // what the benchmark measures.
    committedBudgets.push(POST_CHAIN_PIXEL_BUDGET)
    renderScale.setSceneBudget(combinePixelBudgets(committedBudgets))

    // Only while a second primary is ACTUALLY ON SCREEN.
    //
    // `dir === 0` alone was wrong: a warming candidate is kept visible only
    // until `isWarmComplete` (~5 frames), after which it renders nothing — but
    // a switch can now sit pending for a whole bar waiting for the warm gate
    // (see resolveCommit). Keying on `dir === 0` therefore held the discount
    // for seconds at a time with no second scene to justify it, so the show ran
    // two tiers coarser for much of its life and snapped back and forth. The
    // frame times looked fine because nothing was slow — it just looked worse.
    const overlapping = entriesRef.current.some(
      (e) => e.role === 'primary' && (e.dir === -1 || (e.dir === 0 && !isWarmComplete(e))),
    )
    // Eased rather than switched. A 2-tier step applied on one frame is a
    // visible pop at both ends of every transition — the discount is only
    // defensible if it is imperceptible, and an instant change to loop counts
    // is not. ~0.15 s time constant: quick enough to be helping by the time the
    // crossfade is doing real work, slow enough to read as nothing at all.
    // Exponential rather than `min(1, dt * rate)`: at rate 7 the clamped form
    // snapped for any frame under 7fps, so the ease that exists to keep a
    // 2-tier complexity drop imperceptible stopped easing precisely when the
    // frame rate made it most visible. See `approach()` in performanceState.ts.
    discount.current = approach(discount.current, overlapping ? 1 : 0, DISCOUNT_EASE_RATE, f.delta)
    quality.setTransitionDiscount(discount.current)

    // Two clocks, deliberately. The PRIMARY pair runs at the duration committed
    // for this transition, which the frame budget may have shortened; layers and
    // effects keep the musical ~two beats, because a constrained subject swap is
    // no reason for a background to arrive faster than the music.
    const layerDuration = crossfadeDuration(f.bpm)
    const primaryDuration = Math.max(1e-3, performanceState.transition.durationSec)
    let prune = false
    for (const e of entriesRef.current) {
      if (e.dir === 0) continue // warming (or an idle pinned effect): stays at zero
      const duration = e.role === 'primary' ? primaryDuration : layerDuration
      e.fade.value += (f.delta / duration) * e.dir
      if (e.fade.value >= 1) e.fade.value = 1
      if (e.fade.value <= 0 && e.dir === -1) prune = true
    }

    // Publish the transition BEFORE deriving visibilities from it.
    //
    // The incoming primary's raw clock is the one source of truth for how far
    // through a change we are — the outgoing entry runs its own countdown, and
    // deriving each side from its own clock is what makes a styled transition
    // impossible (the two halves would be independent curves that need not sum
    // to anything). One `t`, one style, both sides derived from it.
    const incomingPrimary = entriesRef.current.find((e) => e.role === 'primary' && e.dir === 1)
    const outgoingPrimary = entriesRef.current.find((e) => e.role === 'primary' && e.dir === -1)
    const tx = performanceState.transition
    tx.progress = incomingPrimary ? Math.max(0, Math.min(1, incomingPrimary.fade.value)) : 1
    tx.active = outgoingPrimary !== undefined && tx.progress < 1
    const mix = transitionMix(tx.style, tx.progress)

    for (const e of entriesRef.current) {
      if (e.dir === 0) continue
      const gain =
        e.role === 'primary'
          ? 1
          : e.role === 'effect'
            ? EFFECT_GAIN
            : state.layerFx[e.role].intensity
      e.out.gain = gain
      // EASED on the way out, linear on the way in.
      //
      // `fade.value` stays a plain linear 0..1 clock because the lifecycle reads
      // it — prune at <= 0, complete at >= 1, and `sampleTransitionFrame`
      // measures against it. Easing it in place would make "how far through the
      // fade am I" and "how visible am I" the same number, and they are not.
      //
      // What scenes and the compositor see is the eased value. A linear alpha
      // ramp changes at the same rate at its start, middle and end, which is
      // what reads as mechanical — smoothstep gives it ease-in and ease-out and
      // costs two multiplies.
      //
      // Safe for the additive majority (17 of 18 scenes) for a specific reason:
      // smoothstep is symmetric, `S(1-t) === 1 - S(t)`, so an outgoing scene at
      // `S(1-t)` and an incoming at `S(t)` still sum to exactly 1 at every point
      // of the fade. The total light is unchanged; only its distribution across
      // the two pictures is eased. An equal-power curve, which is right for
      // audio and for opaque blends, would overshoot here.
      // The two primaries follow the transition's curve pair; everything else
      // (layers, effects) keeps its own independent eased fade, because a layer
      // arriving is not part of the scene change and should not inherit its
      // character — a `dipToBlack` between subjects must not also blink the
      // background layer that is staying put.
      e.out.value =
        e.role === 'primary' && tx.active
          ? (e.dir === 1 ? mix.in : mix.out) * gain
          : smoothstep(Math.max(0, e.fade.value)) * gain
      e.out.progress = e.effect
        ? Math.min(1, Math.max(0, (f.time - e.effect.startedAt) / e.effect.durationSec))
        : 0
      if (e.role === 'primary' && e.dir === 1) {
        sampleTransitionFrame(e.key, perf.ms, e.fade.value, clock.elapsedTime)
      }
    }
    if (prune) {
      // A retired EFFECT is never unmounted — it returns to its idle pinned
      // state so the next firing costs no compile. That is the entire reason
      // effects are pinned, so it has to be excluded from the prune below
      // rather than relying on it never matching.
      for (const e of entriesRef.current) {
        if (e.role === 'effect' && e.dir === -1 && e.fade.value <= 0) {
          e.dir = 0
          e.effect = null
        }
      }
      const dead = (e: Entry) => e.role !== 'effect' && e.dir === -1 && e.fade.value <= 0
      const gone = entriesRef.current.filter(dead)
      if (gone.length > 0) {
        entriesRef.current = entriesRef.current.filter((e) => !dead(e))
        // Fully faded out and unmounted — the streamer can forget it. Only for
        // primaries: layers were never registered with it.
        for (const e of gone) {
          if (e.role === 'primary') sceneStreamer.release(e.id)
        }
        force((n) => n + 1)
      }
    }
  }, -100)

  return (
    <>
      {entriesRef.current.map((e) => {
        const Scene = getScene(e.id).component
        return (
          <SceneFade.Provider key={e.key} value={e.out}>
            <EntryGroup entry={e}>
              <Suspense fallback={null}>
                {e.role === 'primary' ? (
                  <Scene />
                ) : (
                  <BlendedLayer role={e.role}>
                    <Scene />
                  </BlendedLayer>
                )}
              </Suspense>
            </EntryGroup>
          </SceneFade.Provider>
        )
      })}
    </>
  )
}

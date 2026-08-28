import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { animationSignals } from './AnimationDirector'
import { getScene } from '../scenes'
import { cutCamera, pickCameraMode } from './CameraDirector'
import { getEffectiveParams } from './moodParams'
import { approach, performanceState } from './performanceState'
import { advanceSteer, clearSteer } from './sceneSteer'
import { pickTransitionStyle, SECTION_DIP_WINDOW_SEC } from './transitions'
import {
  lensAmountTarget,
  lensForSection,
  MIRROR_OFF,
  mirrorForSection,
  trailsTarget,
  type MirrorTarget,
} from './opticalDirector'
import { quality } from './quality'
import { useStore } from '../store'

/**
 * Scenes the mirror rack and trails sit out entirely (F131, explicit
 * request). All three are already kaleidoscopic or heavily patterned by
 * their own geometry — `kifs` is a mandala, `maze` a nested fractal grid,
 * `wingfold` a folded Julia set — so a standing mirror-segment fold or a
 * history-persistence trail on top of them doubles up on the same gesture
 * rather than adding one, and reads as noise over the fractal's own detail.
 */
const MIRROR_TRAILS_EXCLUDED_SCENES = new Set(['kifs', 'maze', 'wingfold'])

/**
 * Resting bloom per mood — the creative decision the old formula's hardcoded
 * 0.65 was standing in for. Quiet moods sit darker so the music has somewhere
 * to go; hype moods start hot and stay there between hits.
 *
 * Scaled to 0.75x of the original table (0.4/0.5/0.55/0.65/0.75/0.95/0.9) to
 * bring the picture down. This is the FLOOR only: `reactive` and `voiceLift`
 * are added on top untouched, so hits keep their punch and it is the resting
 * level that darkens — which is what "too bright" actually meant.
 *
 * Deliberately separate from the audio-side sensitivity work in
 * bandNormalizer.ts. That dims what the scenes DRAW; this dims how hard the
 * post chain blooms whatever they drew. Bloom feeds nothing upstream, so
 * changing it needs no threshold re-derivation — it is the cheapest brightness
 * lever in the app and the right one to reach for first.
 */
/**
 * Resting bloom threshold — the value the pass was hardcoded to before this was
 * directed. Kept as the base so a calm passage looks exactly as it always did.
 */
const BLOOM_THRESHOLD_BASE = 0.18
/** Resting vignette darkness — likewise the pass's former hardcoded value. */
const VIGNETTE_BASE = 0.85

const BLOOM_BASE: Record<MoodState, number> = {
  silence: 0.3,
  ambient: 0.38,
  mellow: 0.41,
  groove: 0.49,
  building: 0.56,
  peak: 0.71,
  aggressive: 0.68,
}

/**
 * Populates {@link performanceState} once per frame.
 *
 * This is the Phase-1 adapter: it derives the performance state from where
 * those decisions currently live (the Zustand store, the mood engine, the
 * quality governor) so downstream executors can be migrated to read
 * `performanceState` one at a time, with zero behaviour change at each step.
 *
 * The end state (Phase 6) inverts this: the creative directors write
 * `performanceState` directly and the store becomes just the human-override
 * surface feeding into it. When that happens this file shrinks to nothing —
 * which is the point. Everything downstream is already reading the right
 * object by then, so the inversion touches no executor.
 *
 * Runs at −95: after SceneManager's audio tick (−100), before the creative
 * directors (−90 … −85) and well before any executor.
 */
export function PerformanceStateBridge() {
  /** Visible scene the current camera mode was chosen for. */
  const lastCameraScene = useRef('')
  /** Previous frame's beat state, so `rackAudio.onKick` can be an edge. */
  const wasOnKick = useRef(false)
  /** Mood the transition style was last chosen for — see the pick below. */
  const lastStyleMood = useRef('')
  /** Deterministic cycle position, on its own counter. */
  const styleRotation = useRef(0)
  /** Sections seen this session. Seeds the rack choices so a set is
   *  deterministic and a recording reproduces — not `Math.random()`. */
  const sectionCount = useRef(0)
  /** Whether THIS section took a lens at all — see lensForSection. */
  const lensEngaged = useRef(false)
  /** The mirror look this section committed to; eased toward every frame. */
  const mirrorTarget = useRef<MirrorTarget>(MIRROR_OFF)
  /** Phrases seen. Separate from the section counter so the two rotate apart. */
  const mirrorSeed = useRef(0)
  /** When the last section boundary fired, for the dip window. */
  const lastSectionAt = useRef(-Infinity)
  /** Previous window state, so the style is re-picked when it closes too. */
  const wasNearSection = useRef(false)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const params = getEffectiveParams()
    const p = performanceState
    const m = f.mood

    // --- What is on screen (currently owned by the store) ---
    p.scene = s.pendingSceneId ?? s.sceneId
    p.activeScene = s.sceneId
    // Effects are NOT mirrored from the store — EffectDirector owns that list
    // outright, so it must survive this write untouched.
    p.layers.background = s.layerSceneIds.background
    p.layers.accent = s.layerSceneIds.accent
    p.layers.overlay = s.layerSceneIds.overlay
    p.palette = s.paletteId
    p.mood = m.state

    // --- Behaviour ---
    p.animationIntensity = params.intensity
    p.particleDensity = quality.knobs.particleFraction

    // Dramatic pressure, not loudness: a build with rising energy is tense even
    // while quiet, and a drop is the release. Consumed by the camera pick below,
    // by AnimationDirector's explode/dissolve primitives, and by glitch.
    const buildTension = m.isBuilding ? 0.35 + Math.max(0, m.energyVel) * 0.4 : 0
    const predictionTension =
      m.predictedState === 'peak' && m.beatsTillTransition >= 0
        ? Math.max(0, 1 - m.beatsTillTransition / 16) * 0.5
        : 0
    p.visualTension = Math.min(1, Math.max(buildTension, predictionTension) + (f.drop ? 0.5 : 0))

    // The director's hand on the scene dials. Runs here rather than in
    // PerformanceDirector because that one only fires on section boundaries —
    // it composes, it does not perform — and a steer that moved only at
    // boundaries would be a step change, which is the thing sceneSteer.ts eases
    // to avoid. Placed after `visualTension` because it reads it.
    //
    // Gated on `moodDrive`, the same switch that gates the mood multipliers in
    // getEffectiveParams: turning off mood-driven automation has to mean the
    // show stops steering itself, not that it freezes wherever the steer was.
    if (s.moodDrive) {
      advanceSteer(p.sceneParams, {
        mood: m.state,
        tension: p.visualTension,
        delta: f.delta,
        drop: f.drop,
      })
    } else if (p.sceneParams.speed !== undefined) {
      clearSteer(p.sceneParams)
    }

    // Slow half of the two-timescale voice pair. Eased rather than stepped:
    // `vocalPresence` only refreshes every ~12s, so a raw copy would visibly
    // jump. Neutral at 0 when the classifier has produced nothing, which makes
    // every downstream voice term vanish instead of misfiring.
    p.voiceFocus = approach(p.voiceFocus, f.moodsValid ? f.vocalPresence : 0, 0.5, f.delta)

    // --- Camera ---
    // Which mode to shoot in is a DECISION, re-taken at section boundaries and
    // whenever the visible scene changes (a new scene may not declare the mode
    // that was running). Deliberately NOT re-evaluated every frame: a mode that
    // flickers reads as noise, and CameraDirector eases toward its target, so
    // the target has to hold still long enough to converge on.
    //
    // This runs regardless of AutoPilot. Framing is not one of the choices the
    // user is overriding when they pick a scene by hand, so it should keep
    // being directed either way.
    const active = getScene(p.activeScene)
    if (f.sectionChange || active.id !== lastCameraScene.current) {
      lastCameraScene.current = active.id
      p.cameraMode = pickCameraMode(
        active.metadata.cameraModes,
        m.state,
        p.visualTension,
        f.beatIndex,
        p.voiceFocus,
      )
      // A section boundary is the one moment a hard angle jump reads as
      // deliberate rather than as a glitch — this is the VJ cut.
      if (f.sectionChange) cutCamera()
    }

    // --- Post / effects ---
    // Phase 4: these are DECISIONS, not a transcription of the audio. The base
    // level is chosen per mood, and the music modulates around it — so a
    // breakdown reads calm even if its transients are sharp, and a peak reads
    // hot even between hits. EffectsDirector just applies the result.
    const pulse = beatPulse(f) * params.reactivity
    const reactive = (f.bass * 0.7 + pulse * 0.7 + (f.drop ? 0.8 : 0)) * params.reactivity
    // The vocal lift: fast tonality-gated voice band for the MOTION, slow
    // voiceFocus for the PERMISSION. Computed here rather than in
    // EffectsDirector because that stays a pure executor that reads no audio —
    // the creative decision belongs on this side of the seam.
    const fastVoice = Math.max(0, Math.min(1, f.vocal * (1 - Math.min(1, f.spectralFlatness))))
    const voiceLift = fastVoice * p.voiceFocus * 0.45 * params.reactivity
    p.bloom = (BLOOM_BASE[m.state] + reactive + voiceLift) * params.intensity

    // Threshold FALLS as pressure rises, so more of the frame becomes eligible
    // to bloom — the image opens up rather than merely getting brighter. Floored
    // well above zero: at 0 everything blooms and the picture turns to soup.
    p.bloomThreshold = Math.max(
      0.05,
      BLOOM_THRESHOLD_BASE - p.visualTension * 0.06 - (f.drop ? 0.07 : 0) - pulse * 0.02,
    )

    // Aberration direction tracks the accumulating mid-driven shear, so the
    // break has a heading that drifts with the harmony instead of sitting on a
    // fixed diagonal. Free — the offset vector was already being written.
    p.caAngle = animationSignals.twist * Math.PI

    // The frame tightens through a build and releases on the drop.
    p.vignette = approach(
      p.vignette,
      Math.min(1, VIGNETTE_BASE + p.visualTension * 0.16 - (f.drop ? 0.2 : 0)),
      1.5,
      f.delta,
    )

    // Glitch is punctuation, so it is gated on tension and drops rather than
    // running continuously. Low quality zeroes it — the pass stays in the chain
    // (removing it would rebuild the composer's shader), it just does nothing.
    // The `aggressive` head adds a small sustained floor: harshness that the
    // band envelopes miss (distorted but steady material reads calm to flux).
    p.glitch =
      s.quality === 'low'
        ? 0
        : 0.0006 +
          pulse * 0.0035 +
          p.visualTension * 0.002 +
          (f.drop ? 0.004 : 0) +
          (f.moodsValid ? f.moods.aggressive * 0.0015 : 0)

    // Fog deepens as the music thins out — an empty mix gets air around the
    // subject, a dense one stays close and flat. The `relaxed` head adds air
    // to material that is calm without being quiet: a dense but unhurried mix
    // has high level (so `sparse` is low) yet still wants space around it.
    const sparse = 1 - Math.min(1, m.level * 1.3)
    const relaxedAir = f.moodsValid ? f.moods.relaxed * 0.2 : 0
    p.fog = approach(
      p.fog,
      Math.min(1, sparse * 0.6 + (m.state === 'ambient' ? 0.25 : 0) + relaxedAir),
      0.6,
      f.delta,
    )

    // Audio the optical racks consume. Published here rather than read by
    // EffectsDirector, which is a pure executor and reads no audio — see the
    // `rackAudio` doc on PerformanceState.
    //
    // `onKick` is the rising edge: `beatPulse` is a decaying envelope, so
    // thresholding it near its peak turns it back into the event the lens
    // materials actually want. Without the edge, a material that "re-seats on
    // the kick" re-seats on every frame of the decay and reads as a flicker.
    const ra = p.rackAudio
    ra.kick = Math.min(1, pulse)
    ra.highs = f.high
    ra.mids = f.mid
    ra.onKick = pulse > 0.6 && !wasOnKick.current ? Math.min(1, pulse) : 0
    wasOnKick.current = pulse > 0.6

    // Style for the NEXT scene change. Chosen here rather than in SceneManager
    // because it is a creative decision and this is the decide band; SceneManager
    // is an executor that reads it at commit.
    //
    // Re-picked only when the musical situation actually changes — a new mood,
    // or a section boundary — rather than every frame. Re-rolling continuously
    // would make the style whatever the rotation happened to land on at the
    // instant of commit, which is indistinguishable from random and impossible
    // to reason about when watching a set.
    if (f.sectionChange) lastSectionAt.current = f.time
    // A section boundary is an instant; the scene change that should punctuate it
    // commits on the next downbeat, up to a bar later. So the override is a
    // WINDOW rather than an edge — and a bounded one, because latching it
    // indefinitely made five consecutive changes all run `dipToBlack` from a
    // single boundary long past.
    const nearSection = f.time - lastSectionAt.current < SECTION_DIP_WINDOW_SEC
    if (m.state !== lastStyleMood.current || nearSection !== wasNearSection.current) {
      lastStyleMood.current = m.state
      wasNearSection.current = nearSection
      p.transitionStyle = pickTransitionStyle(
        m.state,
        nearSection,
        styleRotation.current++,
        p.transitionStyle,
      )
    }

    // --- The optical racks and the feedback pass --------------------------
    //
    // All three shipped as executors with nothing driving them (F52, F56): the
    // engine could do a great deal that no viewer ever saw, because the only
    // thing that moved any of it was a debug panel.
    //
    // Two different kinds of decision here, and they are deliberately handled
    // differently. `trails` and the lens AMOUNT are magnitudes, so they are
    // eased every frame. The mirror segment count and the lens MATERIAL are
    // choices — 4 segments and 6 segments have nothing meaningful between them,
    // and a material is the look of the frame rather than an amount of it — so
    // they are re-taken only at a section boundary and then held.
    const rackSuppressed = MIRROR_TRAILS_EXCLUDED_SCENES.has(p.activeScene)
    p.trails = approach(p.trails, rackSuppressed ? 0 : trailsTarget(m.state, f.flux, m.level), 0.7, f.delta)
    p.lens.amount = approach(
      p.lens.amount,
      lensAmountTarget(m.state, p.visualTension, lensEngaged.current),
      0.5,
      f.delta,
    )
    // The mirror re-decides on every PHRASE, the lens only on a SECTION.
    //
    // Not a symmetry worth having: they are different kinds of thing. The
    // mirror is a punctuating transform — it folds the frame and then it stops
    // — and section boundaries arrive four to six times in a two-minute track,
    // so tying it to them meant the rack was live in about one sample in eight
    // no matter how far its eligibility was widened. The limiter was never the
    // rule, it was how often anything asked.
    //
    // The lens is a surface treatment and stays on sections, because a material
    // IS the look of the frame and swapping it every sixteen beats reads as a
    // glitch rather than as a choice.
    const phraseEdge = f.beat && f.beatInBar === 0 && f.beatIndex > 0 && f.beatIndex % 16 === 0
    if (f.sectionChange || phraseEdge) {
      // The whole rack, not just the segment count. `tiles`, `twist` and
      // `slice` were previously written by nothing but the debug panel, so
      // three of the mirror's five controls were dead in a running show.
      const mt = mirrorForSection(m.state, p.visualTension, mirrorSeed.current++)
      mirrorTarget.current = mt
    }
    if (f.sectionChange) {
      const seed = sectionCount.current++
      const style = lensForSection(m.state, seed)
      lensEngaged.current = style >= 0
      // Keep the previous material while a disengaged lens eases out. Swapping
      // it on the way down would show a material the section never chose.
      if (style >= 0) p.lens.style = style
    }
    // The continuous half of the rack eases toward the section's target, while
    // `segments` and `tiles` snap at the boundary — those two are counts, and
    // 5.5 segments is not a look halfway between 4 and 8, it is neither.
    //
    // All five re-read `rackSuppressed` every frame rather than only at the
    // boundary, so the excluded scenes (F131) drop the rack the instant they
    // come on screen — mid-section, if that is when the scene change lands —
    // rather than waiting out whatever the previous scene's section chose.
    const mt = mirrorTarget.current
    p.mirror.segments = rackSuppressed ? 0 : mt.segments
    p.mirror.tiles = rackSuppressed ? 0 : mt.tiles
    p.mirror.twist = approach(p.mirror.twist, rackSuppressed ? 0 : mt.twist, 0.9, f.delta)
    p.mirror.slice = approach(p.mirror.slice, rackSuppressed ? 0 : mt.slice, 0.9, f.delta)
    // Spin scales with level on top of the section's base, so a kaleidoscope
    // breathes with the music rather than turning at a constant rate.
    p.mirror.spin = rackSuppressed ? 0 : mt.spin > 0 ? mt.spin * (0.6 + m.level * 0.7) : 0

    // --- Debug override ---------------------------------------------------
    // TEMPORARY: lets a human drag a value in the debug panel and see it,
    // ahead of any director having an opinion about when to move it. This is
    // exactly the shape the file header describes as the eventual end state
    // for THIS WHOLE FUNCTION — "the store becomes just the human-override
    // surface feeding into performanceState" — just arriving early, and scoped
    // to post-fx, for one feature at a time. Runs last, in the same decide-band
    // component, so it always wins over whatever this frame just computed
    // above rather than racing it.
    if (s.debugPostFx.enabled) {
      const dbg = s.debugPostFx
      p.bloom = dbg.bloom
      p.bloomThreshold = dbg.bloomThreshold
      p.glitch = dbg.glitch
      p.vignette = dbg.vignette
      p.fog = dbg.fog
      p.trails = dbg.trails
      p.mirror.segments = dbg.mirrorSegments
      p.mirror.tiles = dbg.mirrorTiles
      p.mirror.twist = dbg.mirrorTwist
      p.mirror.slice = dbg.mirrorSlice
      p.mirror.spin = dbg.mirrorSpin
      p.lens.amount = dbg.lensAmount
      p.lens.style = dbg.lensStyle
      // The style for the NEXT change. SceneManager captures it at commit, so
      // moving this mid-fade cannot alter a transition already in flight.
      p.transitionStyle = dbg.transitionStyle
    }

    // --- Retired mirror modes (F108) --------------------------------------
    // Tiling and slicing are off, and this is where they are switched off
    // rather than at the pass, because three separate things write them and
    // two of them are outside this file: the section director above, the debug
    // override just now, and — the one that actually needs a gate — the
    // PERSISTED store. `debugPostFx` goes through zustand's `persist`, and
    // store.ts is explicit that "a persisted value always beats a changed
    // default", so anyone who ever dragged the tiles slider has a non-zero
    // value in localStorage that removing the slider would strand rather than
    // clear. Zeroing here also keeps `isMirrorActive` and `mirrorRackMs`
    // honest: they read this same state, so a retired mode cannot leave the
    // pass enabled or keep charging the frame budget for a fullscreen draw
    // that now renders an identity transform.
    p.mirror.tiles = 0
    p.mirror.slice = 0
  }, -95)

  return null
}

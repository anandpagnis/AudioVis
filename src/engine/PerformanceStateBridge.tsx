import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine, beatPulse } from '../audio/AudioEngine'
import { lookOf } from '../audio/characterLook'
import type { CharacterMood } from '../audio/characterTypes'
import type { MoodState } from '../audio/types'
import { animationSignals } from './AnimationDirector'
import { getScene } from '../scenes'
import { CAMERA_MODE_SHOT, cutCamera, pickCameraMode, type CameraShotTag } from './CameraDirector'
import { computeValenceArousal } from './valenceArousal'
import { advanceBandClocks } from './bandClocks'
import { exposure, GAIN_MIN } from './exposure'
import { bloomThreshold } from './bloomParams'
import { getEffectiveParams } from './moodParams'
import { approach, performanceState } from './performanceState'
import { advanceSteer, clearSteer } from './sceneSteer'
import { pickTransitionStyle, SECTION_DIP_WINDOW_SEC, type TransitionBoundaryType } from './transitions'
import { createHabituation, stepHabituation, type Habituation } from './habituation'
import { resolveEchoTapSpacingSec } from './echoParams'
import {
  echoTarget,
  lensAmountTarget,
  lensForSection,
  MIRROR_OFF,
  mirrorForSection,
  shouldRepickMirror,
  trailsTarget,
  visualTensionFloor,
  type MirrorTarget,
} from './opticalDirector'
import {
  bloomFromProfile,
  createLookRuntime,
  echoFromProfile,
  fillLookInput,
  fogFromProfile,
  glitchFromProfile,
  lensAmountFromProfile,
  lensFromProfile,
  mirrorFromProfile,
  mirrorMixFromProfile,
  postLookActive,
  scaleMirrorSpin,
  stepLensSwap,
  trailsFromProfile,
  vignetteFromProfile,
  type LensSwapState,
  type LookRuntime,
} from './look/lookPost'
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
 * Scenes where the mirror rack alone must never engage — independent of
 * {@link MIRROR_TRAILS_EXCLUDED_SCENES} above, which also drops trails.
 *
 * `djcam` is a hard cut to a live camera feed of the DJ: nothing composites
 * over that feed already (see the `cutawayUp` layer-tenancy block below, and
 * `DjCamScene`'s own "opaque, nothing composites over a camera feed" header)
 * — a kaleidoscopic fold across someone's face is the same rule, just
 * violated by a post-fx pass instead of a scene layer. Trails are
 * deliberately untouched on `djcam`: nothing asked for that, and a fading
 * light-trail reads nothing like a mirror fold on a photographic subject, so
 * this is its own set rather than adding `djcam` to the one above.
 */
const MIRROR_ONLY_EXCLUDED_SCENES = new Set(['djcam'])

/**
 * Phrases (16-beat windows) a mirror look may hold before it is force-refreshed
 * even if nothing about the music moved. F134 — reported as the rack "ending
 * abruptly and too soon": the phrase-edge re-decision below re-rolled on every
 * 16 beats unconditionally, so a fold that had just committed could be
 * overwritten (often by MIRROR_OFF) one phrase later regardless of whether the
 * section, mood or tension had actually changed — a fixed beat-count timer, not
 * a musical event. 3 phrases (~24s at 125 BPM) is a backstop for a mood/tension
 * pair that never budges, not the normal exit; see the re-decision guard below.
 */
const MIRROR_MAX_PHRASES = 3

/**
 * Phrases (16-beat windows) a lens material may hold with NO decision
 * opportunity at all before one is forced (F237).
 *
 * ## The gap this closes
 *
 * Unlike the mirror rack, which re-decides on every phrase edge regardless
 * of section boundaries (see the comment above the phrase-edge block below —
 * "the lens is a surface treatment and stays on sections"), `lensForSection`
 * had exactly ONE trigger: `f.sectionChange`, a phrase-novelty detector
 * (`PhraseDetector.ts`) that only fires when the spectral profile crosses a
 * real change threshold. A musically consistent passage — a steady groove, a
 * sustained pad, anything without a strong novelty spike — can leave
 * `sectionChange` silent far longer than a normal section actually lasts,
 * and with no other trigger at all, the lens has no way to notice. User
 * report: the same material (fly eye) holding for "more than a min
 * continuously." That is not a section holding unusually long — it is zero
 * re-decision opportunities firing at all.
 *
 * The fix mirrors `MIRROR_MAX_PHRASES`'s own shape but is deliberately a
 * much longer leash: the lens is meant to hold for a whole section, and a
 * ceiling tuned to mirror's cadence (3 phrases, ~24s) would turn "stays on
 * sections" into "changes every 24 seconds regardless," replacing one
 * defect with the opposite one. 8 phrases is roughly a minute at a typical
 * 120 BPM (16 beats/phrase x 8 phrases / 2 beats/sec) — long enough that a
 * real section boundary almost always arrives first, short enough that the
 * reported "stuck for over a minute" symptom cannot recur even in a passage
 * with no novelty spike at all.
 *
 * Reuses `lensForSection`'s existing anti-repeat (`avoidStyle`, F229)
 * unchanged: a stale-triggered re-roll goes through the exact same engage
 * gate and pool exclusion a section-change-triggered one does, so if it
 * re-engages it is guaranteed a DIFFERENT material, and if it does not
 * engage the lens fades out instead of continuing to hold the same look —
 * either outcome ends the "stuck" symptom.
 */
const LENS_MAX_PHRASES = 8

/**
 * Phrases an ENGAGED mirror pick must hold before a `tensionMoved`-only
 * signal is allowed to re-decide it downward — see `shouldRepickMirror`'s doc
 * for why `tensionMoved` specifically needs this and `sectionChange`/`stale`/
 * `moodMoved` do not.
 *
 * Raised 1 -> 2 (this session, user report: "trigger a bit too less, and when
 * they do trigger they dont stay active at all"). At 1, the pick survived only
 * the very next phrase edge unconditionally and became eligible for a
 * tension-triggered take-down from the phrase edge AFTER that — i.e. as little
 * as one held phrase (~7-8s) before tension alone could end it, which reads as
 * "barely stayed on" rather than as a held choice. At 2, that becomes ~15s
 * minimum, well short of the `MIRROR_MAX_PHRASES` backstop above.
 * `sectionChange`/`moodMoved`/`stale` are unaffected — they still bypass this
 * guard unconditionally, exactly as before; only a tension-alone take-down is
 * held back longer.
 */
const MIRROR_MIN_HOLD_PHRASES = 2

/**
 * Consecutive phrase-edges the rack must sit at OFF before `nothingToInterrupt`
 * alone may re-engage it (F229 — see `shouldRepickMirror`'s header). Before
 * this existed, off -> on was completely unconditional: the very phrase after
 * the rack turned off it was already eligible to fire again, which combined
 * with a base rate that never fell below a real floor to make the whole rack
 * read as "always on" rather than as an effect that arrives.
 *
 * Lowered 2 -> 1 (this session, user report: "mirrors trigger a bit too
 * less" — the opposite complaint from the one that set this to 2 in F229).
 * That history: F131 raised the base rate for the same complaint, a session
 * recording afterward still measured only 18% duty, then F229 lowered the
 * base rate again AND added this rest-period guard for the opposite
 * complaint ("trigger a bit too much"). Rather than re-litigate F229's base
 * rate a second time in the same direction, this pass loosens the OTHER lever
 * that also gates re-engagement — the two combined were plausibly making
 * re-engagement doubly rare. 1 phrase is roughly 7-15s at typical tempos:
 * still a real rest (a re-decision opportunity has to actually pass), just
 * not a second one stacked on top of the base-rate roll below.
 */
const MIRROR_MIN_OFF_PHRASES = 1

/**
 * `approach()` rate for `p.mirror.mix` — the fold's VISIBILITY, as distinct
 * from `segments`/`tiles` (counts, still snapped) and `twist`/`slice`
 * (already-eased magnitudes at rate 0.9, ~1.1s time constant). `approach()`
 * is `1 - exp(-delta * rate)`, so the time constant is `1 / rate`: 1/0.45 ≈
 * 2.2s, in the middle of a natural ~2-3s fade in and out. Slower than
 * `twist`/`slice` deliberately — those are a physical quantity (radians of
 * swirl) easing itself back to nothing, `mix` is the whole effect's presence
 * fading, which reads better held a bit longer.
 */
const MIRROR_MIX_RATE = 0.45

/**
 * Minimum `f.songSection.sectionConfidence` (see `SectionTracker.ts`; ranges
 * roughly 0.45-0.9 once `structureValid`, lower while stale) before a
 * drop/breakdown read is trusted enough to force the dramatic `dipToBlack`/
 * `smear` transition style. Below it, a section-boundary transition falls
 * through to the normal/default style instead of a forced dramatic one on a
 * noisy read. 0.5 sits above the ~0.45 a session's first-ever section read
 * gets (still uncertain — nothing has been confirmed by a repeat yet) and
 * comfortably below what a track accrues after even one prior boundary
 * (~0.6), so it filters early/stale reads without touching an established one.
 */
const SECTION_BOUNDARY_MIN_CONFIDENCE = 0.5

/**
 * Arousal above which the camera earns an EXTRA re-pick every phrase, on top
 * of the section/scene boundaries it always gets (audit c5 — "bind camera cut
 * rate to arousal, not to mood name").
 *
 * 0.7 is deliberately high: `computeValenceArousal`'s own blend puts most of
 * its weight on `energy` and `loudness`, both already 0..1 and already fairly
 * generous, so a genuinely energised passage (loud, fast, tense) clears this
 * comfortably while an ordinary `groove` section does not — the extra cuts are
 * for a peak or a build, not for every mood that happens to have a beat.
 */
const AROUSAL_CUT_THRESHOLD = 0.7

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
// Bloom threshold policy — including why it is relative to exposure.gain
// rather than a bare constant — lives in bloomParams.ts (audit c10), which
// this file calls into below.
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
  /** Shot tag of the camera mode currently on screen — see pickCameraMode's
   *  avoidShot param and the arousal-bound re-pick below. */
  const lastCameraShot = useRef<CameraShotTag | null>(null)
  /** Beat index the camera was last (re-)picked on, so the arousal-driven
   *  phrase re-pick below fires once per phrase rather than once per frame. */
  const lastCameraBeat = useRef(-1)
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
  /** Phrases seen since the lens last got a decision opportunity, capped by
   *  LENS_MAX_PHRASES below (F237). */
  const lensPhrasesHeld = useRef(0)
  /** The mirror look this section committed to; eased toward every frame. */
  const mirrorTarget = useRef<MirrorTarget>(MIRROR_OFF)
  /** Phrases seen. Separate from the section counter so the two rotate apart. */
  const mirrorSeed = useRef(0)
  /** Mood at the mirror's last pick, so a re-roll can tell "the music moved" apart from "16 beats passed." */
  const mirrorMoodAtPick = useRef<MoodState | null>(null)
  /** Coarse tension bucket at the last pick — same purpose, for the continuous half of the read. */
  const mirrorTensionAtPick = useRef(-1)
  /** Phrases held on the current pick, capped by MIRROR_MAX_PHRASES below. */
  const mirrorPhrasesHeld = useRef(0)
  /** Consecutive phrase-edges the rack has sat at OFF — the rest-period
   *  counter `shouldRepickMirror`'s `offPhrasesHeld` reads (F229). Incremented
   *  whenever the current pick is off, reset the moment a repick re-engages. */
  const mirrorOffPhrases = useRef(0)
  /** Recent-engagement memory for the mirror and lens gates (audit c1),
   *  replacing the bare `seed % n` roll each used to make with no notion of
   *  how recently it last fired — see habituation.ts. */
  const mirrorHabituation = useRef<Habituation>(createHabituation())
  const lensHabituation = useRef<Habituation>(createHabituation())
  /** When the last section boundary fired, for the dip window. */
  const lastSectionAt = useRef(-Infinity)
  /** Previous window state, so the style is re-picked when it closes too. */
  const wasNearSection = useRef(false)
  /** Boundary type captured at the last section-change edge, held for the
   *  same dip window as `lastSectionAt` — see the pickTransitionStyle call. */
  const lastBoundaryType = useRef<TransitionBoundaryType>('generic')
  /** The mood look's runtime: the profile tracker, its reusable input, and the URL flags, read ONCE (look/lookPost.ts). */
  const lookRt = useRef<LookRuntime | null>(null)
  /** The lens as RENDERED while the profile drives post-fx: material + amount, with the dip-and-swap (stepLensSwap). */
  const lensShown = useRef<LensSwapState>({ style: 0, amount: 0 })
  /** The material the director last CHOSE (the rendered one follows it through the dip). */
  const lensDesired = useRef(0)
  /** Whether the previous frame ran the profile-driven post path, to re-seed the two refs above when it (re)starts. */
  const wasPostOn = useRef(false)
  /** The profile's primary mood at the mirror's last pick: its `moodMoved` signal while the profile is valid. */
  const mirrorPrimaryAtPick = useRef<CharacterMood | null>(null)
  /** The profile's primary mood the transition style was last chosen for. */
  const lastStylePrimary = useRef<CharacterMood | null>(null)

  useFrame(() => {
    const f = audioEngine.features
    const s = useStore.getState()
    const params = getEffectiveParams()
    const p = performanceState
    const m = f.mood
    // Effect systems below read the character-aware look; timing triggers and telemetry use m.state.
    const look = lookOf(m)
    // The mood look profile: computed ONCE per frame, before anything below reads it, in place (no allocation).
    // Every family reads `L` only when `L.valid && L.families.<family>` and otherwise runs its original code.
    const rt = (lookRt.current ??= createLookRuntime())
    rt.tracker.update(fillLookInput(rt.input, f, look), p.look)
    const L = p.look
    // Post-fx (bloom, CA, vignette, fog, trails, echo, lens, mirror): profile-driven, except in silence (see postLookActive).
    const postOn = postLookActive(L, look)

    // --- What is on screen (currently owned by the store) ---
    p.scene = s.pendingSceneId ?? s.sceneId
    p.activeScene = s.sceneId
    // Effects are NOT mirrored from the store — EffectDirector owns that list
    // outright, so it must survive this write untouched.
    //
    // While either directed cutaway (DJ Cam or Limitless) is up, no scene
    // layer composites over it: the tenancy desires are held null here
    // (PerformanceDirector is suppressed too, so nothing re-adds one) and
    // restored the frame the cutaway releases. `DjCamDirector` (-87) and
    // `LimitlessDirector` (-86.5) both run at this point, after this bridge
    // (-95), so the store desires still show for the single hard-cut-in frame
    // — invisible against the cut.
    const cutawayUp = p.djCam.active || p.limitless.active
    p.layers.background = cutawayUp ? null : s.layerSceneIds.background
    p.layers.accent = cutawayUp ? null : s.layerSceneIds.accent
    p.layers.overlay = cutawayUp ? null : s.layerSceneIds.overlay
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
    // Real song structure, when we have it: a confirmed build-up ramps tension
    // toward ~1 and holds it there until the drop lands (which collapses
    // `buildProgress` to 0 — the `+ (f.drop ? 0.5 : 0)` term below is the
    // release spike). `Math.max` with 0 keeps this additive-neutral when the
    // structure read is absent.
    const structureTension =
      f.structureValid && f.songSection.isBuild ? 0.45 + f.songSection.buildProgress * 0.5 : 0
    // A small floor tied to overall mood intensity, not gated on build/predict/
    // structure like the three terms above — see visualTensionFloor's doc.
    // Without it a session that never reaches `building` mood sits at
    // visualTension ~0 for its entire runtime and the mirror/lens eligibility
    // gates (opticalDirector.ts) essentially never open outside `hot` moods.
    const baselineTension = visualTensionFloor(m.level)
    p.visualTension = Math.min(
      1,
      Math.max(buildTension, predictionTension, structureTension, baselineTension) +
        (f.drop ? 0.5 : 0),
    )

    // Continuous valence/arousal, published once here for every downstream
    // director to read (see the field's own doc on PerformanceState). Placed
    // after visualTension because arousal folds it in.
    const va = computeValenceArousal(f, p.visualTension)
    p.valence = va.valence
    p.arousal = va.arousal

    // Per-band clocks (audit c14) — advanced exactly once per frame, here,
    // for the same reason valence/arousal is computed here rather than by
    // each reader: a primary, a crossfade partner and multiple composition
    // layers can be mounted at once, all sharing the same audio, and a clock
    // advanced per-scene-instance would restart on every mount and drift out
    // of sync between simultaneously-drawn scenes. See bandClocks.ts.
    advanceBandClocks(f, f.delta)

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
        mood: look,
        tension: p.visualTension,
        delta: f.delta,
        drop: f.drop,
        // The profile's continuous steer targets, only while the scene family is on and the read is valid.
        look: L.valid && L.families.scene ? L : undefined,
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
    // Cut rate bound to AROUSAL, not to mood name (audit c5): above the
    // threshold, an energised passage also earns a re-pick once per phrase
    // (16 beats) even with no section boundary — a highly energised passage
    // should be shot with more cuts than a calm one holding the same mood for
    // a whole section. Bounded to phrase cadence, the same idiom
    // PerformanceDirector already uses for its own structure-absent fallback,
    // so this never fires faster than the existing beat-grid vocabulary
    // already allows elsewhere in the show.
    const phraseBoundary = f.beat && f.beatInBar === 0 && f.beatIndex > 0 && f.beatIndex % 16 === 0
    const arousalDue =
      p.arousal > AROUSAL_CUT_THRESHOLD && phraseBoundary && f.beatIndex !== lastCameraBeat.current
    const sceneChanged = active.id !== lastCameraScene.current
    if (f.sectionChange || sceneChanged || arousalDue) {
      lastCameraScene.current = active.id
      lastCameraBeat.current = f.beatIndex
      p.cameraMode = pickCameraMode(
        active.metadata.cameraModes,
        look,
        p.visualTension,
        f.beatIndex,
        p.voiceFocus,
        // Anti-repetition (audit c5): avoid picking the same SHOT — not just
        // the same mode — as whatever is already on screen. Skipped on the
        // very first pick (`lastCameraShot.current` is null) and whenever the
        // scene itself just changed, since a new subject earns a clean read
        // of the mood's own top preference rather than being steered away
        // from it by the previous scene's unrelated framing.
        sceneChanged ? null : lastCameraShot.current,
        // Danceability narrows how often the rotation window re-samples —
        // see pickCameraMode's own doc for why this and AROUSAL_CUT_THRESHOLD
        // above are deliberately two separate knobs on either side of the
        // same "when does a re-pick happen" question.
        f.danceability,
        // The mood profile's camera weights, only while the camera family is on and the read is valid.
        L.valid && L.families.camera ? L : undefined,
      )
      lastCameraShot.current = CAMERA_MODE_SHOT[p.cameraMode]
      // A section boundary is the one moment a hard angle jump reads as
      // deliberate rather than as a glitch — this is the VJ cut. An
      // arousal-driven phrase re-pick is not a structural boundary, so it
      // eases into its new framing the way an ordinary mode change already
      // does, rather than snapping.
      if (f.sectionChange) cutCamera()
    }

    // --- Post / effects ---
    // Phase 4: these are DECISIONS, not a transcription of the audio. The base
    // level is chosen per mood, and the music modulates around it — so a
    // breakdown reads calm even if its transients are sharp, and a peak reads
    // hot even between hits. PostFXChain just applies the result.
    const pulse = beatPulse(f) * params.reactivity
    const reactive = (f.bass * 0.7 + pulse * 0.7 + (f.drop ? 0.8 : 0)) * params.reactivity
    // The vocal lift: fast tonality-gated voice band for the MOTION, slow
    // voiceFocus for the PERMISSION. Computed here rather than in
    // PostFXChain because that stays a pure executor that reads no audio —
    // the creative decision belongs on this side of the seam.
    const fastVoice = Math.max(0, Math.min(1, f.vocal * (1 - Math.min(1, f.spectralFlatness))))
    const voiceLift = fastVoice * p.voiceFocus * 0.45 * params.reactivity
    // Resting level from the mood profile (`postOn`), else the original 7-state table. The reactive and vocal
    // terms are the same either way; the profile's `bloomReact` scales the reactive sum.
    p.bloom = postOn
      ? bloomFromProfile(L, reactive, voiceLift, params.intensity)
      : (BLOOM_BASE[look] + reactive + voiceLift) * params.intensity

    // Threshold FALLS as pressure rises, so more of the frame becomes eligible
    // to bloom — the image opens up rather than merely getting brighter — on
    // top of a resting level that tracks the exposure servo's live gain
    // (audit c10, see bloomParams.ts), one frame stale: the same "late is
    // free here" tolerance the servo's own async readback already relies on.
    p.bloomThreshold = bloomThreshold({
      gain: exposure.gain,
      sampled: exposure.sampled,
      gainFloor: GAIN_MIN,
      tension: p.visualTension,
      drop: f.drop,
      pulse,
    })

    // Aberration direction tracks the accumulating mid-driven shear, so the
    // break has a heading that drifts with the harmony instead of sitting on a
    // fixed diagonal. Free — the offset vector was already being written.
    p.caAngle = animationSignals.twist * Math.PI

    // The frame tightens through a build and releases on the drop.
    p.vignette = approach(
      p.vignette,
      postOn
        ? vignetteFromProfile(L, p.visualTension, f.drop)
        : Math.min(1, VIGNETTE_BASE + p.visualTension * 0.16 - (f.drop ? 0.2 : 0)),
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
        : postOn
          ? glitchFromProfile(L, pulse, p.visualTension, f.drop, f.moodsValid ? f.moods.aggressive : 0)
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
      postOn
        ? fogFromProfile(L, sparse, relaxedAir)
        : Math.min(1, sparse * 0.6 + (look === 'ambient' ? 0.25 : 0) + relaxedAir),
      0.6,
      f.delta,
    )

    // Audio the optical racks consume. Published here rather than read by
    // PostFXChain, which is a pure executor and reads no audio — see the
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
    // The plain beat edge, no amplitude gate — see `rackAudio`'s own doc for
    // why `onKick` above isn't enough for every re-seat mechanism (`pixel
    // sort`'s `seedBeat`, this session).
    ra.beat = f.beat

    // Style for the NEXT scene change. Chosen here rather than in SceneManager
    // because it is a creative decision and this is the decide band; SceneManager
    // is an executor that reads it at commit.
    //
    // Re-picked only when the musical situation actually changes — a new mood,
    // or a section boundary — rather than every frame. Re-rolling continuously
    // would make the style whatever the rotation happened to land on at the
    // instant of commit, which is indistinguishable from random and impossible
    // to reason about when watching a set.
    if (f.sectionChange) {
      lastSectionAt.current = f.time
      // Classified once, at the edge, and held for the window below — the
      // structure read at THIS frame is what just committed, so `isDrop` /
      // `isBreakdown` here mean "we just entered a drop/breakdown", not
      // "we are generally in one". No structure read at all degrades to the
      // original behaviour: every section change forces dipToBlack.
      //
      // Also gated on `sectionConfidence`: a low-confidence read (the very
      // first section of a set, or a stale analyzer — see SectionTracker.ts)
      // forcing the dramatic dipToBlack/smear style on what might not
      // actually be a drop/breakdown reads as a noise-driven jarring cut, not
      // a musical one. Below the threshold this falls through to 'generic' —
      // the same "no strong signal" path an absent structure read already
      // takes — rather than forcing the dramatic style on a guess.
      lastBoundaryType.current =
        !f.structureValid || f.songSection.sectionConfidence < SECTION_BOUNDARY_MIN_CONFIDENCE
          ? 'generic'
          : f.songSection.isDrop
            ? 'drop'
            : f.songSection.isBreakdown
              ? 'breakdown'
              : 'generic'
    }
    // A section boundary is an instant; the scene change that should punctuate it
    // commits on the next downbeat, up to a bar later. So the override is a
    // WINDOW rather than an edge — and a bounded one, because latching it
    // indefinitely made five consecutive changes all run `dipToBlack` from a
    // single boundary long past.
    const nearSection = f.time - lastSectionAt.current < SECTION_DIP_WINDOW_SEC
    // The mood profile's transition weights, only while the post family is on and the read is valid. A change
    // of its primary mood is a musical change of the same kind a change of the 7-state look is, so it re-picks too.
    const txLook = L.valid && L.families.post ? L : undefined
    const stylePrimary = txLook ? txLook.primary : null
    if (
      look !== lastStyleMood.current ||
      nearSection !== wasNearSection.current ||
      stylePrimary !== lastStylePrimary.current
    ) {
      lastStyleMood.current = look
      wasNearSection.current = nearSection
      lastStylePrimary.current = stylePrimary
      p.transitionStyle = pickTransitionStyle(
        look,
        nearSection,
        styleRotation.current++,
        p.transitionStyle,
        nearSection ? lastBoundaryType.current : null,
        txLook,
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
    // Mirror alone sits out one MORE set than trails does — see
    // MIRROR_ONLY_EXCLUDED_SCENES's own doc for why `djcam` belongs here and
    // not in `MIRROR_TRAILS_EXCLUDED_SCENES` itself.
    const mirrorSuppressed = rackSuppressed || MIRROR_ONLY_EXCLUDED_SCENES.has(p.activeScene)
    p.trails = approach(
      p.trails,
      rackSuppressed ? 0 : postOn ? trailsFromProfile(L, f.flux, m.level) : trailsTarget(look, f.flux, m.level),
      0.7,
      f.delta,
    )
    // NOT eased with approach() (F232) — `pulse` (computed above for bloom's
    // reactive term) is already `beatPulse()`'s own sharply-peaked,
    // per-beat-decaying curve, so it IS the envelope. Easing on top of a
    // curve that already snaps to zero and back every beat would blur the
    // one thing that makes it read as a repeat rather than a wash — the
    // exact defect the F232 rewrite exists to fix; see `echoTarget`'s own
    // doc in opticalDirector.ts for the full diagnosis. Not gated on
    // `rackSuppressed`: that set exists because the three excluded scenes
    // (kifs/maze/wingfold) are already kaleidoscopic geometry a MIRROR fold
    // or a persistent TRAIL would double up on, which has nothing to do with
    // three discrete repeats of whatever those scenes already draw.
    p.echo = postOn ? echoFromProfile(L, pulse) : echoTarget(look, pulse)
    // Beat-locked, not scaled by `p.echo`'s own value (F232) — see
    // `resolveEchoTapSpacingSec`'s doc for why a wall-clock ramp was the
    // wrong instrument. Resolved every frame (cheap: one division, no
    // allocation) rather than only on a tempo change, since `f.bpm` itself
    // can still be settling early in a set.
    p.echoTapSpacingSec = resolveEchoTapSpacingSec(f.bpm)
    // `p.lens.style` passed through so `lensAmountTarget` can apply the
    // `pixels`-specific coarseness floor (see that function's doc) — it keeps
    // its last value even while disengaged, same as the style-pick comment
    // below notes, so this is "the material currently shown," not stale.
    if (postOn) {
      // Profile path: the rendered lens lives in `lensShown` (not in `p.lens`, which the debug override below
      // rewrites), and a change of material DIPS the amount to ~0, swaps, and eases back (stepLensSwap), so a
      // visible lens never hard-swaps. Re-seeded from `p.lens` whenever this path (re)starts.
      if (!wasPostOn.current) {
        lensShown.current.style = p.lens.style
        lensShown.current.amount = p.lens.amount
        lensDesired.current = p.lens.style
      }
      stepLensSwap(
        lensShown.current,
        lensDesired.current,
        lensAmountFromProfile(L, p.visualTension, lensEngaged.current, lensDesired.current),
        lensEngaged.current,
        f.delta,
      )
      p.lens.amount = lensShown.current.amount
      p.lens.style = lensShown.current.style
    } else {
      p.lens.amount = approach(
        p.lens.amount,
        lensAmountTarget(look, p.visualTension, lensEngaged.current, p.lens.style),
        0.5,
        f.delta,
      )
    }
    wasPostOn.current = postOn
    // The mirror re-decides on every PHRASE; the lens holds for a SECTION and
    // only reaches for a phrase-level check as a staleness backstop (F237),
    // not as its normal cadence.
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
    // glitch rather than as a choice. `LENS_MAX_PHRASES` below exists only to
    // guarantee it EVENTUALLY gets a decision opportunity even when the music
    // never trips `f.sectionChange` — see that constant's own doc.
    const phraseEdge = f.beat && f.beatInBar === 0 && f.beatIndex > 0 && f.beatIndex % 16 === 0
    if (f.sectionChange || phraseEdge) {
      // F134: the phrase edge is a chance to re-roll, not a mandate to. A
      // section boundary always commits — it is the one unambiguous "the music
      // changed" signal. Off to on always commits too — there's no live look to
      // cut short. Otherwise a currently-engaged rack holds through the phrase
      // edge unless the mood changed, the tension moved a real step (not just
      // beat-to-beat jitter — bucketed to a fifth), or it has already run the
      // backstop's worth of phrases with neither moving. That is what makes
      // "ends on a proper change in mood or energy" true instead of aspirational.
      //
      // A `tensionMoved` trigger specifically is also held back for at least
      // `MIRROR_MIN_HOLD_PHRASES` phrases while a pick is engaged — see
      // shouldRepickMirror's doc. Without it, a drop's brief tension spike
      // (0.6s) decays well before the NEXT phrase edge, so `tensionMoved`
      // fires there too and tears the engagement the drop just caused right
      // back down one phrase later.
      const tensionBucket = Math.round(p.visualTension * 5)
      // With a valid profile the "mood" that moved is its (hysteresis-held) primary of the 14, not the 7-state look.
      const moodMoved = postOn ? L.primary !== mirrorPrimaryAtPick.current : look !== mirrorMoodAtPick.current
      const tensionMoved = tensionBucket !== mirrorTensionAtPick.current
      mirrorPhrasesHeld.current++
      const nothingToInterrupt = mirrorTarget.current.mode === 'off'
      // F229: counts consecutive phrase-edges spent at off, independent of
      // `mirrorPhrasesHeld` above (which tracks phrases since the last
      // re-decision REGARDLESS of what it landed on). Reset the instant a
      // repick re-engages, below.
      if (nothingToInterrupt) mirrorOffPhrases.current++
      const stale = mirrorPhrasesHeld.current >= MIRROR_MAX_PHRASES
      const repick = shouldRepickMirror({
        sectionChange: f.sectionChange,
        nothingToInterrupt,
        moodMoved,
        tensionMoved,
        stale,
        currentlyEngaged: !nothingToInterrupt,
        phrasesHeld: mirrorPhrasesHeld.current,
        minHoldPhrases: MIRROR_MIN_HOLD_PHRASES,
        offPhrasesHeld: mirrorOffPhrases.current,
        minOffPhrases: MIRROR_MIN_OFF_PHRASES,
      })
      if (repick) {
        // The whole rack, not just the segment count. `tiles`, `twist` and
        // `slice` were previously written by nothing but the debug panel, so
        // three of the mirror's five controls were dead in a running show.
        // Profile path: engage through the same habituated gate at the blended `mirrorEngage`, then sample
        // mode / segments from the profile's weights (lookPost.mirrorFromProfile). Same hold / dwell / rest
        // logic above either way; the scene exclusions below are unchanged.
        const mt = postOn
          ? mirrorFromProfile(L, p.visualTension, mirrorSeed.current++, mirrorHabituation.current)
          : mirrorForSection(look, p.visualTension, mirrorSeed.current++, mirrorHabituation.current)
        mirrorTarget.current = mt
        mirrorMoodAtPick.current = look
        mirrorPrimaryAtPick.current = postOn ? L.primary : null
        mirrorTensionAtPick.current = tensionBucket
        mirrorPhrasesHeld.current = 0
        if (mt.mode !== 'off') mirrorOffPhrases.current = 0
        mirrorHabituation.current = stepHabituation(mirrorHabituation.current, mt.mode !== 'off')
      }
    }
    // F237: counts phrases since the lens last got ANY decision opportunity,
    // independent of whether that opportunity changed anything — see
    // LENS_MAX_PHRASES's own doc for why this exists (sectionChange alone
    // could leave the lens with zero opportunities for well over a minute
    // during a musically consistent passage).
    if (phraseEdge) lensPhrasesHeld.current++
    if (f.sectionChange || (phraseEdge && lensPhrasesHeld.current >= LENS_MAX_PHRASES)) {
      const seed = sectionCount.current++
      // F229: exclude the currently-held material so a re-engagement cannot
      // repeat the exact same look as last time — `p.lens.style` keeps its
      // last value even while disengaged (see the comment below), so this is
      // "the last material shown," not just "the last material picked."
      // Profile path: engage through `habituatedGate` at `lensEngage`, sample the material from `lensWeights`
      // (never flyEye, never the one last chosen), the same anti-repeat with the chosen rather than the shown one.
      const style = postOn
        ? lensFromProfile(L, seed, lensHabituation.current, lensDesired.current)
        : lensForSection(look, seed, lensHabituation.current, p.lens.style)
      lensEngaged.current = style >= 0
      lensHabituation.current = stepHabituation(lensHabituation.current, style >= 0)
      // Keep the previous material while a disengaged lens eases out. Swapping
      // it on the way down would show a material the section never chose.
      // Profile path: only the director's CHOICE changes here; the rendered material follows it through the
      // dip-and-swap above, never mid-amount.
      if (style >= 0) {
        if (postOn) lensDesired.current = style
        else p.lens.style = style
      }
      lensPhrasesHeld.current = 0
    }
    // The continuous half of the rack eases toward the section's target, while
    // `segments` and `tiles` snap at the boundary — those two are counts, and
    // 5.5 segments is not a look halfway between 4 and 8, it is neither.
    //
    // All five re-read `mirrorSuppressed` every frame rather than only at the
    // boundary, so an excluded scene (F131's three, or `djcam`) drops the rack
    // the instant it comes on screen — mid-section, if that is when the scene
    // change lands — rather than waiting out whatever the previous scene's
    // section chose.
    const mt = mirrorTarget.current
    const mirrorVisible = !mirrorSuppressed && mt.mode !== 'off'
    // `segments`/`tiles` still snap rather than ease — that part of the old
    // comment was right, a fractional segment count means nothing. What was
    // wrong is snapping them to ZERO the instant a re-decision picks
    // MIRROR_OFF: that made the fold vanish in the exact frame the decision
    // changed, with nothing eased at all. Now they only snap to a NEW shape
    // when there is one (`mt.mode !== 'off'`); when a re-decision goes to
    // off, they hold their last engaged value and `mix` below alone fades the
    // fold out — once `mix` reaches 0 the blend is the untouched frame
    // regardless of what `segments` is still sitting at underneath, so
    // nothing downstream needs to know it was never actually reset.
    // `mirrorSuppressed` stays instant for both, unchanged from before:
    // F131's whole point is that an excluded scene drops the rack
    // immediately, not over a multi-second fade that would double up on the
    // scene's own kaleidoscopic geometry for a couple of seconds — and
    // `djcam` wants the same instant drop for the opposite reason (a fold
    // starting mid-fade-out over a hard-cut camera feed is worse, not
    // better).
    if (mirrorSuppressed) {
      p.mirror.segments = 0
      p.mirror.tiles = 0
    } else if (mt.mode !== 'off') {
      p.mirror.segments = mt.segments
      p.mirror.tiles = mt.tiles
    }
    p.mirror.twist = approach(p.mirror.twist, mirrorSuppressed ? 0 : mt.twist, 0.9, f.delta)
    p.mirror.slice = approach(p.mirror.slice, mirrorSuppressed ? 0 : mt.slice, 0.9, f.delta)
    // Spin scales with level on top of the section's base, so a kaleidoscope
    // breathes with the music rather than turning at a constant rate. Already
    // snaps to 0 the instant MIRROR_OFF is picked (spin: 0 there), which is
    // fine and not part of this fade: a frozen-orientation fold fading out
    // via `mix` below reads better than one still visibly spinning while it
    // dissolves, and even if it kept turning, `mix` approaching 0 hides
    // whatever it would contribute — see MirrorPass's `mix(original,
    // mirrored, uMix)`.
    // Profile path: the same breathing scale, but the result never exceeds 0.7 (scaleMirrorSpin).
    p.mirror.spin = mirrorSuppressed
      ? 0
      : mt.spin > 0
        ? postOn
          ? scaleMirrorSpin(mt.spin, m.level)
          : mt.spin * (0.6 + m.level * 0.7)
        : 0
    // The fold's VISIBILITY, eased independently of the counts/magnitudes
    // above — see MIRROR_MIX_RATE's doc for the ~2.2s time constant this
    // gives a rise and a fall. `mirrorSuppressed` is instant here too, for
    // the same reason as `segments`/`tiles`.
    // Profile path: the fold fades up to the profile's `mirrorMix` ceiling rather than always to 1.
    p.mirror.mix = mirrorSuppressed
      ? 0
      : approach(
          p.mirror.mix ?? 0,
          mirrorVisible ? (postOn ? mirrorMixFromProfile(L) : 1) : 0,
          MIRROR_MIX_RATE,
          f.delta,
        )

    // --- Debug override ---------------------------------------------------
    // TEMPORARY: lets a human take manual control of ONE post-fx field at a
    // time in the debug panel and see it immediately, ahead of any director
    // having an opinion about when to move it. This is exactly the shape the
    // file header describes as the eventual end state for THIS WHOLE
    // FUNCTION — "the store becomes just the human-override surface feeding
    // into performanceState" — just arriving early, and scoped to post-fx,
    // for one feature at a time. Runs last, in the same decide-band
    // component, so an overridden field always wins over whatever this frame
    // just computed above rather than racing it.
    //
    // PER-FIELD, not one master flag: a single `debugPostFx.enabled` used to
    // gate all fourteen fields at once, which was wrong in both directions —
    // dragging one slider froze the other thirteen where the director's own
    // values could otherwise still reach the screen, and a stale
    // `enabled: true` reviving from an older install's `localStorage` (see
    // `debugPostFxOverrides`'s own doc on `AppState`, and ISSUES.md's F108)
    // froze the WHOLE panel with no visible switch in the current UI to turn
    // back off — which is exactly what a "not live" report looks like from
    // outside. `debugPostFxOverrides` is never persisted, so it starts empty
    // — everything auto — on every load, and each field below checks only
    // its own flag.
    const ov = s.debugPostFxOverrides
    const dbg = s.debugPostFx
    if (ov.bloom) p.bloom = dbg.bloom
    if (ov.bloomThreshold) p.bloomThreshold = dbg.bloomThreshold
    if (ov.glitch) p.glitch = dbg.glitch
    if (ov.vignette) p.vignette = dbg.vignette
    if (ov.fog) p.fog = dbg.fog
    if (ov.trails) p.trails = dbg.trails
    if (ov.echo) p.echo = dbg.echo
    if (ov.mirrorSegments) p.mirror.segments = dbg.mirrorSegments
    if (ov.mirrorTiles) p.mirror.tiles = dbg.mirrorTiles
    if (ov.mirrorTwist) p.mirror.twist = dbg.mirrorTwist
    if (ov.mirrorSlice) p.mirror.slice = dbg.mirrorSlice
    if (ov.mirrorSpin) p.mirror.spin = dbg.mirrorSpin
    // A human dragging ANY mirror slider should see it immediately — not
    // wait out whatever the autonomous fade above happened to leave `mix`
    // at. Checked across all five mirror fields rather than one flag, so
    // taking manual control of just `mirrorSpin`, say, still surfaces it.
    if (ov.mirrorSegments || ov.mirrorTiles || ov.mirrorTwist || ov.mirrorSlice || ov.mirrorSpin) {
      p.mirror.mix = 1
    }
    if (ov.lensAmount) p.lens.amount = dbg.lensAmount
    if (ov.lensStyle) p.lens.style = dbg.lensStyle
    // The style for the NEXT change. SceneManager captures it at commit, so
    // moving this mid-fade cannot alter a transition already in flight.
    if (ov.transitionStyle) p.transitionStyle = dbg.transitionStyle

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

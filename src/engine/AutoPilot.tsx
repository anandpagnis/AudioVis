import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import {
  MOOD_CHANGE_MAX_AMBIGUITY,
  MOOD_CHANGE_MIN_CONFIDENCE,
  MOOD_PREDICT_MIN_CONFIDENCE,
} from './autoPilotGates'
import { cueState } from './CueTimeline'
import { keyPaletteTracker } from './keyPalette'
import { PALETTES } from './palettes'
import { getPrimaryScenesForMood, pickVariedMode, pickVariedScene } from '../scenes'
import { performanceState } from './performanceState'
import { useStore } from '../store'

/** Palette families per mood — switched only when the current one doesn't fit. */
/**
 * Palettes each mood may draw from, in preference order.
 *
 * ## Every palette in the file is reachable from here (F125)
 *
 * It was not. `palettes.ts` defines **30** palettes across five families, and
 * this table named **six** of them — the `signature` set — so 24 of them, 80%
 * of the work in that file, could never be selected by the running show at all.
 * They were reachable only by a human clicking one, which on an auto-piloted
 * set means never.
 *
 * That is also why F117 could only do so little. Widening `peak` and
 * `aggressive` away from their shared warm pair was a real fix, but it was
 * redistributing six palettes when thirty existed.
 *
 * **The test is the actual fix.** `paletteCoverage.test.ts` asserts that every
 * entry in `PALETTES` appears in at least one mood pool, so palette 31 cannot
 * be added and quietly stranded the way these 24 were. A table like this drifts
 * from the file it indexes unless something checks.
 *
 * ## How they are assigned
 *
 * By temperature and energy, which is what a mood actually names. Cold and
 * neutral palettes sit in `ambient`; the muted earths in `mellow` and
 * `building`; the multi-hue `rainbow` family only in `peak`, `groove` and
 * `aggressive`, since a palette spanning distant hues reads as busy and would
 * fight a quiet passage.
 *
 * Order still carries intent — the first entry is what the mood wants most, and
 * the `signature` palettes deliberately keep those seats because they are the
 * show's identity. The rest widen it rather than replace it.
 */
export const MOOD_PALETTES: Record<MoodState, string[]> = {
  silence: [],
  // Quiet, cold, spacious. The neutrals and the single-hue colds live here.
  ambient: ['ocean', 'glacial', 'aurora', 'nocturne', 'pearl', 'moss', 'sage', 'mono'],
  // Soft and mid — cool bodies with one warm note, plus the muted earths.
  mellow: ['aurora', 'violet', 'nocturne', 'orchid', 'reef', 'glacial', 'umber', 'sage', 'ocean'],
  // Mid energy and properly coloured: two lit hues that are not neighbours.
  groove: ['aurora', 'violet', 'cobalt', 'reef', 'vapor', 'orchid', 'tropic', 'candy', 'solar'],
  // Rising warmth. Everything here moves toward amber/rust as the phrase lifts.
  building: ['solar', 'sodium', 'mirage', 'cobalt', 'oxide', 'canyon', 'adobe', 'velvet', 'ember'],
  // Maximum saturation. The rainbows earn their place here and nowhere quieter.
  peak: ['ember', 'neon', 'vapor', 'velvet', 'auroraBold', 'prism', 'carnival', 'violet', 'solar'],
  // Hard: either very hot or starkly graphic. `mono` is here for the same
  // reason `acid` is — at full tilt, no colour at all reads as aggressive.
  aggressive: ['ember', 'acid', 'neon', 'emberGlass', 'oxide', 'mirage', 'carnival', 'mono'],
}

const MANUAL_HOLD_SEC = 45 // back off after the DJ touches anything

// A committed mood change only drives a scene/palette switch once the read is
// solid: confident enough, and not a near-tie with the runner-up state.
// Borderline changes stay pending and fire on a later frame once they clear.
// The two thresholds live in ./autoPilotGates so the session recorder can grade
// a recording against the same numbers the live gate uses.

/**
 * Worst-case gap, in seconds, before AutoPilot looks for a scene change even
 * without one of its three edge triggers firing (F135).
 *
 * All three triggers below are edges: a drop, a predicted transition going
 * imminent, or `m.changed` — MoodEstimator's one-frame flag for the committed
 * state actually flipping. None of them fire for "the music is audibly
 * building but hasn't crossed a mood category line yet," and none fire for "a
 * buildup is happening inside the first section," because a section boundary
 * is itself an edge that hasn't happened yet either. Reported as "doesn't seem
 * to change scenes for like 15-20 secs despite the changes in the song like
 * buildup and such" — the same shape of complaint F118 fixed once already,
 * but that fix was a threshold on the CHANGE edge; this is the case where no
 * edge is available to threshold in the first place.
 *
 * 25s is deliberately above the 15-20s that read as broken: on a track where
 * the edges fire normally this never trips at all, so it is a backstop for
 * the stuck case, not a substitute for musically-timed switching. It only
 * asks for a look — every downstream guard (`MIN_SUBJECT_DWELL_BEATS`, the
 * `pendingSceneId` single-flight lock) still applies, the same as any other
 * trigger here.
 */
const STALE_TARGET_SEC = 25

/**
 * Floor between automatic palette changes.
 *
 * PhraseDetector's own cooldown is 8 beats — 4s at 120 BPM — which is a fine
 * rate for structural bookkeeping but would strobe as colour. A verse or
 * chorus runs 15-30s, so this lets every real section recolour while refusing
 * to chase a run of closely-spaced boundary detections.
 */
const PALETTE_MIN_SEC = 10

/**
 * Which palette to move to, or null when there is nowhere to go.
 *
 * Pure and exported for tests. The guarantee that matters is that it never
 * returns the palette already showing — "the colour changed" is the whole
 * feature, and the previous logic could silently decline to move because the
 * mood lists overlap so heavily.
 *
 * @param rotation monotonic counter; deterministic so a recorded set repeats.
 */
export function pickPalette(
  moodPalettes: string[],
  current: string,
  keyFamily: string,
  lastPick: string,
  rotation: number,
): string | null {
  const valid = moodPalettes.filter((id) => PALETTES.some((p) => p.id === id))
  const choices = valid.filter((id) => id !== current)
  if (choices.length === 0) return null
  // Drop the previous pick too when an alternative exists, so three moods with
  // overlapping lists can't ping-pong between the same two colours. Applying
  // it to the whole pool (rather than only to the key branch) is what actually
  // enforces "not twice running" — the rotation fallback could otherwise land
  // straight back on it.
  const fresh = choices.filter((id) => id !== lastPick)
  const pool = fresh.length > 0 ? fresh : choices
  // Prefer the key's family when it survived that filter: it is the harmonic
  // anchor, and skipping it only when it was just used keeps colour coherent
  // without pinning the show to a single palette.
  if (keyFamily && pool.includes(keyFamily)) return keyFamily
  return pool[Math.abs(rotation) % pool.length]
}

/**
 * Mood-driven auto-VJ. Watches the committed mood (and its prediction) and
 * requests scene/palette changes through the normal pipeline. Switching is
 * purely event-driven — a mood change, an imminent predicted transition, or a
 * drop each fire an immediate request. There is deliberately NO time cooldown:
 * SceneManager commits every request on the next downbeat, so the bar is the
 * natural rate limiter and the visuals can react as fast as the song does.
 * Backs off whenever the user drives manually.
 */
export function AutoPilot() {
  const handledChange = useRef(-1)
  const pendingChange = useRef(-1)
  const prefetchedFor = useRef<MoodState | null>(null)
  const prevDrop = useRef(false)
  const lastPaletteAt = useRef(-Infinity)
  const lastPalettePick = useRef('')
  /** Last time any trigger below set a target — see STALE_TARGET_SEC. */
  const lastAutoTriggerAt = useRef(-Infinity)
  /** Deterministic cycle position — not random, so a recorded set repeats. */
  const paletteRotation = useRef(0)
  /** The same idea for modes, on its own counter: sharing the palette's would
   *  couple a scene's look to how often the colours happened to change. */
  const modeRotation = useRef(0)
  /** Drop pre-arm: a hype scene requested a bar or two before the projected
   *  drop so SceneManager's next-downbeat commit lands ON the drop rather than
   *  a beat late. `preArmBeat` stamps when — if the drop never comes within a
   *  few bars the arm is abandoned. */
  const preArmed = useRef(false)
  const preArmBeat = useRef(-Infinity)

  useFrame(() => {
    const f = audioEngine.features
    const m = f.mood
    const s = useStore.getState()
    // Rising-edge drop detection must track even while suppressed, so a drop
    // that lands during the manual hold doesn't fire the instant it lifts.
    const dropEdge = f.drop && !prevDrop.current
    prevDrop.current = f.drop
    // Accumulate key votes BEFORE the early returns, for the same reason as
    // the drop edge above: the tracker needs a settled opinion the moment
    // automation resumes, not to start counting from zero then.
    keyPaletteTracker.update(f.key, f.scale, f.time)
    // A new source restarts the engine clock at 0, which would leave the
    // cooldown stamp in the future and freeze the palette for the whole of the
    // next track. These refs outlive a source change; the clock does not.
    if (f.time < lastPaletteAt.current) {
      lastPaletteAt.current = -Infinity
      lastPalettePick.current = ''
    }
    if (f.time < lastAutoTriggerAt.current) lastAutoTriggerAt.current = -Infinity

    if (!s.autoPilot || s.status !== 'running' || f.silence) return
    if (cueState.governed) return // authored cues own the journey
    if (f.time - s.lastManualAt < MANUAL_HOLD_SEC) return
    // Baseline the stale clock the first time automation is actually live,
    // rather than at component mount (which can be well before playback
    // starts) or leaving it at -Infinity (which would fire on frame one).
    if (lastAutoTriggerAt.current === -Infinity) lastAutoTriggerAt.current = f.time

    // Decide what mood to aim visuals at, in priority order:
    //   1) a drop — cut to a high-energy scene the instant it lands;
    //   2) an imminent predicted transition — so the crossfade lands on it;
    //   3) the committed state the moment it changes.
    let target: MoodState | null = null

    // Through a confirmed build-up, hold every DISCRETIONARY switch — the whole
    // point of the build is that the look should stay put until the drop. The
    // drop path (`dropEdge`) is exempt, and `pendingChange` still latches so a
    // mood change that lands mid-build fires the frame the build releases.
    const inBuild = f.structureValid && f.songSection.isBuild

    // Abandon a stale pre-arm — the projected drop never arrived.
    if (preArmed.current && f.beatIndex - preArmBeat.current > 24) preArmed.current = false

    const preArmedThisDrop = dropEdge && preArmed.current
    if (dropEdge) preArmed.current = false

    if (dropEdge && !preArmedThisDrop) {
      target = m.state === 'aggressive' || m.predictedState === 'aggressive' ? 'aggressive' : 'peak'
      prefetchedFor.current = null
    } else if (dropEdge) {
      // Pre-armed: the hype scene is already requested and will commit on the
      // downbeat ≈ the drop. A palette flip still runs below; no new scene request.
      prefetchedFor.current = null
    } else {
      // Latch committed changes: `m.changed` is true for one frame only, but a
      // borderline change must stay eligible until the read firms up (or a
      // newer change supersedes it).
      if (m.changed) pendingChange.current = m.changeCount
      const imminent =
        m.predictedState !== m.state &&
        m.beatsTillTransition >= 0 &&
        m.beatsTillTransition < 4 &&
        m.confidence > MOOD_PREDICT_MIN_CONFIDENCE
      if (inBuild) {
        // hold — no discretionary target while the riser runs
      } else if (imminent && prefetchedFor.current !== m.predictedState) {
        target = m.predictedState
        prefetchedFor.current = m.predictedState
      } else if (
        pendingChange.current !== handledChange.current &&
        m.confidence >= MOOD_CHANGE_MIN_CONFIDENCE &&
        m.ambiguity <= MOOD_CHANGE_MAX_AMBIGUITY
      ) {
        handledChange.current = pendingChange.current
        target = m.state
        prefetchedFor.current = null
      } else if (f.time - lastAutoTriggerAt.current >= STALE_TARGET_SEC) {
        // F135: no edge has fired in a while even though playback is live and
        // unmuted. Aim at whatever is currently committed — not a guess, it's
        // MoodEstimator's own best read, just one that never crossed a
        // category line cleanly enough to flip `m.changed`.
        target = m.state
        prefetchedFor.current = null
      }
    }
    if (target !== null) lastAutoTriggerAt.current = f.time
    // --- Palette: a deliberately WIDER trigger than the scene switch below ---
    //
    // Colour is the cheapest way to mark structure, and section boundaries
    // (verse → chorus) fire far more often than committed mood changes do, so
    // palette gets its own trigger set. Scene changes on those same boundaries
    // are PerformanceDirector's job and stay there — two writers on the scene
    // id is the fight that sends SceneManager down its stale-warm path.
    //
    // Runs BEFORE the `!target` return so a section boundary can recolour a
    // passage whose mood never moved. That is the common case: a verse and its
    // chorus are frequently the same mood.
    const paletteMood = target ?? m.state
    // A latched structural boundary recolours too — but not mid-build (hold the
    // look) and not while a `target` is already driving the switch below.
    const structureRecolour =
      f.structureValid && f.songSection.boundaryChanged && !f.songSection.isBuild
    if (
      (target !== null || f.sectionChange || structureRecolour) &&
      f.time - lastPaletteAt.current >= PALETTE_MIN_SEC
    ) {
      // Excluding what is already showing is the actual fix for "colours never
      // change": the old guard only acted when the current palette was absent
      // from the new mood's list, and the lists overlap heavily — `aurora`
      // alone sits in ambient, mellow, groove AND building, so a whole arc
      // could pass without a single switch.
      const pick = pickPalette(
        MOOD_PALETTES[paletteMood] ?? [],
        s.paletteId,
        keyPaletteTracker.family,
        lastPalettePick.current,
        paletteRotation.current++,
      )
      if (pick) {
        lastPalettePick.current = pick
        lastPaletteAt.current = f.time
        s.setPalette(pick, { auto: true })
      }
    }

    // --- Drop pre-arm --------------------------------------------------------
    // A bar or two before the projected drop, request the hype scene now with
    // `immediate: false` so SceneManager's next-downbeat commit lands ON the
    // drop instead of a beat after it. Only with a real structure read, only
    // once per build, and only when nothing is already in flight.
    if (
      inBuild &&
      !preArmed.current &&
      !s.pendingSceneId &&
      f.songSection.beatsTillDrop >= 1 &&
      f.songSection.beatsTillDrop <= 3
    ) {
      const hypeMood: MoodState =
        m.state === 'aggressive' || m.predictedState === 'aggressive' ? 'aggressive' : 'peak'
      const armCands = getPrimaryScenesForMood(hypeMood).filter((sc) => sc.id !== s.sceneId)
      // Deliberately NOT passed the live VA read: this picks a scene for the
      // HOT moment about to arrive, not for the still-building passage
      // playing right now, and those two are far apart in VA by design — see
      // MOOD_VA.building's negative valence vs peak/aggressive's. Weighting
      // by the current read would bias the pre-arm pick toward the build's
      // own anticipatory character instead of the drop's.
      const armPick = pickVariedScene(armCands, hypeMood, s.recentSceneIds)
      if (armPick && s.requestScene(armPick.id, { auto: true, immediate: false })) {
        const armMode = pickVariedMode(armPick.id, s.sceneModes[armPick.id], modeRotation.current++)
        if (armMode) s.setSceneMode(armPick.id, armMode, { auto: true })
        preArmed.current = true
        preArmBeat.current = f.beatIndex
      }
      return
    }

    if (!target) return

    // Never replace a switch that is already in flight — unless this is a drop,
    // which is the one event worth interrupting anything for.
    //
    // A pending scene has an entry mounted and warming: its chunk is loading and
    // its shader is linking, and `sceneStreamer.retainPending` allows only one
    // such candidate (MAX_PENDING = 1). Requesting a different scene therefore
    // EVICTS the warming entry and throws away every frame of compile work it
    // had banked — and the replacement then starts cold, so it is likelier to
    // still be cold when its own downbeat arrives. Repeatedly re-aiming during
    // the ~1 bar a switch spends pending could keep the show permanently
    // committing scenes that never finished warming.
    //
    // Cheap to skip: the mood that triggered this is a section-scale fact, so
    // the request that is already in flight is aimed at essentially the same
    // musical moment.
    if (s.pendingSceneId && !dropEdge) return

    // Weighted pick among PRIMARY-capable fits (getScenesForMood is not
    // role-filtered — using it directly here used to let an accent/overlay-
    // only scene like `ribbons` get requested as primary), skipping
    // whatever is already showing/pending and softly avoiding whatever
    // just played (pickVariedScene) so the same 1-2 scenes don't monopolize
    // a mood.
    const candidates = getPrimaryScenesForMood(target).filter(
      (scene) => scene.id !== s.sceneId && scene.id !== s.pendingSceneId,
    )
    // Fold essentia's voice read into the pick: scenes tagged for the
    // 'vocal' band get a soft boost once the classifier is actually
    // confident a voice is present. Additive/optional like MoodEstimator's
    // partyBonus — a no-op until moodsValid, so it degrades gracefully when
    // the voice worker hasn't produced a read yet.
    const voiceBoost = (scene: (typeof candidates)[number]) =>
      f.moodsValid && f.vocalPresence > 0.5 && scene.metadata.bands.includes('vocal') ? 1.6 : 1
    const pick = pickVariedScene(candidates, target, s.recentSceneIds, voiceBoost, {
      valence: performanceState.valence,
      arousal: performanceState.arousal,
    })
    // A drop is the one trigger that must land on the moment rather than on the
    // next bar: SceneManager skips the downbeat wait and hard-cuts. Every other
    // trigger here (a mood change, a predicted transition) is a section-scale
    // fact with no exact instant to hit, so those keep the beat-locked
    // crossfade — the drop is the exception, not the new default.
    if (pick) {
      // Choose the LOOK as well as the scene. Picked before the request so the
      // mode is already in the store when the scene mounts — a scene reads its
      // mode reactively and rebuilds geometry on a change, so setting it after
      // the commit would show the old look for a frame and then rebuild during
      // the crossfade, which is the most expensive moment to do it.
      //
      // Only fires for a scene that declares more than one mode, which today is
      // one scene of eighteen — see pickVariedMode for why that ratio is the
      // actual problem rather than this code being speculative.
      const nextMode = pickVariedMode(pick.id, s.sceneModes[pick.id], modeRotation.current++)
      if (nextMode) s.setSceneMode(pick.id, nextMode, { auto: true })
      s.requestScene(pick.id, { auto: true, immediate: dropEdge })
    }
  }, -90) // right after the audio engine tick (-100), before scenes
  return null
}

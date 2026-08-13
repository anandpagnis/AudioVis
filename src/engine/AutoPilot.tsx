import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { audioEngine } from '../audio/AudioEngine'
import type { MoodState } from '../audio/types'
import { cueState } from './CueTimeline'
import { keyPaletteTracker } from './keyPalette'
import { PALETTES } from './palettes'
import { getPrimaryScenesForMood, pickVariedScene } from '../scenes'
import { useStore } from '../store'

/** Palette families per mood — switched only when the current one doesn't fit. */
const MOOD_PALETTES: Record<MoodState, string[]> = {
  silence: [],
  ambient: ['ocean', 'aurora', 'mono'],
  mellow: ['aurora', 'violet', 'ocean'],
  groove: ['aurora', 'violet', 'solar'],
  building: ['solar', 'aurora', 'ember'],
  peak: ['ember', 'solar', 'violet'],
  aggressive: ['ember', 'solar', 'mono'],
}

const MANUAL_HOLD_SEC = 45 // back off after the DJ touches anything

// A committed mood change only drives a scene/palette switch once the read is
// solid: confident enough, and not a near-tie with the runner-up state.
// Borderline changes stay pending and fire on a later frame once they clear.
const MOOD_CHANGE_MIN_CONFIDENCE = 0.4
const MOOD_CHANGE_MAX_AMBIGUITY = 0.6

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
  /** Deterministic cycle position — not random, so a recorded set repeats. */
  const paletteRotation = useRef(0)

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

    if (!s.autoPilot || s.status !== 'running' || f.silence) return
    if (cueState.governed) return // authored cues own the journey
    if (f.time - s.lastManualAt < MANUAL_HOLD_SEC) return

    // Decide what mood to aim visuals at, in priority order:
    //   1) a drop — cut to a high-energy scene the instant it lands;
    //   2) an imminent predicted transition — so the crossfade lands on it;
    //   3) the committed state the moment it changes.
    let target: MoodState | null = null

    if (dropEdge) {
      target = m.state === 'aggressive' || m.predictedState === 'aggressive' ? 'aggressive' : 'peak'
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
        m.confidence > 0.5
      if (imminent && prefetchedFor.current !== m.predictedState) {
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
      }
    }
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
    if (
      (target !== null || f.sectionChange) &&
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

    if (!target) return

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
    const pick = pickVariedScene(candidates, target, s.recentSceneIds, voiceBoost)
    // A drop is the one trigger that must land on the moment rather than on the
    // next bar: SceneManager skips the downbeat wait and hard-cuts. Every other
    // trigger here (a mood change, a predicted transition) is a section-scale
    // fact with no exact instant to hit, so those keep the beat-locked
    // crossfade — the drop is the exception, not the new default.
    if (pick) s.requestScene(pick.id, { auto: true, immediate: dropEdge })
  }, -90) // right after the audio engine tick (-100), before scenes
  return null
}

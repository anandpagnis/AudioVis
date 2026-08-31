import type { AudioFeatures } from '../audio/types'

/**
 * Continuous valence/arousal — the Russell circumplex axes MIR has used to
 * describe musical emotion for over a decade, computed as a pure function of
 * signals `AudioFeatures` already exposes.
 *
 * ## Why this exists
 *
 * Every visual decision in this engine — palette, scene, camera cut rate, the
 * optical racks — routed through `mood.state`, a 7-way label
 * (`silence`/`ambient`/`mellow`/`groove`/`building`/`peak`/`aggressive`). A
 * label is a lossy bottleneck between a rich analyser and every director that
 * reads it: two passages both reading `groove` can differ enormously in how
 * bright, how tense, how consonant they are, and the label cannot say so. The
 * 08-31 session corpus measured 35% of samples failing the scene-switch gate
 * on label ambiguity (`moodConfidence < 0.5 || ambiguity > 0.6`) — a real cost
 * of forcing a continuous signal through a 7-way choice before anything
 * downstream gets to use it.
 *
 * This does not replace `mood.state` — the hysteresis-gated commit logic in
 * `MoodEstimator` is doing real work (holding a decision stable against
 * frame-to-frame noise) that a raw continuous read does not do on its own.
 * It gives every director that currently reads only the label a second,
 * finer-grained axis to read alongside it: `pickPalette`, scene selection's
 * `fit()`, and the camera's cut-rate binding all want "how bright and how
 * energised is this passage RIGHT NOW", not "which of seven buckets is it
 * closest to".
 *
 * ## Why a hand-crafted linear mapping, not a learned model
 *
 * State-of-the-art MER (GlobalMood, DEAM-trained transformer/CNN hybrids) is a
 * trained model over a mel-spectrogram or a pretrained audio embedding — the
 * right tool when the deliverable IS the emotion estimate. It is the wrong
 * tool here: this runs every frame, in a browser main thread already busy
 * with rendering, with zero inference budget and zero training data of its
 * own. What it needs is not a better model, it is a CONTINUOUS axis in place
 * of a 7-way switch — and the classical, pre-deep-learning MER approach
 * (hand-crafted features mapped linearly to the two axes: mode and brightness
 * for valence, energy and tempo for arousal) is exactly sized for that: a
 * handful of multiplies against signals this engine already computes for
 * other reasons, every frame, for free.
 *
 * ## The mapping
 *
 * **Arousal** (0 calm .. 1 energised): `energy` (primary), `loudness` (a
 * differently-weighted, loudness-invariant loudness estimate — a small
 * second vote rather than double-counting `energy`), tempo (normalised
 * against a 60-180 BPM range, the working range this engine's BPM estimator
 * targets), and `tension` — the director's own "dramatic pressure, not
 * loudness" signal (`performanceState.visualTension`), passed in explicitly
 * because it is the one arousal-relevant signal already computed by THIS
 * layer rather than by the analyser, and duplicating its logic here would be
 * two implementations of the same idea drifting apart.
 *
 * **Valence** (-1 negative/dark/tense .. 1 positive/bright/consonant): scale
 * (major/minor — the textbook valence correlate, and the most direct one
 * available; contributes 0 when undetected rather than guessing), spectral
 * centroid (bright reads positive, dark reads negative — the second most
 * common MER valence feature after mode), and spectral flatness inverted
 * (tonal/harmonic content reads more positive than noisy/distorted content —
 * a texture cue independent of loudness or brightness).
 *
 * Every weight below is a judgement call, not a fitted parameter — there is
 * no labelled dataset behind it, unlike `MoodEstimator`'s corpus-calibrated
 * thresholds. Treat the SIGN of each contribution as load-bearing and the
 * exact magnitude as adjustable; the tests pin directional behaviour
 * (brighter reads more positive, minor reads less positive than major, more
 * energy reads more aroused) rather than exact output values for exactly this
 * reason.
 */
export interface ValenceArousal {
  /** -1 (negative) .. 1 (positive). */
  valence: number
  /** 0 (calm) .. 1 (energised). */
  arousal: number
}

/** BPM range the arousal mapping normalises against — this engine's BPM
 *  estimator's working range; see `BpmEstimator.ts`. */
const AROUSAL_BPM_LO = 60
const AROUSAL_BPM_HI = 180

/** Relative weights inside the arousal blend. Sum does not need to be 1 — the
 *  result is clamped — but keeping it near 1 keeps the scale legible. */
const AROUSAL_W_ENERGY = 0.55
const AROUSAL_W_LOUDNESS = 0.15
const AROUSAL_W_TEMPO = 0.15
const AROUSAL_W_TENSION = 0.15

/** Valence contribution from a confirmed major/minor scale read. */
const VALENCE_MODE_MAGNITUDE = 0.35
/** Valence contribution range from spectral centroid (brightness). */
const VALENCE_BRIGHTNESS_WEIGHT = 0.5
/** Valence contribution range from spectral flatness (texture), inverted. */
const VALENCE_HARMONICITY_WEIGHT = 0.35

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

function clamp11(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(-1, x)) : 0
}

/**
 * Compute the current valence/arousal read.
 *
 * Pure and total: every finite-or-not input produces a finite, in-range
 * output, because this runs inside the same per-frame path as every other
 * director and a NaN here must not propagate into a palette pick or a scene
 * score.
 *
 * `tension` defaults to 0 (neutral) so a caller without
 * `performanceState.visualTension` in scope — a test, or a future consumer
 * that only has raw `AudioFeatures` — still gets a usable read; production
 * call sites pass the live value.
 */
export function computeValenceArousal(f: AudioFeatures, tension = 0): ValenceArousal {
  const energy = clamp01(f.energy)
  const loudness = clamp01(f.loudness)
  const t = clamp01(tension)
  const bpm = Number.isFinite(f.bpm) && f.bpm > 0 ? f.bpm : AROUSAL_BPM_LO
  const tempoNorm = clamp01((bpm - AROUSAL_BPM_LO) / (AROUSAL_BPM_HI - AROUSAL_BPM_LO))

  const arousal = clamp01(
    energy * AROUSAL_W_ENERGY +
      loudness * AROUSAL_W_LOUDNESS +
      tempoNorm * AROUSAL_W_TEMPO +
      t * AROUSAL_W_TENSION,
  )

  const centroid = clamp01(f.centroid)
  const flatness = clamp01(f.spectralFlatness)
  const modeTerm = f.scale === 'major' ? VALENCE_MODE_MAGNITUDE : f.scale === 'minor' ? -VALENCE_MODE_MAGNITUDE : 0
  const brightnessTerm = (centroid - 0.5) * 2 * VALENCE_BRIGHTNESS_WEIGHT
  const harmonicityTerm = (0.5 - flatness) * 2 * VALENCE_HARMONICITY_WEIGHT

  const valence = clamp11(modeTerm + brightnessTerm + harmonicityTerm)

  return { valence, arousal }
}

/** Euclidean distance in the valence/arousal plane. Valence spans -1..1 and
 *  arousal 0..1, so the two axes are NOT the same scale — this is the plain
 *  distance on the raw values, matching how {@link ValenceArousal} is defined
 *  rather than pretending the plane is a unit square. */
export function vaDistance(a: ValenceArousal, b: ValenceArousal): number {
  const dV = a.valence - b.valence
  const dA = a.arousal - b.arousal
  return Math.sqrt(dV * dV + dA * dA)
}

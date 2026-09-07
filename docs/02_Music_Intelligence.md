# Document 2 — Music Intelligence

> **Audience:** audio/DSP engineers, AI director authors.  
> **Status:** DSP implemented; ML features planned off hot path.  
> **Spec:** [specs/music_intelligence_spec.md](specs/music_intelligence_spec.md)

---

## Overview

Music Intelligence is the heart of AudioVis. It transforms raw audio into a **structured musical state** that scenes and directors consume every frame. The current implementation is **pure client-side DSP + heuristics** — no ML on the render thread. Future ONNX/Essentia features run off-thread and feed enriched metadata asynchronously.

---

## Goals

- Publish one stable `AudioFeatures` contract per frame.
- Lock tempo and beat phase within a few bars of stable audio.
- Detect sections, drops, and build-ups without song metadata.
- Commit mood states with hysteresis — no per-frame whiplash.
- Predict imminent mood transitions for pre-queuing visuals.
- Support external tempo override (MIDI clock today; OSC/Link planned).

---

## Responsibilities

- Capture audio from any `MediaStream`.
- FFT analysis and adaptive band normalization.
- Rhythm: onset detection, BPM, beat grid, bar/measure/phrase.
- Structure: section boundaries, drop/build/silence flags.
- Emotion: 7-state mood with prediction and visual multipliers.
- Reset cleanly on source stop/restart.

---

## Non-Goals

- Source-separated vocals (vocal band is frequency-range estimate).
- Lyrics recognition or song ID (Shazam-style) in current phase.
- Real-time ONNX on main thread (would miss beats).
- Essentia.js full port in hot path (evaluate off-thread enrichment).

---

## Architecture

```text
MediaStream
  → AudioContext graph (analyser + optional playback tap)
  → FFT 2048 (main) + FFT 8192 (dedicated sub/bass, ~5.4 Hz/bin)
  → spectrum (1024 bins, full 0..Nyquist) + waveform
  → Band extraction (sub, bass, mid, presence, high, vocal, air, sparkle)
    + texture cues (spectral centroid, flatness, rolloff, crest factor)
  → Adaptive normalization + attack/release shaping
  → Onset flux (fixed 1 s window, render-fps-independent) → BpmEstimator
      (IOI histogram + PLL + octave-lock memory)
  → PhraseDetector (spectral novelty on downbeats)
  → MoodEstimator (7-state checklist scoring + hysteresis)
  → AudioFeatures (single mutable object)

  → K-weighting worklet (ITU-R BS.1770-4) → f.loudness / f.lufsShortTerm

  ┌─ off-thread, results applied next frame ─────────────────────┐
  │ EssentiaBridge  → essentia.worker  : degara + multifeature    │
  │                                      tempo, key, danceability │
  │ StructureBridge → structure.worker : self-similarity          │
  │                                      segmentation + riser     │
  │                                      detector → SectionTracker│
  │ VoiceBridge     → voice.worker     : MusiCNN voice/mood       │
  │                                      (models gitignored;      │
  │                                       off unless fetched)     │
  └──────────────────────────────────────────────────────────────┘
```

All three bridges share one PCM tap: an `AudioWorklet` posting fixed
`TAP_BLOCK` (2048-sample, ~43 ms @ 48 kHz) mono blocks. Each bridge pushes
per-sample into its own seconds-sized ring, so none of them depends on the
block size.

**Key files:** `src/audio/AudioEngine.ts`, `spectralFeatures.ts`, `BpmEstimator.ts`, `PhraseDetector.ts`, `MoodEstimator.ts`, `MidiClock.ts`, `types.ts`. The per-bin spectral loop is a pure function in `spectralFeatures.ts` (unit-tested in `src/audio/__tests__/`) — `AudioEngine.ts` only owns the Web Audio graph and normalization/smoothing around it.

---

## Data Flow

Scenes and directors read `audioEngine.features` — never the Web Audio graph. `getAudioResponse()` in `src/engine/audioResponse.ts` converts raw features into visual envelopes (sub, bass, mid, presence, high, vocal, energy, transient, beatPulse, dropPulse, build).

---

## Components

| Component | Role |
|-----------|------|
| AudioEngine | Graph ownership, per-frame update, band extraction, structure heuristics |
| BpmEstimator | Tempo + phase; free-runs at last tempo through silence; `octaveLock` metrical-level memory; `reconcileModelBpm()` for model reads |
| EssentiaBridge / essentia.worker | Off-thread `degara` (fast) + `multifeature` (`rhythm-hq`, octave arbitration) tempo, `KeyExtractor`, `Danceability` |
| StructureBridge / structure.worker | Off-thread streaming self-similarity segmentation (HPCP + MFCC + band cells, Foote novelty) + riser detector; feeds `SectionTracker` |
| SectionTracker | Pure synchronous FSM latching worker segmentation into `SongSectionMomentum` (`isBuild`, `isDrop`, `isBreakdown`, `buildProgress`, `beatsTillDrop`) |
| Loudness worklet | ITU-R BS.1770-4 K-weighting (`audiovis-loudness`) → `f.loudness`, `f.lufsShortTerm` |
| VoiceBridge / voice.worker | Off-thread MusiCNN voice-presence + mood-head activations (weights gitignored; feature is off in a fresh checkout) |
| PhraseDetector | 16-beat phrase grid; re-anchors at section changes |
| MoodEstimator | Committed + predicted mood (checklist scoring), viz multipliers; `confidence` from normalized ambiguity |
| keyPalette | Key jitter → stable 6-family palette preference (vote + dwell) |
| MidiClock | Web MIDI 0xF8 → `setExternalTempo()` |
| calibrate harness | `scripts/calibrate/` — offline corpus runner for constant calibration + F121 regression (`npm run calibrate`) |

---

## Interfaces

```typescript
// Primary consumer contract
interface AudioFeatures { /* see 14_Data_Models.md */ }

// Extension points
audioEngine.startWithStream(stream: MediaStream): Promise<void>
audioEngine.startWithFile(file: File): Promise<void>
bpmEstimator.setExternalTempo(bpm: number, beatTime: number, now: number): void
```

---

## Data Models

See [14_Data_Models.md](14_Data_Models.md) — `AudioFeatures`, `MoodMomentum`, `MoodState`.

---

## Algorithms

### Chapter: Rhythm

| Feature | Algorithm | Data | Update rate | Confidence |
|---------|-----------|------|-------------|------------|
| Onset detection | Spectral flux spikes | FFT magnitude diff | 60 Hz | N/A |
| BPM | IOI histogram + harmonic folding, with metrical-level memory | Onset intervals, 12 s window | Re-eval 2 Hz | `confidence` 0..1 |
| Octave stability | `BpmEstimator.octaveLock` (0..1) — how strongly the current metrical level is backed by dense, well-fitting onsets. The octave switch is asymmetric around it: pulling back toward the locked level is cheap, leaving it costs extra margin. Fixes the F121 76↔152 flip on sparse passages. | Onset density + `gridFit` per octave | Re-eval 2 Hz | Feeds the switch decision |
| Model tempo | Essentia `RhythmExtractor2013` off-thread: `degara` (fast, every ~2.5 s) as the beat-grid source, `multifeature` (`rhythm-hq`, every ~20 s) as an octave-robust second opinion. `reconcileModelBpm()` folds an obvious ½×/2× model error onto the internal lock before it drives the grid. | 12 s PCM window | Worker | `confidence01` (multifeature only) |
| Beat grid | Phase-locked loop | Last tempo + phase | 60 Hz | Inherited from BPM |
| Beat flags | Grid crossing | `beatIndex`, `beatInBar`, `bar`, `measure` | Per beat | Grid trust |
| External tempo | Override + 2 s expiry | MIDI clock ticks | Per tick | High when clock active |
| Beat-grid accuracy | `BpmEstimator`'s internal per-onset hit rate against the predicted grid, exposed as `AudioFeatures.beatGridAccuracy` | Onset timestamps | Per onset | Already blended into `confidence`; useful standalone for accuracy analytics (live Analytics panel, `Y`) |

**Future:** full beat-tracking fusion (Viterbi over tempo hypotheses) if the `octaveLock` heuristic proves insufficient on more recordings.

### Chapter: Harmony

| Feature | Status | Notes |
|---------|--------|-------|
| Key detection | **Implemented** (off-thread) | Essentia `KeyExtractor` in the analysis worker, triggered on section boundaries. `AudioFeatures.key` / `.scale` / `.keyConfidence`. Raw output is jittery (43–65 % window agreement), so `src/engine/keyPalette.ts` collapses 24 keys → 6 circle-of-fifths families and votes with a dwell before it drives the palette. |
| Chord recognition | **Not implemented** | Planned: ONNX chord classifier |
| Consonance/dissonance | **Not implemented** | Chroma variance heuristic candidate |

**Future improvements:** minor-key scenes for breakdowns; chord-aware palette shifts.

### Chapter: Structure

| Feature | Algorithm | Update rate | Confidence |
|---------|-----------|-------------|------------|
| Phrase grid | 16 beats, re-anchored at sections | Per downbeat | Implicit |
| Section change | Spectral profile novelty (bass/mid/high/centroid) on downbeats, thresholded at 0.45 | Event | Binary flag (`sectionChange`) plus the continuous strength behind it (`sectionChangeStrength`) |
| Drop | Energy jump + bass threshold, 0.6 s pulse | Event | Heuristic |
| Build-up | Sustained energy slope | Continuous | Heuristic |
| Silence | RMS below threshold | Continuous | High |
| **Song section (latched)** | Off-thread streaming self-similarity segmentation + a riser detector, fused by a synchronous FSM. `AudioFeatures.songSection` / `.structureValid`. | Segmentation ~15 s cadence; FSM 60 Hz | `songSection.sectionConfidence` |

**Song-section detail.** `structure.worker.ts` (a second essentia-WASM
instance, no TF) turns a rolling ~120 s PCM window into beat-synchronous HPCP +
MFCC + scalar-band cells, builds cosine self-similarity matrices, runs a
checkerboard (Foote) novelty kernel on each, fuses them, and adaptive-peak-picks
boundaries. Segment mean vectors get greedy A/B/C repetition letters; kind
labelling is deliberately minimal — `intro`/`outro` (position), `breakdown`
(quiet-and-tonal), everything else `section` (verse/chorus are **not** guessed
without a trained model). A per-window **riser detector** (five weighted
acoustic slopes: brightness/RMS rise, noise sweep, hat acceleration, kick
dropout) supplies `build` / `beatsTillDrop`. `SectionTracker` (pure, synchronous,
node-tested) latches all of this into `SongSectionMomentum` — `isBuild`,
`isDrop`, `isBreakdown`, `buildProgress`, `beatsTillDrop`, `boundaryChanged`,
`repetitionLabel` — overlaying the fast `f.drop` / `f.buildUp` flags and applying
`MoodEstimator`-style hysteresis. **Fails silent:** no worker / WASM failure
leaves `structureValid = false` and every director falls back to today's
`f.sectionChange`. See F153.

**Future:** a distilled boundary/label model (teacher→student, MusiCNN-scale
student in the worker) if the heuristic proves too coarse on real sets — scoped
in F153's research notes but not built (multi-week offline pipeline, modest
browser accuracy ceiling ~0.62 F@±3s).

### Chapter: Emotion

| Feature | Algorithm | Update rate | Confidence |
|---------|-----------|-------------|------------|
| Mood (7 states) | Per-mood **checklists** of named conditions (soft-energy band, bass carrying / bass-heavy, beat-locked, tonal vs noisy, dynamic vs pushed, steady vs lurching, onset density) + hysteresis | 60 Hz | `mood.confidence` |
| Prediction | Trend velocities → projected state + `beatsTillTransition` | 60 Hz | Drops when unstable |
| Viz multipliers | Smoothed intensity/speed/reactivity per mood | 60 Hz | N/A |

**States:** `silence` → `ambient` → `mellow` → `groove` → `building` → `peak` → `aggressive`

The scoring conditions test `e = m.level ** ENERGY_SHAPE_EXP`, not `m.level` directly:
`RESPONSE_GAMMA` (see `bandNormalizer.ts`) compresses every band toward the bottom of its range,
so the energy windows — drawn for a signal that uses the full 0..1 — otherwise sat where the music
actually lives and only `mellow` ever opened (F121). The threshold constants (`E_MELLOW_LO/HI`,
`E_GROOVE_LO/HI`, `BASS_HEAVY_LO/HI`, `CONF_FLOOR`, `ENERGY_SHAPE_EXP`) are **interim** — final
values come from `corpus/distributions.json` (`npm run calibrate`).

`mood.confidence` is derived from `1 - mood.ambiguity` (the normalized winner/runner-up margin),
NOT the raw score gap — the old formula could not exceed ~0.4 on real material regardless of how
decisive the read was (F121). The full per-state score distribution (`MoodMomentum.scores`) and
`.ambiguity` (0 = decisive, 1 = near-tie) are exposed for calibration analytics.

**Future:** ONNX mood classifier trained on labeled DJ sets; ensemble with heuristic (heuristic wins on latency). If an external opinion is ever needed to validate "does it pick up the vibe correctly," the shape that fits this project's DSP-only philosophy is an *offline, manual* calibration script — never in the render hot path (see [HANDOFF.md](HANDOFF.md) §7).

### Chapter: Genre

| Feature | Status |
|---------|--------|
| Genre classification | **Not implemented** |
| Scene affinity by genre | Metadata-ready in Visual Knowledge Base |

**Future:** ONNX genre tag every 4–8 bars off-thread; influences PerformanceDirector scene pool weighting.

### Chapter: Timbre

| Feature | Algorithm | Update rate |
|---------|-----------|-------------|
| Spectral centroid | Mean frequency over the **full spectrum**, normalized to a fixed 9 kHz reference (so it is sample-rate-invariant and can exceed 1 for very bright material). Widened from a 9 kHz cap so an air-heavy master reads brighter than one that rolls off early. | 60 Hz |
| Spectral flux | Onset-oriented brightness change | 60 Hz |
| Band energies | Fixed Hz ranges, adaptive normalization | 60 Hz |
| Sub / bass | `sub` (20–80 Hz) from a dedicated 8192-point FFT (~5.4 Hz/bin); `bass` (<160 Hz) stays on the 2048 grid so its kick energy isn't smeared by the longer window | 60 Hz |
| Vocal estimate | 250 Hz–5 kHz blend | 60 Hz |
| Voice (tonal vocal) | `vocal × (1 - spectralFlatness)` — the vocal band gated by tonality | 60 Hz |
| Air | ~9–16 kHz band above `high` (shimmer, cymbal wash, breath) — a bin range the original six bands never covered at all | 60 Hz |
| Sparkle | 16 kHz–Nyquist, above `air` — an air-heavy-master-vs-dull/lossy discriminator. Wired into `MoodEstimator` as a small **additive** bias on `ambient` (beside `air`) and `aggressive` (beside `spectralRolloff`), bounded by `SPARKLE_WEIGHT` = 0.06. Kept deliberately small: `f.sparkle` is BandNormalized against its own running max, so on a lossy encode brick-walled at ~15.5 kHz the normalizer stretches codec dither to full scale exactly as it would stretch real shimmer, and nothing in the normalized value tells the two apart. Unvalidated on lossless material — the calibration corpus is 96 kbps and has nothing up here. | 60 Hz |
| Spectral flatness | Geometric mean / arithmetic mean of magnitude over `[1, 9 kHz)` — tonal (low) vs. noisy/distorted (high) texture. Kept at the 9 kHz cap: the near-dead top octave sinks the geometric mean. | 60 Hz |
| Spectral rolloff | Frequency below which 85% of `[1, 9 kHz)` energy sits, normalized to 9 kHz — a 2–9 kHz harshness/brightness cue robust to one dominant bin. Deliberately NOT Nyquist-referenced: its consumer reads it as a harshness cue and a Nyquist scale collapses its dynamic range there. | 60 Hz |
| Crest factor | Peak/RMS ratio — low for pushed/brickwalled masters, high for dynamic material | 60 Hz |

**On `voice` vs `vocal`.** The raw `vocal` band is a plain energy sum over 250 Hz–5 kHz, so it
lights up on hi-hats, snare body, and distortion exactly as readily as on a singer — which is why
nothing consumed it for a long time. Multiplying it by tonality (`1 - spectralFlatness`) suppresses
the noisy half of that range and leaves what is actually pitched, so a held note reads high and a
busy percussive bar reads low. Exposed as `AudioResponse.voice` and `SceneFrame.b.voice`, and it is
what the fluid scenes (Liquid Form, Flow Ribbons) key their headline behaviour to. It remains an
estimate, not source separation — a true vocal stem needs a model, which is deliberately out of
scope (see [HANDOFF.md](HANDOFF.md) §7).

The six original band Hz cutoffs and their normalization are untouched, so the registered scenes' calibrated band-to-job wiring (see [05_Scene_Architecture.md](05_Scene_Architecture.md)) still holds. What the 2026-08-30 front-end sweep *did* change, verified firing-rate-preserving against the reference set (`corpus/eval-report.md`): `centroid` now integrates the whole spectrum (its `* 3` gain re-derived to `* 2.1` to hold its distribution); `sub` moved to the dedicated 8192-point FFT; `sparkle` was added; `f.spectrum` grew to the full 1024 bins; the onset/percussion stat windows became time-based instead of a frame count.

**Future:** MFCC + timbre clustering for scene selection; Essentia `SpectralComplexity`.

### Chapter: Energy

| Feature | Algorithm |
|---------|-----------|
| RMS | Adaptive normalized broadband level |
| Loudness (LUFS) | **Implemented.** ITU-R BS.1770-4 K-weighting (two IIR biquads — shelf + high-pass) in a dedicated `AudioWorklet`, not an `AnalyserNode`, because the filters need the unbroken sample stream. `f.loudness` is the ~400 ms momentary value through a BandNormalizer (loudness-**invariant**, 0..1, same scale as the bands); `f.lufsShortTerm` is the raw 3 s LUFS on an **absolute** scale — diagnostic only, and nothing that gates may assume invariance from it. Spec-pinned in `loudness.test.ts`. |
| Energy | Weighted band blend, smoothed. Bands `bass` 0.5 / `mid` 0.3 / `high` 0.2 plus a broadband term at 0.3, divided by the weight sum (1.3) rather than clipped — a saturated `energy` would silently break drop detection, whose test is `recent > before * K`. |
| Broadband term | `f.rms` blended with a **25 %** share of `f.loudness` (`broadbandEnergyTerm`). Deliberately a minority share, not the full swap: `f.loudness` through a BandNormalizer has essentially no low tail (corpus p10 ≈ 0.29 against `f.rms`'s ≈ 0.06), and swapping it outright moved the dominant mood on 3 of 8 reference tracks. At 25 % the worst-case (p10) shift in the energy target is `(0.29 − 0.06) × (0.3/1.3) × 0.25 = 0.0133` — a quarter of the 0.0531 that broke things. |
| Sub/bass/mid/presence/high | Per-band adaptive norm + attack/release |
| Transient | Fast envelope for flashes |

**Tuning:** `audioEngine.tuning` — band attack/release, beat subdivision (½×/1×/2×/4×).

**Owed:** the loudness blend above is a partial, conservative wiring, not the
fix the DSP audit's remedy column asks for. A full switch to K-weighted energy
needs a distribution-matching remap of `f.loudness` into the blend plus a
re-derivation of every `E_*` mood edge and `detectStructure` constant against a
real corpus — necessary because K-weighting *reorders* which frames are hot,
which no monotone constant nudge can undo. `CALIB_ENERGY_TERM` (`rms` /
`blend` / `loudness`) runs that A/B in the calibrate harness.

### Chapter: Prediction

| Feature | Algorithm | Horizon |
|---------|-----------|---------|
| Next mood | Trend extrapolation from energy/bass/brightness velocities | ~4 beats (AutoPilot prefetch window) |
| Next beat | PLL extrapolation | `nextBeatTime` |
| Imminent peak | Building state + energy slope | Used by AutoPilot pre-queue |

**Future:** Bar-ahead section prediction from similarity matrix; drop prediction from build pattern library.

---

## State Machines

### Mood hysteresis

```text
[scoring] → candidate state exceeds threshold for holdFor(state) beats
         → committed state changes (mood.changed = true for one frame)
         → viz multipliers ease over ~1.5 s
```

Hold times increase for calmer states (ambient holds longer than peak).

### Beat grid trust

```text
confidence > 0.25 → downbeat commits enabled
confidence ≤ 0.25 → 2.5 s timeout commit fallback
external tempo active → onset tracking paused, grid locked to clock
clock stops > 2 s → resume onset tracking
```

---

## Update Frequency

| Output | Rate |
|--------|------|
| Bands, waveform, spectrum | 60 Hz |
| Beat flag | Once per beat |
| Section change | Event (downbeat-gated) |
| Mood commit | Event (hysteresis-gated) |
| BPM histogram refresh | 2 Hz |

---

## Performance Constraints

- **Zero allocations** in `AudioEngine.update()` hot path — buffers reused.
- FFT size: 2048 main + 8192 for the dedicated sub/bass analyser (one extra
  `getFloatFrequencyData` copy per frame). Onset/percussion *detection* is
  skipped on any frame where the time-domain buffer is unchanged at three
  probe indices (`frameGating.fftAdvanced`) — the render loop outrunning the
  audio callback, real above ~90 fps and whenever a tab is throttled. Those
  frames would otherwise feed `flux ≈ 0` **by construction** into the adaptive
  threshold and suppress real onsets.
- Every analyser is created with `minDecibels = -90`, `maxDecibels = 0`
  (`analyserRange.ts`). These affect only `getByteFrequencyData`; the float
  accessors this engine uses ignore them, so it is a no-op here and set for
  correctness-by-default. It is load-bearing in `landing/tunnelAudio`, the
  one byte-data reader, where the -30 dB default ceiling saturated the low
  band on essentially every frame.
- No Worker blocking — if ML added, post results via `postMessage`, consume next frame.
- Target: audio analysis < 1 ms per frame on M1.

---

## Failure Modes

| Condition | Mitigation |
|-----------|------------|
| Silence at start | Grid free-runs at 120 BPM default; idle motion stays musical |
| Tempo drift | IOI histogram adapts every 0.5 s |
| Double source restart | Full reset of beat/phrase/mood/onset history |
| macOS tab-only audio | UI guides user to share tab with "Share tab audio" |
| Untrusted grid | Timeout commit prevents indefinite pending scene |

---

## Testing

- `npm run test` (Vitest, `src/audio/__tests__/`) — unit tests for `BpmEstimator` (synthetic click
  tracks: tempo lock, on-grid vs. jittered `hitScore`, tempo-change persistence, free-run decay,
  external-tempo override, **variable-density octave hold**, **the logged 136.6→102.5
  reinterpretation**, `reconcileModelBpm`), `PhraseDetector` (boundary detection, cooldown,
  silence guard), `MoodEstimator` (state commitment, hysteresis, score distribution, ambiguity,
  **confidence-vs-ambiguity monotonicity**, **bass-heavy ≠ mellow**, **the `sparkle` bound**),
  `spectralFeatures` (band isolation, flatness/rolloff on synthetic spectra), `frameGating`
  (**ring window constant across 30/60/144 fps**, **duplicate-frame skipping**), `energyTarget`
  (**the loudness blend's bound**), `analyserRange` (**byte-mapping saturation arithmetic**),
  `loudness` (BS.1770 spec values) and `PercussionDetector`. None of these need a browser or
  `AudioContext` — the estimator classes take plain data, and `vite.config.ts` runs the suite
  under `environment: 'node'`.

  Note what that environment rules out: there is **no Web Audio implementation** in the test run,
  so no test here constructs a real `AnalyserNode`. Claims about analyser *properties* are
  therefore pinned against the Web Audio spec's own conversion formula, transcribed in
  `analyserRange.test.ts`, and the end-to-end loudness-invariance property is guarded through the
  real dB→band→normalizer path in `loudnessInvariance.test.ts`. Neither is a test of Chromium.
- **`npm run calibrate`** (offline, NOT in `npm run check`) — runs the *real* `src/audio`
  estimators over a corpus of decoded MP3s (`corpus/` — a ~1–2 k-track MTG-Jamendo sample fetched
  with `npm run corpus:fetch`, or the 8 `testfolder/` tracks) and regenerates
  `corpus/distributions.json` (feature percentiles the mood/tempo constants are calibrated against)
  and `corpus/eval-report.md` (octave-flip counts, seconds-per-mood, confidence spread — the F121
  before/after oracle). With no audio present it runs only the synthetic sanity checks. See
  `corpus/README.md`.
- Analytics panel (`Y`): rolling beat-tracking accuracy, mood confidence/ambiguity trends, and the
  live mood-score distribution — the numeric counterpart to the checks below.
- Debug panel (`D`): live BPM, confidence, mood prediction, bands, section/drop flags
- Session recorder (`toggle-session-log`): `sessionLog.ts` writes `moodConfidence` (the mood read's
  own certainty) distinctly from `confidence` (beat-grid trust); its summary grades the
  scene-switch gate against the live `autoPilotGates.ts` thresholds.
- Manual: play track with clear drops → verify `drop` rising edge triggers AutoPilot
- Manual: stop/restart source → verify clean state reset
- `npm run check` for type safety (now includes the test suite)

---

## Future Improvements

Priority order for enriched musical features (user-requested list mapped):

| Feature group | Approach | Thread | Status |
|---------------|----------|--------|--------|
| Advanced rhythm (swing, half-time) | Essentia off-thread + fuse with PLL | Worker | Half/double-time handled by `octaveLock`; swing not started |
| Key/mode | Chroma analysis | Worker | **Shipped** — Essentia `KeyExtractor` + `keyPalette` family vote |
| Genre/mood ML | ONNX Runtime Web | Worker | Mood heads shipped behind gitignored MusiCNN weights; genre not started |
| Loudness (LUFS) | ITU-R BS.1770 | Worklet | **Shipped** — K-weighting worklet; see Chapter: Energy |
| Onset strength / percussive ratio | Extended flux + HPSS | Worker | Per-drum flux (kick/snare/hat) shipped in `PercussionDetector`; HPSS not started |
| Section labels (verse/chorus) | Self-similarity + clustering | Worker | Segmentation + A/B/C repetition letters shipped; verse/chorus naming deliberately **not** guessed without a trained model |

**Rule:** Never block beat grid or scene commits waiting for ML. Directors use last-known ML tags with decaying confidence.

See [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md) Phase 3.

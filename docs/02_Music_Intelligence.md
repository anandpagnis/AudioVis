# Document 2 — Music Intelligence

> **Audience:** audio/DSP engineers, AI director authors.  
> **Status:** DSP implemented on the render thread; Essentia.js + TensorFlow.js now run key/rhythm/voice/mood ML off-thread and feed the same `AudioFeatures` contract.  
> **Spec:** [specs/music_intelligence_spec.md](specs/music_intelligence_spec.md)

---

## Overview

Music Intelligence is the heart of AudioVis. It transforms raw audio into a **structured musical state** that scenes and directors consume every frame. The render-thread core is still **pure client-side DSP + heuristics** — tempo, beat grid, structure, and the base mood score never wait on a model. Layered on top, two background Web Workers (`src/audio/essentia/`) run **Essentia.js** (WASM) for rhythm confirmation, key, and danceability, and a **MusiCNN TensorFlow.js model** for voice presence and a 4-head mood read (happy/aggressive/party/relaxed). Both are additive: a dead/unsupported/not-yet-fetched worker just leaves those fields at their neutral default and the DSP estimators keep running unchanged — see "Failure Modes" below.

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

- Source-separated vocals (`vocal`/`voice` are frequency-range/tonality estimates; the essentia
  worker's `vocalPresence` is a stronger classifier-based read but still not a stem).
- Lyrics recognition or song ID (Shazam-style) in current phase.
- Any ML on the render thread — key/rhythm/voice/mood classifiers run in the two essentia workers
  precisely so a slow inference can never stall the beat grid or a scene commit.
- Genre classification (still not implemented — see "Chapter: Genre" below).

---

## Architecture

```text
MediaStream
  → AudioContext graph (analyser + optional playback tap)
  → FFT 2048 → spectrum + waveform
  → Band extraction (sub, bass, mid, presence, high, vocal, air)
    + texture cues (spectral flatness, spectral rolloff, crest factor)
  → Adaptive normalization + attack/release shaping
  → Onset flux → BpmEstimator (IOI histogram + PLL)
  → PhraseDetector (spectral novelty on downbeats)
  → MoodEstimator (7-state scoring + hysteresis, additively nudged by essentia's `moods.party`)
  → AudioFeatures (single mutable object)

  ── in parallel, off the main thread ──
  AudioWorklet PCM tap (4096-sample mono mixdown)
    → essentia.worker.ts   (Essentia.js WASM: rhythm confirm, key, danceability)
    → voice.worker.ts      (MusiCNN TF.js: voiceFraction, moods{happy,aggressive,party,relaxed})
  EssentiaBridge / VoiceBridge (main thread) hold the latest async result and let
  AudioEngine.update() drain it each frame — same fade-in pattern as the AI texture backend.
```

**Key files:** `src/audio/AudioEngine.ts`, `spectralFeatures.ts`, `BpmEstimator.ts`, `PhraseDetector.ts`,
`MoodEstimator.ts`, `MidiClock.ts`, `types.ts` for the DSP core; `src/audio/essentia/EssentiaBridge.ts`,
`VoiceBridge.ts`, `essentia.worker.ts`, `voice.worker.ts`, `protocol.ts`, `voiceProtocol.ts` for the
essentia layer. The per-bin spectral loop is a pure function in `spectralFeatures.ts` (unit-tested in
`src/audio/__tests__/`) — `AudioEngine.ts` only owns the Web Audio graph and normalization/smoothing
around it. Converting Essentia's TF.js model weights is a one-time offline step, documented in
`scripts/convert-essentia-models.md`; the converted weights are gitignored (`public/models/`) and
fetched at runtime, so the app degrades gracefully — not breaks — when they're absent.

---

## Data Flow

Scenes and directors read `audioEngine.features` — never the Web Audio graph. `getAudioResponse()` in `src/engine/audioResponse.ts` converts raw features into visual envelopes (sub, bass, mid, presence, high, vocal, energy, transient, beatPulse, dropPulse, build).

---

## Components

| Component | Role |
|-----------|------|
| AudioEngine | Graph ownership, per-frame update, band extraction, structure heuristics |
| BpmEstimator | Tempo + phase; free-runs at last tempo through silence; can be corrected by essentia's rhythm read |
| PhraseDetector | 16-beat phrase grid; re-anchors at section changes |
| MoodEstimator | Committed + predicted mood, viz multipliers |
| MidiClock | Web MIDI 0xF8 → `setExternalTempo()` |
| EssentiaBridge | PCM tap + worker scheduling for rhythm/key/danceability (`src/audio/essentia/`) |
| VoiceBridge | PCM tap + worker scheduling for voice presence and the 4-head mood classifier |

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
| BPM | IOI histogram + harmonic folding | Onset intervals, 12 s window | Re-eval 2 Hz | `confidence` 0..1 |
| Beat grid | Phase-locked loop | Last tempo + phase | 60 Hz | Inherited from BPM |
| Beat flags | Grid crossing | `beatIndex`, `beatInBar`, `bar`, `measure` | Per beat | Grid trust |
| External tempo | Override + 2 s expiry | MIDI clock ticks | Per tick | High when clock active |
| Beat-grid accuracy | `BpmEstimator`'s internal per-onset hit rate against the predicted grid, exposed as `AudioFeatures.beatGridAccuracy` | Onset timestamps | Per onset | Already blended into `confidence`; useful standalone for accuracy analytics (live Analytics panel, `Y`) |

**Implemented:** `essentia.worker.ts` runs Essentia's rhythm extractor (`multifeature` method, `degara`
as fallback) on a 12 s PCM window every 2.5 s and reports `bpm`/`confidence01`/`method` back to
`EssentiaBridge.update(f, bpmEstimator)`, which folds a confident read into the onset-PLL estimator
rather than replacing it outright — see "State Machines" below for the handoff rule.

### Chapter: Harmony

| Feature | Status | Notes |
|---------|--------|-------|
| Key detection | **Implemented** | Essentia's key extractor, triggered by `PhraseDetector`'s section boundary (with a 20 s fallback timer and a 6 s floor between runs so a burst of boundaries can't spam the worker); reports tonic + scale + `strength` (`KeyResult`, `src/audio/essentia/protocol.ts`) |
| Chord recognition | **Not implemented** | Planned: ONNX chord classifier |
| Consonance/dissonance | **Not implemented** | Chroma variance heuristic candidate |

**Implemented:** key/mode now drives palette selection — `keyPaletteTracker` (`src/engine/keyPalette.ts`)
accumulates key votes into a harmonic "family" that `AutoPilot`'s `pickPalette()` prefers when it
survives the anti-repeat filter. See [07_Palette_System.md](07_Palette_System.md).

**Future improvements:** Chord recognition; minor-key-specific scene/palette tuning beyond the family mapping above.

### Chapter: Structure

| Feature | Algorithm | Update rate | Confidence |
|---------|-----------|-------------|------------|
| Phrase grid | 16 beats, re-anchored at sections | Per downbeat | Implicit |
| Section change | Spectral profile novelty (bass/mid/high/centroid) on downbeats, thresholded at 0.45 | Event | Binary flag (`sectionChange`) plus the continuous strength behind it (`sectionChangeStrength`) |
| Drop | Energy jump + bass threshold, 0.6 s pulse | Event | Heuristic |
| Build-up | Sustained energy slope | Continuous | Heuristic |
| Silence | RMS below threshold | Continuous | High |

**Future:** Self-similarity matrix for chorus/verse labels; Essentia `SBic` segmentation.

### Chapter: Emotion

| Feature | Algorithm | Update rate | Confidence |
|---------|-----------|-------------|------------|
| Mood (7 states) | Weighted score of energy, bass, brightness, flux, spectral flatness/rolloff, crest factor, air + hysteresis, additively nudged by essentia's `moods.party` | 60 Hz | `mood.confidence` |
| Prediction | Trend velocities → projected state + `beatsTillTransition` | 60 Hz | Drops when unstable |
| Viz multipliers | Smoothed intensity/speed/reactivity per mood | 60 Hz | N/A |

**States:** `silence` → `ambient` → `mellow` → `groove` → `building` → `peak` → `aggressive`

The full per-state score distribution and a derived ambiguity score (`MoodMomentum.scores` /
`.ambiguity`, 0 = decisive winner, 1 = near-tie) are exposed alongside the committed state —
previously computed every frame and discarded, now surfaced for accuracy/calibration analytics.

**Implemented (partial ensemble):** the `voice.worker.ts` MusiCNN model reports a 4-head mood read
(`happy`/`aggressive`/`party`/`relaxed`, `AudioFeatures.moods`, valid once `moodsValid` is true) over
~3 s patches, averaged over the analysis window. Rather than replacing the heuristic 7-state score,
only `party` is folded in — additively, capped low (0.18) — as a `groove` bonus: measured against a
labelled set it separates club material from ambient far better than the DFA `danceability` head it
effectively stands in for (house 0.93–0.99 vs. ambient 0.00–0.06; `danceability` inverted that
ordering). `aggressive` and `relaxed` similarly nudge `PerformanceStateBridge`'s glitch/fog terms
(see [03_AI_Performance_Director.md](03_AI_Performance_Director.md)) rather than the mood vote itself
— deliberately additive everywhere, so an unfetched model costs nothing rather than degrading the
heuristic. `happy` currently has no consumer.

**Future:** genre-level or full-track mood classification beyond the 4 MusiCNN heads above; ensemble
weighting tuned by ear rather than the current fixed caps. If an external opinion is ever needed to
validate "does it pick up the vibe correctly" beyond what the classifier already gives, the shape
that fits this project's DSP-first philosophy is an *offline, manual* calibration script — never in
the render hot path (see [HANDOFF.md](HANDOFF.md) §7).

### Chapter: Genre

| Feature | Status |
|---------|--------|
| Genre classification | **Not implemented** |
| Scene affinity by genre | Metadata-ready in Visual Knowledge Base |

**Future:** ONNX genre tag every 4–8 bars off-thread; influences PerformanceDirector scene pool weighting.

### Chapter: Timbre

| Feature | Algorithm | Update rate |
|---------|-----------|-------------|
| Spectral centroid | FFT-weighted mean frequency, normalized | 60 Hz |
| Spectral flux | Onset-oriented brightness change | 60 Hz |
| Band energies | Fixed Hz ranges, adaptive normalization | 60 Hz |
| Vocal estimate | 250 Hz–5 kHz blend | 60 Hz |
| Voice (tonal vocal) | `vocal × (1 - spectralFlatness)` — the vocal band gated by tonality | 60 Hz |
| Air | ~9–16 kHz band above `high` (shimmer, cymbal wash, breath) — a bin range the original six bands never covered at all | 60 Hz |
| Spectral flatness | Geometric mean / arithmetic mean of magnitude — tonal (low) vs. noisy/distorted (high) texture | 60 Hz |
| Spectral rolloff | Normalized frequency below which 85% of energy sits — a brightness cue robust to one dominant bin, unlike centroid | 60 Hz |
| Crest factor | Peak/RMS ratio — low for pushed/brickwalled masters, high for dynamic material | 60 Hz |

**On `voice` vs `vocal` vs `vocalPresence`.** The raw `vocal` band is a plain energy sum over 250
Hz–5 kHz, so it lights up on hi-hats, snare body, and distortion exactly as readily as on a singer —
which is why nothing consumed it for a long time. Multiplying it by tonality (`1 - spectralFlatness`)
suppresses the noisy half of that range and leaves what is actually pitched (`voice`), so a held note
reads high and a busy percussive bar reads low; this is the fast, per-frame, zero-latency signal
scenes key their headline motion to (Flow Ribbons). `AudioFeatures.vocalPresence` is the slower,
classifier-based complement: MusiCNN's voice head, resolved as the share of ~3 s patches in a window
whose `p(voice)` clears a decision threshold (`voiceFraction`, not a mean). `CameraDirector` eases it
into `voiceFocus` and uses it to prefer intimate camera modes (`locked`/`push`) over a threshold, and
`AutoPilot`/`PerformanceStateBridge` use it as a soft scene/bloom boost — see
[06_Camera_Director.md](06_Camera_Director.md) and [03_AI_Performance_Director.md](03_AI_Performance_Director.md).
Neither is source separation — a true vocal stem needs a model that isolates the voice, which is
deliberately out of scope (see [HANDOFF.md](HANDOFF.md) §7).

The four texture cues (air, spectral flatness/rolloff, crest factor) are strictly additive: none
change the six original bands' Hz cutoffs or normalization, so calibrated band-to-job wiring on
existing scenes (see [05_Scene_Architecture.md](05_Scene_Architecture.md)) is untouched.

**Future:** MFCC + timbre clustering for scene selection; Essentia `SpectralComplexity`; full ITU-R BS.1770 loudness (crest factor above is a cheap proxy, not true LUFS).

### Chapter: Energy

| Feature | Algorithm |
|---------|-----------|
| RMS | Adaptive normalized loudness |
| Energy | Weighted band blend, smoothed |
| Sub/bass/mid/presence/high | Per-band adaptive norm + attack/release |
| Transient | Fast envelope for flashes |

**Tuning:** `audioEngine.tuning` — band attack/release, beat subdivision (½×/1×/2×/4×).

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
- FFT size: 2048 (fixed).
- ML runs entirely off-thread: `essentia.worker.ts` / `voice.worker.ts` post results via
  `postMessage`; `EssentiaBridge`/`VoiceBridge` hold the latest one and `AudioEngine.update()` drains
  it on the next frame. Nothing in the hot path awaits a worker.
- Target: audio analysis < 1 ms per frame on M1 (unchanged — the essentia layer runs on its own
  cadence, seconds apart, entirely off the render thread).

---

## Failure Modes

| Condition | Mitigation |
|-----------|------------|
| Silence at start | Grid free-runs at 120 BPM default; idle motion stays musical |
| Tempo drift | IOI histogram adapts every 0.5 s |
| Double source restart | Full reset of beat/phrase/mood/onset history |
| macOS tab-only audio | UI guides user to share tab with "Share tab audio" |
| Untrusted grid | Timeout commit prevents indefinite pending scene |
| Essentia model weights not fetched (gitignored, dev-only convert step skipped) | Bridges stay in their neutral default (`moodsValid: false`, `vocalPresence: 0`, no key/rhythm correction); DSP estimators are unaffected |
| Essentia/voice worker dead, unsupported, or a request errors | `VoiceError.missing` stops retries rather than hammering a 404 every section; bridge simply never resolves that job again this session |
| Essentia read goes stale | `MODEL_FRESH_SEC` bounds how long a worker read stays authoritative before onset/heuristic tracking resumes unaided |

---

## Testing

- `npm run test` (Vitest, `src/audio/__tests__/`) — unit tests for `BpmEstimator` (synthetic click
  tracks: tempo lock, on-grid vs. jittered `hitScore`, tempo-change persistence, free-run decay,
  external-tempo override), `PhraseDetector` (boundary detection, cooldown, silence guard),
  `MoodEstimator` (state commitment, hysteresis, score distribution, ambiguity), `spectralFeatures`
  (band isolation, flatness/rolloff on synthetic spectra), `essentiaBridge.test.ts` (job scheduling,
  cadence backoff, fresh-vs-stale handoff to `BpmEstimator`), `voiceBridge.test.ts` (fraction vs. mean
  handling, `missing`-error retry suppression), and `moodSignals.test.ts` (the `partyBonus`/glitch/fog
  nudges staying additive and zeroed when `moodsValid` is false). None of these need a browser or
  `AudioContext`/real worker — everything is plain data in, plain data out.
- Analytics panel (`Y`): rolling beat-tracking accuracy, mood confidence/ambiguity trends, and the
  live mood-score distribution — the numeric counterpart to the checks below.
- Debug panel (`D`): live BPM, confidence, mood prediction, bands, section/drop flags
- Manual: play track with clear drops → verify `drop` rising edge triggers AutoPilot
- Manual: stop/restart source → verify clean state reset
- `npm run check` for type safety (now includes the test suite)

---

## Future Improvements

| Feature group | Status | Approach | Thread |
|---------------|--------|----------|--------|
| Rhythm confirmation | **Implemented** | Essentia `RhythmExtractor2013` (multifeature/degara), fused with PLL | `essentia.worker.ts` |
| Key/mode | **Implemented** | Essentia key extractor, section-boundary-triggered | `essentia.worker.ts` |
| Danceability | **Implemented, unused downstream** | Essentia DFA danceability — superseded by MusiCNN's `party` head for the groove score (see "Chapter: Emotion"); no current consumer | `essentia.worker.ts` |
| Voice presence / mood (4-head) | **Implemented** | MusiCNN TF.js embedding | `voice.worker.ts` |
| Advanced rhythm (swing, half-time) | Not implemented | Would need a dedicated feature beyond `RhythmExtractor2013`'s bpm/confidence | Worker |
| Genre/mood ML (full genre tags) | Not implemented | ONNX Runtime Web or a genre-tagged model | Worker |
| Loudness (LUFS) | Not implemented | ITU-R BS.1770 approximation (crest factor is a cheap proxy today) | Main or Worker |
| Onset strength / percussive ratio | Not implemented | Extended flux + HPSS | Worker |
| Section labels (verse/chorus) | Not implemented | Self-similarity + clustering | Worker |

**Rule:** Never block beat grid or scene commits waiting for ML. Directors use last-known ML tags with decaying confidence (`MODEL_FRESH_SEC` for essentia's rhythm/key reads; `voiceFraction`/`moods` simply hold their last value until the next window resolves).

See [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md) Phase 3.

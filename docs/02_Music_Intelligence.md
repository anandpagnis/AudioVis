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
  → FFT 2048 → spectrum + waveform
  → Band extraction (sub, bass, mid, presence, high, vocal, air)
    + texture cues (spectral flatness, spectral rolloff, crest factor)
  → Adaptive normalization + attack/release shaping
  → Onset flux → BpmEstimator (IOI histogram + PLL)
  → PhraseDetector (spectral novelty on downbeats)
  → MoodEstimator (7-state scoring + hysteresis)
  → AudioFeatures (single mutable object)
```

**Key files:** `src/audio/AudioEngine.ts`, `spectralFeatures.ts`, `BpmEstimator.ts`, `PhraseDetector.ts`, `MoodEstimator.ts`, `MidiClock.ts`, `types.ts`. The per-bin spectral loop is a pure function in `spectralFeatures.ts` (unit-tested in `src/audio/__tests__/`) — `AudioEngine.ts` only owns the Web Audio graph and normalization/smoothing around it.

---

## Data Flow

Scenes and directors read `audioEngine.features` — never the Web Audio graph. `getAudioResponse()` in `src/engine/audioResponse.ts` converts raw features into visual envelopes (sub, bass, mid, presence, high, vocal, energy, transient, beatPulse, dropPulse, build).

---

## Components

| Component | Role |
|-----------|------|
| AudioEngine | Graph ownership, per-frame update, band extraction, structure heuristics |
| BpmEstimator | Tempo + phase; free-runs at last tempo through silence |
| PhraseDetector | 16-beat phrase grid; re-anchors at section changes |
| MoodEstimator | Committed + predicted mood, viz multipliers |
| MidiClock | Web MIDI 0xF8 → `setExternalTempo()` |

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

**Future:** Essentia `RhythmExtractor2013` off-thread for difficult genres; beat tracking fusion with onset PLL.

### Chapter: Harmony

| Feature | Status | Notes |
|---------|--------|-------|
| Key detection | **Not implemented** | Planned: chroma + Krumhansl profile off-thread |
| Chord recognition | **Not implemented** | Planned: ONNX chord classifier |
| Consonance/dissonance | **Not implemented** | Chroma variance heuristic candidate |

**Future improvements:** Map key/mode to palette temperature; minor-key scenes for breakdowns.

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
| Mood (7 states) | Weighted score of energy, bass, brightness, flux, spectral flatness/rolloff, crest factor, air + hysteresis | 60 Hz | `mood.confidence` |
| Prediction | Trend velocities → projected state + `beatsTillTransition` | 60 Hz | Drops when unstable |
| Viz multipliers | Smoothed intensity/speed/reactivity per mood | 60 Hz | N/A |

**States:** `silence` → `ambient` → `mellow` → `groove` → `building` → `peak` → `aggressive`

The full per-state score distribution and a derived ambiguity score (`MoodMomentum.scores` /
`.ambiguity`, 0 = decisive winner, 1 = near-tie) are exposed alongside the committed state —
previously computed every frame and discarded, now surfaced for accuracy/calibration analytics.

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
| Spectral centroid | FFT-weighted mean frequency, normalized | 60 Hz |
| Spectral flux | Onset-oriented brightness change | 60 Hz |
| Band energies | Fixed Hz ranges, adaptive normalization | 60 Hz |
| Vocal estimate | 250 Hz–4 kHz blend | 60 Hz |
| Air | ~9–16 kHz band above `high` (shimmer, cymbal wash, breath) — a bin range the original six bands never covered at all | 60 Hz |
| Spectral flatness | Geometric mean / arithmetic mean of magnitude — tonal (low) vs. noisy/distorted (high) texture | 60 Hz |
| Spectral rolloff | Normalized frequency below which 85% of energy sits — a brightness cue robust to one dominant bin, unlike centroid | 60 Hz |
| Crest factor | Peak/RMS ratio — low for pushed/brickwalled masters, high for dynamic material | 60 Hz |

All four are strictly additive: none change the six original bands' Hz cutoffs or normalization, so the five registered scenes' calibrated band-to-job wiring (see [05_Scene_Architecture.md](05_Scene_Architecture.md)) is untouched.

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
  external-tempo override), `PhraseDetector` (boundary detection, cooldown, silence guard),
  `MoodEstimator` (state commitment, hysteresis, score distribution, ambiguity), and
  `spectralFeatures` (band isolation, flatness/rolloff on synthetic spectra). None of these need a
  browser or `AudioContext` — the estimator classes take plain data.
- Analytics panel (`Y`): rolling beat-tracking accuracy, mood confidence/ambiguity trends, and the
  live mood-score distribution — the numeric counterpart to the checks below.
- Debug panel (`D`): live BPM, confidence, mood prediction, bands, section/drop flags
- Manual: play track with clear drops → verify `drop` rising edge triggers AutoPilot
- Manual: stop/restart source → verify clean state reset
- `npm run check` for type safety (now includes the test suite)

---

## Future Improvements

Priority order for enriched musical features (user-requested list mapped):

| Feature group | Approach | Thread |
|---------------|----------|--------|
| Advanced rhythm (swing, half-time) | Essentia off-thread + fuse with PLL | Worker |
| Key/mode | Chroma analysis | Worker |
| Genre/mood ML | ONNX Runtime Web | Worker |
| Loudness (LUFS) | ITU-R BS.1770 approximation | Main or Worker |
| Onset strength / percussive ratio | Extended flux + HPSS | Worker |
| Section labels (verse/chorus) | Self-similarity + clustering | Worker |

**Rule:** Never block beat grid or scene commits waiting for ML. Directors use last-known ML tags with decaying confidence.

See [15_Implementation_Roadmap.md](15_Implementation_Roadmap.md) Phase 3.

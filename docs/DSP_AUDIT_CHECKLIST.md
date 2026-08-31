# Audio DSP Audit — Checklist

Tracking status of the 19-item audit of the audio-analysis layer (`src/audio/*`).
Legend: `[x]` done · `[~]` partial · `[ ]` not started.

Status as of 2026-08-30, `dsp-improve` working tree (uncommitted).

- **1/2/3/14** — the F121 recording-diagnosed set (mood-confidence scale, mood
  stuck on mellow, BPM octave flips, model-read reliability).
- **18** — the `docs/02` refresh.
- **4/5/6/7/8/19** — the FFT/analyser front-end sweep (this pass). Verified
  firing-rate-preserving against the 8-track reference set: 5/8 tracks
  byte-exact mood breakdown vs the F121 baseline, the rest within noise;
  `moodLevel`/`energy`/`bass`/`spectralFlatness`/`crestFactor` p50 all exact;
  octave-flip count unchanged (9 total). See `corpus/eval-report.md`.

**Score: 12 done · 3 partial · 4 not started.**

- **16** — the EssentiaBridge scheduler is now pure + tested (this pass); it also
  fixed three latent bugs it turned up. **12** — the BS.1770 K-weighting signal
  landed (Part A); wiring it into scoring (Part B) is calibration-gated.

Two front-end fixes were deliberately narrowed from the audit's literal wording
after an adversarial pass showed the letter-of-the-law version would regress
things — see items 4 and 6.

---

## Done

- [x] **1 — Mood confidence structurally can't exceed ~0.39.**
  `MoodEstimator.update()` now builds `confidence` from the *normalized*
  separation (`0.65·(1−ambiguity) + 0.2·dwell + 0.15·winnerHeld`), not the raw
  `margin·2` that could never reach 1 against `score()`'s compressed 0.1–0.8
  band. Corpus eval: `moodConf` p90 0.70–0.82, max up to 0.96 (was: peak 0.392).
  `AutoPilot.MOOD_CHANGE_MIN_CONFIDENCE` re-baselined to 0.5 (interim — final
  value from `corpus/eval-report.md`).
  Evidence: `src/audio/MoodEstimator.ts` (`update`, confidence block).

- [x] **2 — Classifier sits on `mellow` while energy/bass are high.**
  `score()` rewritten as per-mood named checklists keyed on
  `e = m.level ** ENERGY_SHAPE_EXP` (0.6), which undoes `RESPONSE_GAMMA`'s
  downward compression so the energy windows line up with where real music
  sits. `mellow` gained a genuine suppressive bass gate (`1 − 0.85·bassHeavy`,
  was only ever halved). Corpus eval shows `groove`/`peak`/`aggressive` now
  winning whole tracks. Constants still interim (calibrated against the 8-track
  set; the full 1500-track run is the final oracle).
  Evidence: `src/audio/MoodEstimator.ts` (`score`, top constant block).

- [x] **3 — BPM octave flips 76↔152 on sparse passages.**
  `BpmEstimator.octaveLock` (0..1 metrical-level memory: fast rise on a dense
  confirming window, slow decay). Asymmetric octave switch around the locked
  level (pull-back cheap, push-away costs `octaveLock·OCTAVE_LOCK_MARGIN`);
  `gridFit()`'s occupancy *reward* density-gated (penalty kept); `lockedIn`
  gate on the persist-before-jump path. A `multifeature` second opinion
  (`rhythm-hq`, 20 s cadence) + `reconcileModelBpm()` fold a degara
  wrong-octave read onto the lock. Corpus eval: 0–5 flips/track, 0% sustained
  half-tempo. Constants interim.
  Evidence: `src/audio/BpmEstimator.ts` (`reconcileModelBpm`, `evaluate`, `gridFit`).

- [x] **4 — Brightness cues capped at 9 kHz; rolloff not a true rolloff.**
  **Narrowed:** `centroid` now accumulates over the whole spectrum (was capped
  at 9 kHz), so an air-heavy master finally reads brighter than one that rolls
  off early — but it keeps its 9 kHz-referenced normalization, which is what
  makes it sample-rate-invariant (`/n` against a fixed 1024 bins would read ~9%
  off on a 48 kHz `AudioContext`). Its `* 3` scale was re-derived to `* 2.1`
  against the corpus so `f.centroid`'s distribution is held where it was
  (p50 0.54, p90 ~0.85) — every downstream `bright` term is unperturbed.
  **`rolloff` and `flatness` left unchanged:** rolloff's one consumer reads it
  as a 2–9 kHz *harshness* cue, and a Nyquist reference collapses its dynamic
  range there (and breaks `AudioResponse.rolloff`'s 0..1 contract); flatness's
  geometric mean tanks if the near-dead top octave enters it.
  **New `sparkle` cue** (`spectralFeatures.ts`) — mean magnitude 16 kHz→Nyquist,
  non-overlapping with `air` (9–16 kHz), `prevMag`-hygienic, unit-tested,
  BandNormalized onto `f.sparkle`. It is the dedicated "air-heavy vs dull/lossy"
  discriminator. **Computed and on the contract but NOT wired into
  `MoodEstimator` yet:** the calibration corpus is 96 kbps (brick-walled
  ~15.5 kHz) so a wired weight is untunable, and a reasoned one measurably
  shifted the 8-track mood mix. Same "expose first, wire later" path as `air` /
  `key` / `vocalPresence`.
  Evidence: `src/audio/spectralFeatures.ts` (full-range centroid, `sparkle`
  loop), `src/audio/AudioEngine.ts` (`f.sparkle`, centroid `* 2.1`),
  `src/audio/__tests__/spectralFeatures.test.ts` (golden-value band test,
  sparkle isolation, centroid-responds-above-9kHz).

- [x] **5 — "Analyser dB range clamps (`maxDecibels` default −30)".**
  **Premise disproven empirically.** An oscillator at +18 dBFS through an
  `OfflineAudioContext` analyser read the *same* bin value with `maxDecibels`
  set to −30, −10, 0, and un-set (mins reached −202 dB). `getFloatFrequencyData`
  — the only frequency read this codebase does — is not clamped by
  `min`/`maxDecibels`; those affect `getByteFrequencyData` only. So there is no
  analyser-property change to make.
  What was real and is now fixed: because the float path is unclamped, a hot
  master genuinely produced `f.spectrum` bins above 1.0 linear (~1.6),
  violating the documented "0..1 per bin" contract — `writeLinearSpectrum()`
  clamps them. And a loudness-invariance regression test now runs the real
  dB→`computeSpectralBands`→`BandNormalizer` path (and the `computeLowBands`
  path) at ±20 dB input offsets and asserts equal band outputs.
  Evidence: `src/audio/spectralFeatures.ts` (`writeLinearSpectrum`),
  `src/audio/__tests__/loudnessInvariance.test.ts`.

- [x] **6 — Low-end FFT resolution ~21–23 Hz/bin.**
  **Narrowed to `f.sub` only.** A dedicated second `AnalyserNode` (fftSize
  8192, ~5.4 Hz/bin, built in `attachMidTap` so it covers both graph paths)
  feeds `computeLowBands()` → `f.sub`. Measured: a 35 Hz + 55 Hz pair that the
  2048 grid smears into 2 wrong bins (21.5 Hz, 64.6 Hz — only 3 bins across the
  whole sub band) resolves cleanly on the 8192 grid (37.7 Hz, 53.8 Hz, 14
  bins). **`f.bass` deliberately stays on the 2048 grid:** the 8192 window's
  ~186 ms span blunts the kick energy that `beatStrength` / `beatPulse()` and
  ~19 scenes' `b.bass` pulses sample at the beat, and delays drop detection
  half a beat — an adversarial review flagged all three. `f.sub` has no such
  consumer (it is inherently a slow envelope). `stop()`/`resetAnalysis()`
  drop the analyser and its buffer.
  Evidence: `src/audio/AudioEngine.ts` (`lowAnalyser`, `attachMidTap`, `f.sub`
  source), `src/audio/spectralFeatures.ts` (`computeLowBands`),
  `src/audio/__tests__/spectralFeatures.test.ts` (`computeLowBands` suite).

- [x] **7 — Onset / percussion stat windows are frame-rate-dependent.**
  Both the broadband-onset flux ring (`AudioEngine`) and the per-band
  percussion history (`PercussionDetector`) are now evicted by AGE
  (`now − t ≥ 1.0 s − ε`), not a fixed 60-sample count. The `− ε` keeps them at
  exactly 60 samples at a steady 60 fps (bit-identical to the old count, so the
  F121 onset calibration is preserved) while being a true 1 s window at 30 or
  144 fps, where the old count was 2 s / 0.4 s respectively.
  Evidence: `src/audio/AudioEngine.ts` (`fluxHistory`, `FLUX_WINDOW_SEC`),
  `src/audio/PercussionDetector.ts` (`HISTORY_SEC`).

- [x] **8 — FFT oversampling above ~90 fps.**
  Implemented the checklist's own first suggestion — a cheap "did the FFT
  advance" guard: `f.waveform[0]`/`[512]`/`[1023]` are compared to the previous
  frame; when all three are unchanged (render loop outrunning the audio
  callback, or a throttled tab) the onset + percussion detectors are skipped
  for that frame, so a `flux ≈ 0` duplicate can't dilute their adaptive
  thresholds. `prevMag` is not advanced on a skip, so the next live frame
  diffs across the gap correctly. Sentinels reset in `resetAnalysis()`.
  *Not* done: a fixed-60 Hz flux-bucketing scheme — it injects a ~1.5:1
  sawtooth into the flux stream at any fps that isn't a multiple of 60, which
  is a worse artifact than the one it fixes (adversarial finding).
  Evidence: `src/audio/AudioEngine.ts` (`waveProbe*`, `fftAdvanced`).

- [x] **14 — `degara` reports no confidence.**
  Kept the cheap `degara` on the beat-grid path; added the expensive
  `multifeature` method as a slow second opinion (`rhythm-hq` job, ~20 s
  cadence, carries Essentia's own `confidence01`) used purely for octave
  arbitration. A `degara` read with no confidence falls back to
  grid-fit/`hitScore` reliability, only when the applied octave is trusted.
  Evidence: `src/audio/essentia/EssentiaBridge.ts` (`pickJob`, `drain`),
  `src/audio/essentia/essentia.worker.ts`.

- [x] **18 — `docs/02_Music_Intelligence.md` stale.**
  Rewritten. Key detection marked **Implemented**; architecture diagram
  includes the `essentia`, `voice`, and `structure` workers; `octaveLock` /
  `reconcileModelBpm` / the calibrate harness documented; ML-off-by-default
  caveat stated. (Needs a follow-up touch for the item-4/6/19 front-end changes
  — see below.)

- [x] **19 — `f.spectrum` exposes only the lower 512 bins.**
  `f.spectrum` is now the full `FFT_SIZE / 2` = 1024 bins spanning 0..Nyquist
  (~0–22 kHz at 44.1 kHz). The copy loop iterates `f.spectrum.length` and
  `createEmptyFeatures` allocates `Float32Array(1024)`, so the two can't drift
  into a silent out-of-bounds write; a test asserts the length. `types.ts` doc
  updated; `lilimState.ts` / `outputLink.ts` / `DebugPanel.tsx` comments and
  the debug spectrum bar range updated. The lilim scene's own 11 kHz `specHi`
  ceiling is now a deliberate choice, not a data limit — raising it toward
  lilim's 18 kHz is a safe follow-up once the shader scenes are re-checked.
  Evidence: `src/audio/AudioEngine.ts` (`writeLinearSpectrum`, loop),
  `src/audio/types.ts`, `src/audio/__tests__/loudnessInvariance.test.ts`.

---

## Partial

- [~] **12 — No true loudness (LUFS).**
  **Part A done:** `src/audio/loudness.ts` — ITU-R BS.1770-4 K-weighting
  (analog-prototype coefficients, sample-rate-agnostic, verified against the
  spec's 48 kHz table to 1e-6) + a denormal-flushed, NaN-guarded `KWeighting`
  filter + an `OfflineLoudness` windower for the calibrate harness. A dedicated
  `audiovis-loudness` AudioWorklet runs the two IIR biquads on the contiguous
  stream (an AnalyserNode can't — gapped snapshots) and posts 400 ms / 3 s
  K-weighted mean-squares at ~60 Hz. `f.lufsShortTerm` (raw ~−60..0, absolute
  scale, diagnostic only — must never enter scoring) and `f.loudness`
  (BandNormalized momentary K-weighted RMS → invariant 0..1) are on the
  contract; both panels show LUFS. Worklet verified in a real
  `AudioWorkletGlobalScope`: full-scale 1 kHz sine → −3.00 LUFS.
  **Part B (not done):** wire `f.loudness` into `energyTarget` (swap the crude
  `f.rms` term) — a full F121/F154-class recalibration (mirror in
  `features.ts`, 8-track re-derive, full corpus). Blocked on the F154 corpus
  run finishing (one calibrate at a time).
  Evidence: `src/audio/loudness.ts`, `src/audio/AudioEngine.ts`
  (`LOUDNESS_PROCESSOR`, `attachLoudnessTap`), `src/audio/__tests__/loudness.test.ts`.

- [~] **13 — Voice/mood ML models ship disabled.**
  Consumption fully wired (`VoiceBridge` + `voice.worker.ts`, `f.moods` /
  `f.moodsValid` / `f.vocalPresence` read by `MoodEstimator` `partyBonus`,
  `AutoPilot`, `PerformanceStateBridge`, debug panels). **Still missing:** the
  weights are gitignored (CC BY-NC-SA), so `moodsValid` is `false` in a fresh
  checkout. Hosting + licence resolution outstanding.
  Evidence: `src/audio/essentia/VoiceBridge.ts`, `.gitignore` (models block).

- [~] **17 — No real-audio end-to-end test.**
  `corpus/` + `npm run calibrate` runs the real `src/audio` estimators over a
  1500-track MTG-Jamendo corpus → `corpus/distributions.json` +
  `corpus/eval-report.md`. The harness now streams (per-metric flat pools with
  frame-striding) instead of holding every frame, so a full run no longer
  OOMs; `CALIB_STRIDE` / `CALIB_LIMIT` / `CALIB_TESTFOLDER_ONLY` knobs give a
  fast iteration loop. **Still missing:** not in `npm run check`/CI, audio is
  gitignored, no committed CC0 clips with hard tolerance asserts.
  Evidence: `scripts/calibrate/`, `vitest.calibration.config.ts`.

---

## Done (this pass)

- [x] **16 — `EssentiaBridge` tests only cover the inert/no-worker path.**
  The scheduler + result merge are now a pure module, `src/audio/essentia/scheduling.ts`
  (`pickJob` / `applyDispatch` / `ingestResponse` / `drainResults` over an
  injected `EssentiaSchedState`); the class keeps all I/O and calls them with
  `this.sched`. `essentiaScheduling.test.ts` covers the full priority ladder,
  the timer writes, the degara-only cadence self-throttle, the `hqBpm` capture
  guard, and every drain merge path (hq-fresh vs internal-grid octave
  reference, the `[40,240]` clamp, slot→field mapping, independence). The old
  inert-path suite is untouched. Turned up and fixed three latent bugs:
  **Bug A** — `rhythm-hq`'s "not the first job" guard (`lastJobAt >= 0`) was a
  tautology `pickJob`'s own first branch already guaranteed, so hq fired as
  job #2; now gated on `RHYTHM_HQ_MIN_READS` completed degara reads.
  **Bug B** — no `id` check on a worker response, so a job in flight at a
  source change merged track 1's tempo/key onto track 2 (the AudioEngine
  comment claims this can't happen); now an `inFlightId` set at dispatch /
  cleared on `detach()` drops the stale result.
  **Bug D** — `hqFresh` mixed a dispatch-time clock with a receipt-time value;
  dispatching an hq job now clears `hqBpm` so a stale reference can't be
  labelled fresh during the ~950 ms run.
  Still open: **Bug C** — no aggregate worker-time budget, so under worker load
  a long key/dance/hq job can delay the next degara read past its cadence
  (noted in ISSUES.md, low priority).
  Evidence: `src/audio/essentia/scheduling.ts`,
  `src/audio/__tests__/essentiaScheduling.test.ts`.

---

## Not started

- [ ] **9 — Linear resampling to 44.1 k / 16 k.**
  `resampleTo441()` is still 2-tap linear interpolation; same in the structure
  and voice workers. `src/audio/essentia/essentia.worker.ts`.

- [ ] **10 — `presence` (2–5 kHz) is a strict subset of `high` (2–9 kHz).**
  `high` still accumulates from `midEnd` (2 kHz). `src/audio/spectralFeatures.ts`.

- [ ] **11 — PCM tap granularity 4096 samples (~85 ms @ 48 k).**
  `TAP_PROCESSOR` still posts fixed 4096-sample blocks with no timestamps.
  `src/audio/essentia/EssentiaBridge.ts`.

- [ ] **15 — `danceability` computed every 8 s, consumed nowhere.**
  `EssentiaBridge` still schedules the job; `f.danceability` only reaches the
  debug/analytics panels. `MoodEstimator` uses `moods.party` for the same job.
  Either drop it or wire it. `src/audio/essentia/scheduling.ts` (`pickJob`).

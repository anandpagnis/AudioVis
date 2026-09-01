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

**Score: 16 done · 3 partial · 0 not started.**  (partials: 12 = LUFS Part A +
F171 infra, term swap deferred to a corpus session · 13 = ML-off UX by user
decision · 17 = synthetic E2E in CI, real corpus stays manual.)

- **9** (F170) — the 2-tap linear resample in the three Essentia workers is now
  a shared Kaiser-windowed-sinc polyphase filter (≥ 81 dB stopband at every
  target Nyquist). No calibration impact.
- **11** (F167) — PCM tap block 4096 → 2048 (`TAP_BLOCK`); sample-accurate
  timestamps scoped out with rationale. No calibration impact.
- **15** (F168) — `danceability` wired as `groove`'s club bias, gated on
  `!moodsValid` (licence-clean fallback for the MusiCNN `party` head).
  Corpus-blind — no calibration impact.
- **17** (F172) — a pure-DSP E2E over procedural fixtures now runs in
  `npm run check` (`pipelineE2E.test.ts`). Plumbing regression only — explicitly
  **not** an accuracy gate; real corpus stays a manual step.
- **10** (F169) — `high` narrowed to 5–9 kHz so it no longer contains
  `presence`. 8-track: dominant mood unchanged on all 8, `energy` −1.5 %. No
  constant re-derivation needed at 8-track scale; full-corpus confirm owed.
- **12** (F171) — `energyTarget` extracted to a shared pure helper
  (`energyTarget.ts`, kills the two-file drift); `f.loudness` now computed in
  the harness. The `f.rms` → `f.loudness` **term swap is deferred** — the naive
  8-track swap moved the dominant mood on 3/8 tracks (`f.loudness` has no low
  tail; K-weighting reorders frames), needs a remap + full corpus.

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
  **Part B — infrastructure landed (F171), the term swap DEFERRED:**
  - `src/audio/energyTarget.ts` — the `energyTarget` blend is now one shared
    pure helper (`energyTargetOf` + `stepEnergy`), imported by both
    `AudioEngine.ts` and `scripts/calibrate/features.ts`. Kills the
    copy-pasted-expression drift the two files carried (the same bug class the
    worker `resample` copies had). Byte-inert: 8-track distributions +
    `structure` firing rates identical before/after.
  - `features.ts` now computes `f.loudness` every frame via `OfflineLoudness`,
    so it is in `corpus/distributions.json` for analysis
    (`CALIB_ENERGY_TERM=loudness` runs the swap A/B).
  - **The `f.rms` → `f.loudness` swap is NOT done.** The 8-track A/B: the naive
    swap moves the *dominant* mood on 3/8 tracks — an ambient track flips to
    `mellow`, and a quiet-intro track locks the mood hysteresis onto `silence`
    for 55 s — because `f.loudness` through a BandNormalizer has no low tail
    (corpus p10 ≈ 0.29 vs `f.rms` ≈ 0.06). K-weighting *reorders* which frames
    are hot, so no monotone constant re-derivation restores it. The real swap
    needs a distribution-matching remap of `f.loudness` into the blend **plus**
    a full 1500-track re-derivation of every `E_*` / `detectStructure` /
    `ENERGY_SHAPE_EXP` constant. Left for a session with the corpus.
  Evidence: `src/audio/energyTarget.ts`, `src/audio/loudness.ts`,
  `scripts/calibrate/features.ts` (energy-blend comment),
  `src/audio/__tests__/loudness.test.ts`.

- [~] **13 — Voice/mood ML models ship disabled.** (F173 — partial by decision)
  Consumption fully wired (`VoiceBridge` + `voice.worker.ts`, `f.moods` /
  `f.moodsValid` / `f.vocalPresence` read by `MoodEstimator` `partyBonus` +
  `danceBonus`, `AutoPilot`, `PerformanceStateBridge`, debug panels).
  **F173 (this pass):** the two dev panels now read **`ML: off (no weights)`**
  (vs `ML: error …`) when `voiceBridge.status.missing`, and `docs/HANDOFF.md`
  §6 has a MusiCNN licence-blocker subsection: the weights are CC BY-NC-SA 4.0
  (NonCommercial + ShareAlike), committing them anywhere in history — Git LFS
  included — is redistribution that poisons a commercial build, so they stay
  gitignored by design; ML-off is the shipping default and the product is fully
  functional there.
  **Deferred by decision (user, 2026-08-31):** the hosting mechanism for a
  *permissively-licensed / self-trained* replacement, a release-build assertion
  that `public/models/` is clean, and any fetch/convert automation. None of it
  blocks today because ML-off is the default. Item stays `[~]`.
  Evidence: `src/ui/DebugPanel.tsx`, `src/ui/AnalyticsPanel.tsx`,
  `docs/HANDOFF.md` §6, `.gitignore` (models block).

- [~] **17 — No real-audio end-to-end test.** (F172 — plumbing E2E landed;
  real-corpus-in-CI intentionally not done)
  **Done:** `src/audio/__tests__/pipelineE2E.test.ts` runs deterministic
  procedural audio (`scripts/calibrate/fixtures.ts` — seeded synth, four
  regimes: four-on-floor, half-time, sparse ambient, build+drop) through
  `runTrack` (the same `AudioEngine.update` mirror the calibrate harness uses)
  as part of `npm run check`. Asserts: every per-frame feature finite and
  in its documented range for all four regimes; the beat tracker locks near
  the fixture tempo (±7, one octave allowed) on a steady groove and does NOT
  hard-lock on a beatless bed; a `drop` fires once after the build+drop riser
  and then settles; mood is not frozen on frame 1; same seed → byte-identical
  PCM → identical frame stream. `runTrack` + `fft.ts` + `fixtures.ts` are now
  in `tsconfig` `include` so the cross-`src`/`scripts` import is deliberate and
  strict-typechecked. `unit.calib.ts` reuses the same fixtures.
  **Scope call — real corpus stays a manual gate.** All audio is gitignored
  (MTG-Jamendo BY-SA / BY-NC-SA); fetching 1500 tracks in CI is
  redistribution-adjacent, slow, and flaky. The `npm run calibrate` corpus run
  remains a **local** step, not a CI job.

  > ⚠️ **The synthetic E2E is a plumbing regression test, NOT an accuracy
  > gate.** Synthesised kicks/pads do not load `MoodEstimator` /
  > `detectStructure` like real music (the mood mix they produce is a
  > `BandNormalizer`-AGC artefact), and the bounds are deliberately loose. **A
  > green `pipelineE2E.test.ts` run is never evidence that a calibration
  > constant change is safe** — that judgement comes only from
  > `npm run calibrate` over the real corpus and a diff of
  > `corpus/eval-report.md`. This rule applies to the item 10 + 12
  > recalibration below: `npm run check` staying green throughout it means
  > nothing about whether the retune is correct.

  Evidence: `src/audio/__tests__/pipelineE2E.test.ts`,
  `scripts/calibrate/fixtures.ts`, `tsconfig.json`.

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

- [x] **9 — Linear (2-tap) resampling to 44.1 k / 22.05 k / 16 k.** (F170)
  Replaced with one shared Kaiser-windowed-sinc polyphase resampler,
  `src/audio/essentia/resample.ts`, used by all three workers (rhythm/key →
  44.1 k, structure → 22.05 k, voice/MusiCNN → 16 k). One low-pass does both
  anti-image and anti-alias: cutoff between `0.84·min-Nyquist` and
  `min-Nyquist`. **Key correctness point:** `halfLen` (taps each side, at the
  *input* rate) scales with the decimation ratio — 35 for 48→44.1, 69 for
  48→22.05, 95 for 48→16 — because the polyphase inner loop convolves input
  samples, so the physical FIR runs at `inRate`. The workflow's first draft
  used a fixed `halfLen 32` for every pair, which gave the two 3:1 decimators
  only ~35 dB of stopband rejection; the shipped design measures ≥ 81 dB right
  at the target Nyquist for all five real rate pairs. Per-phase DC-normalised
  (no gain error on DC), stateless (each call resamples one complete ring
  window), zero-pad edges. No calibration impact — the harness runs no workers.
  Evidence: `src/audio/essentia/resample.ts`,
  `src/audio/essentia/__tests__/resample.test.ts` (stopband probes just above
  each target Nyquist), `essentia.worker.ts` / `voice.worker.ts` /
  `structure.worker.ts`.

---

- [x] **11 — PCM tap granularity 4096 samples (~85 ms @ 48 k).** (F167)
  `TAP_BLOCK` const, 4096 → 2048 (~43 ms @ 48 k, ~23 msg/s), interpolated once
  into the worklet blob so the three literal sites can't drift. First analysis
  can start ~43 ms sooner; a source cut is seen a block earlier. Not lowered
  further — 1024 (~10 ms) is where the per-message overhead (1 postMessage + 3
  synchronous ring copies) starts eating the win. **Timestamps deliberately not
  added:** every consumer pushes into a seconds-sized ring right-aligned to
  "now" and nothing does cross-stream sample alignment, so a per-block frame
  counter would be dead weight (`currentFrame` is there in the worklet if a
  future feature needs it). All three bridge `pushPcm`s are per-sample loops
  over `block.length` — block-size-agnostic, verified. Sanity test:
  `TAP_BLOCK % 128 === 0`.
  Evidence: `src/audio/essentia/EssentiaBridge.ts`,
  `src/audio/__tests__/essentiaBridge.test.ts`.

---

- [x] **15 — `danceability` computed every 8 s, consumed nowhere.** (F168)
  Wired (not dropped) — as `groove`'s club bias in `MoodEstimator.score()`,
  **gated on `!f.moodsValid`**: the MusiCNN `party` head is the better signal
  and wins whenever the weights are present, but they're CC BY-NC-SA and absent
  from a commercial build, so the pure-algorithm `danceability` is the
  licence-clean fallback that keeps `groove` from going flat there. Mutually
  exclusive with `partyBonus` by the same gate. Hard-clamped `0 < v < 12`
  (degenerate input reads ≈97), renormed `(v−1)/5`, capped `×0.12` (≤
  `partyBonus`'s 0.18), and energy-gated `band(e, 0.35, 1.01)` so it can't lift
  a quiet passage. **Corpus-blind by construction:** `scripts/calibrate` runs
  no Essentia worker, so `f.danceability` is 0 in every calibrate frame and
  `npm run calibrate` output is byte-identical with/without this term — same
  validation position as `partyBonus` (unit test + listening only). Constants
  are reasoned, documented as such.
  Evidence: `src/audio/MoodEstimator.ts` (`DANCE_*`, `danceBonus`),
  `src/audio/__tests__/moodSignals.test.ts`, `src/audio/types.ts`.

---

- [x] **10 — `presence` (2–5 kHz) was a strict subset of `high` (2–9 kHz).** (F169)
  `computeSpectralBands` now accumulates `high` over `[presenceEnd, highEnd)` =
  5–9 kHz (was `[midEnd, highEnd)` = 2–9 kHz), divisor `highEnd - presenceEnd`.
  `high` and `presence` no longer overlap; `f.high` is a real brilliance band
  instead of 43 % duplicated `presence`. The golden-value test asserts the new
  `high` (its "six bands byte-identical" contract now explicitly excludes
  `high`). 8-track A/B: `f.high` p50 −20 %, but `energy` p50 only −1.5 % (it is
  ~15 % of the blend) and the **dominant mood is unchanged on all 8 tracks**;
  `structure` drop rate −5 % (65 → 62 /hr, ≈1 event on 8 tracks). No constant
  re-derivation — the shift is within 8-track noise. A full-corpus pass should
  still confirm the `detectStructure` drop rate and `f.high`'s ~10 scene
  consumers (`audioResponse.high`), and decide whether the freed 2–5 kHz wants
  a small `presence` term in `energyTarget` — left for the corpus session.
  Evidence: `src/audio/spectralFeatures.ts` (`computeSpectralBands`),
  `src/audio/__tests__/spectralFeatures.test.ts`.

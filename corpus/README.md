# Calibration corpus

DSP-estimator constants in `src/audio/` (mood score windows, tempo-continuity
priors, the mood-confidence rebuild) are set from **measured distributions over
a real song corpus**, not by eye — and validated against it as a before/after
oracle. This directory is that pipeline.

**F121** is the reason: the mood estimator sat on `mellow` for 139 of 155 s of a
real recording and its `confidence` never cleared 0.39; the BPM read flipped
between 76 and 152. ISSUES.md: *"needs the estimator itself opened up against a
known track."* Eight tracks (`testfolder/`) is a regression anchor, not enough
to calibrate against — hence ~1–2 k here.

## What's committed vs generated

| Committed | Generated (gitignored) |
| --- | --- |
| `build-manifest.mjs`, `fetch.mjs`, `reference/` | `audio/` — the MP3s |
| `tracks.json` — the sampled id list + tags | `frames/` — decoded feature frames (if used) |
| `distributions.json` — cross-track percentiles | `refs/` — Python ground-truth tempo/sections |
| `eval-report.md` — the before/after oracle | |

Committing audio would be redistribution (per-track CC + the dataset's
non-commercial clause) — same reasoning as `testfolder/README.md` and
`public/models/`.

## Run it

```bash
# 1. sample a genre/mood-balanced id list from MTG-Jamendo metadata (~few MB)
node corpus/build-manifest.mjs --size 1500

# 2. fetch the audio into corpus/audio/  (gitignored; tens of GB for 1500)
npm run corpus:fetch            # add --limit 200 for a quick pass

# 3. (optional) ground-truth tempo + sections for the octave oracle
pip install -r corpus/reference/requirements.txt
python corpus/reference/analyze_reference.py

# 4. run the REAL src/audio estimators over the corpus, regenerate
#    distributions.json + eval-report.md
npm run calibrate
```

`npm run calibrate` uses `vitest.calibration.config.ts` and is **never** part of
`npm run check`. With no audio present it runs only the synthetic sanity checks
in `scripts/calibrate/unit.calib.ts`.

## How the harness stays honest

`scripts/calibrate/features.ts` re-implements only the inline glue from
`AudioEngine.update()` (FFT read, RMS, smoothing lines, energy blend, onset
detector, `advanceGrid`, `detectStructure`) — each block tagged with the
`src/audio/AudioEngine.ts` line range it mirrors. Everything that is already a
pure module (`computeSpectralBands`, `BandNormalizer`, `BpmEstimator`,
`MoodEstimator`, …) is imported and run directly, so the code being calibrated
*is* the shipped code. `crosscheck.calib.ts` bounds the residual FFT/windowing
difference against a real decode of the 8 `testfolder` tracks.

## Licensing

MTG-Jamendo is **non-commercial research and academic use** only. `tracks.json`
here records ids + tags only and does **not** assert per-track CC license (unlike
`testfolder/tracks.json`'s 8 hand-verified tracks). The committed outputs
(`distributions.json`, `eval-report.md`) are derived statistics and a text
report — facts, not derivative works — and no audio enters the repo. If the
product's licensing posture needs distance from NC data, swap the manifest
builder's source to **FMA** (`https://freemusicarchive.org`, CC-BY/CC0 subsets).

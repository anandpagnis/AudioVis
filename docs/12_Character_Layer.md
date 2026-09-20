# 12. Character layer (mood engine v2)

**Status:** built, wired in behind an automatic fallback, and measured against human ratings (below). Not yet judged on real footage.

## The problem it fixes

The old engine reduced everything to one 7-way label (`MoodState`), chosen by
fixed energy windows over a loudness-invariant `energy`. Two things went wrong:

1. **The label was uninformative.** Measured on 400 human-rated clips (PMEmo),
   the label explained ~7% of the variance in human arousal and ~5% in valence;
   its arousal read correlated 0.44 with listeners while single timbre features
   reached 0.76. `building`/`peak` were almost unreachable and `groove`/`ambient`
   absorbed the middle.
2. **Scene selection could not use it.** Per-mood scene pools overlapped ~90%, so
   even a correct label led to the same scenes.

## Two layers, not one label

| Layer | Question | Where | Speed |
|---|---|---|---|
| **Intensity** | How intense is this moment? | existing `MoodEstimator`, `SectionTracker` (unchanged) | frames |
| **Character** | What does the music *feel* like? | `EmotionDimensionEstimator` + `CharacterClassifier` | seconds |

Character is a point in a continuous 4-D space (all 0..1) plus a probability
distribution over 14 named moods (`serene tender dreamy melancholic brooding
mysterious groove playful uplifting euphoric driving tense aggressive epic`; the
same taxonomy the offline Gemini labeller uses).

## Files

| File | Role |
|---|---|
| `src/audio/characterTypes.ts` | the contract (`CharacterState`, `CHARACTER_MOODS`) |
| `src/audio/emotionDimensions.ts` | features -> valence/arousal/tension/pulse; percentile-calibrated |
| `src/audio/emotionQuantiles.ts` | **generated** reference percentile tables |
| `src/audio/characterPriors.ts` | **generated** per-mood priors (balance moods on unlabelled audio) |
| `src/audio/moodTaxonomy.ts` | the 14 prototypes (centre + spread in the 4-D space) |
| `src/audio/CharacterClassifier.ts` | soft classification, smoothing, hysteresis (held primary) |
| `src/audio/chromaKey.ts`, `harmonicTension.ts` | clean-room key/mode and tension estimators (no Essentia) |
| `src/scenes/character.ts` | per-scene character vectors + `pickSceneForCharacter` |
| `src/engine/characterPick.ts` | glue for AutoPilot / PerformanceDirector, per-song seed, fallback |
| `src/engine/paletteCharacter.ts` | each palette's character derived from its colours; `pickPaletteByCharacter` |

`AudioFeatures.character` is mutated in place every frame.

**Gotcha (fixed 2026-09-20):** `AudioEngine.resetAnalysis()` does `Object.assign(features, createEmptyFeatures())`, which
replaces `features.character` with a fresh object. It must be re-linked to `characterClassifier.state` afterwards
(it is, and `audioEngineNoIntel.test.ts` pins it). Before the fix the live character read was never valid after the
first source started, so every consumer silently used the old mood-label paths while the offline evaluation (which
does not go through `AudioEngine`) looked fine.

## How a scene is chosen now

`pickByCharacter` scores **every** primary-capable scene (not just the current
mood label's pool) by Gaussian fit to the current character point, times a
novelty term (last 12 picks) and a deterministic per-song "cast" bias, and picks
weighted-randomly. It returns `null` until the character read is valid, and the
directors then run the original mood-label pick, so the new path can only add
variety. **Kill switch:** `?scenepick=legacy`.

## How a palette is chosen now

Every palette gets a valence/arousal/tension point **derived from its colours** (HSV of the
three lit slots: pleasure from brightness and saturation, arousal from saturation, brightness
and hue warmth, tension from hue discord and saturated red; rank-normalised across the roster;
`paletteCharacter.ts`). `AutoPilot` then picks among **all** palettes by fit to the music's
character, with recency, a per-song seed and only a gentle key bonus (x1.3), instead of the mood
pool plus a key override that funnelled songs onto ~6 families. Section recall, the 10 s floor
and the old pool pick (until the character read is ready, or with `?scenepick=legacy`) are kept.
Measured on 184 real songs, one palette each: 29 of 30 palettes used, most common 8%, entropy 0.94,
palette arousal tracks song arousal at 0.65. The colour model uses judgement-call weights (the
Valdez & Mehrabian coefficients were quoted from memory, and the hue terms are ours); it is
verified by table inspection and unit tests, not by a listener study.

## Design rules (please keep)

- **Weights come from the literature, not from labelled data.** The estimator is a
  plain average of a short, justified feature list. PMEmo/DEAM/Jamendo ratings are
  used only to *check* it, on held-out clips, and never to train shipped weights
  (they are non-commercial; see `docs/LICENSES.md`).
- **Be honest about what was tuned.** No weights were fitted, but two design decisions were
  made after seeing tune-fold results: roughness was dropped from valence (it pulled the
  composite below brightness alone), and pulse was percentile-mapped (raw beat confidence
  rarely exceeds 0.5, which made `groove`/`driving` unreachable). The test fold was scored
  once, afterwards. Any further change that looks at test-fold numbers makes them optimistic.
- **Percentile calibration** (`emotionQuantiles.ts`) is built from audio features
  only. Regenerate with `npm run calibrate:quantiles` (needs `corpus/audio`,
  `testfolder` and the PMEmo "pool" fold; ~15 min).
- **Tempo is not an arousal input** (measured ~0 correlation on short clips);
  **noisiness is not a valence input** (its sign flips between genres).
- **Tension is unvalidated**: no human tension ratings exist in the datasets used.

## Measuring it

```
npm run eval:emotion             # replay the engine over human-rated clips, write corpus/emotion/eval-report.md
EMO_FOLD=tune|test  EMO_LIMIT=N  # held-out folds; N clips per set (0 = all, ~26 min for PMEmo)
npm run calibrate:quantiles      # rebuild the percentile tables
```

Data comes from `node corpus/fetch-emotion-sets.mjs` (gitignored). Fold rule: last
digit of the numeric clip id; 9 = quantile pool (never evaluated), 0-4 = tune, 5-8 = test.

## Measured results (2026-09-20)

Human-rated clips (PMEmo, non-commercial, internal evaluation only). Weights were
chosen from the literature; the **tune** fold (ids ending 0-4, 374 clips) was used
while iterating, the **test** fold (ids 5-8, 309 clips) was looked at once at the end.
Fold 9 is the unlabelled reference pool for the percentile tables and priors.

| Spearman rho vs human ratings | old engine | new estimator |
|---|---|---|
| Arousal, tune / **test** | 0.44 / 0.51 | 0.74 / **0.81** (0.77-0.85) |
| Valence, tune / **test** | 0.39 / 0.61 | 0.46 / **0.63** (0.55-0.70) |

- **Arousal is a clear win** (about +0.30 on both folds).
- **Valence is roughly a wash** against the old formula (+0.07 tune, +0.02 test, inside the
  noise: the old formula itself swings 0.39 to 0.61 between folds). Trained models reach about 0.65.
- **The label now carries emotion information.** Variance of human ratings explained by the
  dominant mood: arousal 0.08 -> **0.51**, valence 0.05 -> **0.44** (test fold).
- **Diversity:** all 14 moods lead at least one clip; largest single mood 19%; normalised
  entropy 0.89 (targets: under 30%, at least 0.80). Priors are balanced on unlabelled audio.
- **Named moods vs Gemini pre-labels (98 Jamendo tracks): weak.** Exact agreement 14% (top-2
  24%). Gemini itself is lopsided (33 `groove` + 21 `driving` of 98), the engine is balanced by
  design, and Gemini labels are mixed-model free-tier pre-labels, so this is not proof the engine
  is wrong, but the *names* are not validated. Arousal vs Gemini: 0.56 (0.83 on the 15 best-labelled
  tracks). Valence 0.20 (0.46 on non-lite models). **Tension 0.22 / 0.06: unvalidated**; do not rely on it.
- **Gemini is not a better yardstick than the tags.** Scored against the Jamendo mood tags (independent of
  both; 36 tracks with an unambiguous arousal or valence tag, 84 with an interpretable mood tag), the
  engine separates tagged-high from tagged-low tracks better than Gemini does: arousal AUC 0.82 vs 0.67,
  valence 0.79 vs 0.56 (small n, wide error bars: about +-0.09 on valence). Named mood is tag-compatible
  for 43% of tracks by the engine's dominant mood (58% top two) vs 45% (64% with secondary) for
  Gemini, against about 28% by chance. So the weak engine-vs-Gemini numbers mostly reflect noise and a
  `groove`/`driving` default in the labels, not a broken engine. **Do not tune the taxonomy toward these
  labels**; a by-ear labelled set is still the only real check of the mood names.
  (`npm run eval:gemini` prints this section. The Gemini run was stopped with 59 of 98 tracks at three
  samples and 39 at one; resuming it would not change this conclusion.)
- Scene choice uses the continuous point (valence/arousal/tension/pulse), so the mood *names*
  matter less than the axes.

Reproduce: `npm run eval:emotion` (caches features), `npm run eval:replay` (seconds, from the
cache), `npm run eval:gemini`, `npm run calibrate:quantiles`, `npm run calibrate:priors`.

## Post-FX, camera, filters, bloom: the "look"

Those systems are hand-tuned tables keyed on the old 7-state mood. Rather than re-author them
blind, `characterLook.ts` changes which row they read: `lookState(oldState, character)`.
Character (slow) supplies the flavour via the taxonomy's `LEGACY_MAP` (serene -> ambient,
tense -> building, epic -> peak, ...); the old detector (fast) keeps intensity: silence stays
silence, real builds and drops pass through, and a quiet moment (`ambient`/`mellow`) caps the
look at `groove` so a breakdown never gets peak effects. `MoodMomentum.look` holds it (read via
`lookOf(mood)`). Also `vizLook`: the intensity/speed/reactivity multipliers, now continuous in
arousal and pulse and blended 65/35 with the old state's (so drops still punch); that is what
`getEffectiveParams` applies to every scene.

Switched to the look: trails, echo, lens, mirror, bloom, camera-mode pick, scene steering
(`PerformanceStateBridge`), `FilterDirector`, `EffectDirector`. Measured on 683 real clips
(dominant state per clip): old state ambient 20 / mellow 27 / groove 30 / building 0 / peak 1 /
aggressive 21 (%), look state 9 / 13 / 34 / 14 / 10 / 21; evenness over the six non-silent states
0.79 -> 0.93. `?scenepick=legacy` turns the look off along with the scene and palette pickers.

## Still on the old 7-state mood

The *timing* of scene switches is old-mood changes, the 25 s stale timer and now also a character shift
(`characterShift.ts`: the held primary mood changing, at least 12 s after the last request, latched while
automation is suppressed; off under `?scenepick=legacy`). Still old: the UI mood pill and session
log (telemetry), the Limitless / DJ Cam return-scene picks, and `MoodEstimator` itself.

## Known limits

- Scene character vectors (`SCENE_CHARACTER`) were authored from source code and
  descriptions, not from watching renders. They need review on real footage.
- The free-tier whitelist is only 5 scenes (4 primary-capable), so the free demo
  cannot look varied whatever the engine does. That is a product decision.
- A live stream has no song boundary; the per-song cast re-rolls when the character
  drifts far and stays there (`characterPick.ts`).

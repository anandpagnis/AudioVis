# Mood labels (Gemini pre-labels)

`corpus/labels/gemini/` holds one JSON per track (`<trackId>.json`) plus an
aggregate `_all.json`, written by `scripts/mood-labels/label.mjs`. The folder is
gitignored: it is derived from Jamendo audio (CC BY-NC-SA / BY-SA, dataset
non-commercial) and is regenerable. Force-add (`git add -f`) only if you
deliberately decide to commit a set.

These are **LLM pre-labels for human review, not ground truth**. Each record
carries the model id, timestamp, number of samples, the spread between samples,
and a `needsReview` flag (valence/arousal range across samples > 1.5, low mood
agreement or low confidence). Blocked tracks have `"status": "blocked"` and no
label.

Workflow, key setup, cost and the **privacy warning** (free-tier content may be
used to improve Google models; use a paid/billing-enabled project for private
audio) are in `scripts/mood-labels/README.md`.

```bash
node scripts/mood-labels/label.mjs --list
node scripts/mood-labels/label.mjs --sources testfolder --samples 3
node scripts/mood-labels/compare-to-jamendo.mjs     # coarse check vs Jamendo mood tags
```

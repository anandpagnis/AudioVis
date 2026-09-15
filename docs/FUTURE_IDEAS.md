# AudioVis — Future Ideas

A parking lot for researched-but-not-yet-actioned directions — distinct from
`docs/ISSUES.md` (a log of what's already fixed and verified) and
`docs/HANDOFF.md` §7 (the committed near-term roadmap). Entries here are
"worth doing, not yet decided or scheduled," typically because they need a
product decision, a budget/licensing call, or more investigation before
anyone should start writing code. Promote an entry to `ISSUES.md` (as a
tracked, in-progress fix) once work actually begins.

---

## Frame budget: two follow-ups from the F236 cost-table correction (2026-09-14)

**Trigger.** F236 (`docs/ISSUES.md`) replaced most of `sceneCost.ts`'s
op-count estimates with a real `/bench` sweep on the user's own hardware
(RTX 4060-class GPU, Ryzen 7), after several scenes turned out to be priced
wrong by up to 304x. Two things came out of that fix that are real work, not
done as part of it:

- **Regenerate `SCENE_COST_MODEL`.** The resolution-parametric fit (used
  whenever a live `internalMP` is passed to `sceneCostMs()`) is now
  knowingly stale for the eleven scenes it covers — fitted from the
  2026-08-27 sweep F236 just superseded for the flat per-tier table. A
  correct refit needs real per-cell `internalMP`, which F236's sweep
  report didn't capture for the no-chain pass (the postchain-delta pass
  did report MP, so a rerun capturing it for both passes would close this
  in one sweep). `sceneCost.test.ts`'s cross-check between the model and
  the table is `it.skip`'d with the full reasoning, waiting on this.
- **Calibrate the ladder's floor on genuinely weak hardware — partially
  closed by F238 (`docs/ISSUES.md`).** The requested M1 MacBook sweep was
  run, and it confirmed the fear: `POST_CHAIN_MS`'s fixed reservation was
  5.8x wrong on that machine relative to the RTX 4060 it was tuned on.
  F238 responded by making that ONE reservation self-calibrating per device
  (a live EMA from the whole-frame GPU timer already running every session,
  gated to isolate the chain's own cost) rather than hand-picking a second
  static number — so this specific anchor point no longer needs a repeat
  `/bench?postchain` exercise on every new device class. **Still open**:
  `sceneCost.ts`'s PER-SCENE costs and `TIER_BUDGET_MS`'s ladder itself
  remain flat numbers measured on exactly the 4060/Ryzen 7 class machine
  (`sceneCost.ts`'s own header already admits they "scale with the
  machine"), unaddressed by F238's narrower fix. Whether the survival tier
  is actually low enough for the M1 class, or whether per-scene costs need
  the same self-calibration treatment F238 gave the post chain, is still
  unanswered.

---

## Mood analysis: a commercially-clean alternative to MusiCNN (2026-09-13)

**Trigger.** `voice.worker.ts`'s five mood/voice heads run on Essentia's
`msd-musicnn-1` weights, CC BY-NC-SA 4.0 — NonCommercial + ShareAlike (see
`docs/HANDOFF.md` §6). Gitignored, absent by design, additive-neutral when
missing (`f.moodsValid` gate) — the product ships fine with ML off today.
This entry is about what a *better-than-off* commercial-safe path would
actually look like, researched but not started.

### Alternatives surveyed

| Model | Licence | What it gives you | Catch |
|---|---|---|---|
| **YAMNet** (Google) | Apache 2.0 — verified permissive | ~3.7MB, same footprint class as MusiCNN, official TF.js port exists | General AudioSet sound-event tagging (521 classes: "music," "dog bark," "speech"), **not mood** — a mood head still has to be trained on top of its embeddings |
| **OpenL3 / PANNs** | Not yet verified — repos found, licence text not confirmed | General-purpose audio embeddings, moderate size (tens of MB) | Same shape as YAMNet: embeddings only, own mood head required. Verify licence before relying on either. |
| **LAION CLAP** | LAION generally permissive-leaning; confirm the *specific checkpoint's* licence before shipping | **Zero-shot** — classify audio against arbitrary text prompts ("aggressive electronic," "calm ambient") with no training at all. A live in-browser demo already exists (webai.show). | Much bigger than MusiCNN (SWIN Transformer + RoBERTa, likely 100M+ params) — needs real benchmarking in this app's worker/frame-budget constraints before trusting the 12s cadence stays cheap |
| **Pay Essentia/MTG for a commercial licence** | MAEST's own model card explicitly offers "proprietary licence upon request" — Essentia likely offers the same for `msd-musicnn-1` | Keep the exact models already integrated, zero re-engineering | Costs money (unknown pricing) — worth one email before building anything else on this list |

None of these are a drop-in weight swap. Every non-CLAP option means
training a *new* mood classifier on top of someone else's legally-clean
embeddings — MusiCNN's specific mood heads aren't matched anywhere else for
free-and-permissive.

### How hard is training, actually

Two very different asks live under "train a model":

- **Retrain the embedding backbone itself (MusiCNN's own convolutional
  stack) from scratch** — hard, not a side-project scope. Needs tens of
  thousands of labelled tracks, real GPU time (days, not hours), and
  genuine ML engineering to match the original paper's accuracy.
- **Train a small classifier head on top of a frozen, already-good,
  permissively-licensed embedding model** — this is what Essentia itself
  did (one shared embedding + five tiny per-mood heads), and it's
  tractable in days: extract embeddings for a labelled dataset (a batch
  job, hours not days), train a small MLP/logistic-regression head per
  mood (minutes on a CPU given a few thousand examples), validate, tune
  thresholds.

**The real bottleneck is the labelled data's licence, not compute.**
MTG-Jamendo's *dataset framework* is Apache-2.0, but the underlying audio
is individually Jamendo-uploader-licensed — this repo's own
`testfolder/README.md` already documents that a chunk of the set actually
in use here is CC BY-NC-SA. Training a *commercial* mood head on the
mood/theme subset (18,486 tracks) would need filtering down to only the
CC BY / CC BY-SA tracks first, which shrinks the usable set by an unknown
amount.

**What this can't be used for**: a personal DJ set list. Too small a
sample to generalize a classifier from, and it doesn't solve the licensing
question either — that's a *calibration* corpus (tune existing thresholds
— what `npm run calibrate` already does), not a *training* corpus. Those
are different jobs with different data requirements.

### Recommended sequencing, if this is ever picked up

1. Email Essentia/MTG about a commercial licence for the existing
   `msd-musicnn-1` + mood heads. Cheapest option by a wide margin if
   affordable — zero re-engineering.
2. In parallel or if (1) falls through: a quick feasibility spike on CLAP
   zero-shot in a worker, measuring real inference cost against this
   app's frame/worker budget, before investing further.
3. If neither works out: YAMNet + a self-trained head on a CC-BY-filtered
   MTG-Jamendo mood subset. The realistic DIY path, but the most work.

### On a longer/sliding classification window (considered, not pursued)

Each MusiCNN inference is already fixed at ~3.0s (187 mel frames — the
model's own trained input shape, not a runtime tunable). What's actually
coarse is that `VoiceBridge` batches these into **non-overlapping**
3-second patches (a tumbling window) inside a 12-second job, fired only
once every 12 seconds — so the mood-head numbers are frozen for a full
12s, then jump. A genuinely smoother read would mean *overlapping* patches
at a shorter hop, at a proportional CPU cost. Not pursued because it
doesn't address the actual "stuck on groove" complaint (see the next
section) — that's a DSP scoring-thresholds problem, not a temporal-
resolution one.

### A local LLM call (considered, rejected for the live path)

Real audio-*understanding* LLMs (Qwen2-Audio, GAMA, MusiLingo) are built on
7B-parameter backbones — dedicated-GPU territory, not a browser tab
competing with a 60fps render loop. The small browser-capable LLMs (Gemma
3 270M, Qwen3.5-0.8B) have no native audio understanding — using one would
still need the same mel-spectrogram front-end already in place, with a
much bigger, much slower reasoning layer bolted on for no demonstrated
accuracy gain. This matches `docs/HANDOFF.md`'s already-stated position:
ML fits the *offline, manual calibration aid* slot (feed fixture tracks
through it once, diff against the estimator, retune) — never a live
per-session call.

---

## Related open items from the same investigation (already diagnosed, not yet fixed)

Logged here as pointers rather than duplicated in full — see the
referenced turns/entries for the complete reasoning.

- **`groove`'s DSP band/floors are too generous relative to its
  neighbours** (`E_GROOVE_LO`/`E_GROOVE_HI` = 0.38..0.8, `CONF_FLOOR` =
  0.65) — the fix that helps every session regardless of whether MusiCNN
  weights are present. F235 wired two previously-unused mood heads
  (`aggressive`, `relaxed`) into the scorer as a lower-risk first step;
  this band/floor rebalance is the harder, higher-impact half, not yet
  attempted because it needs live verification against real material this
  sandbox can't provide.
- **No confidence/ambiguity gate on the mood-driven optical racks.**
  `AutoPilot` refuses to act on a mood change below
  `MOOD_CHANGE_MIN_CONFIDENCE`/above `MOOD_CHANGE_MAX_AMBIGUITY`
  (`autoPilotGates.ts`). The mirror/lens/echo racks
  (`PerformanceStateBridge.tsx`, `opticalDirector.ts`) react to `m.state`
  directly with no equivalent gate, so a shaky/borderline mood read that
  AutoPilot would correctly ignore can still cause the racks to re-pick.
- **No cross-fade between adjacent moods' pools.** Hysteresis smooths
  *when* a mood commits, but the moment it does, every downstream table
  (palette pool, camera pool, lens pool) switches as a hard set-to-set
  jump — a track sitting right on a boundary gets a simultaneous shift
  across every system at once, softened only by timing, not by blending
  two moods' outputs.

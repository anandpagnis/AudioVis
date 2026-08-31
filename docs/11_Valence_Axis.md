# Document 11 — The Valence Axis

> **Audience:** audio/DSP engineers, AI-director authors.
> **Status:** planned, not built. v1 is ~1.5–2 days and low-risk; v2 is ~1 week
> and mostly waits on the AutoPilot/PerformanceDirector planner merge
> (`HANDOFF.md` §7 #2).

---

## 0. Why

Mood today is **one axis** — `MoodState` is a 7-element array ordered calm →
hype (`silence … aggressive`). Two very different tracks land in the same state:
a euphoric trance drop and a dark techno grind are both `peak`, and `peak` vs
`aggressive` only splits on "fast vs harsh". There is no
**euphoric ↔ menacing** distinction anywhere, and it is most missing exactly
where energy is high and the show is loudest.

Add **`valence`** — a scalar `0..1` (0 = dark/cold/tense, 0.5 = neutral,
1 = bright/warm/euphoric) — as a second, orthogonal axis.

**Scoping rule that runs through both versions: valence changes the *colour and
atmosphere* of the show, not the *choreography*.** Scene rate, camera motion,
speed and punch stay keyed to energy. Valence drives palette temperature, the
bloom/glitch/fog character, and — in v2 — which *kind* of scene and cut.

Two releases, gated on real-music testing between them:

| | scope | risk | effort |
|---|---|---|---|
| **v1** | the `valence` signal + palette-family selection + post/atmosphere tint + observability + calibration | low — purely additive, gates nothing, doesn't touch `score()` | ~1.5–2 days |
| **v2** | quantized `tone` bucket, tone-aware scene selection, continuous palette interpolation, valence-aware transitions, scene-internal hook, planner integration | medium — one genuine hazard (continuous palette blend, the F48 code path) | ~1 week, spread across the planner merge |

---

## 1. The signal (shared by v1 and v2)

### 1.1 Definition

`m.valence ∈ [0, 1]`, slow-smoothed so it reads as weather, not a switch —
same ~3 s time constant as `m.brightness` / `m.level`.

### 1.2 Inputs — all already computed, no new DSP

| input | weight | rationale |
|---|---|---|
| `m.brightness` (slow-smoothed `f.centroid`, now full-spectrum after F154) | **0.40** | brightness is the single strongest valence correlate |
| key mode — `f.scale` major/minor × `f.keyConfidence` | **0.25** | major → positive, minor → negative; scaled by confidence so an unsure read contributes ≈ 0. Essentia `KeyExtractor` already runs (section-triggered). |
| `clamp01((f.crestFactor − CREST_LO) / CREST_RANGE)` | **0.15** | dynamic / open material reads positive; brick-walled reads flat and tense |
| `1 − clamp01(f.spectralFlatness)` | **0.20** | tonal = consonant / positive; noisy / distorted = negative |

```ts
const keySign = f.scale === 'major' ? 1 : f.scale === 'minor' ? -1 : 0
const keyVal01 = 0.5 + 0.5 * keySign * f.keyConfidence // 0.5 when unknown/unsure
const dspValence = clamp01(
  0.40 * m.brightness +
  0.25 * keyVal01 +
  0.15 * clamp01((f.crestFactor - CREST_LO) / CREST_RANGE) +
  0.20 * (1 - clamp01(f.spectralFlatness)),
)
```

Weights sum to 1.0; every term is already `0..1`. Final values come from the
corpus (§5) — treat these as the starting point.

### 1.3 MusiCNN blend — used only when the model is present

`f.moods` (`{ happy, aggressive, party, relaxed }`, from `voice.worker.ts`) is a
trained read of human mood labels, but its weights are gitignored / CC BY-NC-SA
(`ISSUES.md` F13), so `f.moodsValid` is `false` in a fresh checkout.

```ts
const musicnnValence = clamp01(
  0.5 * f.moods.happy + 0.3 * f.moods.relaxed + 0.2 * (1 - f.moods.aggressive),
)
const target = f.moodsValid ? lerp(dspValence, musicnnValence, 0.7) : dspValence
```

Lean toward the model when it exists; **never depend on it** — the DSP term
carries the feature on its own.

### 1.4 Smoothing + exposure

```ts
m.valence += (target - m.valence) * Math.min(1, f.delta * VALENCE_SMOOTH) // ≈ 0.3
```

`createEmptyMood()` / `reset()` seed `valence: 0.5` — a fresh source is neutral,
not dark.

### 1.5 Files (signal only)

| file | change |
|---|---|
| `src/audio/types.ts` | `MoodMomentum.valence: number`; `createEmptyMood()` → `valence: 0.5` |
| `src/audio/MoodEstimator.ts` | `VALENCE_SMOOTH` const; a `keySign(f)` helper; the compute block in `update()`, placed after the confidence block and before `predict()` |
| `src/audio/__tests__/MoodEstimator.test.ts` | valence rises with `f.centroid`, falls with `f.spectralFlatness`, major > minor at equal `keyConfidence`, is 0.5 on empty/silence, ignores `f.moods` when `!moodsValid` |

---

## 2. v1 — palette + post

Ship this, then **play a euphoric and a dark track through it at similar
energy** (the v1 acceptance gate). Only start v2 once that reads right.

### 2.1 Palette-family selection — `src/engine/AutoPilot.tsx`

**Current** `pickPalette(moodPalettes, current, keyFamily, lastPick, rotation)`:
filters valid → drops `current` and `lastPick` for freshness → returns
`keyFamily` if it survived (the harmonic anchor wins) → else
`pool[rotation % pool.length]` (deterministic cycle).

**Change:** add a `valence` parameter and replace the final fallback line. The
pools in `MOOD_PALETTES` are already loosely warm-ordered ("ambient" = colds and
neutrals, "building" = "moves toward amber/rust", "peak" = the rainbows) — make
each one *strictly* cool → warm (a one-time manual sort, ~30 min, using the
`PaletteFamily` grouping) and pick the slot from valence:

```ts
export function pickPalette(
  moodPalettes: string[],
  current: string,
  keyFamily: string,
  lastPick: string,
  rotation: number,
  valence: number, // NEW
): string | null {
  // …existing valid/fresh/pool derivation, unchanged…
  if (keyFamily && pool.includes(keyFamily)) return keyFamily // key still wins
  // valence picks the slot; rotation only jitters within a ±1 band so a held
  // valence still explores a little and a recorded set still repeats.
  const center = Math.round(valence * (pool.length - 1))
  const jitter = (Math.abs(rotation) % 3) - 1 // -1, 0, +1
  const idx = Math.min(pool.length - 1, Math.max(0, center + jitter))
  return pool[idx]
}
```

Determinism holds — `valence` is a pure function of the audio.

**Consumers:** the one call site in `AutoPilot` (pass `f.mood.valence`), and
`PerformanceDirector.tsx`'s section-path palette picks — route both through the
same 6-arg signature.

**Tests:**
- `paletteCoverage.test.ts` — its "every id reachable" assertion still holds
  after the re-order (no structural change); add: simulate 600 picks at
  `valence 0.1` vs `0.9`, assert the cold end of each pool dominates at 0.1 and
  the warm end at 0.9.
- `paletteRotation.test.ts` — update for the new arg; determinism assertion
  unchanged.

### 2.2 Post / atmosphere — `src/engine/PerformanceStateBridge.tsx`

`performanceState` already carries `bloom` (0..2 strength), `bloomThreshold`
(0..1, "the most expressive single float in the post chain"), `glitch`, `fog`.
No new fields — valence rides these. Every term is small and sits behind the
existing tension / drop gates:

| field | valence term | effect |
|---|---|---|
| `bloomThreshold` | `−= (m.valence − 0.5) * BLOOM_VAL` | high valence lowers the threshold → *more of the frame* blooms → bright, expansive. Low valence raises it → only the hottest pixels glow → tight, dim. |
| `bloom` | `*= 1 + (m.valence − 0.5) * 0.2` | mild strength trim; dark reads less glowy |
| `glitch` | `ceiling *= 1 + (1 − m.valence) * GLITCH_VAL` | a dark track's transients read as RGB-split artifacts; a euphoric one stays clean. **Tension stays the trigger** — this only raises the cap. |
| `fog` | `+= (1 − m.valence) * FOG_VAL` on density | low valence = thicker, more oppressive air (already tinted to the palette background) |

There is already a `relaxedAir = f.moodsValid ? f.moods.relaxed * 0.2 : 0` term
(~line 273) — the valence version generalises it (works without the model);
fold `relaxedAir` into it rather than stacking both.

New consts (`BLOOM_VAL`, `GLITCH_VAL`, `FOG_VAL`) at the top of the bridge,
tuned by eye against a real track.

**Test:** no `PerformanceStateBridge` test exists yet — add a focused one:
sweep a synthetic `m.valence` 0 → 1 with everything else fixed, assert
`bloomThreshold` falls monotonically, `glitch` ceiling and `fog` rise
monotonically.

### 2.3 Observability — `src/ui/DebugPanel.tsx` + `src/ui/AnalyticsPanel.tsx`

Required, not optional — you cannot tune what you cannot watch.

- `DebugPanel`: add `val 0.xx` to the mood line, next to `mood` / `conf` /
  `ambig`.
- `AnalyticsPanel`: a valence sparkline, reusing `RollingWindow` and the same
  sparkline component the mood-confidence / ambiguity traces use.

### 2.4 Calibration — `scripts/calibrate/`

| file | change |
|---|---|
| `features.ts` | `FrameSample.valence`; push `f.mood.valence` |
| `report.ts` | `distributions()` gains a `valence` percentile table |
| `harness.calib.ts` | for tracks with a `moodTheme` tag in `corpus/tracks.json` (`happy` / `sad` / `dark` / `melancholic` / …), add an `eval-report.md` column: mean valence vs a coarse tag → expected-valence map (`happy` → 0.75, `dark` → 0.25, …). Not a hard assert — the tags are noisy — just visible. |

Run `npm run calibrate`; want `valence` p50 ≈ 0.45–0.55 and p10–p90 spanning
~0.2–0.8 (spread, not bunched), and the tag column trending the right way.
Retune the four §1.2 weights, keep them summing to 1.0.

### 2.5 v1 acceptance

1. `npm run check` green.
2. `npm run calibrate` — valence distribution centred and spread; tag-agreement
   column trends right.
3. **Real music** (the gate): a euphoric and a dark track at similar energy —
   palette, bloom and glitch visibly differ; no tone whiplash; the `val`
   readout matches your ears. This decides whether v2 is worth doing.

### 2.6 v1 file list + effort

| file | change | ~effort |
|---|---|---|
| `src/audio/types.ts` | `valence` field + default | 10 min |
| `src/audio/MoodEstimator.ts` | signal + `VALENCE_SMOOTH` + `keySign` | 2 h |
| `src/audio/__tests__/MoodEstimator.test.ts` | 5 tests | 1 h |
| `src/engine/AutoPilot.tsx` | `pickPalette` 6th arg + pool re-order + call site | 3 h |
| `src/engine/PerformanceDirector.tsx` | route palette picks through the new signature | 30 min |
| `src/engine/__tests__/paletteCoverage.test.ts`, `paletteRotation.test.ts` | valence-skew + arg updates | 1 h |
| `src/engine/PerformanceStateBridge.tsx` | bloom/glitch/fog valence terms + consts | 2 h |
| `src/engine/__tests__/` (new) | bridge valence-monotonicity test | 45 min |
| `src/ui/DebugPanel.tsx`, `AnalyticsPanel.tsx` | `val` readout + sparkline | 1.5 h |
| `scripts/calibrate/{features,report,harness}` | `valence` field + table + tag column | 2 h |
| `docs/02_Music_Intelligence.md` | add `valence` to the Timbre / Energy chapter | 20 min |

**≈ 1.5–2 days**, then the real-music gate.

---

## 3. v2 — the full axis

Incremental. Order below is dependency + risk order: do 3.1 → 3.2 → 3.4 → 3.5
(independent, low-risk, ~3 days total), then 3.3 (the risky one, behind a flag),
and fold 3.6 into the planner merge whenever that happens.

### 3.1 Quantized `tone` bucket — foundation, ~½ day

`MoodMomentum.tone: 'dark' | 'neutral' | 'bright'` — bucket `m.valence` at
≈ 0.40 / 0.60 **with hysteresis**: a `toneSince` clock and a ~2 s hold before a
flip, the same shape as `MoodEstimator`'s `candidateSince` / dwell lock, so a
valence hovering on a boundary doesn't chatter scene / transition decisions.

- `src/audio/types.ts` + a small FSM in `MoodEstimator.update()` next to the
  mood-state hysteresis.
- `DebugPanel`: draw the mood as a dot in a 2 D energy × valence square instead
  of a 1 D bar.

### 3.2 Tone-aware scene selection — ~1 day (mostly classification + validation)

- `SceneMetadata` (`src/scenes/index.ts`): add `tone?: ('dark'|'neutral'|'bright')[]`
  (an array — a scene can suit two). First-pass classification of the 11, to be
  corrected by eye against a dark vs bright track:
  - **bright:** `kifs` (rose window), `ribbons` (flowing traces), `wingfold` (Julia bloom)
  - **neutral:** `wireframe`, `chrome`, `plasma`, `malachite`, `pointcloud`
  - **dark:** `maze` (claustrophobic flythrough), `dissolve` (scattering), `matrix` (cold rain)
- `validateSceneDef` / the type: `tone` optional, default `['neutral']` so an
  unclassified scene stays eligible.
- `PerformanceDirector.tsx` (and the `AutoPilot` scene pick): multiply each
  candidate's selection weight by a tone-match factor (`1.0` match / `~0.4`
  mismatch / `1.0` for a `neutral` scene either way). A **bias, not a filter** —
  a mismatched scene can still win if it is the only fresh option.
- New test: with `m.tone = 'dark'`, dark-classified scenes win the pool over
  ~200 sims; neutral scenes stay always-eligible.

**Visual:** the scene *geometry* now tracks tone — a dark slam stops drawing
the euphoric mandala and gets claustrophobic / glitchy forms.

### 3.3 Continuous palette interpolation — ~1–2 days · the one real hazard

Replace v1's discrete slot-pick with a live two-anchor blend.

- On a mood-state change, `AutoPilot` sets `paletteAnchorCool` and
  `paletteAnchorWarm` — the coldest and warmest palette in that mood's pool
  (recency logic still chooses *which* pool / anchors).
- Per frame: `performanceState.paletteBlend = m.valence`
  (0 = cool anchor, 1 = warm anchor).
- The palette blend core (the same lerp the on-change crossfade already uses)
  takes `paletteBlend` as a **continuous live weight** instead of ramping
  0 → 1 on a discrete change.
- `keyPalette.ts`'s key → family vote stays a separate slow input — they
  compose: key picks the family hue centre, valence picks warm / cool within it.

**Risk mitigation — this is the code path `HANDOFF.md` blames for F48 three
times:**
- flag it (`?paletteBlend=1` / a store toggle); keep v1's discrete pick as the
  fallback; A/B them.
- **measure frame cost** — this is a per-frame palette change; verify no
  per-frame palette-object allocation (mutate in place, the way the F154 fog
  term does).
- extend `palettes.test.ts` / `paletteCoverage.test.ts` with blend-math and
  no-NaN cases across the full `valence` range.

**Visual:** colour *breathes* with the music continuously instead of stepping
at boundaries. The single most "premium-feeling" v2 item.

### 3.4 Valence-aware transition vocabulary — ~1 day

The transition selector (in `SceneManager`'s crossfade commit, or a
`chooseTransition(from, to, ctx)` helper — check the "transition vocabulary"
work already on `fix/volume-independent-reactivity`) keys off `to.tone` × energy:

| entering | transition |
|---|---|
| `tone: 'dark'` + high energy | hard cut, or the glitch / RGB-split wipe (`dropEdge` hard-cut + `LensPass` + the panic glitch already exist) |
| `tone: 'bright'` | bloom-swell crossfade — ramp `performanceState.bloom` above `BLOOM_BASE` through the fade, decay back after |
| low energy, any tone | the existing long dissolve |

`predictedValence` (§3.6) lets the F153 drop pre-arm pick the transition style
*before* the drop lands.

**Test:** `chooseTransition` returns the expected style for each (tone, energy)
quadrant.

**Visual:** the *feel of the cut* matches what you land in — a slam lands hard,
a euphoric lift blooms in.

### 3.5 Scene-internal valence hook — ~½ day + per-scene

- `src/engine/sceneFrame.ts`: add `valence: number` to the `useSceneFrame`
  context (from `f.mood.valence`).
- Opt-in per scene: `maze` fog colour cools at low valence, `kifs` orbit-trap
  laser warms at high valence, `pointcloud` emission tint. Most scenes ignore it
  and ride the shared blended palette.
- Document the new context field in `docs/05_Scene_Architecture.md`.

### 3.6 Predictive valence + planner integration — folds into `HANDOFF.md` §7 #2

- `MoodMomentum.predictedValence` — project the valence slope over ~4 s, the way
  `predict()` projects the state. Feeds the pre-arm and the §3.4 transition
  pre-selection.
- When AutoPilot + PerformanceDirector merge into the one planner,
  `valence` / `tone` / `predictedValence` become `Decision` inputs, with a
  **"no tone whiplash"** constraint (≤ 1 tone flip per ~16 beats unless a
  section boundary) alongside the four `docs/03_AI_Performance_Director.md`
  already types.

### 3.7 v2 acceptance

- Each sub-item ships behind its own `npm run check` + real-music A/B.
- 3.3 specifically: no frame-time regression (measured), no F48-class flicker,
  flag-gated rollback available.
- Full-set test: a real DJ set — scene geometry tracks tone, colour breathes
  rather than steps, cuts feel right, the system pre-warms before drops.

### 3.8 v2 effort

≈ 1 week as a block; realistically spread. 3.1 → 3.2 → 3.4 → 3.5 are
independent and low-risk (~3 days). 3.3 is the ~1–2 day hazard — do it last,
behind a flag. 3.6 waits on the planner merge.

---

## 4. Risks & sequencing

- **Stacks on the still-interim F121 mood calibration.** Valence is additive —
  it doesn't change `score()`, doesn't gate anything — so it is *lower* risk
  than most next steps, but the four §1.2 weights want a real-music tuning pass.
- **v1 lands before "play real music through it"** (`HANDOFF.md` §0 / §7 #1).
  Acceptable *because* v1 is additive and its acceptance gate **is** a
  real-music test. Do not start v2 until that passes.
- **§3.3 (continuous palette blend) is the one genuine hazard** — F48 lived
  there. Flag it, keep the discrete fallback, measure frame cost.
- **Licence:** the MusiCNN blend (§1.3) rides `f.moods`, which is CC BY-NC-SA /
  gitignored (F13). v1 and v2 both work without it. Never make valence
  *depend* on the model.

## 5. Calibration recipe (both versions)

1. `npm run calibrate` → read the `valence` percentile table. Want p50 ≈
   0.45–0.55, p10–p90 ≈ 0.2–0.8 (spread, not bunched).
2. Read the `moodTheme` tag-agreement column. If `dark`-tagged tracks read
   valence > 0.5, drop the brightness weight / raise the flatness weight.
3. Adjust the four §1.2 weights; re-run; keep them summing to 1.0.
4. **Real music is the final arbiter** — the `val` readout must match your ears
   on a handful of tracks you know. The corpus is 96 kbps and can't be trusted
   on brightness-adjacent cues (same caveat as F154 `sparkle`).

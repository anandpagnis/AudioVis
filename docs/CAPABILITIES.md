# AudioVis — Technical Capability Assessment

Written for an LLM or engineer picking this up cold and needing to gauge what
exists, how well, and what is missing. Facts only; no roadmap framing.

**Scope note:** licensing, auth, billing and hosting are deliberately excluded
at the reader's request. They are real blockers for a commercial release and are
tracked in `docs/ISSUES.md` (F01–F03). Everything below is engine-technical.

---

## 1. What it is

A browser-based audio-reactive visual engine ("AI VJ"). It listens to live
audio, extracts musical structure, and drives a directed visual performance —
choosing scenes, palettes, camera behaviour and post-processing to match, and
committing changes on musical boundaries rather than on a timer.

**Stack:** React 19, React Three Fiber, Three.js r178, Zustand, Vite 7.
`essentia.js` (WASM) and TensorFlow.js (WASM backend) run in workers.
~22.4k LOC of source, ~5.0k LOC of tests, 394 tests, deployed as Cloudflare
static assets.

**The differentiator:** it reacts to song *structure* — tempo grid, phrase and
section boundaries, drops, key, mood trajectory — not just to spectrum. Most
comparable tools react to the last ~20 ms of audio.

---

## 2. Implemented and working

### 2.1 Audio analysis
- **Input:** system/tab audio (`getDisplayMedia`), microphone/line-in
  (`getUserMedia`), local file. A `startWithStream(MediaStream)` extension point
  exists for virtual cables.
- **~65 features** on a single per-frame `AudioFeatures` object: 8 frequency
  bands (sub/bass/mid/presence/high/vocal/air/energy), RMS, crest factor,
  spectral centroid / flatness / rolloff / flux, transient envelope.
- **Independent drum envelopes** — kick, snare, hi-hat detected separately from
  the broadband onset detector that owns beat timing.
- **Band-passed lead waveform** (`midWaveform`) exposed as a time-domain buffer
  so scenes can trace the melody rather than the drums.
- **Adaptive normalisation** — band levels are normalised against a rolling
  program reference, so visuals respond to musical dynamics rather than playback
  volume. Silence detection is relative to program level with hysteresis.
- **Tempo:** onset-flux BPM estimation with a phase-locked beat grid; beat, bar,
  measure and phrase counters; confidence and grid-accuracy scores. Optional
  external MIDI clock sync.
- **Structure:** phrase novelty detection, section-change flags with strength,
  drop and build-up heuristics.
- **Off-thread ML** (workers): key + scale with confidence, danceability,
  vocal presence, and four mood axes (happy / aggressive / party / relaxed) via
  essentia.js + TFJS. All optional — a `moodsValid` flag makes absence explicit
  rather than reading as zero.
- **Mood engine:** seven committed states (silence, ambient, mellow, groove,
  building, peak, aggressive) with hysteresis, plus a *predicted* next state and
  estimated beats-until-transition, used to pre-queue scenes so a change lands
  on the drop rather than after it.

### 2.2 Direction / automation
- **AutoPilot** — reacts to committed mood changes, imminent predicted
  transitions, and drops. Picks scene and palette.
- **PerformanceDirector** — recomposes the layer stack at section boundaries,
  with a 16-beat phrase fallback.
- **CueTimeline** — authored cues anchored to beat positions; when governed,
  it overrides both directors.
- **CameraDirector** — 9 camera modes (orbit, hover, push, pull, spiral,
  handheld, locked, topdown, cinematic) driven from per-scene anchors.
- **AnimationDirector** — shared animation primitives computed once centrally
  so N scenes cost the same as one.
- **Weighted selection** with recency avoidance and per-band boosting, so the
  same two scenes do not monopolise a mood.
- **Rate limits:** 32-beat dwell floor on the subject, 16-beat floor on layers,
  45 s manual-override hold.

### 2.3 Rendering / composition
- **18 scenes** (16 active, 2 withheld), all GPU-procedural: raymarched SDFs,
  2D fractals, particle systems, feedback-buffer scenes, one PBR/IBL scene.
- **Four-slot composition:** background / primary / accent / overlay, plus an
  event-triggered effect slot. Per-layer gain and blend mode
  (add / screen / normal / multiply), with a descending default gain ladder.
- **Beat-locked transitions:** switches commit on a downbeat when the grid is
  trusted, crossfade over ~2 beats, and hard-cut on drops or when the frame
  budget cannot fund the overlap.
- **Shader pre-warm:** incoming scenes mount and compile before the commit, so
  the compile stall does not land on the beat.
- **Post chain:** bloom (mipmap), chromatic aberration, vignette, exponential
  fog — structurally fixed and modulated only by uniform, because changing the
  effect list rebuilds the merged shader.
- **Palette system:** 6 palettes with smooth blending, auto-selected by musical
  key family.
- **Context-loss recovery:** full resource invalidation and render-tree remount.

### 2.4 Performance system
- **Quality governor:** 5 tiers scaling *complexity* (raymarch steps, iteration
  counts, noise octaves, particle fraction) as well as resolution. Steps on both
  mean frame time and p95, expressed as multiples of the measured display
  refresh interval.
- **Frame budget:** unified cost accounting (`frameLoad.ts`) covering subject,
  crossfade overlap, layers, effects and fixed per-frame costs, enforced *at
  render time* every frame, not only at decision time.
- **Transition discount:** complexity eases down while two primaries share the
  frame.
- **Scene benchmark** (`/bench`, dev-only): sweeps every scene across every tier
  in isolation and reports real GPU milliseconds via
  `EXT_disjoint_timer_query_webgl2`.

### 2.5 Output / UI
- Fullscreen canvas, auto-hiding chrome, keyboard-driven.
- BPM/beat/mood readout; fps + p95 + tier + frame-budget meter (`J`);
  audio-analysis debug panel (`D`); accuracy/smoothness analytics panel (`Y`).
- WebM canvas+audio recording, PNG screenshot.
- Presets with import/export, performance cues, shareable URL parameters,
  localStorage persistence.

---

## 3. Measured performance data

GPU ms per frame, scene alone, no post chain, tier 1, from `/bench`:

| scene | GPU ms | scene | GPU ms |
|---|---|---|---|
| foldpath | 16.02 → ~4 after fix | chrome | 2.20 |
| network | 6.26 | ribbons | 2.14 |
| heap | 5.24 | torusfold | 1.99 |
| juliawings | 14.0 → 4.69 after fix | wireframe | 1.43 |
| kaleido | 3.15 | orbs | 1.25 |
| inversion | 3.06 | trail | 0.57 |
| synthgrid | 2.22 | dissolve | 0.38 |

Budget at 60 Hz is 16.67 ms for *everything*, including the post chain.

---

## 4. Technical gaps

### 4.1 Blocking quality issues
- **Four scenes ignore the quality governor entirely** — `network`, `chrome`,
  `orbs`, `panic` read no quality knob, so their cost is fixed at every tier.
  `network` is the second most expensive scene (6.26 ms, flat across all five
  tiers) and the governor cannot relieve it. (F42)
- **The post chain has never been measured.** It runs in every frame and its
  budget reservation (2 units) and the feedback pass's (1 unit, charged only
  while trails are running) are
  reasoned estimates, not data. `/bench` deliberately excludes post so scene
  costs compare cleanly — which leaves the one constant cost unmeasured. (F44)
- **Particle scene costs are unmeasured.** `plasma`, `dissolve`, `pointcloud`
  build geometry on a worker; the first benchmark run caught them partly
  unfilled. The bench is fixed but has not been re-run. (F33)
- **No verification against real music.** Eight reference tracks exist in
  `testfolder/` and have never been run end-to-end with frame-time captured.
  Everything above is measured in isolation or reasoned from code.

### 4.2 Content and composition
- **The layer pool is 4 scenes wide** (`plasma`, `ribbons`, `network`, `orbs`)
  serving 2–3 slots, so layer variety is structurally poor. At `peak` and
  `aggressive` the pool is a *single* scene. This is the root cause of "one
  layer is always on screen" and no amount of weight tuning fixes it. (Issue 3)
- **The background slot has zero content** — no scene declares the role, so the
  most structural composition slot is permanently empty. (F18)
- **The effect slot is fully built and completely empty** — director, lifecycle,
  pinned entries, trigger edges and tests all exist; `getEffectScenes()` returns
  nothing. This is the cheapest available upgrade to how a drop *feels*. (F20)
- **Two primaries can never have layers** (`plasma`, `network`) because their
  compatibility closure contains only primary-only scenes. Layer presence is an
  accident of the graph rather than a decision. (F19)

### 4.3 Instrumentation
- **No GPU headroom signal in production.** `delta` is vsync-locked wall clock,
  so until the budget is blown it reads exactly one refresh interval whether the
  GPU was at 10% or 95%. The only live signal is binary "already too late". The
  timer-query code exists but is used solely by `/bench`. (F26)
- **No spike attribution.** When a frame goes long there is no record of what
  was on screen, so steady cost and transition cost cannot be told apart from
  the logs. (F25)

### 4.4 Product-technical
- **No clean output path.** Nothing produces a chrome-free render surface for
  OBS or a projector beyond screen-capturing the whole page. No Syphon/Spout/NDI
  equivalent, no second-window output.
- **No MIDI control surface.** `MidiClock` exists for *sync* only; no mapping
  from controller input to scene, layer, palette or parameter.
- **No offline/deterministic render.** Everything is real-time only; there is no
  path from an audio file to a rendered video file.
- **Desktop-only by design.** Mobile and non-WebGL2 devices are hard-gated.

### 4.5 Unverified changes
A batch of recent performance work is typechecked, tested and built, but has
**never been rendered**: FoldPath's half-resolution offscreen buffer,
JuliaWings' removed antialiasing, Chrome's depth-write gate, and TorusFold's
`mat2` uniform (which can only fail at shader-compile time). Visual verification
is outstanding.

---

## 5. Honest summary

The **audio-understanding layer is the strongest part** and is genuinely
differentiated — structural listening, off-thread ML, volume-independent
normalisation, predictive transitions. The **direction architecture is sound**:
a clean decide/execute split, cost-budgeted composition, beat-locked commits.

The **weaknesses are content and verification, not architecture.** The scene
roster is thin where it matters (4 layer-capable scenes, no background scenes,
no effect scenes), several scenes bypass the performance system entirely, and
almost nothing has been confirmed against real music on real hardware. The
engine can express far more than the content currently gives it to express.

Full issue register with IDs, evidence and status: `docs/ISSUES.md`.

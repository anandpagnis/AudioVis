# AudioVis

A modern, browser-based audio-reactive visual engine — cinematic GPU visuals that lock onto the
*musical* structure of whatever you're listening to, not just its volume.

```bash
npm install
npm run dev      # http://localhost:5183
```

Open the app and pick a source: **System audio** (share a tab/screen with "Share audio"
enabled — works with Spotify, YouTube, anything), **Microphone / line-in** (USB interfaces
and virtual cables like BlackHole show up in the device picker), or **Audio file** (a local
track plays through your speakers while driving the visuals — great for rehearsing). Then go
fullscreen.

## Keyboard

| Key | Action |
| --- | --- |
| `1`–`9`, `0` | Switch scene (committed on the next downbeat when the beat grid is confident, then crossfaded over ~two beats) |
| `A` | Autopilot — the mood engine picks scenes and palettes for you |
| `C` | Capture a performance cue — the full current look, anchored to the current beat |
| `R` | Record the canvas + audio to a downloadable .webm |
| `S` | Save a PNG screenshot |
| `M` | Mood drive — mood scales intensity/speed/reactivity on top of your sliders |
| `G` | AI textures — mood-matched generated art from the local backend |
| `P` | Cycle color palette |
| `B` | Presets panel (built-ins + your saved presets, favorites, JSON import/export) |
| `T` | Tune panel (intensity / speed / reactivity + quality) |
| `F` | Fullscreen |
| `D` | Audio-analysis debug panel (spectrum, bands, BPM, confidence, phrase, drop/build flags) |
| `H` | Hide all UI |

Scene, palette, tune params, quality, mood toggles, and saved presets persist in `localStorage`.

## Mood engine (live + predictive)

AudioVis reads the *musical state* of the track, not just its volume. `MoodEstimator`
tracks trend velocities (energy, bass, spectral brightness) over a rolling window and
commits one of seven states with hysteresis: **silence · ambient · mellow · groove ·
building · peak · aggressive**. It also predicts where the song is heading — a build-up
projects its energy slope to estimate *beats until the peak*.

Three switches (all on by default, all in the tune panel):

- **Autopilot (`A`)** — the auto-VJ. On confident mood changes it requests the
  best-fitting scene and palette through the normal pipeline, so switches still land on
  downbeats and crossfade over ~2 beats. When a peak is predicted within ~4 beats it
  pre-queues the high-energy scene so the crossfade lands *on* the drop. Touch any
  manual control and it backs off for 45 s.
- **Mood drive (`M`)** — mood multiplies your intensity/speed/reactivity sliders
  (mellow ≈ 0.88×/0.72×/1.15×, peak ≈ 1.32×/1.25×/1.4×), eased over ~1.5 s so shifts
  feel like weather, not switches.
- **AI textures (`G`)** — see below.

The debug panel (`D`) shows the live read: `building → peak in ~6b  82%  vE +0.31`.

## AI textures (local Stable Diffusion)

A local sd-turbo server generates mood-matched abstract art that washes over whatever
scene is playing (audio-warped, beat-shimmering, crossfaded in-shader). Fully optional —
without the backend the app is simply 100% procedural.

```bash
backend/run.sh    # one-time: creates venv + installs deps; first run downloads ~2.5 GB
```

Runs on Apple Silicon (MPS), 512×512 at 2 diffusion steps, on port 8787. Generation
takes seconds to ~a minute depending on the machine and what else is using the GPU —
it happens fully in the background and fades in whenever it's ready. Every
mood × palette × style combo is generated once and cached on disk in
`backend/textures/`, so a library builds up across sessions and repeats are instant.
The frontend prefetches the *predicted* mood's art, so the drop's texture is ready
before the drop hits.

## Performance

Quality defaults to **auto**: a frame-time monitor walks a 5-step resolution ladder —
dropping resolution quickly when frames slip below ~50 fps, climbing back only after
sustained headroom. Fixed low/medium/high pins are available in the tune panel (low also
drops the chromatic-aberration pass). The debug panel (`D`) shows live fps, render scale,
and GPU telemetry (draw calls, triangles, geometry/texture/program counts). All scenes
dispose their GPU resources on switch; heavy scenes are single draw calls (30k-star
galaxy, 48-ribbon field) or instanced meshes. The app is code-split: each scene and the
AI layer load as their own chunks (prefetched when you request them), with three.js/react
in long-cacheable vendor chunks.

## Response shaping & band routing (tune panel)

- **Attack / Release** — how fast the analyzed bands rise and fall (0.25–3×). Snappier
  attack for percussive sets, slower release for washy ambient.
- **Pulse** — beat subdivision: `½×` stretches the pulse across two beats (half-time
  feel), `2×`/`4×` add softer ticks between grid beats.
- **Routing** — up to six declarative band mappings, e.g. `bass → intensity +0.5` or
  `vocal → reactivity +0.8`. Each maps an envelope (sub, bass, mid, presence, high,
  vocal, energy, transient, beatPulse) onto intensity/speed/reactivity with a signed
  amount. Applied globally on top of your sliders and mood drive.

## Composition layers (presets panel)

A primary scene can run with one **accent** and one **overlay** layer. Each active layer
gets an intensity slider (0–1.5×) and a blend mode — `add` (default), `screen`
(brightens without blow-out), `normal`, `multiply`. Layer choices and their FX are saved
with presets.

## Performance cues (presets panel)

Author a visual journey through a specific track: play it (the **Audio file** source is
ideal), build a look, press `C` at the moment it should fire — the full look (scene,
layers, palette, params, layer FX) is captured at that beat. With **follow** on, replaying
the track from the start fires each cue as its beat arrives, still committing on downbeats
and crossfading. Cues override the autopilot/director while they govern; automation
resumes 32 beats after the last cue. Cues persist, save into presets, and travel in share
URLs.

## Sync & sharing

- **MIDI clock** (tune panel) — locks the beat grid to an external MIDI clock (DJ
  controller, drum machine, DAW bridge). Onset-based estimation pauses while the clock
  runs and resumes automatically if it stops.
- **share** (presets panel) — copies a URL that reproduces your current look and cue
  timeline on any machine running the app.

## OBS / wallpaper mode

Configure a chromeless instance entirely from the URL:

```
http://localhost:5183/?scene=tunnel&palette=ember&ui=hidden&quality=low&reactivity=1.4
```

`scene`, `accent`, `overlay`, `palette`, `ui=hidden`, `quality=auto|low|medium|high`, `intensity`, `speed`,
`reactivity`, `autopilot=0|1`, `mooddrive=0|1`, `gen=0|1`. URL values override saved
settings — ideal for OBS browser sources or a projector rig
(`?ui=hidden&autopilot=1&gen=1`).

## Extending

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full extension guide: `registerScene()` /
`registerPalette()` plugin APIs, `audioEngine.startWithStream()` for arbitrary audio
inputs (virtual cables, OBS, network, MIDI-driven synths), the scene contract, and the
WebGPU migration path.

For a detailed engineering handoff — including the current vision, implemented phases, known
limitations, verification checklist, and next implementation sequence — see
[HANDOFF.md](HANDOFF.md).

## Architecture

```
Raw audio → FFT → filtering → feature extraction → onset detection
          → BPM estimation (IOI histogram + harmonic folding)
          → beat grid (phase-locked loop, free-runs through silence)
          → phrase/section detection (spectral novelty on downbeats)
          → energy analysis (drops, build-ups, silence)
          → normalized AudioFeatures  →  scenes
```

- **`src/audio/`** — the analysis engine. `AudioEngine` owns the Web Audio graph and publishes a
  single mutable `AudioFeatures` object per frame (`time, waveform, spectrum, rms, energy, bass,
  sub, mid, presence, high, vocal, transient, bpm, beat, beatStrength, beatProgress, bar, measure, phrase, phraseProgress,
  sectionChange, confidence, nextBeatTime, drop, buildUp, silence`). `BpmEstimator` does live
  tempo tracking with confidence scores, adapts to tempo changes, and predicts future beats.
  `PhraseDetector` finds section boundaries (verse → chorus, breakdowns) by comparing spectral
  profiles across downbeats and re-anchors the phrase grid on them. **Scenes never touch the Web
  Audio API.**
- **`src/engine/`** — the visual framework: scene manager + transition manager (switches commit
  on downbeats and crossfade over ~two beats), `CameraRig` (reusable orbit/hover moves with
  beat pulls and section-change cuts), `LightRig` (palette-colored audio-reactive lighting for
  mesh scenes), palette system with smooth blending, the parameter system (global intensity /
  speed / reactivity, "tune" panel in the UI), shared post-processing (beat-reactive bloom +
  chromatic aberration), GLSL chunks.
- **`src/scenes/`** — the scene collection. Each scene is a self-contained React Three Fiber
  component registered in `scenes/index.ts` with metadata for role, mood fit, audio-band
  affinity, compatibility, intensity, and performance cost. All scenes keep idle motion
  during silence and use beat/bar/measure timing (e.g. the Light Tunnel advances exactly one
  ring per beat).
- **`src/engine/audioResponse.ts`** — portable visual envelopes (`sub`, `bass`, `mid`, `presence`,
  `high`, `vocal`, `energy`, `transient`, beat, drop, and build) for custom scenes.
- **`src/engine/PerformanceDirector.tsx`** — phrase/section-level scene composer. It ranks
  mood-fitting, compatible scenes by the strongest current audio layer and queues transitions
  through the same downbeat-locked crossfade used by manual scene changes.
- **Composition layers** — the primary scene can be paired with an accent and/or overlay scene.
  Layers fade independently, are selectable from the presets panel, persist with presets, and are
  populated conservatively by the Performance Director during energetic sections.
- **`src/ui/`** — floating glass HUD, live BPM readout, debug analyzer. High-frequency displays
  write to the DOM directly on rAF; nothing re-renders React at 60 fps.

### Scenes (10)

**Nebula** · domain-warped fbm clouds, churn speed follows energy, core glow rides the bass
**Particle Galaxy** · 30k-star spiral, differential rotation accelerates with energy, breathes on beats
**Light Tunnel** · beat-grid-locked rings (one per beat, downbeats accented), spokes on the highs
**Fluid** · iteratively advected ink; a dye ring splashes outward on every beat, drops flood the frame
**Monolith** · lit scene (LightRig) — a black monolith flashes on beats while debris orbits it
**Noise Field** · endless wireframe terrain, bass-driven relief, flight speed follows tempo
**Volumetric Clouds** · parallax cloud decks, bass thickens the cover, god-rays pulse on beats
**Ribbon Fields** · 48 GPU ribbons; a light pulse travels each ribbon once per bar
**Crystal Growth** · shards grow over a 32-beat cycle and shatter on section changes
**Digital Aurora** · curtain folds sway with the bar phase, shimmer on the highs

### Adding an input source

`AudioEngine.start()` only needs a `MediaStream` — MIDI/OSC/Ableton Link/virtual-cable sources can
be added behind the same `SourceKind` switch without touching analysis or scenes.

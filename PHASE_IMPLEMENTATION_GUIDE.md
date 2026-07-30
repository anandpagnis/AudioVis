# Phase Implementation Guide

This document coordinates the implementation of the new art direction. After each section, the user reviews and approves before I move forward.

---

## ⚠️ Approach change (superseded the original Phase 1)

We **dropped the custom-WebGL2-renderer plan**. Rebuilding the renderer was ~500 h for zero visual gain and high risk. Instead we keep Three.js + R3F + SceneManager/CameraRig/PostFX and rebuild the **look** on top: raymarched fullscreen-quad `ShaderMaterial` scenes (same technique as the existing `NebulaScene`). The "Custom Renderer Foundation" sessions below (1.1–1.5) are **obsolete** — kept only for history. The real phase order is now:

- **Phase 1 (revised) — Shader library + first raymarch scene** ✅ *done*
- **Phase 2 — Tactical HUD** (Evangelion overlay; canvas, no renderer changes) ✅ *done, awaiting review*
- **Phase 3 — Scene library expansion** (Cyber Cathedral + Infinite Tunnel) ✅ *done*
- **Phase 4 — More scenes + instant switching** (Holographic Ocean + Neural Network; cooldown removal) ✅ *done*
- **Phase 5 — Particle engine** (Particle Flow: 70k curl-noise GPU particles) ✅ *done*
- **Phase 6 — GPU fluid simulation** (Fluid Reactor: stable-fluids + bass shockwaves) ✅ *done, awaiting review*
- **Phase 7+ — Camera choreography, palette generation** (remaining roadmap)

### Phase 6 — GPU fluid simulation — delivered this session

- **Fluid Reactor** (`fluidsim`) — a real Navier–Stokes fluid solver on the GPU (ping-pong render targets: advection → forces → divergence → 20 Jacobi pressure iterations → gradient subtract → dye advection). A swirling emitter feeds it, and **every beat/drop fires a radial shockwave from the centre** — the "bass makes shockwaves" from the art direction. Runs as a primary scene or an additive overlay. (17 scenes total.)
- Integrates with the post-processing composer by running all off-screen passes in the scene's `useFrame` and restoring the render target afterward.

**Review checklist for you** (the sim's *algorithm* is proven via a standalone 240-step harness — see screenshot; in-app it mounts with zero errors/warnings but, like every WebGL scene, renders black in the rAF-stalled preview, so the live render is your check):
- [ ] `npm run typecheck` + `npm run build` clean (confirmed)
- [ ] Select **Fluid Reactor** on a real track → swirling fluid that curls and mixes; **drops/beats should punch a shockwave out from the centre**
- [ ] Try it as an **overlay** over another scene (additive)
- [ ] Watch performance on the M1 — it's the heaviest scene (20 pressure iterations/frame); if it dips, tell me and I'll drop the sim resolution or iteration count

### Phase 5 + cleanup — delivered this session

- **Particle Flow** (`particles`) — the particle engine: 70k GPU points advected through an animated curl-noise flow field, entirely in the vertex shader (one draw call). Bass widens it, beats burst it, drops surge the flow. Works as a primary scene or an additive overlay. (16 scenes total now.)
- **UI → collapsible corner menu** (previous step) with `auto` kept as the always-visible default.
- **System-audio fix**: macOS Chrome can only capture *browser-tab* audio (not whole screen) — the start card + error are now macOS-accurate, so the overlay clears once you share a tab with "Share tab audio".
- **Dead-code pruning**: removed the leftover bottom-bar/panel CSS and unused store toggles.

**Review checklist for you**:
- [ ] `npm run typecheck` + `npm run build` clean (confirmed)
- [ ] On macOS: click the source button (now "Browser-tab audio"), share a Chrome tab with music + tick "Share tab audio" → overlay clears, visuals react
- [ ] Select **Particle Flow** → an airy swirling particle field that flows/bursts with the music; try it as an overlay too
- [ ] Confirm the corner menu holds everything and `auto` still runs the show by default

### Phase 4 (revised) + instant switching — delivered this session

- **Instant scene switching** — removed the arbitrary time cooldowns. `AutoPilot` is now event-driven (mood change / imminent prediction / **rising-edge drop** → immediate switch, no 22s/9s gate). `PerformanceDirector` recomposes instantly on a real `sectionChange`, with a beat-based (not wall-clock) one-phrase fallback. Safe because `SceneManager` commits every request on the next downbeat — the bar is the natural rate limiter, so no strobing.
- **Holographic Ocean** (`ocean`) — raymarched sea of fbm waves, iridescent fresnel + crest sparkle, swells rise with the bass.
- **Neural Network** (`neural`) — an endless domain-repeated lattice of nodes wired by struts; activation pulses sweep through it, nodes swell on the bass.

**Review checklist for you** (live audio pass — I verified shaders via standalone render; switching logic is typecheck-clean and reasoned):
- [ ] `npm run typecheck` + `npm run build` clean (confirmed here)
- [ ] Play a track with clear drops → scenes should now **cut on the drop** instead of waiting out a timer
- [ ] With **Autopilot (A)**, confirm switching feels responsive to the song (mood changes/section boundaries) without strobing (commits still land on downbeats)
- [ ] Switch to **Holographic Ocean** and **Neural Network**, cycle palette (`P`), confirm they react to the music
- [ ] Sanity check: it should NOT switch many times per bar — if it ever does, tell me and I'll add a 1-bar floor

### Phase 2 + 3 (revised) — delivered this session

- **Tactical HUD** — `src/ui/TacticalHUD.tsx`, mounted in `App.tsx` between Stage and the control chrome. A full-viewport canvas that reads `audioEngine.features` on its own rAF (no React re-render). Radar w/ radial spectrum + beat sweep, top-right diagnostics (BPM / SYNC / MOOD / next-state / BAR / PHRASE + CONF/ENGY/LOW/HIGH meters), center lock-on reticle, CRT scan line, drop/build warnings, bottom-right oscilloscope + telemetry. Generic katakana flavor (no NERV branding). Palette-colored. **Toggle: `J`** or the `hud` chip; on by default, persisted, part of the *show* (independent of `H`). Only draws while audio is running.
- **Cyber Cathedral** (`cathedral`) — raymarched colonnade with a barrel-vaulted ceiling you drift through; columns swell on the bass.
- **Infinite Tunnel** (`fractaltunnel`) — raymarched warping fbm throat; radius pumps on the bass, flight speed rides the tempo. (Glow was retuned down after verification showed it blowing out on interior travel.)

**Review checklist for you** (the live audio-reactive pass only you can do — the preview pane stalls rAF, so I verified shaders via standalone render and the HUD via a temp dev hook, now removed):
- [ ] `npm run typecheck` + `npm run build` clean (confirmed here)
- [ ] Play audio → the tactical HUD appears: radar sweep locks to the beat, BPM/mood update, spectrum moves. Toggle with `J`.
- [ ] Switch to **Cyber Cathedral** and **Infinite Tunnel** — confirm they render, react to bass/energy, and colorize with the palette (`P`)
- [ ] With **Autopilot (A)** on, both new scenes should appear in rotation on peak/building sections
- [ ] Confirm the HUD stays visible when you hide the control chrome with `H` (it's part of the show), and hides with `J`

### Phase 1 (revised) — delivered this session

- `src/engine/shaderLib.ts` — reusable raymarch GLSL: `NOISE3D_GLSL` (3D value noise + fbm), `SDF_GLSL` (sphere/box/torus, smooth union/subtract/intersect, twist), `RAYMARCH_GLSL` (march loop + tetrahedron normals, references a scene-provided `float map(vec3)`).
- `src/scenes/AngelCoreScene.tsx` — flagship raymarched biomechanical organism (breathing core + membrane ring + orbiting bulbs), audio-reactive, palette-aware, registered as scene `angelcore`.
- **Bug fix**: automation now uses audio time (`audioEngine.features.time`) consistently, so scenes actually auto-switch (was mixing wall-clock time → desynced on stop/restart).

**Review checklist for you**:
- [ ] `npm run typecheck` + `npm run build` clean (confirmed here)
- [ ] Play real audio (System audio / a local file), then click **Angel Core** in the scene bar — confirm the organism renders, breathes on the bass, and pulses on the beat
- [ ] Turn on **Autopilot (A)** during a track and confirm scenes now switch on mood changes (the bug fix)
- [ ] Cycle palettes (**P**) on Angel Core — colors should sweep smoothly

*Note*: the shader was verified this session by compiling its exact fragment shader standalone and rendering it (the in-app audio path is user-gesture-gated and can't be driven headlessly), so the live audio-reactive check above is the one thing only you can do.

---

## Phase 1: Custom Renderer Foundation  *(OBSOLETE — see approach change above)*

### Session 1.1: Renderer Core & WebGL2 Setup

**What I'll build**:
- `src/engine/renderer/WebGL2Renderer.ts` — WebGL2 context initialization, capability checks, render pipeline
- `src/engine/renderer/types.ts` — TypeScript interfaces (IRenderer, IScene, IMaterial, IMesh, etc.)
- `src/engine/renderer/Uniform.ts` — uniform binding and caching system
- Basic example: fullscreen quad renderer (for testing)

**Deliverables**:
- [ ] Renderer class compiles and initializes on canvas
- [ ] Fullscreen quad renders a solid color
- [ ] `renderer.info` object tracks draw calls, triangles, geometry/texture counts
- [ ] No TypeErrors on build

**Test**: `npm run build` + manual canvas test (solid red fullscreen quad)

**Approval Gate**: User reviews code structure, runs build, confirms canvas works. Then I proceed to 1.2.

---

### Session 1.2: Scene Graph & Material System

**What I'll build**:
- `src/engine/renderer/Scene.ts` — lightweight scene graph (add, remove, traverse)
- `src/engine/renderer/Material.ts` — base Material class + StandardMaterial
- `src/engine/renderer/Geometry.ts` — BufferGeometry (positions, normals, UVs)
- `src/engine/renderer/Mesh.ts` — Mesh class (transform, material, draw)

**Deliverables**:
- [ ] Scene graph hierarchy works (nested objects, transforms)
- [ ] Materials compile GLSL shaders
- [ ] Uniforms bind correctly (tested with simple scene)
- [ ] Mesh renders with position/rotation/scale
- [ ] No frame drops on simple test scene

**Test**: Render a single cube with lighting; rotate it via keyboard; verify 60 fps

**Approval Gate**: User verifies scene graph structure, shader compilation, transform math. Then I proceed to 1.3.

---

### Session 1.3: Port One Scene (Tunnel)

**What I'll build**:
- `src/scenes/Tunnel_v2.tsx` — rewrite Tunnel as a renderer-compatible scene
- Update `SceneManager.tsx` to mount renderer scenes (not just Three.js)
- Adapter layer: Three.js scenes still work; new renderer scenes live alongside

**Deliverables**:
- [ ] Tunnel renders without Three.js (new renderer only)
- [ ] Beat-locked rings advance correctly
- [ ] Palette swaps work
- [ ] Fade in/out smooth
- [ ] AutoPilot can request Tunnel (scene selection UI works)

**Test**: Play audio → request Tunnel → see rings, change palette → stop audio → restart

**Approval Gate**: User plays real music, verifies Tunnel looks correct, beat-locking is tight. Then I proceed to 1.4.

---

### Session 1.4: Port Remaining 9 Scenes

**What I'll build**:
- Rewrite Nebula, Galaxy, Fluid, Monolith, Noise Field, Clouds, Ribbons, Crystal, Aurora as new-renderer scenes
- Update all scene registrations in `src/scenes/index.ts`

**Deliverables per scene**:
- [ ] Renders without visual regression (compared to Three.js version)
- [ ] Audio response intact (same envelopes drive same visual behavior)
- [ ] Crossfade works (old → new renderer during transitions)
- [ ] Performance: no drop below 50 fps during scene switch

**Test**: Autopilot mode; watch it switch through all 10 scenes over 5 minutes of music

**Approval Gate**: User watches full autopilot cycle, checks for artifacts, confirms no performance regressions. Then Phase 1 is complete.

---

### Session 1.5: Polish & Fallback

**What I'll build**:
- Error handling: if shader fails to compile, fallback to flat white mesh
- Disposal: all scenes properly free GPU memory on switch
- HMR: shader hot-reload (change a shader, see update without full rebuild)
- Fullscreen mode: canvas scales to fill display

**Deliverables**:
- [ ] No memory leaks (switch scenes 20x, memory stable)
- [ ] Shader hot-reload works in dev mode
- [ ] Fullscreen works on external display
- [ ] All 10 scenes render at 60 fps sustained

**Test**: Extended session (10+ min) of autopilot; task manager shows stable memory; fullscreen on projector

**Approval Gate**: User does final stability/performance check. Phase 1 COMPLETE.

---

## Phase 2: Shader Library & Post-Effects

### Session 2.1: Noise Functions

**What I'll build**:
- `src/engine/shaders/noise.glsl` — Perlin, Simplex, Voronoi, fBm
- Unit tests: verify noise outputs are in [0,1] and smooth

**Deliverables**:
- [ ] All noise functions compile
- [ ] Noise is seamless (tiling correctly)
- [ ] fBm produces multi-octave patterns
- [ ] Performance: noise call <0.5ms on M1

**Approval Gate**: User reviews shader code, runs one test scene using noise. Then I proceed to 2.2.

---

### Session 2.2: SDF Library

**What I'll build**:
- `src/engine/shaders/sdf.glsl` — primitives (sphere, box, torus, cylinder) + blend ops

**Deliverables**:
- [ ] All SDF primitives render correctly
- [ ] Blend operations (union, subtract, intersect) work
- [ ] No artifacts at blend boundaries
- [ ] Performance: SDF trace <1ms per pixel

**Approval Gate**: User verifies SDF visual quality in test scenes. Then I proceed to 2.3.

---

### Session 2.3: Raymarching Utils

**What I'll build**:
- `src/engine/shaders/raymarch.glsl` — march loop, lighting, normal estimation

**Deliverables**:
- [ ] Raymarching converges (max steps respected)
- [ ] Lighting looks natural (Phong or PBR)
- [ ] Normals calculated correctly (no banding)

**Approval Gate**: User verifies raymarched test sphere looks good. Then I proceed to 2.4.

---

### Session 2.4: Post-Processing Library

**What I'll build**:
- `src/engine/shaders/postfx.glsl` — bloom, chromatic aberration, film grain, glitch, vignette, etc.

**Deliverables**:
- [ ] Each effect renders without artifacts
- [ ] Bloom doesn't blow out (tone mapping correct)
- [ ] Chromatic aberration is subtle and correct
- [ ] Performance: all effects combined <5ms

**Approval Gate**: User sees post-FX on a test scene. Then I proceed to 2.5.

---

### Session 2.5: Fractals & Utils

**What I'll build**:
- `src/engine/shaders/fractals.glsl` — Mandelbrot, Julia, IFS
- `src/engine/shaders/utils.glsl` — color spaces, easing, helpers

**Deliverables**:
- [ ] Fractals render and zoom correctly
- [ ] Color conversions work (RGB ↔ HSL, LCh)
- [ ] Easing functions match beat grid

**Approval Gate**: User verifies fractal rendering. Phase 2 COMPLETE.

---

## Phase 3: Tactical HUD / Evangelion UI

### Session 3.1: HUD Canvas Layer & Radar

**What I'll build**:
- `src/ui/TacticalHUD.tsx` — canvas overlay, high-frequency drawing
- Radar display: circular grid, beat phases, confidence arc

**Deliverables**:
- [ ] Canvas renders at 60 fps without blocking React
- [ ] Radar responds to beat grid (pulses on downbeat)
- [ ] Grid rotates smoothly
- [ ] Overlay doesn't interfere with 3D rendering

**Test**: Play audio, watch radar pulse and rotate with beat

**Approval Gate**: User reviews HUD responsiveness. Then I proceed to 3.2.

---

### Session 3.2: Diagnostic Panel & Scanning

**What I'll build**:
- BPM readout, confidence %, mood label, spectral indicators
- Scanning lines, lock-on crosshairs, pulse rings
- Japanese typography integration

**Deliverables**:
- [ ] All metrics update in real-time (no lag)
- [ ] Scanning lines rotate with energy
- [ ] Lock-on scales on beat peaks
- [ ] Text renders clearly (font loaded)

**Approval Gate**: User verifies telemetry accuracy and visual polish. Phase 3 COMPLETE.

---

## Phase 4: Procedurally Generated Scenes

### Session 4.1: Angel Core

**What I'll build**:
- `src/scenes/AngelCore.tsx` — raymarched biomechanical scene
- SDF morphing, tendrils, breathing animation, palette integration

**Deliverables**:
- [ ] Scene renders at 60 fps
- [ ] Breathing syncs to bass envelope
- [ ] Wings scale with energy
- [ ] Palette colors apply correctly
- [ ] Scene metadata registered

**Test**: Play various tracks; watch Angel Core respond to audio

**Approval Gate**: User verifies audio response and visual quality. Then I proceed to 4.2.

---

### Session 4.2: Neural Network

**What I'll build**:
- `src/scenes/NeuralNetwork.tsx` — flowing nodes, bezier connections, particles

**Deliverables**:
- [ ] Nodes pulse independently (spatial beat offset)
- [ ] Connections glow on energy peaks
- [ ] Camera orbits smoothly
- [ ] Particles flow along connections
- [ ] Performance: 60 fps sustained

**Approval Gate**: User checks audio sync and performance. Then I proceed to 4.3.

---

### Session 4.3–4.6: Remaining Scenes (Cyber Cathedral, Infinite Tunnel, Holographic Ocean, Particle Nebula)

**Same pattern as 4.1–4.2** — one scene per session, user reviews audio sync + performance after each.

**Approval Gate after 4.6**: User watches full v2.1 feature set (all new scenes + HUD working together). Phase 4 COMPLETE.

---

## Phase 5: Particle Engine & Organic Geometry

### Session 5.1: GPU Particle System

**What I'll build**:
- `src/engine/particles/ParticleSystem.ts` — compute shader or texture ping-pong sim
- Position, velocity, age, forces (gravity, turbulence, attraction)

**Deliverables**:
- [ ] 100k+ particles render at 60 fps
- [ ] Particle motion is smooth (no jumps)
- [ ] Forces apply correctly (gravity pulls down, wind pushes)
- [ ] Particles die and are recycled (no memory leak)

**Test**: Play audio, emit particles, watch them swarm and dissipate

**Approval Gate**: User checks performance and physics correctness. Then I proceed to 5.2.

---

### Session 5.2: Procedural Geometry & Growth

**What I'll build**:
- `src/engine/procedural/GeometryGrowth.ts` — metaballs, neural branches, crystal formation
- Real-time SDF → geometry conversion or animated parameter morphing

**Deliverables**:
- [ ] Geometry grows smoothly (no pops)
- [ ] Metaballs blend correctly
- [ ] Branches follow L-system rules
- [ ] Audio triggers growth rate changes

**Approval Gate**: User verifies growth animation and audio response. Then I proceed to 5.3.

---

### Session 5.3: Scene Integration (Living Membrane, Crystal Garden)

**What I'll build**:
- `src/scenes/LivingMembrane.tsx` — pulsating metaball with membrane skin
- `src/scenes/CrystalGarden.tsx` — crystals grow over 32 beats, shatter on drop

**Deliverables**:
- [ ] Both scenes render correctly
- [ ] Membrane breathing syncs to bass
- [ ] Crystals grow in real-time
- [ ] Shattering triggered by drop detection
- [ ] AutoPilot can request them

**Approval Gate**: User watches both scenes with real music. Phase 5 COMPLETE = **v2.2 Launch** 🎯

---

## Phases 6–9: Final Polish

**Same checkpoint pattern**: each session delivers one feature, user reviews, I proceed to next.

### Phase 6: Camera Choreography + Dynamic Lighting
- Session 6.1: Cinematic camera moves (orbit, flythrough, dolly zoom)
- Session 6.2: Dynamic lighting (point lights, rim light, volumetric)

### Phase 7: Fluid Simulation (optional)
- Session 7.1: GPU fluid advection
- Session 7.2: Dye injection + rendering
- Session 7.3: Fluid scenes

### Phase 8: Palette Generation
- Session 8.1: Palette generator + smooth transitions

### Phase 9: Performance Optimization
- Session 9.1: Profiling + optimization passes
- Session 9.2: Edge cases, mobile support

---

## Review Checklist (Every Session)

**User should verify**:
- [ ] Code builds (`npm run typecheck`, `npm run build`)
- [ ] Dev server runs (`npm run dev`)
- [ ] Feature works as described
- [ ] No performance regression (<5% frame time increase)
- [ ] No memory leaks (watch memory over 5 min)
- [ ] Automation (AutoPilot/PerformanceDirector) still works
- [ ] Existing features unchanged (cue timeline, MIDI sync, recording, share URL)

**I should provide**:
- [ ] Clear diff comments (why each change)
- [ ] Success criteria checklist in commit message
- [ ] Any known limitations or TODOs for next session
- [ ] Breadcrumbs: what's next, any blockers

---

## Approval Template

After each session, user posts:

```
## Session [X.Y] Review

✅ Code builds
✅ Feature works as described
✅ Performance: [fps at 1080p]
✅ No regressions

→ Ready for next session: [Session X.Y+1]
```

Or:

```
## Session [X.Y] Needs Work

⚠️ [Issue]: [Description]

→ Holding until fixed
```

---

## Success Criteria (Overall)

- ✅ All phases complete
- ✅ TypeCheck + build clean
- ✅ v2.0, v2.1, v2.2 ship with zero regressions
- ✅ All existing features (cues, MIDI, recording, share URLs) still work
- ✅ Performance: 60 fps sustained on M1 at 1080p
- ✅ Automation system switches scenes correctly (AutoPilot + PerformanceDirector)
- ✅ Real music testing: 10+ tracks across genres, all play smoothly

---

## When Ready to Start

User confirms:

```
## Ready for Phase 1, Session 1.1

Starting: [Date]
Target: WebGL2 core + fullscreen quad
Expected: [Date + 1 day]
```

Then I begin.


# AudioVis Art Direction Pivot — Complete Roadmap

**Goal**: Transform from Three.js/procedural-scene-heavy → custom WebGL2/GPU-driven renderer with Evangelion-inspired tactical HUD, raymarched sci-fi scenes, and organic biomechanical aesthetics.

**Timeline**: ~19 weeks to a polished v2.2 (incremental releases every 4-5 weeks).

**Guiding Principle**: Every frame should feel alive. Audio-reactive. Synchronized to the beat grid. No static scenes.

---

## Phase 1: Custom Renderer Foundation (Weeks 1–4)

### Goal
Replace Three.js with a lightweight custom WebGL2 renderer. **Zero visual change to the user** — existing 10 scenes still run, just on new infrastructure.

### Key Deliverables

#### 1.1 WebGL2 Core
- `src/engine/renderer/WebGL2Renderer.ts` — boilerplate:
  - `create(canvas)` → initializes WebGL2 context + capability checks
  - `render(scene, camera)` → draw call pipeline
  - `dispose()` → cleanup
  - `info` object (draw calls, triangles, geometry/texture counts) for telemetry
  - Fullscreen quad rendering helper (base for all shader work)

#### 1.2 Scene Graph Replacement
- `src/engine/renderer/Scene.ts` — lightweight hierarchy:
  - `add(object)`, `remove(object)`, `traverse(callback)`
  - Support for Materials, Geometries, Group nodes
  - Layer system (for depth-sorted rendering, transparency)

#### 1.3 Material System
- `src/engine/renderer/Material.ts`:
  - Base `Material` class with shader compilation, uniform binding
  - `StandardMaterial` (for lit geometry, replicates MeshStandardMaterial)
  - `ShaderMaterial` (raw GLSL input)
  - Uniform caching + hot-reload support

#### 1.4 Geometry & Mesh
- `src/engine/renderer/Geometry.ts` — vertex data:
  - `BufferGeometry` (positions, normals, UVs, custom attributes)
  - `dispose()` to free GPU memory
- `src/engine/renderer/Mesh.ts`:
  - `position`, `rotation`, `scale`, `matrix` (local-to-world transform)
  - Material assignment
  - `draw()` → binds geometry + material, issues draw call

#### 1.5 Camera Rig
- Reuse existing camera code from `src/engine/CameraRig.tsx` (orbit, cinematic, beat-driven shake)
- Port to use new renderer's camera model (view + projection matrices)

#### 1.6 Post-Processing
- Reuse existing post-FX infrastructure (bloom, chromatic aberration)
- Port to fullscreen quad rendering on new renderer

### Success Criteria
- ✅ App builds and runs
- ✅ One existing scene (e.g., Tunnel) renders correctly
- ✅ All 10 scenes port and render without visual regression
- ✅ Automation (AutoPilot, PerformanceDirector) works
- ✅ Performance: 60 fps at 1080p on M1 MacBook

### Effort: ~80–100 hours
- Core renderer: 30–40h
- Scene graph: 15–20h
- Material system: 20–25h
- Scene porting: 20–30h

### Risk
**High**: If Three.js → custom migration is 2+ weeks behind, everything downstream slips. *Mitigation*: Prototype with one scene first (Tunnel). Use a Three.js adapter layer initially (keep Three.js working; migrate one scene at a time).

---

## Phase 2: Shader Library & Post-Effects (Weeks 5–8)

### Goal
Build the GPU-side toolkit for shaders. **Still no visual change** — shaders ship but aren't used in scenes yet.

### Key Deliverables

#### 2.1 Noise Functions
- `src/engine/shaders/noise.glsl`:
  - Perlin noise (2D, 3D, 4D with time)
  - Simplex noise (faster variant)
  - Voronoi noise (cellular)
  - Fractional Brownian Motion (fBm) with octave control

#### 2.2 SDF Library
- `src/engine/shaders/sdf.glsl`:
  - Primitives: sphere, box, torus, cylinder, cone
  - Blend operations: smooth union, subtract, intersect
  - Domain ops: repeat, twist, bend, morph

#### 2.3 Raymarching Utils
- `src/engine/shaders/raymarch.glsl`:
  - March loop (with max steps, epsilon tolerance)
  - Lighting (normal estimation, Phong/PBR)
  - Distance field → color mapping

#### 2.4 Post-Processing Library
- `src/engine/shaders/postfx.glsl`:
  - Bloom (threshold + multi-pass blur)
  - Chromatic aberration (RGB split)
  - Film grain (noise overlay)
  - RGB glitch (line shifts)
  - Lens distortion (barrel/pincushion)
  - Vignette (edges darken)
  - Motion blur (cheap, velocity-based)

#### 2.5 Fractal Shaders
- `src/engine/shaders/fractals.glsl`:
  - Mandelbrot / Julia sets
  - IFS (Iterated Function Systems)
  - Fractal Brownian motion terrain

#### 2.6 Utility Shaders
- `src/engine/shaders/utils.glsl`:
  - Color space conversions (RGB ↔ HSL, LCh)
  - Easing functions (smoothstep variants, beat sync)
  - Math helpers (remap, clamp, mix)

### Success Criteria
- ✅ All shader files compile without errors
- ✅ Shader compilation is fast (<100ms)
- ✅ Uniforms are bindable and hot-reloadable
- ✅ Example: fullscreen Mandelbrot renders at 60 fps

### Effort: ~60–80 hours
- Noise functions: 15h
- SDF library: 15h
- Raymarching: 10h
- Post-effects: 15h
- Fractals + utils: 10h

---

## Phase 3: Tactical HUD / Evangelion UI (Weeks 9–11)

### Goal
**First major visual pivot 🎯**. Ship Evangelion-inspired animated overlays. Existing scenes still render underneath.

### Key Deliverables

#### 3.1 HUD Canvas Layer
- `src/ui/TacticalHUD.tsx` (overlays the 3D canvas):
  - High-frequency canvas drawing on rAF (60 fps)
  - Separate from React updates (no re-renders)
  - Position/opacity controlled by Zustand store

#### 3.2 Radar Display
- Circular radar with beat grid overlay
- Phase ring (current beat position)
- Confidence arc (BPM confidence)
- Sector segments (one per measure, colored by audio band dominance)
- Pulsing on the beat

#### 3.3 Diagnostic Panel
- BPM readout (large, centered)
- Confidence percentage
- Mood state label
- Phrase/section boundary flag
- Drop / build-up indicators
- Energy bar
- Spectral band indicators (bass, mid, high visualization)

#### 3.4 Scanning & Lock-On Animations
- Rotating scan lines (beat-synced)
- Lock-on crosshairs (scale on beat peak)
- Pulse rings expanding from center (audio-reactive)
- Warning labels ("SYNC" blinking at 120 bpm)
- Telemetry text (lat/lng-style coordinates that shift)

#### 3.5 Visual Style
- Neon glow effects (using CSS text-shadow, or canvas glow)
- Green/cyan color palette (classic tactical)
- Japanese typography (Font: Orbitron or similar)
- Grid background (subtle, repeating hex or square grid)
- Scan lines overlay (CRT effect, subtle)
- All animations beat-locked

#### 3.6 Layer Architecture
```
Canvas (3D scene at z=0)
  ↓
Canvas overlay (tactical HUD at z=1, semi-transparent bg)
  ↓
DOM UI (buttons, text, chrome)
```

### Success Criteria
- ✅ HUD renders at 60 fps without dropping frames
- ✅ Radar responds to beat grid (pulse on downbeat)
- ✅ Scan lines rotate smoothly with energy envelope
- ✅ Lock-on scales with beat strength
- ✅ Japanese text renders clearly
- ✅ All animations sync to `audioEngine.features.beat` and `beatProgress`

### Effort: ~40–50 hours
- Canvas layer + infrastructure: 10h
- Radar display: 10h
- Diagnostic panel: 8h
- Scanning/lock-on: 10h
- Polish + animations: 5h

### Outcome
**v2.0 Launch**: Users see a completely new visual identity. Same scenes underneath, but now wrapped in Evangelion tactical aesthetic. Auto-switching still works.

---

## Phase 4: Procedurally Generated Scenes (Weeks 12–17)

### Goal
**Second major visual shift 🎯**. Ship 4–6 new raymarched/procedural scenes that are shorter, tighter, and more cinematic than the original 10.

### Key Deliverables

#### 4.1 Angel Core
- Raymarched biomechanical organism
- Core: pulsating sphere with tendrils
- Tendrils: SDF morphing + domain twist
- Breathing: modulates with bass envelope
- Winglike structures: scale with energy
- Lighting: two-tone (rim light + fill)
- Color: shifts through palette

#### 4.2 Neural Network
- Flowing nodes connected by bezier curves
- Each node pulses independently (spatially offset beat timing)
- Connections glow when audio energy > threshold
- Camera slowly orbits the network
- Particles flow along connections (audio-driven)
- Vocal energy lights up specific nodes
- Fractally nested networks (far-plane gets smaller copies)

#### 4.3 Cyber Cathedral
- Tall geometric columns (raymarched boxes + cylinders)
- Ceiling: fractured glass-like (Voronoi cells)
- Floor: infinite checkerboard (domain repeat)
- Lighting: god rays from top (volumetric shadow mapping simulation)
- Camera: wide angle, slight upward tilt
- Color: cold (blues, purples, whites)
- Bass creates "pillars" in the Voronoi cells (domain warp)

#### 4.4 Infinite Tunnel
- Rings stacked along Z-axis (camera flies through)
- Each ring: Mandelbrot fractal or SDF morph
- Speed: audio tempo
- Rings subdivide on high-energy beats
- Walls: animated with fractional Brownian motion
- Color cycling through palette

#### 4.5 Holographic Ocean
- Fluid simulation lite: advected texture ping-pong (GPU texture read/write)
- Waves: sine-based with audio modulation
- Particles: holographic sparkles riding the waves
- Camera: angled top-down, flying low over the surface
- Refraction effect: light bends through water
- Color: cool (cyan, magenta, white)

#### 4.6 Particle Nebula (preview of Phase 5)
- Lightweight particles (not Phase 5's full engine, just 10k stars)
- Spiral galaxy: differential rotation
- Bass: galaxy contracts
- Treble: stars sparkle
- Fullscreen but sparse (breathing room)

### Success Criteria per Scene
- ✅ Renders at 60 fps on M1
- ✅ Responsive to audio (one primary envelope per scene)
- ✅ Colorizes correctly with palette shifts
- ✅ Smooth transitions (fade in/out, no pops)
- ✅ Idle motion during silence (drift, rotate, breathe)

### Scene Metadata (for AutoPilot/Director)
```ts
{
  id: 'angel-core',
  name: 'Angel Core',
  roles: ['primary', 'accent'],
  moods: ['peak', 'aggressive'],
  bands: ['bass', 'energy'],
  intensity: 'high',
  compatibleWith: ['neural-net', 'cathedral'],
  performanceCost: 'high',
  moodFit: { peak: 1.0, aggressive: 0.9, building: 0.6 },
}
```

### Effort: ~100–150 hours (30–40 per scene)
- Shader development: 50–80h
- Scene integration: 30–40h
- Metadata tuning: 10h
- Audio response integration: 10–20h

### Outcome
**v2.1 Launch**: Users get 4–6 visually coherent new scenes that feel like a unified world. Each has a distinct personality but shared aesthetic language.

---

## Phase 5: Particle Engine & Organic Geometry (Weeks 18–22)

### Goal
**Third visual shift 🎯**. Add life through particles and procedurally growing geometry.

### Key Deliverables

#### 5.1 GPU Particle Engine
- Compute shader simulation (or texture ping-pong fallback):
  - Position, velocity, age, life
  - Forces: gravity, wind, turbulence (Curl noise)
  - Attraction/repulsion to spatial zones
  - Sphere collision (bounce)
  
- Particle types:
  - **Dust**: slow, large, semi-transparent
  - **Sparks**: fast, bright, short-lived
  - **Plasma**: additive, color-shifting
  - **Fireflies**: hovering, flicker
  - **Rain**: vertical spray
  - **Energy orbs**: audio-reactive, orbit around points

#### 5.2 Procedural Geometry
- Real-time SDF → mesh conversion (Marching Cubes, optional for Phase 5.5)
- Metaballs: multiple spheres with smooth blending
- Neural branches: L-system growth (audio-driven growth rate)
- Crystal formations: branching SDF trees, audio-triggered shattering
- Organic breathing: domain warp + time modulation

#### 5.3 Integration with Scenes
- **Angel Core v2**: grows tendrils in real-time, particles flow along them
- **Neural Network v2**: particles fire along synapses
- **New scene — Living Membrane**: single pulsating metaball with membrane-like skin
- **New scene — Crystal Garden**: crystals grow over 32 beats, shatter on drop

#### 5.4 Audio Mapping
- Particles spawn rate: transient energy
- Particle velocity: audio energy envelope
- Gravity: bass loudness
- Wind direction: phase (rotates with the beat)
- Color: vocal presence
- Attraction zones: one zone per audio band (sub, mid, high)

### Success Criteria
- ✅ 100k+ particles at 60 fps on M1
- ✅ Particle motion syncs to beat subdivision
- ✅ No frame drops during peaks
- ✅ Geometry grows/shrinks smoothly

### Effort: ~80–120 hours
- Particle engine: 40–50h
- Procedural geometry: 20–30h
- Scene integration: 15–20h
- Audio response tuning: 5–10h

### Outcome
**v2.2 Launch**: Scenes feel organic and alive. Particles dance to the music. Geometry morphs responsively. The "living organism" aesthetic is now complete.

---

## Phase 6: Advanced Camera & Dynamic Lighting (Weeks 23–25)

### Goal
Cinematic presentation and dramatic lighting.

### Key Deliverables

#### 6.1 Camera Choreography
- **Orbit camera**: reuse existing, tune for new scenes
- **Cinematic flythrough**: pre-authored or procedurally generated paths
- **Dolly zoom**: bass drives zoom in/out
- **Focus breathing**: subtle zoom pulse (beat subdivision)
- **Beat-driven shake**: on kick drum (transient peak)
- **Section-boundary cuts**: hard camera reset on phrase change (optional)

#### 6.2 Dynamic Lighting
- **Point lights**: scene-placed, audio-reactive intensity
- **Rim lighting**: subtle backlight, beat-synced flicker
- **Volumetric lighting**: god rays (scene-specific, shader-based)
- **Color-mapped lights**: palette colors drive light colors
- **Flicker on transient**: very fast intensity modulation

#### 6.3 Bloom & Glow
- Tone-mapped, beat-reactive bloom threshold
- Glow on high-energy sources (particles, geometry cores)

### Effort: ~40–60 hours
- Camera choreography: 15–20h
- Lighting system: 15–20h
- Integration: 10h

### Outcome
Scenes feel cinematic and polished. Camera motion guides the eye. Lighting reinforces the beat.

---

## Phase 7: Fluid Simulation (Optional, Weeks 26–29)

### Goal
Smoke, ink, plasma with bass-driven physics.

### Key Deliverables

#### 7.1 GPU Fluid Advection
- Texture ping-pong (render to A, read from A, write to B, swap)
- Advection: semi-Lagrangian velocity field
- Pressure projection (optional; Jacobi iteration)
- Diffusion: optional, slows the sim (expensive)

#### 7.2 Dye Injection
- User input or audio-driven sources
- Beat-synced splashes (circle or rectangle dye injection)
- Vel field driven by audio envelopes

#### 7.3 Rendering
- Raymarching through dye density
- Color per density level
- Transparency/opacity modulation

#### 7.4 Scenes
- **Fluid Galaxy**: ink swirls in a galaxy pattern
- **Plasma Reactor**: hot plasma with shockwaves (bass-driven pressure spikes)

### Effort: ~60–90 hours
- Sim implementation: 30–40h
- Rendering: 15–20h
- Scene integration: 15–20h

### Optional Because
- GPU budget (shares texture bandwidth with particles)
- Complexity (can defer to v2.5)
- Impact (nice-to-have, not must-have for v2.2)

---

## Phase 8: Palette Generation & Transitions (Weeks 30–31)

### Goal
Color system that evolves with mood.

### Key Deliverables

#### 8.1 Palette Generator
- Pre-computed palettes: synthwave, cyberpunk, Evangelion, vaporwave, aurora, fire, ice
- Random generation: HSL-based (hue shift, saturation range, lightness spread)
- Mood-driven selection (MoodEstimator picks palette family)

#### 8.2 Smooth Transitions
- Crossfade in LCh color space (perceptually uniform)
- Duration: ~3 beats
- Interpolation: ease-in-out

#### 8.3 Integration
- All scenes respect palette (via `params.palette` or direct lookup)
- HUD colors adapt (radar grid, text)
- Lights color-map to palette

### Effort: ~20–30 hours
- Generator: 10h
- Transitions: 8h
- Integration: 5h

---

## Phase 9: Performance & Polish (Weeks 32–34)

### Goal
Optimization pass. Ensure 60 fps on all target hardware.

### Key Deliverables

#### 9.1 Profiling
- GPU stats (draw calls, triangles, shader overhead)
- Frame-time histogram
- Identify bottlenecks (CPU-bound vs. GPU-bound)

#### 9.2 Optimizations
- Frustum culling (skip off-screen geometry)
- LOD for particles (fewer particles at distance)
- Texture atlasing (combine small textures)
- Shader compilation caching (avoid recompile on hot reload)
- Dynamic resolution scaling (frame-time monitor, walk resolution ladder)

#### 9.3 Mobile / Low-End Support
- Fallback shaders for WebGL 1.0 (if needed)
- Particle count caps per device
- Reduced bloom passes
- Simplified post-effects

#### 9.4 Edge Cases
- Handle audio stop/restart (reset all timers, particles)
- Test on low-BPM and high-BPM tracks
- Fullscreen mode on external display
- `ui=hidden` chromeless mode

### Effort: ~40–60 hours
- Profiling: 10h
- Optimizations: 20–30h
- Testing: 10h

---

## Phase 10: (Optional) Cloud Sync & Multiplayer

### Goal
Multi-machine sync, OSC/Link bridge, cloud preset gallery.

### Not in Scope for v2.2
- Deferred to v3.0 if needed

---

## Timeline Summary

```
Week 1–4:   Phase 1 (Foundation)         [Internal]
Week 5–8:   Phase 2 (Shaders)            [Internal]
Week 9–11:  Phase 3 (Tactical HUD)       [v2.0 Public Launch 🎯]
Week 12–17: Phase 4 (New Scenes)         [v2.1 Public Launch 🎯]
Week 18–22: Phase 5 (Particles)          [v2.2 Public Launch 🎯]
Week 23–25: Phase 6 (Camera/Lighting)    [v2.3 Public Launch]
Week 26–29: Phase 7 (Fluid, optional)    [v2.4 if time]
Week 30–31: Phase 8 (Palettes)           [Patch]
Week 32–34: Phase 9 (Optimization)       [v2.5 release]
```

---

## How to Track Progress

1. **Create issues** per phase (or per scene in Phase 4)
2. **Update HANDOFF.md** as features land
3. **Test on real music** — use audio file playback (Phase 7 from old handoff) to author cues, then test automation during scene changes
4. **Feedback loop**: Each public launch, gather what feels off (timing, colors, pacing) and iterate

---

## Critical Success Factors

1. **Phase 1 must not slip** — it blocks everything
2. **Shader library must be modular** — scenes should be quick to build
3. **Audio integration is non-negotiable** — every visual decision must tie back to `audioEngine.features`
4. **Test automation constantly** — AutoPilot/PerformanceDirector are now fixed; use them to validate each scene
5. **Iterate on real music** — Spotify, YouTube, local tracks; not silence

---

## File Structure (New)

```
src/
  engine/
    renderer/
      WebGL2Renderer.ts     (Phase 1)
      Scene.ts              (Phase 1)
      Material.ts           (Phase 1)
      Geometry.ts           (Phase 1)
      Mesh.ts               (Phase 1)
    shaders/
      noise.glsl            (Phase 2)
      sdf.glsl              (Phase 2)
      raymarch.glsl         (Phase 2)
      postfx.glsl           (Phase 2)
      fractals.glsl         (Phase 2)
      utils.glsl            (Phase 2)
    particles/
      ParticleSystem.ts     (Phase 5)
      ParticleTypes.ts      (Phase 5)
    fluid/
      FluidSim.ts           (Phase 7)
    colors/
      PaletteGenerator.ts   (Phase 8)
  ui/
    TacticalHUD.tsx         (Phase 3)
  scenes/
    AngelCore.tsx           (Phase 4)
    NeuralNetwork.tsx       (Phase 4)
    CyberCathedral.tsx      (Phase 4)
    InfiniteTunnel.tsx      (Phase 4)
    HolographicOcean.tsx    (Phase 4)
    LivingMembrane.tsx      (Phase 5)
    CrystalGarden.tsx       (Phase 5)
```

---

## Launch Checklist (per release)

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] All scenes render at 60 fps (M1, 1080p)
- [ ] AutoPilot switches scenes on mood changes
- [ ] PerformanceDirector adds overlays on phrase boundaries
- [ ] Manual scene selection blocks automation for 45s
- [ ] Cue capture/follow works (Phase 5 legacy)
- [ ] Recording audio + canvas works
- [ ] Share URL encodes and restores look
- [ ] Test with 3+ real tracks (different BPMs, genres)
- [ ] Update HANDOFF.md
- [ ] Test fullscreen on external display


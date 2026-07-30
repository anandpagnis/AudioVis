# AudioVis — Visual Vision Brief

**Status:** current source of truth for *how it should look*.
Supersedes the aesthetic sections of `ART_DIRECTION_ROADMAP.md` (whose Phase 1
"custom renderer" was explicitly abandoned — the renderer was never the problem).
`HANDOFF.md` remains the source of truth for architecture and workflow.

---

## 1. The target

Derived from reference images supplied by the user (July 2026). Six references,
one consistent visual language:

| Reference | What it contributes |
|---|---|
| Ghost-in-the-Shell technical schematic (wireframe cyborg hand, phosphor green on grid, annotated `F-54703201` / `ECM-3510` callouts, corner data panel) | **Hard line-art precision.** Drawn strokes, not glow. Annotation as composition. |
| Abstract red/cyan plasma (fine grain, filaments, shard fragments, hot core on dead black) | **Fine grain + chromatic fringing + filament structure.** High-frequency detail. |
| Large-format monochrome stage projection (mirrored dot-matrix figure, hard light-beam geometry) | **Mirror symmetry, particulate substance, extreme contrast.** Ikeda-scale restraint. |
| Chrome/liquid-metal figure above a DJ, intense green wash | **A hero object.** One readable subject, specular, not abstract soup. |
| Wireframe cube containing a dissolving particle figure | **Geometric frame + organic content.** |
| *Fallen Angels* (Wong Kar-wai) poster — grain, scanlines, blown saturated grade, red type | **Filmic degradation and grade.** Not clean digital. |

### The unifying principle

> **Hard-edged precise structure + organic particulate substance + filmic
> degradation, at brutal contrast.**

Every reference has three things the current app lacks: a **subject**,
**negative space**, and **crisp edges somewhere in frame**.

### Non-negotiables (user's words)

- "**Crystal cut, perfect clear, artistic**"
- "**Buttery smooth is the most important** — not choppiness"
- Seamless visuals locked to the beat

Smoothness outranks visual ambition. A simpler look at a rock-solid frame rate
beats a richer look that hitches.

---

## 2. Why the old look failed ("it looks like a science project")

This was architectural, not a tuning problem. Every scene was a **fullscreen
additive glow field** with bloom over everything. That combination produces the
exact inverse of the references:

1. **Additive blending + low bloom threshold = muddy mid-tones.** References live
   in true black and blown highlights; the app lived in grey-purple haze.
   (Measured before the fix: **39% of the frame clipped to pure white** while the
   mean sat at 167 — simultaneously washed *and* blown.)
2. **No hard edges.** Raymarched SDFs shaded with fresnel + diffuse give soft
   volumetric falloff. Nothing in the app was *drawn*.
3. **No grain, no grade, no halation** — clean digital output reads as tech demo.
4. **No composition.** Fullscreen noise, edge to edge. References are 60–80%
   empty black around one subject.
5. **No symmetry, and type was a corner overlay rather than part of the frame.**

You cannot tune from glow-soup to crystal-cut. It is a different rendering
approach layered on the same (good) engine.

---

## 3. Technical translation

### 3.1 The grade — ATTEMPTED AND REVERTED (`src/engine/PostFX.tsx`)

A filmic chain (selective Bloom → BrightnessContrast → HueSaturation →
ToneMapping(AgX) → ChromaticAberration → Scanline → Noise → Vignette) was built
and **reverted**: it washed the entire frame to a flat grey and hid every scene.
`PostFX.tsx` is back to the original bloom + aberration + vignette.

Read this before attempting it again — three separate failures, each verified by
reading real canvas pixels:

1. **Chain order.** AgX is a *display transform* and must come last in the colour
   pipeline. Grading after it expands an already-mapped signal into clipping:
   39% of the frame blown to pure white. Reordering fixed that (0% blown, max
   luminance 204).
2. **`BrightnessContrast.brightness` is an ADDITIVE offset, not exposure.** A
   negative value (used to try to crush blacks) drives black *negative*, and
   negative input to AgX's log-space transform comes back as a **lifted mid-grey
   ~193**. Verified directly: with all scene output forced to zero, the chain
   still produced a full-frame grey wash. This was the "scenes don't show up"
   bug. **Never set it below 0.**
3. **The scenes are the real blocker.** They render additively and very hot —
   most of the frame sits at or above 1.0 — so *any* tone mapper parks the whole
   image at its rolloff knee and flattens it to structureless grey. Bloom then
   grabs the entire frame rather than just highlights. **A grade cannot be fixed
   in post alone; the scenes' own output level has to come down first.** That is
   scene work, not post work, and is the true prerequisite for the film look.

Also true and worth keeping:

- **Bloom threshold 0.18 is far too low** — it blooms the whole image and is a
  major cause of the grey haze. Raising it is correct, but only meaningful once
  the scenes are exposed sanely (point 3).
- **The effect list must be FIXED.** Adding/removing effects rebuilds the
  composer's merged shader — a multi-hundred-ms stall — and repeated rebuilds
  exhausted the GPU and lost the WebGL context outright (observed live during
  HMR). Modulate by parameter; never remount.
- **Effect opacities must be initialised at mount, not only in `useFrame`.**
  Grain/scanline blend opacity defaults to 1.0, so any frame rendered before the
  loop ticks shows them at full strength.

**Calibration requires real audio.** An idle frame is not representative (scene
brightness is driven by bass/energy, which are zero at idle), and the preview
pane's stalled rAF serves stale frames. Every blind calibration attempt failed.

### 3.2 Still to build

- **Hard-edge rendering.** `fwidth`-based crisp strokes on SDF isolines,
  wireframe passes, drawn contours. This is the GitS schematic look and the
  single largest visual gap.
- **Crisp graphic layer at native resolution.** `src/ui/TacticalHUD.tsx` is
  already a separate 2D canvas at native res — it is the **most valuable existing
  asset for this aesthetic**. Line art, annotation callouts, and typography drawn
  there are crystal sharp *for free*, while the heavy shader behind runs at lower
  internal resolution. This split serves crispness and performance at once.
  Promote it from corner overlay to composed element (callout lines pointing at
  the subject).
- **Mirror / kaleidoscope post pass.** Cheap; instantly delivers the stage-scale
  symmetry of reference 3.
- **Composition discipline.** Hero subject, centered, surrounded by black. Stop
  filling the frame. This is a *scene design* rule, not a code feature.
- **Hard cuts on the beat** as an alternative to crossfades — more Ikeda, and
  cheaper (no double-scene overlap).

---

## 4. Smoothness architecture (built — see `HANDOFF.md` / memory for detail)

Butter-smooth is about **frame-time variance**, not average. A steady 50 fps
feels smoother than a 60 fps that hitches.

Already in place:

- **`src/engine/quality.ts` — the Quality Governor.** Scales *complexity*, not
  just resolution: `raymarchSteps`, `noiseOctaves`, `fluidJacobi`,
  `particleFraction`, `renderScale`, `maxHeavyLayers`, across a 5-tier ladder
  driven by smoothed frame time. **New heavy scenes must read from it** —
  raymarchers by spreading `qualityUniforms()` and calling
  `applyQualityUniforms(u)`; everything else via `quality.knobs`.
- **Shader pre-warm** (`SceneManager`): the incoming scene mounts when
  *requested*, renders `WARM_FRAMES` frames to force its shader to compile, then
  goes invisible (zero cost) until the downbeat promotes it. Previously the
  compile stalled *on the beat* — the worst-timed hitch in the app.
- **Skip-invisible**: the fluid solver bails entirely when its fade is ~0, so a
  crossfade never runs two sims.
- **Context-loss recovery** (`Stage.tsx`): `preventDefault()` on
  `webglcontextlost` (the difference between recovering and hard-crashing) plus a
  `glEpoch` remount on restore. Verified firing live.

Known remaining levers, in priority order:

1. **Decouple scene resolution from output resolution** — render heavy raymarch
   at ~half res, keep the graphic/type layer native. Grain hides the softness.
2. Crossfade in a half-res buffer, or hard-cut instead of dissolving.
3. Per-scene cost review as new heavy scenes land.

---

## 5. Scene cull

The references are shows with **three or four extremely refined looks**, not
seventeen decent ones. Current count: 16 registered (`ribbons` temporarily
removed at user request).

**Do not port all scenes to the new aesthetic.** Keep a small number as raw
material, delete the rest. Deleting scenes is safe — the engine (audio, mood,
automation, registry) does not care, and `getScene()` filters dangling
`compatibleWith` references automatically.

Selection criteria: does it have a **subject**, can it hold **negative space**,
and can it carry **hard edges**? Fullscreen haze scenes fail all three.

---

## 6. What NOT to change

The engine is not the problem and must not be rewritten:

- Audio analysis (FFT banding, tempo/beat, the 7-state predictive mood engine,
  drop/build/section detection, phrase tracking) — the genuinely hard part, and
  entirely independent of how things look.
- Automation (AutoPilot, PerformanceDirector, CueTimeline, precedence, manual
  backoff).
- Infrastructure (scene registry + metadata, lazy chunks, palettes, store, share
  URLs, recording, MIDI clock, file source).
- The Quality Governor.

A custom renderer has been considered and rejected twice. The look lives in the
fragment shaders, the post chain, and composition — not in the renderer.

# Document 9 — Rendering Engine

> **Audience:** engine developers, shader authors, creative directors.
> **Status:** crystal-cut aesthetic pivot in progress; full grade blocked on scene exposure (see Failure Modes).
> **Spec:** [specs/rendering_engine_spec.md](specs/rendering_engine_spec.md)

---

## Overview

This document owns **how a frame looks and stays smooth**: the post-processing chain, the Quality Governor, and the rendering-technique rules that keep new scenes consistent with the target aesthetic. It does not own *what* scene plays when (Performance Director, [03](03_AI_Performance_Director.md)) or the scene contract itself ([05](05_Scene_Architecture.md)).

The target look was derived from six reference images the user supplied (July 2026), one consistent visual language:

| Reference | Contribution |
|---|---|
| Ghost-in-the-Shell technical schematic (wireframe cyborg hand, phosphor green on grid, annotated callouts) | Hard line-art precision. Drawn strokes, not glow. Annotation as composition. |
| Abstract red/cyan plasma (fine grain, filaments, shard fragments, hot core on dead black) | Fine grain + chromatic fringing + filament structure. |
| Large-format monochrome stage projection (mirrored dot-matrix figure, hard light-beam geometry) | Mirror symmetry, particulate substance, extreme contrast — Ikeda-scale restraint. |
| Chrome/liquid-metal figure above a DJ, intense green wash | A hero object — one readable subject, specular, not abstract soup. |
| Wireframe cube containing a dissolving particle figure | Geometric frame + organic content. |
| *Fallen Angels* (Wong Kar-wai) poster — grain, scanlines, blown saturated grade | Filmic degradation and grade, not clean digital. |

**Unifying principle:** hard-edged precise structure + organic particulate substance + filmic degradation, at brutal contrast. Every reference has a **subject**, **negative space**, and **crisp edges somewhere in frame** — the pre-pivot roster had none of the three.

---

## Goals

- **Crystal-cut clarity.** Hard edges, readable subjects, brutal contrast, real negative space — "crystal cut, perfect clear, artistic" in the user's words.
- **Buttery smooth above all.** Frame-time variance matters more than visual ambition — "buttery smooth is the most important, not choppiness." A simpler look at a rock-solid frame rate beats a richer look that hitches.
- **A small, refined roster** over a large mediocre one.
- **Composition discipline as a first-class constraint**, not an afterthought applied in post.

---

## Responsibilities

- The fixed post-processing chain (`src/engine/PostFX.tsx`) and its calibration.
- The Quality Governor (`src/engine/quality.ts`) and the smoothness mechanisms built around it.
- Rendering-technique guidance that keeps new scenes compatible with a future grade (output level, edge language).

---

## Non-Goals

- A custom WebGL2 renderer — considered and rejected **twice**. The GPU, not the host rendering API, sets the ceiling; a rewrite moves nothing. The look lives in fragment shaders, the post chain, and composition.
- Reintroducing the full filmic grade chain without first bringing scene output level down (see Failure Modes) — attempting the grade again before that prerequisite is done will reproduce the same failure.

---

## Architecture

### Why the pre-pivot look failed ("it looks like a science project")

This was architectural, not a tuning problem. Every scene was a fullscreen additive glow field with bloom over everything — the exact inverse of the references:

1. **Additive blending + low bloom threshold = muddy mid-tones.** References live in true black and blown highlights; the app lived in grey-purple haze. Measured before the fix: 39% of the frame clipped to pure white while the mean sat at 167 — simultaneously washed *and* blown.
2. **No hard edges.** Raymarched SDFs shaded with fresnel + diffuse give soft volumetric falloff. Nothing in the app was *drawn*.
3. **No grain, no grade, no halation** — clean digital output reads as tech demo.
4. **No composition.** Fullscreen noise, edge to edge. References are 60–80% empty black around one subject.
5. **No symmetry**, and type was a corner overlay rather than part of the frame.

You cannot tune from glow-soup to crystal-cut — it required a different rendering approach layered on the same (good) engine, not a rewrite of the engine.

### Scene roster

**Status: done.** Five scenes are registered — `schematic`, `wireframe`, `plasma`, `dissolve`, `chrome` (see [05_Scene_Architecture.md](05_Scene_Architecture.md) for their contract and technique). The other sixteen legacy scenes are unregistered — still on disk, loader entries kept, absent from `SCENES[]`, safe to delete (the engine doesn't care, and `getScene()` filters dangling `compatibleWith` references automatically).

Selection rubric for any scene, old or new: does it have a **subject**, can it hold **negative space**, can it carry **hard edges**? Fullscreen haze scenes fail all three.

---

## Algorithms

### The grade — attempted and reverted (`src/engine/PostFX.tsx`)

A filmic chain (selective Bloom → BrightnessContrast → HueSaturation → ToneMapping(AgX) → ChromaticAberration → Scanline → Noise → Vignette) was built and **reverted**: it washed the entire frame to flat grey and hid every scene. `PostFX.tsx` is back to the original bloom + aberration + vignette. Three separate failures, each verified by reading real canvas pixels — read this before attempting the grade again:

1. **Chain order.** AgX is a *display transform* and must come last in the colour pipeline. Grading after it expands an already-mapped signal into clipping — 39% of the frame blown to pure white. Reordering fixed that (0% blown, max luminance 204).
2. **`BrightnessContrast.brightness` is an additive offset, not exposure.** A negative value (used to try to crush blacks) drives black *negative*, and negative input to AgX's log-space transform comes back as a lifted mid-grey (~193). Verified directly: with all scene output forced to zero, the chain still produced a full-frame grey wash. **Never set it below 0.**
3. **The scenes are the real blocker.** They render additively and very hot — most of the frame sits at or above 1.0 — so *any* tone mapper parks the whole image at its rolloff knee and flattens it to structureless grey. Bloom then grabs the entire frame rather than just highlights. **A grade cannot be fixed in post alone; the scenes' own output level has to come down first.** That is scene work ([05](05_Scene_Architecture.md)'s "target 0–1 range on hero elements"), not post work, and is the true prerequisite for the film look.

Also true and worth keeping for the next attempt:

- **Bloom threshold 0.18 is far too low** — it blooms the whole image and is a major cause of the grey haze. Raising it is correct, but only meaningful once scenes are exposed sanely (point 3 above).
- **The effect list must stay structurally fixed.** Adding/removing effects rebuilds the composer's merged shader — a multi-hundred-ms stall — and repeated rebuilds exhausted the GPU and lost the WebGL context outright (observed live during HMR). Modulate by parameter; never remount.
- **Effect opacities must be initialized at mount**, not only in `useFrame`. Grain/scanline blend opacity defaults to 1.0, so any frame rendered before the loop ticks shows them at full strength.

### Still to build

- **Hard-edge rendering.** `fwidth`-based crisp strokes on SDF isolines, wireframe passes, drawn contours. This is the GitS schematic look and the single largest visual gap.
- **Promote `TacticalHUD` from corner overlay to composed element.** `src/ui/TacticalHUD.tsx` is already a separate 2D canvas at native resolution — the most valuable existing asset for this aesthetic. Line art, annotation callouts, and typography drawn there are crystal sharp *for free*, while the heavy shader behind runs at lower internal resolution. Promoting it means callout lines pointing at the subject, not just a corner readout.
- **Mirror / kaleidoscope post pass.** Cheap; instantly delivers the stage-scale symmetry of the monochrome-stage reference.
- **Composition discipline.** Hero subject, centered, surrounded by black. This is a scene-design rule, not a code feature.
- **Hard cuts on the beat** as an alternative to crossfades — more Ikeda, and cheaper (no double-scene overlap). Partially implemented — see the heavy-overlap guard in [08_Transition_Engine.md](08_Transition_Engine.md).

---

## Performance Constraints

Butter-smooth is about **frame-time variance**, not average — a steady 50 fps feels smoother than a 60 fps that hitches. Mechanisms already in place:

- **`src/engine/quality.ts` — the Quality Governor.** Scales *complexity*, not just resolution: `raymarchSteps`, `noiseOctaves`, `fluidJacobi`, `particleFraction`, `renderScale`, `maxHeavyLayers`, across a 5-tier ladder driven by smoothed frame time. New heavy scenes must read from it — raymarchers by spreading `qualityUniforms()` and calling `applyQualityUniforms(u)`; everything else via `quality.knobs`.
- **Shader pre-warm** (`SceneManager`) — the incoming scene mounts when requested, renders `WARM_FRAMES` frames to force its shader to compile, then goes invisible (zero cost) until the downbeat promotes it. Previously the compile stalled *on the beat* — the worst-timed hitch in the app.
- **Skip-invisible** — the fluid solver bails entirely when its fade is ~0, so a crossfade never runs two sims.
- **Context-loss recovery** (`Stage.tsx`) — `preventDefault()` on `webglcontextlost` (the difference between recovering and hard-crashing) plus a `glEpoch` remount on restore.

Known remaining levers, in priority order:

1. **Decouple scene resolution from output resolution** — render heavy raymarch at ~half res, keep the graphic/type layer native. Grain hides the softness.
2. Crossfade in a half-res buffer, or hard-cut instead of dissolving.
3. Per-scene cost review as new heavy scenes land.

---

## Failure Modes

| Condition | Behavior / mitigation |
|---|---|
| Grade attempted before scene output is sane | Full-frame grey wash regardless of grade parameters — fix scene exposure first, not the grade |
| `BrightnessContrast.brightness` set below 0 | Lifted mid-grey (~193) even with zero scene output — never do this |
| PostFX effect list changed at runtime | Multi-hundred-ms composer rebuild stall; repeated changes can lose the WebGL context |
| Calibrating against an idle frame | Not representative — scene brightness is audio-driven and near-zero at idle |
| Calibrating in a preview pane with a stalled render loop | Serves stale canvas frames; measurements can silently reflect an old frame |

---

## Testing

- **Calibration requires real audio.** An idle frame is not representative (scene brightness is driven by bass/energy, which are zero at idle), and a preview pane with a stalled `requestAnimationFrame` loop serves stale frames rather than live ones. Every blind calibration attempt against synthetic or idle state has failed — verify grade/bloom constants only against a real, playing track.
- `npm run check` for type safety; no automated visual regression suite exists.

---

## Future Improvements

See "Still to build" above, plus [HANDOFF.md](HANDOFF.md) §7 for sequencing against the rest of the roadmap.

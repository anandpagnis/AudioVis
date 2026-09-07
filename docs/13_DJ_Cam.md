# 13 · DJ Cam

> **Status:** implemented on branch `dj-cam`. Opt-in, off by default.

A rare broadcast-style cutaway: at a genuine high point of the set the AI
director drops the synthetic show and cuts to a **live camera of the DJ**, holds
it through the moment, then eases back to a real scene. There is also a manual
"Cut to DJ Cam" punch button on the Console for live use and for tuning the
look.

**Naming.** This is _not_ `CameraDirector` (`06_Camera_Director.md`), which runs
3D virtual-camera moves per scene. DJ Cam replaces the whole frame with a webcam
feed.

---

## The pieces

| File                                | Role                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/djCamSource.ts`             | Module singleton. Owns the `MediaStream` + one shared offscreen `<video>`. `acquire()` runs `getUserMedia` in the **control window** inside a click and hands the stream to the output window via `outputLink.handSource({kind:'camera'})`. Mirrors the mic path (already-denied pre-check, `withTimeout`, `startToken`). |
| `scenes/DjCamScene.tsx`             | Hand-written R3F scene, id `djcam`. Fullscreen `VideoTexture` quad + a broadcast-grade fragment shader (cover-fit, 2.39:1 letterbox, vignette, desaturation, contrast lift, faint energy-tied grain). Opaque. Reads `ctx.state.djCam.releasing` to fade **itself** to black on the way out.                               |
| `engine/DjCamDirector.tsx`          | Decide-band director, `useFrame(-87)`. Pure `advanceDjCam(opts)` (enter/hold/exit decision) + a thin wrapper that applies it and owns the exit choreography. Sole writer of `performanceState.djCam`.                                                                                                                     |
| `engine/performanceState.ts`        | `djCam: { active, since, manual, releasing }`.                                                                                                                                                                                                                                                                            |
| `store.ts`                          | `djCamEnabled` (persisted opt-in), `djCamDeviceId` / `djCamDevices` (device picker), `pendingDjCam` / `djCamRequestNonce` + `requestDjCam()` / `clearDjCamRequest()` (the manual punch, a one-shot channel copied from `pendingFilterId`).                                                                                |
| `engine/outputLink.ts`              | `LOOK_FIELDS` gains the four store fields; `Telemetry.djCamActive` reports the live cutaway back up so the Console button reads real output state. `HandedSource` gains `{kind:'camera'}`.                                                                                                                                |
| `engine/ExposureSampler.tsx`        | Stops sampling while `djCam.active` — a lit room would otherwise pull the whole show's exposure down for the length of the cutaway.                                                                                                                                                                                       |
| `engine/PerformanceStateBridge.tsx` | Holds the layer-tenancy desires null while `djCam.active` — nothing composites over the DJ's face.                                                                                                                                                                                                                        |
| `ui/Console.tsx`                    | The "DJ Cam" panel in the Post FX column: preview, punch button, connect-camera + device select, autofire toggle.                                                                                                                                                                                                         |
| `scenes/index.ts`                   | `HIDDEN_PICKER_IDS = new Set(['djcam'])` — `djcam` is `roles:['primary']` (so `requestScene` accepts it) but filtered out of every by-hand picker; `getScenesForMood` and `validateSceneDef`'s mood check also honour the set.                                                                                            |

---

## When it fires

**Auto** (`djCamEnabled` on). Every gate must pass:

- a rising edge of `songSection.isDrop`, with `sectionConfidence ≥ 0.6`;
- `performanceState.visualTension ≥ 0.9` (a real drop's `+0.5` spike clears this; a soft section change does not);
- a genuine build preceded it (`songSection.buildProgress` peaked `≥ 0.6`);
- past a **45 s** warm-up into the source;
- outside a **240 s** wall-clock global cooldown (survives track changes);
- once per source (a per-source latch, reset on the engine-clock rewind);
- outside a **60 s** window after a manual cutaway ended;
- transport running, not near-silent, not `cueState.governed`, camera stream live.

**Manual** — the Console "Cut to DJ Cam" button (or `?djcam=on`). Bypasses every
auto guard. Requires only a live camera stream.

Constants live in a grouped block at the top of `DjCamDirector.tsx` and are
pinned by `djCamDirector.test.ts`.

---

## How it enters and leaves

`dipToBlack` (the plan's first choice) is in the engine's `DISABLED_STYLES` and
coerces to `dissolve`, which ghosts the opaque letterboxed feed. So:

- **Enter — hard cut.** `requestScene('djcam', { immediate: true })`. The right
  edit on a drop, and ghost-free because it never overlaps.
- **Hold.** Auto: at least `DJCAM_AUTO_HOLD_FLOOR_BEATS` (**32**, one phrase),
  then release on the next `sectionChange` / `boundaryChanged`; hard ceilings at
  **64 beats** and **45 s** wall clock. Manual: holds until punched out, with a
  **240 s** dead-man ceiling.
- **Leave — scene-owned dip.** `performanceState.djCam.releasing` goes true;
  `DjCamScene` ramps its own output to black over `DJCAM_EXIT_FADE_SEC` (**0.6 s**).
  The return scene is requested **non-immediate**, so it commits on a downbeat
  and dissolves up from a frame that is already fully black — smooth, and
  ghost-free because nothing of the feed is left to bleed through the bars. The
  32-beat floor exists precisely so the `djcam` subject has cleared
  `MIN_SUBJECT_DWELL_BEATS` (32) and that non-immediate request is accepted; a
  short manual hold falls back to an immediate cut from the already-black feed.
- **Fail-closed.** A dropped camera stream ends any cutaway at once (no fade —
  the feed is frozen). `djCamEnabled` going false ends an _auto_ cutaway but not
  a live manual punch.

While `djCam.active` (which stays true through the release fade) `AutoPilot`,
`PerformanceDirector`, `EffectDirector` and `FilterDirector` all stand down.

---

## Tuning the grade

`djcam` carries a Scene Contract whose neutral 0.5 position **is** the locked
cinemascope look. Five dials, live from the Console:

| Dial (contract key)           | Effect                                                            |
| ----------------------------- | ----------------------------------------------------------------- |
| `fill` — "letterbox"          | bar thickness (0.5 → 2.39:1; higher → tighter; far enough → gone) |
| `shape` — "vignette"          | radial darkening (human-only; `sceneSteer` declines `shape`)      |
| `complexity` — "desaturation" | pull toward luma (0.5 → ~15%)                                     |
| `density` — "grain"           | film-grain amplitude (further scaled by `energy`)                 |
| `contrast`                    | S-curve lift about mid-grey (0.5 → ~1.12×)                        |

`?djcam=on` enables auto **and** punches one cutaway on load, so the grade can
be iterated on without waiting for a real drop.

---

## Testing

- `engine/__tests__/djCamDirector.test.ts` — the pure `advanceDjCam` decision
  core (auto gates, hold/release with the beat floor + dual ceilings, manual
  path bypassing every guard, both fail-closed paths, post-manual suppress) plus
  the store punch channel.
- `outputLink.test.ts`, `canHoldPrimary.test.ts`, `registry.test.ts` — the
  cross-window wiring, the picker exclusion, and that `djcam` never reaches an
  automatic pool.
- Live: `npm run dev`, Console → connect a camera, punch "Cut to DJ Cam", tune
  the grade dials, punch back. For the auto path, play a track with a clear
  build→drop with `djCamEnabled` on.

## Not in scope (v1)

Auto framing / face tracking, picture-in-picture, a MIDI binding for the punch.

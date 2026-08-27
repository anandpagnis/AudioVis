# Scene roles, as a measurable contract

Every role assignment in the roster today was made by a human looking at the
scene. That does not survive a marketplace: a third-party scene arrives with a
*claim* about what it is, and something has to check the claim.

This document is the spec that check will be written against. It exists before
the machinery on purpose — writing down what we have been doing implicitly is
the cheapest way to find out whether it is coherent.

## The five roles

| role | render order | gain | chosen | cadence |
|---|---|---|---|---|
| `background` | 0 | 0.40 | PerformanceDirector | section boundaries only |
| `primary` | 10 | 1.00 | PerformanceDirector / AutoPilot / operator | section, or 16-beat phrase fallback |
| `accent` | 20 | 0.55 | PerformanceDirector | with the primary |
| `overlay` | 30 | 0.40 | PerformanceDirector | with the primary |
| `effect` | 40 | 0.85 | EffectDirector | rising-edge musical triggers |

Everything composites **additively**, so gains sum rather than average. The
ladder descends with distance from the subject; each scene is authored to look
right alone at 1.0, and those numbers are how much each yields to the subject.

## Why this can be measured at all

The reasons already written into `src/scenes/index.ts` for the sixteen manual
decisions are, without exception, statements about pixels:

- `orbs` → background: *"nowhere near enough structure to carry a frame as the
  subject, but composites beautifully over one"*, and the cheapest in the roster.
- `kaleido` → primary only: *"a centred mandala owns the middle of the frame by
  construction; composited over another subject the two symmetries fight, and
  behind one it is entirely hidden by its own dark centre."*
- `wireframe` → primary only: *"two subjects fighting for the same frame."*
- `trail` → primary only: it pays for a render-target pair.

Coverage, spatial distribution, conflict with another subject, cost. Not one of
them required knowing what the scene *means*. That is the whole basis for
profiling rather than inferring: an LLM reading shader source would be guessing
at something a renderer can measure, and when a marketplace scene is mis-roled,
"the model thought it was a background" is not a debuggable answer.

## The four statistics

Measured per scene per tier, from frames the scene actually rendered, in
isolation, framed on its own `cameraAnchor`.

All four are taken from a **range-normalised** copy of the frame: the field's
[p5, p99] is mapped onto a fixed reference before anything is measured. Two
exceptions stay raw, and both are deliberate — `meanLuma` and `motion`.

Normalising is what lets composition be compared across scenes at all.
Brightness is the engine's job: the exposure servo and the slot gains own level,
and a scene is authored to look right at 1.0. Two scenes with the same shape
should profile the same, because that is how they will be seen.

The **floor** has to come off before the field is amplified, and that is not a
detail. Measured: normalising to p99 alone, with the post chain mounted, took
`orbs` from `fill 0.021` to `fill 0.963` and every scene in the roster above
0.83 — the statistic stopped discriminating entirely. With bloom and the fog
veil there is no true black left to normalise against, so scaling from the top
amplifies the lifted floor straight past the lit threshold.

### 1. Fill — how much of the frame is lit

Fraction of pixels above a threshold, on the normalised field. Separates a
bright subject on black from a wash that covers everything.

A subject may fill the frame. A layer that fills the frame has nowhere to sit.

**A flat field has no range**, so it reports no structure — which is true, and
opens a hole this statistic cannot close on its own: judged on shape alone a
mid-grey wash looks like an empty frame. The layer veto therefore also consults
absolute `meanLuma`. It is the one place level is still checked, and a wash is
precisely the case where level *is* the composition.

### 2. Centrality — where the light is

Share of total lit energy falling in the centre, the mid-field and the edge.

This is the statistic that catches `kaleido` on its own: a centred mandala puts
almost all its energy in the middle, which is precisely where a subject already
is. It also catches the inverse — a scene whose energy is entirely peripheral is
a frame, not a subject.

### 3. Motion — how fast it changes

Frame-to-frame luminance change, averaged over the measured window, on the
**raw** field.

Raw because a scene that pulses in brightness without changing shape *is*
moving. Normalising every frame to the same level made exactly that scene read
as perfectly still, which is the opposite of what motion is asked for here.

A background that changes per beat is a second subject; the recompose cadence
already encodes that belief (*"a ground that changes every 16 beats is just a
second primary"*). An effect that changes slowly is not punctuation.

### 4. Conflict — what happens when it meets a subject

Everything blends additively, so a layer cannot *occlude* a subject. It can only
add light. So the failure mode is not occlusion, it is **saturation**: two
scenes piling light into the same region until neither is readable. "Two
subjects fighting for the same frame" is exactly that.

Measured as the overlap between this scene's lit energy and a **canonical
subject model** — a centred blob matching the exposure doctrine in
`09_Rendering_Engine.md` (a bright subject, centred, ≤15% of the frame lit) —
plus the share of pixels that would exceed full white once summed.

Computed analytically from the same luminance field as the other three. No
second render, nothing to keep in sync.

## Eligibility, as rules

These are the *starting* thresholds, to be tuned in validation. They are
deliberately written as vetoes rather than as grants.

**`primary` requires** enough structure to hold a frame alone: fill above a
floor, and centrality that is not purely peripheral. A scene that lights 2% of
the frame at the edges is not a subject.

**`background` requires** low conflict, low motion, low cost, and fill that is
distributed rather than centred. It is present for a whole section under
everything else, so it is the role with the least tolerance for expense or for
competing with the subject.

**`accent` and `overlay` require** low conflict above all — this is the pair
that sits directly over the subject. Moderate fill, and cost that leaves room
for the subject plus the other slot.

**`effect` cannot be profiled**, and this is a real limit rather than an
omission. The role's binding requirement is a *contract*, not a property: the
scene must drive itself to visual zero by `slotProgress` 1, because
`SceneManager` retires it there and does not fade it out. A scene either honours
that or vanishes mid-frame. It has to stay declared-and-verified — the profiler
can check the contract is met by sampling the scene's output across its
lifetime, but it cannot infer the intent.

## The posture: declaration is a claim, measurement is a veto

A scene **declares** the roles it intends to hold. The profile may **refuse** a
declared role. It may never **grant** one that was not declared.

This is not a technicality. An author knows things the profiler does not —
what the scene is for, how it was composed, what it is meant to sit against.
Measurement knows one thing the author reliably does not: whether it actually
behaves that way on this engine, at this cost, against a real subject. Letting
the profiler grant roles would put a statistic in charge of art direction.
Letting it veto keeps it in the role it is good at.

It is also the posture `registerScene` already takes on cost: an untrusted scene
may claim a `pixelBudget` and have it capped at `UNTRUSTED_MAX_BUDGET`, rather
than being asked to have no opinion.

## Known uncertainties

Recorded before the work rather than after, so it is clear which parts are
expected to survive contact.

- **Palette dependence.** Conflict is measured in luminance, and a dark palette
  produces less of it than a bright one for the same geometry. Range
  normalisation absorbs some of this — a uniformly darker palette normalises
  back — but not a palette that changes the DISTRIBUTION of light. Either the
  profile is measured on a fixed reference palette, or across several with the
  worst case taken. Not yet decided.
- **The post chain is now part of the measurement**, which was the point of
  fixing defect 1, and it means the profile depends on the exposure servo's gain
  and on whatever the bloom threshold is set to. A scene that only reads through
  bloom is a scene that only reads through bloom — but if the post chain is
  retuned, every profile is stale.
- **Camera dependence.** The bench frames each scene on its declared
  `cameraAnchor`, held still. `CameraDirector` moves. A scene can be
  well-behaved at its anchor and centred everywhere else in its orbit.
- **Tier dependence.** All four statistics are measured per tier, but the roles
  are declared once. If a scene's centrality changes materially with tier,
  something has to decide which row governs.

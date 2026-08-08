# Test tracks (MTG-Jamendo)

Eight Creative-Commons tracks for validating the audio pipeline against real
music instead of synthetic click tracks. Sourced from the
[MTG-Jamendo dataset](https://github.com/MTG/mtg-jamendo-dataset) — the same
corpus Essentia's own models are trained and validated on, so its tags are
reasonable ground truth for what our estimators should be reporting.

**The `.mp3` files are gitignored and not committed.** `tracks.json` is the
committed artifact — it records every track's Jamendo id, tags, license and
attribution, which is enough to re-fetch the identical set without this repo
redistributing anyone's audio. See *Licensing* below for why that matters.

## Re-fetching

```
node scripts/fetch-test-tracks.mjs
```

Or by hand, per track in `tracks.json`:

```
https://cdn.freesound.org/mtg-jamendo/raw_30s/audio-low/<last 2 digits of jamendoId>/<jamendoId>.low.mp3
```

## The set

| file | category | genre tags | voice tag | length |
| --- | --- | --- | --- | --- |
| `electronic__948191.mp3` | electronic | dance, disco, electronic, house | no | 2:47 |
| `electronic__1112048.mp3` | electronic | classical, electronic, soundtrack | no | 1:24 |
| `rock-pop-vocals__1071484.mp3` | rock/pop + vocals | pop | **yes** | 2:51 |
| `rock-pop-vocals__875003.mp3` | rock/pop + vocals | alternative, indie, rock | **yes** | 2:49 |
| `ambient-instrumental-no-voice__783235.mp3` | ambient instrumental | ambient, orchestral, soundtrack | no | 2:00 |
| `ambient-instrumental-no-voice__1079451.mp3` | ambient instrumental | ambient, soundtrack | no | 2:23 |
| `hiphop-vocals__585146.mp3` | hiphop + vocals | chillout, hiphop, triphop | **yes** | 1:12 |
| `hiphop-vocals__1137250.mp3` | hiphop + vocals | electronic, hiphop, triphop | **yes** | 2:04 |

Total 12.3 MB, ~17 minutes. Four tracks carry an `instrument---voice` tag and
four do not — a deliberate 4/4 split, since Phase 3's voice/instrument
classifier needs negatives as much as positives.

Two caveats on the ground truth:

- Tags are **uploader-supplied**, not expert annotation. They are a sanity
  check ("does this read as hiphop"), not a gold standard.
- `instrument---voice` means *voice is present somewhere*, not that the track
  is vocal-led. The absence of the tag is the more reliable half of the signal.

## Audio properties

Mono, 85–108 kbps, **mixed 44.1 and 48 kHz** — the low-bitrate dataset variant.
The mixed sample rates are a feature here: they exercise `EssentiaBridge`'s
resample path, which silently transposes every key estimate if it regresses.

Note `raw_30s` in the source URLs means "tracks at least 30 s long", **not**
30-second excerpts. These are full-length verbatim tracks.

## Licensing

Confirmed before adding anything:

- **Dataset terms**: "the MTG-Jamendo Dataset is made available solely for
  non-commercial research and academic use. Any other use requires prior
  written authorization from Jamendo S.A." Local testing of a personal,
  non-commercial tool sits inside that. Shipping these files in a product does
  not — contact hello@jamendo.com if that ever changes.
- **Per-track**: four tracks are CC BY-SA, four are CC BY-NC-SA. Exact license
  and URL per track are in `tracks.json`.
- **NoDerivatives excluded on purpose.** Several otherwise-good candidates were
  CC BY-NC-**ND**. Trimming a clip is an adaptation, which ND forbids — so
  selecting only BY-SA / BY-NC-SA keeps local trimming legitimate. If you add
  tracks later, keep excluding ND for the same reason.
- **Why gitignored rather than committed**: committing is redistribution, which
  triggers attribution and share-alike obligations on this repo, and the
  NC clause would constrain what the repo itself may ever be used for. Keeping
  the audio local and committing only the manifest avoids all of that, and
  keeps binaries out of git history.

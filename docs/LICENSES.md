# Licences: what may ship

Single source of truth for which third-party components may be in a build that is
distributed or sold (accounts / Pro tier), and the open decisions that are still
the owner's. Written 2026-09-19 from an audit of the repository; every licence
fact below is marked **verified** (read from the file or the upstream page on
that date) or **unverified**. This is a factual inventory, not legal advice.

Related: `THIRD_PARTY_NOTICES.md` (generated, npm production deps),
`src/ui/Credits.tsx` (in-app attribution), `scripts/check-dist-licences.mjs`
(build gate), `docs/HANDOFF.md` §6 (known licence blockers),
`testfolder/README.md`, `corpus/README.md`.

## The rule

**A build that is distributed or sold must pass both gates:**

1. `npm run check:licences` - scans `dist/` and fails if any Essentia / AGPL
   code, MusiCNN weights, `models/` directory, or un-allowlisted audio file is
   present (`scripts/check-dist-licences.mjs`; `npm run build:commercial` runs
   it after the build; `npm run check` runs it last).
2. `npm run licences:check` - fails if `THIRD_PARTY_NOTICES.md` is stale, or if
   any production npm dependency carries an AGPL / GPL / LGPL / SSPL / CC-NC /
   unknown licence that is not in the explicit allowlist in
   `scripts/gen-third-party-notices.mjs` (currently only `essentia.js`, allowed
   solely because it is gated behind `VITE_ENABLE_ESSENTIA`, default off, and
   excluded from commercial builds). After any dependency change run
   `npm run licences:notices` and commit the result.

Commercial builds are built with `VITE_ENABLE_ESSENTIA` unset. Setting it to `1`
is for local / internal, non-distributed builds only.

## Inventory

| Component class | Where | Licence | Ships in a commercial build? | Status |
| --- | --- | --- | --- | --- |
| npm production deps (81 packages incl. transitive) | `package.json`, `THIRD_PARTY_NOTICES.md` | MIT, Apache-2.0, BSD-3-Clause, ISC, Zlib, 0BSD, plus `dompurify` `(MPL-2.0 OR Apache-2.0)` and `posthog-js` `(Apache-2.0 AND MIT)` | Yes, except `essentia.js` (below) | **Verified** by the generator reading each `node_modules/<pkg>/package.json` |
| `essentia.js` 0.1.3 (JS wrapper + WASM core) | `src/audio/essentia/`, `src/audio/intel/` | **AGPL-3.0** (its `package.json` and `LICENSE`) | **No** - only when `VITE_ENABLE_ESSENTIA=1` | **Verified.** Was bundled unconditionally with no notice until the build-flag work on this branch |
| MusiCNN / Essentia mood + voice models | `public/models/**` (gitignored) | **CC BY-NC-SA 4.0** (MTG models page: "All the models created by the MTG are licensed under CC BY-NC-SA 4.0") | **No** | **Verified** 2026-09-19 on essentia.upf.edu/models.html |
| TF.js runtime | `@tensorflow/tfjs-*` 4.22 | Apache-2.0 | Only in the Essentia path (`voice.worker.ts` is its only importer) | **Verified** from package metadata. The npm tarballs ship no LICENSE file; the Apache-2.0 text is reproduced in `THIRD_PARTY_NOTICES.md` |
| TF.js WASM binaries | `public/tfjs/*.wasm` (gitignored, copied from `@tensorflow/tfjs-backend-wasm` by `scripts/setup-tfjs-wasm.mjs`) | Apache-2.0 | Only in the Essentia path | **Verified** from the source package's declared licence |
| Vendored ISF filters (5) | `src/assets/isf/filters/` | MIT (Vidvox ISF-Files) | Yes | **Verified**; `LICENSE` + `NOTICE` rendered in `Credits.tsx` |
| Live scenes | `src/scenes/` | Per-scene, see `SceneMetadata.license` | Only `commerciallyShippableScenes()` | See "Open items: scene provenance" |
| Landing music | `public/landing/fractures.mp3` (used only by `src/landing/tunnelAudio.ts`) | **Unknown.** ID3 title "Fractures", artist "Anderholm, Alexandra Pride"; no licence or attribution anywhere in the repo | Currently yes (allowlisted with a TODO in the dist gate) | **Unresolved - owner decision** |
| Test corpus | `testfolder/*.mp3` (gitignored, 8 tracks) | Per track: 5 x CC BY-NC-SA 3.0, 2 x CC BY-SA 3.0, 1 x CC BY-SA 2.0 (`testfolder/tracks.json`); dataset terms "solely for non-commercial research and academic use" | **No** - local evaluation only | **Verified** against `tracks.json`; dataset terms verified on github.com/MTG/mtg-jamendo-dataset |
| Calibration corpus | `corpus/audio/`, `corpus/frames/`, `corpus/refs/` (gitignored) | MTG-Jamendo, as above | **No** | Same terms as above. Committed derived files (`corpus/distributions.json`, `corpus/eval-report.md`) and DSP constants tuned on them are measurements from that corpus; see the datasets rule |
| Dataset annotations | MTG-Jamendo metadata; DEAM | Jamendo metadata **CC BY-NC-SA 4.0** (verified). DEAM: **unverified** in this audit, treat as non-commercial | **No** | Internal evaluation only |
| Fonts | `index.html` loads Google Fonts CSS for **Space Grotesk** (300/400/500/700) and **IBM Plex Mono** (300/400/500) from `fonts.googleapis.com` / `fonts.gstatic.com` | Both SIL Open Font License 1.1 | Fetched from Google at runtime, not bundled | **Verified** 2026-09-19: Space Grotesk repo states "licensed under the SIL Open Font License v1.1"; IBM Plex repo states OFL. No font files are in the repo. Privacy impact of the third-party request is not a licence matter and is not assessed here |
| Screenshots | `public/proof/*.png` (used on the marketing page / `og:image`) | Project screenshots | Yes | **Unverified** - provenance not recorded; confirm they show only own / cleared scenes |
| Project code itself | repository root | **No LICENSE file; `package.json` has no `license` field (`"private": true`)** | n/a | **Owner decision** |

## Essentia, MusiCNN, AGPL and CC BY-NC-SA

What is true today:

- `essentia.js` (wrapper and WASM core) is AGPL-3.0. AGPL section 13 extends
  the source-offer obligation to users who interact with the software over a
  network, which is how this app is delivered.
- The MusiCNN weights are CC BY-NC-SA 4.0: non-commercial, and share-alike.
  They are gitignored and must stay out of git history, Git LFS and any
  deployed `dist/` (see `docs/HANDOFF.md` §6).
- A branch-level switch exists: `VITE_ENABLE_ESSENTIA` (default off). With it
  off, the Essentia provider is behind a build-time-dead dynamic import and
  `dist/` should contain none of it; `scripts/check-dist-licences.mjs` is the
  check that this is actually so. The product must be verified fully
  functional in that mode before it is called the commercial configuration.
- With the flag on, `Credits.tsx` renders the MTG-UPF attribution, the AGPL-3.0
  and CC BY-NC-SA 4.0 notices, and a link to essentia.upf.edu. That is an
  attribution aid, not a substitute for meeting AGPL-3.0 or the NC/SA terms.

Options for shipping music analysis commercially:

1. **Permissive replacement (chosen direction).** Ship without Essentia and
   without the MusiCNN weights; use the project's own DSP estimators
   (`src/audio/`) and, if learned models are wanted, weights whose licence is
   confirmed permissive (candidates below). The consuming code is already
   `moodsValid`-gated, so this is weights-only. Note `docs/ISSUES.md` F168
   calls the DFA `danceability` fallback "licence-clean", but that value is
   computed by Essentia in the worker; it is not available when Essentia is
   excluded, so do not rely on it for the commercial configuration.
2. **Proprietary licence from MTG.** MTG's models page says the models "are
   also available under proprietary license upon request" (verified
   2026-09-19). That covers the models; whether it also covers the essentia.js
   AGPL code is not stated on that page and would have to be asked of MTG in
   writing. Only pursue if the MusiCNN features are worth the cost.

Do not "fix" either by committing the weights, adding a `postinstall` fetch, or
moving them into an LFS store.

## Datasets rule

MTG-Jamendo audio is licensed for "non-commercial research and academic use"
only; its metadata / annotations are CC BY-NC-SA 4.0; commercial use needs prior
written authorisation from Jamendo S.A. (hello@jamendo.com). DEAM annotations
are to be treated the same way (unverified). Therefore:

- Jamendo / DEAM audio and annotations are for **internal evaluation only**.
- **Never train, fine-tune or distil weights that ship on them**, and never
  ship them, their features, or labels derived from them as product data.
- Calibration constants in `src/audio/` that were tuned against measured
  Jamendo distributions (`corpus/`) are derived measurements, not the corpus
  itself, but this is the grey area to put in front of counsel before launch
  rather than assume.

## Candidate replacement models

Verified means the licence was read on the upstream page on 2026-09-19.
Status is for the *weights* unless stated; code licences are separate.

| Candidate | Licence | Status |
| --- | --- | --- |
| YAMNet (Google) | Apache-2.0 expected (code lives in `tensorflow/models`, Apache-2.0) | **Unverified**: the licence line was not found on the README or Kaggle/TF Hub model page fetched; confirm on the exact weights you would ship |
| LAION-CLAP | Repo `LAION-AI/CLAP`: CC0-1.0 (page shows it). HF checkpoint `laion/clap-htsat-unfused` card: `apache-2.0` | **Verified** for those two pages; check each checkpoint's own card and its training-data terms before use |
| OpenL3 | Code MIT; pretrained weights **CC BY 4.0** ("made available under a Creative Commons Attribution 4.0 International (CC BY 4.0) License") | **Verified**; requires attribution, so it belongs in `Credits.tsx` if adopted |
| MS-CLAP (Microsoft) | Code MIT (page shows it) | Code **verified**; **weights unverified** - the page does not state the licence of the Zenodo / Hugging Face checkpoints |

Whichever is chosen, also confirm the licence of the data it was trained on and
of any label set (AudioSet labels are CC BY 4.0 but the underlying audio is not
part of the model licence) - not verified here.

**Rejected:**

| Model | Licence | Why |
| --- | --- | --- |
| MERT (`m-a-p/MERT-v1-330M`) | Weights **CC-BY-NC-4.0** (model card, verified) | Non-commercial |
| MuQ / MuQ-MuLan | Code MIT; weights **CC-BY-NC 4.0** (repo README, verified) | Non-commercial |

## Open items (owner decisions)

1. **OWNER DECISION NEEDED - project licence and copyright holder.** There is
   no root `LICENSE`, and `package.json` declares no `license`. Choosing the
   licence (or staying proprietary / all-rights-reserved) and the copyright
   holder is not something this audit or its tooling decides. Until then the
   repository has no stated licence.
2. **OWNER DECISION NEEDED - `public/landing/fractures.mp3`.** Provide the
   licence and attribution text for "Fractures" (Anderholm, Alexandra Pride) -
   e.g. purchase / licence receipt or CC terms - or replace the track. Then
   remove it from `AUDIO_ALLOWLIST` in `scripts/check-dist-licences.mjs`
   (or keep the entry with the evidence) and add the credit to
   `src/ui/Credits.tsx` (a `TODO(owner)` is there; deliberately not rendered
   until verified). The file is referenced only by `src/landing/tunnelAudio.ts`.
3. **OWNER DECISION NEEDED - Essentia path.** Pick option 1 (permissive
   replacement) or option 2 (MTG proprietary licence) above; until one is done,
   commercial builds run with music-analysis ML off.
4. **OWNER DECISION NEEDED - legal review of AGPL exposure for any build that
   shipped Essentia, including the currently deployed site.** What the repo
   does and does not tell us:
   - `.github/workflows/ci.yml`: on push to `main`, after `npm run check`, the
     `deploy` job runs `npm ci`, `npm run build` (with the `VITE_SUPABASE_*` /
     `VITE_POSTHOG_KEY` secrets) and `npx wrangler deploy`
     (`wrangler.jsonc` serves `dist/` as static assets). Its comments call it
     "the first deploy this project has ever had".
   - Before the `VITE_ENABLE_ESSENTIA` change, `essentia.js` was imported
     unconditionally, so **any** build from that code, including a CI deploy,
     contained the AGPL wrapper and WASM core with no notice.
   - `public/models/` is gitignored, so a CI checkout has no MusiCNN weights and
     a CI deploy would not include them. But this working machine has
     `public/models/` and a local `dist/` (built 2026-09-18) that contains
     `dist/models/`; a `wrangler deploy` run by hand from such a tree would
     ship the CC BY-NC-SA weights.
   - `docs/ISSUES.md` (around line 12044) refers to a "live deployed site", so
     a deployment exists. **The repo cannot tell us** whether it was built by CI
     or by hand, from which commit, with which flag, or whether the live
     bundle contains Essentia or the weights. Inspect the live artefact
     (network tab / `dist` contents of the deployed version) to find out.
   - Whether serving that code counts as a compliance problem, and what the
     remedy is (redeploy without it, publish source, or relicense), is for
     counsel.
5. **Live scenes with weak provenance.** `SCENES` (live roster) entries all
   declare `license: 'original'`, but several rest on statements that cannot
   be audited upstream. From `src/scenes/index.ts`:
   - `butterfly`: `provenance.spdx = 'NOASSERTION'`. A requester-supplied
     paste with no title, author or licence header, identified only as a
     Shadertoy multipass shader. **The only live scene with a NOASSERTION
     record.**
   - `lattesfold`: untitled paste; CC0 rests only on the requester's statement.
   - `snowflake`: "witnessed generation", no upstream to audit.
   - `fridaylines`, `javazone`, `beats`, `travelling`, `web`, `truchet`: header
     declares CC0 (attributed in comments to mrange); `web` is a derivative of
     BigWing's shader, and `travelling` bundles IQ / hg_sdf helper code (MIT)
     whose attribution should be checked against the ISF-style notice rules.
   - The non-`original` entries in `DISABLED_SCENES` (`panic`, `synthgrid`,
     `network` are NonCommercial; `tunnel`, `inversion`, `juliawings`,
     `kaleido`, `orbs`, `trail`, `foldpath`, `torusfold`, `crystalfold`,
     `lumen` are unverified, several with NOASSERTION provenance; `heap` is
     CC BY 4.0 and needs attribution) must stay out of commercial builds. See `docs/HANDOFF.md`
     §6 and `docs/ISSUES.md` F01 / F105 / F178.
6. **Publish the notices.** `THIRD_PARTY_NOTICES.md` is not yet reachable by
   end users; decide where to serve it (e.g. a page linked from Credits).
7. **Screenshots** in `public/proof/` (see inventory): confirm provenance.

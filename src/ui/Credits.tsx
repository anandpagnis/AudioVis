import { useStore } from '../store'
import { ISF_FILTERS } from '../engine/isfFilterRoster'
import { SCENES } from '../scenes'
import ISF_LICENSE from '../assets/isf/filters/LICENSE?raw'
import ISF_NOTICE from '../assets/isf/filters/NOTICE?raw'

/**
 * Fallback credit per vendored ISF filter id, transcribed from
 * `src/assets/isf/filters/NOTICE` — the authoritative source, whose raw text
 * is also rendered in full below so this table can be checked against it.
 *
 * `parseISF` already lifts each filter's own `CREDIT:` line into
 * `IsfFilter.credit` (see `compileIsfFilter` in `IsfFilterPass.ts`), so for
 * the five vendored files this table is normally never consulted — it exists
 * so a filter whose header omits or truncates `CREDIT` still shows a name
 * instead of silently dropping the attribution MIT requires.
 */
const NOTICE_CREDIT: Record<string, string> = {
  'Bad TV': "by VIDVOX, adapted from Felix Turner's BadTVShader",
  'Broken LCD': 'VIDVOX',
  'Bump Distortion': 'by carter rosenberg',
  'CMYK Halftone': 'by zoidberg',
  'Color Invert': 'by zoidberg',
}

/** `IsfFilter.id` is expected to be the filename minus its extension (the
 *  convention every existing filter test uses), but this tolerates a caller
 *  that kept the `.fs` on it too. */
function noticeCreditFor(id: string): string | undefined {
  return NOTICE_CREDIT[id] ?? NOTICE_CREDIT[id.replace(/\.fs$/i, '')]
}

/**
 * Is a parsed `CREDIT` worth showing on its own? Empty/whitespace doesn't
 * count, and neither does a one- or two-character fragment a malformed
 * header could leave behind — both fall back to {@link noticeCreditFor}.
 */
function isUsableCredit(credit: string | undefined): credit is string {
  return credit !== undefined && credit.trim().length > 2
}

/**
 * Scenes in the LIVE, selectable roster (`SCENES`, not `DISABLED_SCENES`)
 * whose source material is not this project's own.
 *
 * Currently always empty: `sceneLicensing.test.ts` pins every non-`original`
 * scene to `DISABLED_SCENES` until it clears commercial review, and nothing
 * disabled is ever in `SCENES`. This filters the real, live roster rather
 * than a snapshot, so the day a scene clears review and moves into `SCENES`
 * with a `license`/`provenance` it appears here with no code change here.
 */
const ATTRIBUTED_SCENES = SCENES.filter(
  (s) => s.metadata.license !== undefined && s.metadata.license !== 'original',
)

/** Anchors get no styling from the panel's stylesheet; keep them legible on the glass. */
const LINK_STYLE = { color: 'inherit', textDecoration: 'underline' } as const

interface SoftwareCredit {
  name: string
  licence: string
  url: string
  /** Precise text is in THIRD_PARTY_NOTICES.md; this is the one-line credit. */
  note?: string
}

/**
 * Open-source libraries this build's client bundle is built on, with licence
 * and project link. The complete, generated list with full licence texts is
 * `THIRD_PARTY_NOTICES.md` (`npm run licences:notices`); this is the
 * human-facing summary of the main ones. Policy: `docs/LICENSES.md`.
 *
 * Deliberately NOT listed: `@dimforge/rapier3d-compat` (Apache-2.0) — it is
 * only reachable through `@types/three` and nothing in `src/` imports it, so
 * it is not in the bundle; and TensorFlow.js, which only the Essentia voice
 * worker imports and so belongs to {@link ESSENTIA_ENABLED}'s block below.
 * Credit what ships, not what merely appears in the lockfile.
 *
 * TODO(owner): once a public URL for THIRD_PARTY_NOTICES.md exists (e.g. served
 * from /public or the marketing site), link it from this section.
 */
const SOFTWARE_CREDITS: SoftwareCredit[] = [
  { name: 'three.js', licence: 'MIT', url: 'https://threejs.org' },
  { name: 'React', licence: 'MIT', url: 'https://react.dev' },
  {
    name: 'React Three Fiber',
    licence: 'MIT',
    url: 'https://github.com/pmndrs/react-three-fiber',
    note: 'with @react-three/postprocessing',
  },
  {
    name: 'postprocessing',
    licence: 'Zlib',
    url: 'https://github.com/pmndrs/postprocessing',
  },
  { name: 'Zustand', licence: 'MIT', url: 'https://github.com/pmndrs/zustand' },
  { name: 'React Router', licence: 'MIT', url: 'https://reactrouter.com' },
]

/**
 * Build-time flag for the Essentia music-intelligence path. `'1'` builds ship
 * Essentia (AGPL-3.0) and, if present, the MusiCNN weights (CC BY-NC-SA 4.0) —
 * internal / non-commercial builds only. Anything else, including unset (the
 * default and the commercial configuration), ships neither, and the notice
 * block below is not rendered. Vite inlines `import.meta.env.X` as a literal,
 * so with the flag off this is a constant `false` and the block is dropped.
 */
const ESSENTIA_ENABLED = import.meta.env.VITE_ENABLE_ESSENTIA === '1'

// TODO(owner): landing audio. `public/landing/fractures.mp3` (ID3 title
// "Fractures", artist "Anderholm, Alexandra Pride"), used by
// `src/landing/tunnelAudio.ts`, has NO licence or attribution recorded
// anywhere in this repo. Its licence is to be confirmed (or the track replaced)
// before a commercial release; only then add a credit line here. Deliberately
// NOT rendered until verified — an unverified licence claim must not appear in
// the UI. Tracked in docs/LICENSES.md (open items).

/**
 * Third-party attribution — the UI surface F178 (see `docs/ISSUES.md`) was
 * blocked on.
 *
 * MIT requires the vendored ISF filters' credit and licence text travel with
 * the work, and until this component existed nothing in the app showed a
 * viewer any third-party credit at all (see
 * `src/assets/isf/filters/NOTICE`). This lists every filter in
 * `ISF_FILTERS` — attribution is about what ships in the bundle, not what a
 * picker currently offers, so nothing here is filtered by a disabled-list —
 * plus the MIT licence text itself, plus any live scene whose source is not
 * this project's own.
 *
 * Static reference text, not a per-frame readout, so this is plain DOM in the
 * shape of `SceneParamsPanel`/`Console` rather than the RAF+canvas pattern
 * `AnalyticsPanel`/`DebugPanel`/`FpsMeter` use for live telemetry.
 */
export function Credits() {
  return (
    <div className="credits-panel glass">
      <div className="menu-title">
        <span>Credits &amp; attribution</span>
        <button
          className="menu-x"
          title="Close (I)"
          onClick={() => useStore.getState().toggleCredits()}
        >
          ✕
        </button>
      </div>

      <div className="credits-section">
        <h3>ISF post-processing filters</h3>
        <p className="param-note">
          Five ISF filters are vendored, unmodified, from the Vidvox ISF-Files collection
          (github.com/Vidvox/ISF-Files) under the MIT licence below. Listed here whether or not the
          current build's filter picker offers each one — attribution travels with everything
          shipped in the bundle, not only with what is currently selectable.
        </p>
        <ul className="credits-list">
          {ISF_FILTERS.map((f) => {
            const credit = isUsableCredit(f.credit) ? f.credit : noticeCreditFor(f.id)
            return (
              <li key={f.id}>
                <strong>{f.id}</strong>
                <span className="credit-line">{credit ?? 'credit unknown — see NOTICE below'}</span>
                {f.description && <span className="credit-desc">{f.description}</span>}
              </li>
            )
          })}
        </ul>
        <details>
          <summary>MIT License (applies to all five filters above)</summary>
          <pre className="credits-license">{ISF_LICENSE}</pre>
        </details>
        <details>
          <summary>Full NOTICE (the source the credits above are drawn from)</summary>
          <pre className="credits-license">{ISF_NOTICE}</pre>
        </details>
      </div>

      <div className="credits-section">
        <h3>Software</h3>
        <p className="param-note">
          Built with open-source software. Licences and full texts are reproduced in the project's
          third-party notices.
        </p>
        <ul className="credits-list">
          {SOFTWARE_CREDITS.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>
              <span className="credit-line">
                {c.licence} ·{' '}
                <a href={c.url} target="_blank" rel="noreferrer noopener" style={LINK_STYLE}>
                  {c.url.replace(/^https?:\/\//, '')}
                </a>
              </span>
              {c.note && <span className="credit-desc">{c.note}</span>}
            </li>
          ))}
        </ul>
      </div>

      {ESSENTIA_ENABLED && (
        <div className="credits-section">
          <h3>Music analysis (Essentia)</h3>
          <p className="param-note">
            This build includes Essentia, developed by the Music Technology Group, Universitat
            Pompeu Fabra (MTG-UPF).
          </p>
          <ul className="credits-list">
            <li>
              <strong>essentia.js</strong>
              <span className="credit-line">
                AGPL-3.0 ·{' '}
                <a
                  href="https://essentia.upf.edu"
                  target="_blank"
                  rel="noreferrer noopener"
                  style={LINK_STYLE}
                >
                  essentia.upf.edu
                </a>
              </span>
              <span className="credit-desc">
                Licensed under the GNU Affero General Public Licence v3.0 — the corresponding source
                and licence terms are available from the project site.
              </span>
            </li>
            <li>
              <strong>MusiCNN models (Essentia model zoo)</strong>
              <span className="credit-line">CC BY-NC-SA 4.0</span>
              <span className="credit-desc">
                Mood and voice models by MTG-UPF, licensed under Creative Commons
                Attribution-NonCommercial-ShareAlike 4.0 — non-commercial use only.
              </span>
            </li>
            <li>
              <strong>TensorFlow.js</strong>
              <span className="credit-line">
                Apache-2.0 ·{' '}
                <a
                  href="https://github.com/tensorflow/tfjs"
                  target="_blank"
                  rel="noreferrer noopener"
                  style={LINK_STYLE}
                >
                  github.com/tensorflow/tfjs
                </a>
              </span>
              <span className="credit-desc">Runs the models above.</span>
            </li>
          </ul>
        </div>
      )}

      {ATTRIBUTED_SCENES.length > 0 && (
        <div className="credits-section">
          <h3>Scene material</h3>
          <ul className="credits-list">
            {ATTRIBUTED_SCENES.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>
                <span className="credit-line">{s.metadata.license}</span>
                {s.metadata.provenance && (
                  <span className="credit-desc">
                    {s.metadata.provenance.author ? `${s.metadata.provenance.author} — ` : ''}
                    {s.metadata.provenance.source}
                    {s.metadata.provenance.spdx ? ` · ${s.metadata.provenance.spdx}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

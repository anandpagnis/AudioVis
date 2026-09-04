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
          Five ISF filters are vendored, unmodified, from the Vidvox ISF-Files
          collection (github.com/Vidvox/ISF-Files) under the MIT licence
          below. Listed here whether or not the current build's filter picker
          offers each one — attribution travels with everything shipped in
          the bundle, not only with what is currently selectable.
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

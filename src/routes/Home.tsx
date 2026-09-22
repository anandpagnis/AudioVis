import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AccountMenu } from '../ui/AccountMenu'
import { useAuth, useEntitlement } from '../auth/authStore'
import { commerciallyShippableScenes } from '../scenes'
import { trackEvent } from '../lib/posthogClient'

/** The three in-page anchors MarketingHome's sections answer to. */
const SECTION_HASHES = new Set(['features', 'pricing', 'marketplace'])

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Mood-aware autopilot',
    body: 'Scenes, palettes, and transitions are picked automatically as the track moves — nobody touches a knob unless they want to.',
  },
  {
    title: '30+ generative scenes',
    body: 'GPU-driven, shader-built scenes that react to bass, mids, and drops in real time.',
  },
  {
    title: 'DJ Cam cutaways',
    body: 'The director cuts to a live camera feed on a drop, then hands it back — no manual switching.',
  },
  {
    title: 'Studio-grade export',
    body: 'Record straight to 9:16, 1:1, 16:9, or 4:5 — MP4-first, nothing rendered twice.',
  },
  {
    title: 'MIDI + cue sync',
    body: 'Lock scenes to a controller, or author a cue timeline ahead of a set.',
  },
  {
    title: 'Built for the booth',
    body: 'One control surface, one clean output for the projector — the show renders once, not twice.',
  },
]

export const MARKETPLACE_CATEGORIES: { title: string; body: string }[] = [
  {
    title: 'Scene packs',
    body: 'Themed bundles of generative scenes beyond the core library, built for specific genres and rooms.',
  },
  {
    title: 'Presets & cue timelines',
    body: 'Ready-to-run palette and transition presets, plus pre-authored cue timelines for a whole set.',
  },
  {
    title: 'Community creations',
    body: "Scenes and presets built by other DJs and VJs — publish your own once it's open.",
  },
]

const FREE_FEATURES = [
  { label: 'A handful of scenes', included: true },
  { label: 'Mood-aware autopilot', included: true },
  { label: 'Full 30+ scene library', included: false },
  { label: 'Manual scene & palette control', included: false },
  { label: 'Recording & export', included: false },
  { label: 'MIDI sync', included: false },
  { label: 'DJ Cam cutaways', included: false },
  { label: 'Presets & cue timelines', included: false },
]

const PRO_FEATURES = [
  { label: 'A handful of scenes', included: true },
  { label: 'Mood-aware autopilot', included: true },
  { label: 'Full 30+ scene library', included: true },
  { label: 'Manual scene & palette control', included: true },
  { label: 'Recording & export (9:16, 1:1, 16:9, 4:5)', included: true },
  { label: 'MIDI sync', included: true },
  { label: 'DJ Cam cutaways', included: true },
  { label: 'Presets & cue timelines', included: true },
]

/**
 * Forward-looking dashboard tiles (F246) — deliberately NOT generic "more
 * features coming soon" filler. Each is a real direction for this specific
 * product, chosen to not collide with what's already shipped or already
 * promised elsewhere:
 *
 * - Presets & cue timelines is NOT here — engine/presets.ts already has a
 *   full data model (including PerformanceCue timelines) and the Pricing
 *   section above already checks it off as included for Pro. There's just no
 *   Console UI to save/load one yet, which is a real gap worth flagging on
 *   its own (see this session's summary), not something to also list twice
 *   with two different "is this done or not" stories.
 * - Set analytics is the post-set counterpart to ui/AnalyticsPanel.tsx, which
 *   is a LIVE in-session debug instrument (beat accuracy, frame time) — a
 *   history view of past sets is a genuinely different thing, not a rename.
 * - Venue profiles gives the Venues & Nightclubs tier below something
 *   concrete to grow into (multi-room setups implies saved-per-room config).
 * - Creator profile is the account-side half of Marketplace's "Community
 *   creations" category — publishing needs somewhere to publish TO.
 */
const DASHBOARD_PLACEHOLDERS: { title: string; body: string }[] = [
  {
    title: 'Set analytics',
    body: 'BPM range, mood timeline, and scene mix from your last set — a history view, not the live in-console readout.',
  },
  {
    title: 'Venue profiles',
    body: 'Save calibrated settings per room or rig, and switch between them in one click.',
  },
  {
    title: 'Creator profile',
    body: 'A public page for your sets and published scenes — where Marketplace’s community creations come from.',
  },
]

/**
 * /home — branches hard on plan (F246). A signed-in Pro visitor gets a real
 * dashboard (launch panel, their scene library, account, what's next); anyone
 * else gets the marketing page (hero, features, pricing, marketplace teaser,
 * sign-up) that used to be the whole of this route (F244). Reached from the
 * tunnel's nav, the Console TopBar's wordmark link, /demo's badge/logo, and —
 * for anyone not Pro — straight from `/app` itself (ControlSurface).
 *
 * The dashboard is the DEFAULT for Pro, not the ONLY thing Pro can reach
 * here — a `#features`/`#pricing`/`#marketplace` hash always wins regardless
 * of plan (F247), so a Pro visitor following a link that points at one of
 * those sections (ProDashboard's own nav, /demo's badge, Account's nav) still
 * lands on the actual section instead of being bounced back to the
 * dashboard. `useLocation()`, not a plain `window.location.hash` read: this
 * needs to re-evaluate on a hash-only navigation (same `/home` pathname,
 * different hash), which a router-aware hook reacts to and a one-time read
 * would not.
 */
export function Home() {
  const plan = useEntitlement()
  const { hash } = useLocation()
  // Briefly true on load while Supabase checks for a stored session. Held
  // blank rather than deciding pro-vs-marketing on a default 'anonymous', or
  // a returning Pro visitor sees a flash of the marketing page before
  // flipping to their dashboard.
  const authLoading = useAuth().status === 'loading'
  if (authLoading) return <div className="home" />
  const wantsSection = SECTION_HASHES.has(hash.slice(1))
  return plan === 'pro' && !wantsSection ? <ProDashboard /> : <MarketingHome />
}

/**
 * The big "launch" panel plus a grid of cards — styled to echo the Console's
 * own empty-preview look (see console.css's `.stage-preview`/`no output`
 * treatment) without actually rendering anything: this is a launcher, not a
 * second copy of the engine. `Launch Lilim` is the one real action here;
 * Manage account is the one other real link. Everything else is either real
 * data (the scene library, pulled live from scenes/index.ts) or an honest,
 * specifically-described placeholder — never a bare "more coming soon".
 */
function ProDashboard() {
  const navigate = useNavigate()
  const scenes = commerciallyShippableScenes()
  const shown = scenes.slice(0, 10)
  const moreCount = scenes.length - shown.length

  return (
    <div className="home">
      <header className="home-nav">
        <Link className="home-mark" to="/" title="Back to the tunnel">
          LILIM
        </Link>
        <div className="home-nav-links">
          <Link className="home-navlink" to="/home">
            Home
          </Link>
          <Link className="home-navlink" to="/marketplace">
            Marketplace
          </Link>
          <AccountMenu />
        </div>
      </header>

      <section className="dash-launch">
        <button className="dash-launch-panel" onClick={() => navigate('/app')}>
          <span className="dash-launch-badge">16:9</span>
          <span className="dash-launch-center">
            <span className="dash-launch-mark">LILIM</span>
            <span className="dash-launch-cta">
              Launch Lilim
              <svg width="22" height="10" viewBox="0 0 22 10" fill="none" aria-hidden="true">
                <path
                  d="M0 5h20M15 1l5 4-5 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </span>
        </button>
        <p className="dash-launch-sub">Your control panel — every scene, recording, MIDI sync, presets, DJ Cam.</p>
      </section>

      <section className="dash-grid">
        <article className="dash-card dash-card-wide">
          <h2 className="dash-card-title">Your scene library</h2>
          <p className="dash-card-body">{scenes.length} scenes unlocked with Pro.</p>
          <div className="dash-scene-chips">
            {shown.map((s) => (
              <span className="dash-scene-chip" key={s.id}>
                {s.name}
              </span>
            ))}
            {moreCount > 0 && <span className="dash-scene-chip dash-scene-chip-more">+{moreCount} more</span>}
          </div>
          <button className="dash-card-link" onClick={() => navigate('/app')}>
            Open in console →
          </button>
        </article>

        <button className="dash-card dash-card-button" onClick={() => navigate('/account')}>
          <h3 className="dash-card-title">Manage account</h3>
          <p className="dash-card-body">Profile, plan, and billing.</p>
        </button>

        <article className="dash-card dash-card-wide">
          <span className="dash-card-soon">Coming soon</span>
          <h3 className="dash-card-title">Marketplace</h3>
          <p className="dash-card-body">
            A place to get more out of Lilim beyond the core library — and, eventually, to publish
            your own.
          </p>
          <div className="dash-marketplace-row">
            {MARKETPLACE_CATEGORIES.map((c) => (
              <div className="dash-marketplace-item" key={c.title}>
                <b>{c.title}</b>
                <span>{c.body}</span>
              </div>
            ))}
          </div>
        </article>

        {DASHBOARD_PLACEHOLDERS.map((p) => (
          <article className="dash-card" key={p.title}>
            <span className="dash-card-soon">Coming soon</span>
            <h3 className="dash-card-title">{p.title}</h3>
            <p className="dash-card-body">{p.body}</p>
          </article>
        ))}
      </section>

      <footer className="home-footer">
        <span>LILIM</span>
        <button className="home-navlink" onClick={() => navigate('/')}>
          Back to the tunnel
        </button>
      </footer>
    </div>
  )
}

/**
 * The pitch: hero, features, pricing, and a marketplace teaser as sections on
 * one scrollable page (F244). Free/anonymous land here by default; a Pro
 * visitor only reaches this component via a `#features`/`#pricing`/
 * `#marketplace` hash (F247) — Home() routes a bare `/home` to ProDashboard
 * instead.
 *
 * Section nav scrolls within the page (`scrollIntoView`), not route changes —
 * `#features`/`#pricing`/`#marketplace` are anchors on this one document. The
 * hash is honoured on mount so a `/home#pricing` link (from /demo, from
 * Account, or ProDashboard's own nav) lands on the right section;
 * client-side navigation doesn't do this on its own the way a full page load
 * would.
 */
function MarketingHome() {
  const navigate = useNavigate()
  const plan = useEntitlement()
  const { user } = useAuth()

  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (!id) return
    // Deferred a frame: the target section needs to exist in the DOM first,
    // and on a cold load the lazy chunk's paint can land a tick after this
    // effect runs.
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    }, 0)
    return () => window.clearTimeout(t)
  }, [])

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // All three plans can land here (F247: a Pro visitor reaches this
  // component too, via a section hash) — unlike the rest of this component,
  // the Pricing tier's own CTA needs the full three-way branch back.
  const proCta = (() => {
    // `plan` tagged on every branch, not just anonymous: "clicked while
    // already Free/Pro" is still funnel signal (repeat interest, or
    // confirms the CTA copy read correctly for that state).
    const track = () => trackEvent('pro_cta_clicked', { plan })
    if (plan === 'pro')
      return {
        label: 'Open Lilim',
        onClick: () => {
          track()
          navigate('/app')
        },
      }
    if (plan === 'free')
      return {
        label: 'You’re on the list',
        onClick: () => {
          track()
          navigate('/account')
        },
      }
    return {
      label: 'Sign in / Sign up',
      onClick: () => {
        track()
        navigate('/sign-in')
      },
    }
  })()

  const proNote = (() => {
    if (plan === 'pro') return 'You have full access — every scene, recording, MIDI sync, presets, DJ Cam.'
    if (plan === 'free')
      return `Signed in as ${user?.email}. Access is granted by hand right now — you're set up to get it the moment it's granted.`
    return 'Self-serve billing is coming — for now, sign up and you’re on the list.'
  })()

  return (
    <div className="home">
      <header className="home-nav">
        <Link className="home-mark" to="/" title="Back to the tunnel">
          LILIM
        </Link>
        <div className="home-nav-links">
          <button className="home-navlink" onClick={() => scrollTo('features')}>
            Features
          </button>
          <button className="home-navlink" onClick={() => scrollTo('pricing')}>
            Pricing
          </button>
          <button className="home-navlink" onClick={() => scrollTo('marketplace')}>
            Marketplace
          </button>
          <button className="home-navlink" onClick={() => navigate('/demo')}>
            Try the demo
          </button>
          <AccountMenu />
        </div>
      </header>

      <section className="home-hero">
        <span className="home-eyebrow">Browser-based AI VJ agent</span>
        <h1 className="home-title">The visuals run themselves.</h1>
        <p className="home-sub">
          Point it at your music and Lilim takes it from there — reading bass, drops, and mood in
          real time to direct scenes, palettes, and camera cuts on its own.
        </p>
        <div className="home-hero-ctas">
          <button className="home-cta primary" onClick={() => navigate('/demo')}>
            Try the free demo
          </button>
          <button className="home-cta ghost" onClick={() => scrollTo('pricing')}>
            See pricing
          </button>
        </div>
      </section>

      {/* Real captures, not renders — console.png is the actual control
          panel mid-set; the four scene shots are straight from the output
          window. Unprocessed on purpose for now (three still show the
          browser's own fullscreen notification baked into the frame) —
          swapping in cropped versions is a follow-up, not blocking on
          having *something* real here instead of stock-photo energy or
          nothing at all. */}
      <section className="home-proof">
        <span className="home-section-eyebrow">See it live</span>
        <h2 className="home-section-title">Real output, not a mockup.</h2>
        <div className="home-proof-console">
          <img src="/proof/console.png" alt="The Lilim control panel running a set live" loading="lazy" />
        </div>
        <div className="home-proof-grid">
          <img src="/proof/scene1.png" alt="A generative scene rendered by Lilim" loading="lazy" />
          <img src="/proof/scene2.png" alt="A generative scene rendered by Lilim" loading="lazy" />
          <img src="/proof/scene3.png" alt="A generative scene rendered by Lilim" loading="lazy" />
          <img src="/proof/scene 4.png" alt="A generative scene rendered by Lilim" loading="lazy" />
        </div>
      </section>

      <section id="features" className="home-section">
        <span className="home-section-eyebrow">Features</span>
        <div className="home-features-grid">
          {FEATURES.map((f) => (
            <article className="home-feature-card" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="pricing" className="home-section">
        <span className="home-section-eyebrow">Pricing</span>
        <h2 className="home-section-title">Pick what fits your rig.</h2>
        <p className="home-section-sub">
          Free to try with no account. Pro unlocks everything else — the full library, export,
          MIDI, DJ Cam.
        </p>
        <div className="home-tiers">
          <article className="home-tier">
            <span className="home-tier-name">Free</span>
            <div className="home-tier-price">$0</div>
            <p className="home-tier-note">No account needed</p>
            <ul className="home-tier-list">
              {FREE_FEATURES.map((f) => (
                <li key={f.label} data-included={f.included}>
                  {f.label}
                </li>
              ))}
            </ul>
            <button className="home-tier-cta ghost" onClick={() => navigate('/demo')}>
              Try the free demo
            </button>
          </article>

          <article className="home-tier featured">
            <span className="home-tier-name">Pro</span>
            <div className="home-tier-price">
              $20<span className="home-tier-price-suffix">/mo</span>
            </div>
            <p className="home-tier-note">{proNote}</p>
            <ul className="home-tier-list">
              {PRO_FEATURES.map((f) => (
                <li key={f.label} data-included={f.included}>
                  {f.label}
                </li>
              ))}
            </ul>
            <button className="home-tier-cta primary" onClick={proCta.onClick}>
              {proCta.label}
            </button>
          </article>

          <article className="home-tier">
            <span className="home-tier-name">Venues &amp; Nightclubs</span>
            <div className="home-tier-price">Custom</div>
            <p className="home-tier-note">Running it on a rig, every week</p>
            <ul className="home-tier-list">
              <li data-included="true">Everything in Pro</li>
              <li data-included="true">Multi-rig / multi-room setups</li>
              <li data-included="true">Direct support</li>
              <li data-included="true">Custom scene direction</li>
            </ul>
            <button
              className="home-tier-cta ghost"
              onClick={() => {
                window.location.href = 'mailto:lilim.aivj@gmail.com?subject=Lilim%20for%20our%20venue'
              }}
            >
              Let's talk
            </button>
          </article>
        </div>
      </section>

      <section id="marketplace" className="home-section">
        <span className="home-section-eyebrow">Marketplace</span>
        <h2 className="home-section-title">Scene packs and presets. Coming soon.</h2>
        <p className="home-section-sub">
          A place to get more out of Lilim beyond the core library — and, eventually, to publish
          your own. Nothing is live yet.
        </p>
        <div className="home-marketplace-grid">
          {MARKETPLACE_CATEGORIES.map((c) => (
            <article className="home-marketplace-card" key={c.title}>
              <span className="home-marketplace-soon">Coming soon</span>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="home-footer">
        <span>LILIM</span>
        <button className="home-navlink" onClick={() => navigate('/')}>
          Back to the tunnel
        </button>
      </footer>
    </div>
  )
}

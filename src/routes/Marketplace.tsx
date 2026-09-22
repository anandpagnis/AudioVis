import { Link } from 'react-router'
import { MARKETPLACE_CATEGORIES } from './Home'

/**
 * /marketplace — the Pro top nav's Marketplace destination. A real page
 * rather than the `/home#marketplace` anchor the free/anon nav still uses:
 * once Pro's top nav drops Features/Pricing/Marketplace for Home/Marketplace
 * (see Landing/Home/Account), it no longer lands anywhere near that anchor's
 * host page. Same "coming soon" categories as /home's teaser section and
 * ProDashboard's card — imported, not copied, so the three can't drift.
 */
export function Marketplace() {
  return (
    <div className="account">
      <header className="account-nav">
        <div className="account-nav-start">
          <Link className="account-back" to="/home" title="Back to Lilim home" aria-label="Back to Lilim home">
            <svg width="16" height="8" viewBox="0 0 22 10" fill="none" aria-hidden="true">
              <path
                d="M22 5H2M7 1 2 5l5 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <Link className="account-mark" to="/" title="Back to Lilim">
            LILIM
          </Link>
        </div>
      </header>

      <section className="account-hero">
        <span className="account-eyebrow">Marketplace</span>
        <h1 className="account-title">Coming soon.</h1>
        <p className="account-hero-copy">
          A place to get more out of Lilim beyond the core library — and, eventually, to publish
          your own. Nothing is live yet.
        </p>
      </section>

      <section className="account-grid">
        {MARKETPLACE_CATEGORIES.map((c) => (
          <article className="account-card" key={c.title}>
            <h2 className="account-card-title">{c.title}</h2>
            <p className="account-card-body">{c.body}</p>
          </article>
        ))}
      </section>

      <footer className="account-footer">
        <span>LILIM</span>
        <Link className="account-navlink" to="/home">
          Back to Lilim
        </Link>
      </footer>
    </div>
  )
}

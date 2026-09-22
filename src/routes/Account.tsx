import { Link, useNavigate } from 'react-router'
import { signOut, useAuth, useEntitlement } from '../auth/authStore'
import { supabase } from '../lib/supabaseClient'

/**
 * /account — reached from AccountMenu (the tunnel's nav, /home's nav, the
 * Console TopBar) wherever a signed-in visitor is. The route stays public and
 * handles "not signed in" inline (a sign-in prompt right here) rather than
 * redirecting away, so a direct visit never dead-ends.
 *
 * Billing is a UI placeholder only — there is no payment processor wired up
 * (see /home's Pricing section for Pro's $20/mo price and the same caveat).
 * This page must never claim to show real billing history; the empty state
 * says so explicitly.
 */
export function Account() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const plan = useEntitlement()

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
        <div className="account-nav-links">
          {plan === 'pro' ? (
            <>
              <Link className="account-navlink" to="/home">
                Home
              </Link>
              <Link className="account-navlink" to="/marketplace">
                Marketplace
              </Link>
            </>
          ) : (
            <>
              <Link className="account-navlink" to="/home#features">
                Features
              </Link>
              <Link className="account-navlink" to="/home#pricing">
                Pricing
              </Link>
              <Link className="account-navlink" to="/home#marketplace">
                Marketplace
              </Link>
            </>
          )}
        </div>
      </header>

      <section className="account-hero">
        <span className="account-eyebrow">Account</span>
        <h1 className="account-title">Manage your account.</h1>
      </section>

      {!supabase ? (
        <div className="account-card account-signin-card">
          <p className="account-signin-copy">Accounts aren't configured on this deployment yet.</p>
        </div>
      ) : !user ? (
        <div className="account-card account-signin-card">
          <p className="account-signin-copy">Sign in to see your plan and account details.</p>
          <button className="account-cta primary" onClick={() => navigate('/sign-in')}>
            Sign in / Sign up
          </button>
        </div>
      ) : (
        <section className="account-grid">
          <article className="account-card">
            <h2 className="account-card-title">Profile</h2>
            <div className="account-field">
              <span className="account-field-label">Email</span>
              <span className="account-field-value">{user.email}</span>
            </div>
            <button className="account-cta ghost" onClick={() => void signOut()}>
              Sign out
            </button>
          </article>

          <article className="account-card">
            <h2 className="account-card-title">Plan</h2>
            <div className="account-plan-row">
              <span className={`account-plan-badge plan-${plan}`}>{plan === 'pro' ? 'Pro' : 'Free'}</span>
              {plan === 'pro' && <span className="account-plan-price">$20/mo</span>}
            </div>
            <p className="account-field-value account-plan-copy">
              {plan === 'pro'
                ? "You have full access — every scene, recording, MIDI sync, presets, DJ Cam."
                : "You're on the list. Pro is $20/mo once self-serve billing opens — for now, access is granted by hand."}
            </p>
            <button className="account-cta ghost" onClick={() => navigate('/home#pricing')}>
              {plan === 'pro' ? 'See plan details' : 'Compare plans'}
            </button>
          </article>

          <article className="account-card account-card-wide">
            <h2 className="account-card-title">Billing history</h2>
            <div className="account-billing-placeholder">
              <div className="account-billing-row account-billing-skeleton" />
              <div className="account-billing-row account-billing-skeleton" />
              <p className="account-billing-empty">
                No billing history yet — self-serve billing isn't live. Once it is, invoices and
                receipts for your $20/mo Pro subscription will show up here.
              </p>
            </div>
          </article>
        </section>
      )}

      <footer className="account-footer">
        <span>LILIM</span>
        <button className="account-navlink" onClick={() => navigate('/')}>
          Back to Lilim
        </button>
      </footer>
    </div>
  )
}

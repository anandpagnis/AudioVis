import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { signOut, useAuth, useEntitlement } from '../auth/authStore'

/**
 * Auth-aware nav element, dropped into every page's own header (tunnel
 * masthead, Home's nav, the Console TopBar) so sign-in state and a way to
 * reach /home (F247), /account, and /help (F248) are never more than one
 * click away — useful in the Console specifically, whose TopBar wordmark
 * already links to /home but has no other nav at all.
 *
 * Self-contained styling (accountMenu.css's --am-* tokens) rather than
 * reading each host page's own brand variables — those are named
 * differently per page (console.css's --crimson/--maroon/--plum vs.
 * home.css's --brick/--maroon/--purple vs. marketing.css's --t-* scale) and
 * unifying them is a bigger refactor than this component needs; the five hex
 * values are identical everywhere, so hardcoding them here renders
 * identically in every host context without touching existing token setups.
 *
 * "Sign in" is a plain `<Link to="/sign-in">` (F245 made sign-in a route,
 * not a modal this component used to render) — no lazy AuthPanel import to
 * manage here any more.
 */
export function AccountMenu() {
  const { status, user } = useAuth()
  const plan = useEntitlement()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Briefly true while Supabase checks for a stored session — same reasoning
  // as ControlSurface's authLoading: render nothing rather than flash a
  // "Sign in" link that a returning user immediately sees replaced.
  if (status === 'loading') return null

  if (!user) {
    return (
      <div className="account-menu">
        <Link className="account-menu-signin" to="/sign-in">
          Sign in
        </Link>
      </div>
    )
  }

  const initial = (user.email ?? '?').charAt(0).toUpperCase()

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        className="account-menu-avatar"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
      >
        {initial}
      </button>
      {open && (
        <div className="account-menu-panel">
          <div className="account-menu-email">{user.email}</div>
          <span className={`account-menu-plan plan-${plan}`}>{plan === 'pro' ? 'Pro' : 'Free'}</span>
          <Link className="account-menu-link" to="/home" onClick={() => setOpen(false)}>
            Home
          </Link>
          <Link className="account-menu-link" to="/account" onClick={() => setOpen(false)}>
            Manage account
          </Link>
          <Link className="account-menu-link" to="/help" onClick={() => setOpen(false)}>
            Help &amp; feedback
          </Link>
          <button
            className="account-menu-link"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

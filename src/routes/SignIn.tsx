import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router'
import { Auth } from '@supabase/auth-ui-react'
import type { Theme } from '@supabase/auth-ui-shared'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../auth/authStore'

/**
 * Every value here is one of the brand's five hexes (black/cream/maroon
 * #780000/crimson #c1121f/plum #510049) at an alpha — same rule console.css
 * documents for its own colour system — never a new hue invented just for
 * this widget. `brandAccent` is maroon, not a darkened crimson: the two are
 * already used together as a gradient pair elsewhere (e.g. Home's `.home-cta
 * .primary`), so reusing maroon here as crimson's "pressed" state stays
 * inside the same five colours rather than adding a sixth.
 */
const LILIM_AUTH_THEME: Theme = {
  default: {
    colors: {
      brand: '#c1121f',
      brandAccent: '#780000',
      brandButtonText: '#fdf0d5',
      defaultButtonBackground: 'rgba(253, 240, 213, 0.04)',
      defaultButtonBackgroundHover: 'rgba(253, 240, 213, 0.08)',
      defaultButtonBorder: 'rgba(253, 240, 213, 0.22)',
      defaultButtonText: 'rgba(253, 240, 213, 0.9)',
      dividerBackground: 'rgba(253, 240, 213, 0.12)',
      inputBackground: 'rgba(253, 240, 213, 0.04)',
      inputBorder: 'rgba(253, 240, 213, 0.16)',
      inputBorderHover: 'rgba(253, 240, 213, 0.32)',
      inputBorderFocus: '#c1121f',
      inputText: '#fdf0d5',
      inputLabelText: 'rgba(253, 240, 213, 0.6)',
      inputPlaceholder: 'rgba(253, 240, 213, 0.32)',
      messageText: 'rgba(253, 240, 213, 0.75)',
      messageBackground: 'rgba(253, 240, 213, 0.05)',
      messageBorder: 'rgba(253, 240, 213, 0.14)',
      messageTextDanger: '#ffb4b4',
      messageBackgroundDanger: 'rgba(120, 0, 0, 0.25)',
      messageBorderDanger: 'rgba(193, 18, 31, 0.4)',
      anchorTextColor: 'rgba(253, 240, 213, 0.6)',
      anchorTextHoverColor: '#fdf0d5',
    },
    space: {
      spaceSmall: '8px',
      spaceMedium: '16px',
      spaceLarge: '20px',
      labelBottomMargin: '6px',
      anchorBottomMargin: '8px',
      emailInputSpacing: '4px',
      socialAuthSpacing: '8px',
      buttonPadding: '12px 16px',
      inputPadding: '12px 14px',
    },
    fontSizes: {
      baseBodySize: '13.5px',
      baseInputSize: '14px',
      baseLabelSize: '12.5px',
      baseButtonSize: '14px',
    },
    fonts: {
      bodyFontFamily: 'inherit',
      buttonFontFamily: 'inherit',
      inputFontFamily: 'inherit',
      labelFontFamily: 'inherit',
    },
    borderWidths: {
      buttonBorderWidth: '1px',
      inputBorderWidth: '1px',
    },
    radii: {
      borderRadiusButton: '999px',
      buttonBorderRadius: '999px',
      inputBorderRadius: '10px',
    },
  },
}

/**
 * /sign-in — a real page, not a modal (F245). The modal (`.overlay`, fixed +
 * flex-centered) clipped the Supabase widget top and bottom on any viewport
 * shorter than its content, with no way to scroll to the hidden part — the
 * exact failure mode this route avoids by using ordinary top-down document
 * flow inside `.sign-in`'s own `overflow-y: auto` instead of flex-centering
 * (see sign-in.css; the same safe pattern `.account`/`.home` already use).
 *
 * Reached from AccountMenu, Home's Pro tier CTA, and Account's sign-in
 * prompt — all three now just `navigate('/sign-in')` instead of flipping a
 * `showAuthPanel` flag (removed from authStore along with it).
 */
export function SignIn() {
  const navigate = useNavigate()
  const { user, status } = useAuth()

  // Once a session lands (fresh sign-in, or landing here already signed in),
  // hand off to /app — which already knows how to route pro/free/anonymous
  // correctly (see Visualizer.tsx's ControlSurface) — rather than this page
  // trying to duplicate that decision.
  useEffect(() => {
    if (status === 'ready' && user) navigate('/app', { replace: true })
  }, [status, user, navigate])

  if (status === 'loading' || user) return null

  return (
    <div className="sign-in">
      <div className="sign-in-nav">
        <Link className="sign-in-mark" to="/" title="Back to Lilim">
          LILIM
        </Link>
      </div>

      <div className="sign-in-body">
        <span className="sign-in-eyebrow">Sign in</span>
        <h1 className="sign-in-title">Continue to Pro</h1>
        <p className="sign-in-sub">Every scene, recording, MIDI sync, presets, DJ Cam.</p>

        {supabase ? (
          <div className="sign-in-widget">
            <Auth supabaseClient={supabase} appearance={{ theme: LILIM_AUTH_THEME }} providers={['google']} view="sign_in" />
          </div>
        ) : (
          // Missing VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY — this deploy
          // hasn't been connected to Supabase yet. Said plainly rather than
          // rendering nothing, which would look like a dead page.
          <p className="sign-in-error">Sign-in isn't configured on this deployment yet.</p>
        )}
      </div>
    </div>
  )
}

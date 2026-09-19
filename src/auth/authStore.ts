import { create } from 'zustand'
import type { RealtimeChannel, Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { identifyUser, resetIdentity } from '../lib/posthogClient'

export type Plan = 'anonymous' | 'free' | 'pro'

interface Profile {
  plan: 'free' | 'pro'
  is_owner: boolean
}

interface AuthState {
  session: Session | null
  user: User | null
  profile: Profile | null
  /** Flips to 'ready' once after the first auth check resolves; never reverts. */
  status: 'loading' | 'ready'
}

/**
 * Deliberately separate from `store.ts` rather than a slice on it: that store
 * persists to localStorage via an explicit `partialize` allowlist (visual/DJ
 * settings only), and auth state is both security-sensitive and already
 * persisted by Supabase's own client internals — folding it in would risk it
 * being swept into that allowlist, or drifting out of sync with Supabase's own
 * source of truth. Nothing here is persisted by this store itself.
 */
const useAuthStore = create<AuthState>(() => ({
  session: null,
  user: null,
  profile: null,
  status: supabase ? 'loading' : 'ready',
}))

let initialized = false
let profileChannel: RealtimeChannel | null = null

function subscribeToProfile(userId: string): void {
  if (!supabase) return
  profileChannel?.unsubscribe()
  void supabase
    .from('profiles')
    .select('plan, is_owner')
    .eq('id', userId)
    .maybeSingle()
    .then(({ data }) => useAuthStore.setState({ profile: (data as Profile | null) ?? null }))
  // Live updates so the UI flips to Pro the instant you grant it by hand in
  // the table editor — no manual refresh needed.
  profileChannel = supabase
    .channel(`profile-${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
      (payload) => useAuthStore.setState({ profile: payload.new as Profile }),
    )
    .subscribe()
}

function clearProfile(): void {
  profileChannel?.unsubscribe()
  profileChannel = null
  useAuthStore.setState({ profile: null })
}

/**
 * Wire up the Supabase auth listener. Called once from main.tsx, unlike the
 * two-window link (installMirrorHook/startLink) this does NOT need to skip
 * /demo — there's no cross-window collision risk here, and a demo visitor is
 * free to sign up from it later.
 *
 * A no-op (beyond flipping straight to 'ready') when Supabase isn't
 * configured, so the app — including the anonymous /demo funnel — keeps
 * working in any deploy that hasn't set up accounts yet.
 */
export function initAuth(): void {
  if (!supabase) {
    useAuthStore.setState({ status: 'ready' })
    return
  }
  if (initialized) return
  initialized = true
  supabase.auth.onAuthStateChange((event, session) => {
    useAuthStore.setState({ session, user: session?.user ?? null, status: 'ready' })
    if (session?.user) subscribeToProfile(session.user.id)
    else clearProfile()
    // No dismiss-a-modal step needed here (F245 made /sign-in a real route,
    // not a modal) — SignIn.tsx's own effect watches `user` and navigates to
    // /app the moment a session lands.

    // Ties whatever anonymous funnel activity preceded this (viewed pricing,
    // clicked the Pro CTA) to the now-known user, and clears it back out on
    // sign-out so a shared machine's next anonymous session doesn't inherit
    // the previous person's identity. Scoped to the real transitions, not
    // INITIAL_SESSION/TOKEN_REFRESHED, same reasoning F245 used for the old
    // closeAuthPanel() call this replaced.
    if (event === 'SIGNED_IN' && session?.user) {
      identifyUser(session.user.id, { email: session.user.email })
    } else if (event === 'SIGNED_OUT') {
      resetIdentity()
    }
  })
}

export function useAuth() {
  return useAuthStore()
}

/** 'anonymous' (no session), 'free' (signed in, `plan` still 'free'), or 'pro' (granted by hand — see schema.sql — or the owner bypass). */
export function useEntitlement(): Plan {
  return useAuthStore((s) => {
    // `npm run dev` always grants Pro. This app is also its own owner's
    // live-use DJ tool — gating a `vite dev` build behind a Supabase project
    // that may not even exist yet would break that workflow the moment this
    // landed, not just before launch. Real enforcement (including for the
    // owner, via `is_owner` below) only applies to a production build
    // (`vite build` sets this false); a local preview of that build
    // (`npm run preview`) is deliberately NOT exempted, since that's the one
    // local workflow meant to reflect prod.
    if (import.meta.env.DEV) return 'pro'
    if (!s.user) return 'anonymous'
    if (s.profile?.is_owner || s.profile?.plan === 'pro') return 'pro'
    return 'free'
  })
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * Null in any deploy that hasn't configured Supabase yet (missing env vars),
 * rather than throwing at import time — the free demo at /demo has no
 * dependency on auth at all, and must keep working even before Pro billing is
 * wired up. Every auth-store call already goes through this and no-ops when
 * it's null; see auth/authStore.ts.
 */
export const supabase = url && anonKey ? createClient(url, anonKey) : null

// app/supabase.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "./config.js";

// --- Create a single shared client
export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storage: window.localStorage,
  },
});

// --- Session helpers

/** Return the current session or null (wrapper around v2 getSession). */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data?.session ?? null;
}

/** Alias for getSession (compat). */
export const getCurrentSession = getSession;

/** Ensure a session exists; redirect to /auth.html if not. */
export async function ensureLoggedIn(redirect = "/auth.html") {
  const session = await getSession();
  if (!session) {
    const ret = new URL(redirect, location.origin);
    ret.searchParams.set("return", location.pathname + location.search);
    location.replace(ret.href);
    throw new Error("Not authenticated");
  }
  return session;
}

/** Also export under a second name in case other files expect this. */
export const requireAuth = ensureLoggedIn;

/** Observe auth state changes. */
export function onAuthStateChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

/** Sign out convenience. */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  return true;
}

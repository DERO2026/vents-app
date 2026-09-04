// Tracks an in-progress signup email-verification across reloads/relaunches
// so a user who leaves the OTP screen (backgrounds the app, closes the tab,
// force-quits) comes straight back to it next time instead of landing on the
// welcome/sign-up screen and hitting a dead end. Cleared on successful
// verification or when the user explicitly changes email / abandons signup.
const KEY = 'vents_pending_verification';
// InsForge OTPs expire well before this — this is just an outer bound so a
// stale entry doesn't haunt the browser forever if the user never comes back.
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

// The rest of the signup form (name/username/phone/state/etc.) — persisted
// alongside the email so it survives a reload, tab close, or a fresh page
// load reached via the confirmation link, none of which preserve React
// component state. Without this, a user who leaves the OTP screen (or
// authenticates via the raw magic-link URL instead of the in-app OTP flow)
// can land back in the app with an authenticated Supabase session but a
// VENTS profile row containing only id/email/role — the DB trigger that
// creates that row on signup has no access to the rest of the form, and the
// client-side write of the rest only happens once a session exists.
export interface PendingSignupProfile {
  full_name: string;
  username: string;
  phone_number: string;
  state: string;
  // Account/home country, ISO 3166-1 alpha-2 (e.g. 'NG', 'US') -- chosen once
  // via CountrySelectScreen before signup. Metadata only, never an
  // event-visibility restriction (see select_events RLS policy).
  country?: string;
  date_of_birth?: string;
  avatar_url?: string;
}

export interface PendingVerification {
  email: string;
  savedAt: number;
  profile?: PendingSignupProfile;
}

export function savePendingVerification(email: string, profile?: PendingSignupProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email, savedAt: Date.now(), profile }));
  } catch { /* storage unavailable — verification still works, just won't survive a reload */ }
}

export function getPendingVerification(): PendingVerification | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.email || typeof parsed.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingVerification(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

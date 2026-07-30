// Tracks an in-progress signup email-verification across reloads/relaunches
// so a user who leaves the OTP screen (backgrounds the app, closes the tab,
// force-quits) comes straight back to it next time instead of landing on the
// welcome/sign-up screen and hitting a dead end. Cleared on successful
// verification or when the user explicitly changes email / abandons signup.
const KEY = 'vents_pending_verification';
// InsForge OTPs expire well before this — this is just an outer bound so a
// stale entry doesn't haunt the browser forever if the user never comes back.
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface PendingVerification {
  email: string;
  savedAt: number;
}

export function savePendingVerification(email: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email, savedAt: Date.now() }));
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

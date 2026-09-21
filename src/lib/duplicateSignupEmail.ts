// Classifies the two different "this email is already taken" shapes
// AuthScreen's signup submit handler can hit, so a duplicate-email signup
// attempt routes to the right UX instead of a raw, unhandled dead-end error
// (Sentry issue JAVASCRIPT-REACT-12: a real user retried signup with an
// email they'd already used once, moments after their first attempt, and
// got exactly that raw error with no path forward).
//
// The two shapes come from two different places and mean two different
// things:
//
// 1. Our own check_user_exists() pre-check (called before signUp()) throws
//    a plain `Error('Email already exists')` when it reports
//    `email_taken: true`. check_user_exists() only ever flags an
//    already-CONFIRMED account (see supabase/migrations/0027_...sql) — an
//    unconfirmed signup for the same email doesn't set email_taken, so this
//    exact message can only mean the email genuinely belongs to a verified
//    account already. Routing that case into the OTP/resend flow would be
//    wrong (it would send a fresh signup code to an already-verified
//    account), so it should prompt the user to log in instead.
//
// 2. supabase.auth.signUp() itself can still fail with its own
//    "already registered" / "already exists" / "already in use" error
//    (exact wording varies by Supabase project config) even after (1) found
//    nothing — this happens when an UNCONFIRMED signup for this email
//    exists but is too recent (<3 minutes old) for reclaim_unverified_signup()
//    to have deleted it as stale first. This is exactly the
//    "signed up, never saw the OTP email, tried again right away" scenario
//    — the right move is to route into the same OTP-entry screen a fresh
//    signup lands on and resend the code, not show a dead-end error.
//
// Both checks are deliberately narrow (exact/near-exact string matches) so
// a genuinely different error (network failure, validation error, rate
// limit) is never misclassified as either duplicate-email case.

/**
 * True only for the exact message AuthScreen's own check_user_exists
 * pre-check throws for an email already belonging to a CONFIRMED account.
 * Never true for Supabase's own signUp() duplicate-email error (see module
 * doc above) or for any unrelated error.
 */
export function isConfirmedDuplicateEmailError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { message?: unknown }).message === 'Email already exists';
}

/**
 * True for Supabase Auth's own signUp() error when it reports the email as
 * already registered — which, once isConfirmedDuplicateEmailError() has
 * already been ruled out earlier in the same submit (see AuthScreen.tsx),
 * can only mean an UNCONFIRMED signup for this email exists.
 */
export function isUnconfirmedDuplicateSignupError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  const m = message.toLowerCase();
  return m.includes('already registered') || m.includes('already exists') || m.includes('already in use');
}

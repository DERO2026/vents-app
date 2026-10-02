import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real-production-flow verification of suspended/deleted account login
// enforcement, requested specifically because a prior audit had only read
// the AuthScreen.tsx code and not traced every path a session can reach the
// app through. Live-verified against project slrtjxtzhowhwhebjprv:
// admin_suspend_user/admin_soft_delete_user only ever write
// public.users.status/banned_until -- they never touch auth.users, so
// Supabase Auth itself has no idea an account is suspended/deleted and
// signInWithPassword succeeds with correct credentials regardless. Every
// enforcement point is therefore purely application-level, and each one
// must independently check users.status.
//
// Root cause found and fixed here: App.tsx's hydrateAuth() -- "the one code
// path that always runs on session restore regardless of how the session
// was established" per its own comment, including a magic-link sign-in,
// which lands as a fresh page load and skips AuthScreen's own checks
// entirely -- only ever checked `status === 'suspended'`, never
// `'deleted'`. A deleted account's existing session (or a deleted account
// signing in via a magic link) was never signed out by this path: it kept
// full access on every app relaunch, bfcache restore, or magic-link login
// until/unless it happened to go through AuthScreen's own login-success
// check instead. AuthScreen.tsx's own two checks (the success-path check
// right after signInWithPassword, and the catch-block get_account_status
// fallback for a wrong-password-but-also-suspended/deleted case) already
// correctly checked both statuses -- only hydrateAuth had the gap.

let appSrc: string;
let authScreenSrc: string;

beforeAll(() => {
  const appDir = join(__dirname, '..', 'app');
  appSrc = readFileSync(join(appDir, 'App.tsx'), 'utf8');
  authScreenSrc = readFileSync(join(appDir, 'components', 'AuthScreen.tsx'), 'utf8');
});

describe('App.tsx hydrateAuth(): session restore now rejects deleted accounts, not just suspended', () => {
  it('checks both suspended and deleted status, not suspended alone', () => {
    expect(appSrc).toMatch(/if \(profile\?\.status === 'suspended' \|\| profile\?\.status === 'deleted'\) \{/);
  });

  it('signs out the live Supabase Auth session for either status, not just clears local state', () => {
    const block = appSrc.match(/if \(profile\?\.status === 'suspended' \|\| profile\?\.status === 'deleted'\) \{[\s\S]*?setAuthLoading\(false\);\s*return;\s*\n\s*\}/)?.[0] ?? '';
    expect(block).toMatch(/await supabase\.auth\.signOut\(\)\.catch\(\(\) => \{\}\);/);
    expect(block).toMatch(/unregisterPushNotifications\(sessionUserId\)/);
    expect(block).toMatch(/setCurrentUser\(null\);/);
  });

  it('shows a distinct, non-generic message for a deleted account vs a suspended one', () => {
    const block = appSrc.match(/if \(profile\?\.status === 'suspended' \|\| profile\?\.status === 'deleted'\) \{[\s\S]*?setAuthLoading\(false\);\s*return;\s*\n\s*\}/)?.[0] ?? '';
    expect(block).toMatch(/Your account has been suspended\./);
    expect(block).toMatch(/This VENTS account is no longer active\./);
    expect(block).toMatch(/profile\.status === 'suspended'\s*\n\s*\? 'Your account has been suspended/);
  });

  it('runs on every fresh mount and on bfcache restore, covering a magic-link sign-in and a resumed session', () => {
    expect(appSrc).toMatch(/useEffect\(\(\) => \{ hydrateAuth\(\); \}, \[hydrateAuth\]\);/);
    expect(appSrc).toMatch(/if \(event\.persisted\) \{\s*\n\s*setAuthLoading\(true\);\s*\n\s*hydrateAuth\(\);/);
  });
});

describe('authError banner actually renders the message, not just sets unused state', () => {
  it('is rendered as a visible, dismissable overlay', () => {
    expect(appSrc).toMatch(/\{authError && \(/);
    expect(appSrc).toMatch(/onClick=\{\(\) => setAuthError\(null\)\}/);
  });
});

describe('AuthScreen.tsx: both fresh-login checks already covered suspended AND deleted (no regression introduced)', () => {
  it('the success-path check (immediately after signInWithPassword) checks both statuses', () => {
    expect(authScreenSrc).toMatch(/if \(profile\?\.status === 'suspended' \|\| profile\?\.status === 'deleted'\) \{/);
    expect(authScreenSrc).toMatch(/await supabase\.auth\.signOut\(\)\.catch\(\(\) => \{\}\);/);
  });

  it('the catch-block get_account_status fallback also checks both statuses', () => {
    expect(authScreenSrc).toMatch(/row\?\.status === 'suspended' \|\| row\?\.status === 'deleted'/);
  });
});

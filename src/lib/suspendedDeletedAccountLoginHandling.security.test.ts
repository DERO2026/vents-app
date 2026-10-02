import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Final release audit (item 2): suspended/disabled/deleted accounts must get
// a clear, honest login message instead of a generic error, without
// creating a user-enumeration vulnerability or weakening RLS/auth.
//
// Investigation found this was already fully built in AuthScreen.tsx (no
// prior regression coverage existed): on a login failure that isn't a
// recognized network/infra error, it resolves the email (including
// username->email via resolve_username_to_email), calls the
// get_account_status(p_email) RPC, and if the account is suspended or
// deleted shows a dedicated full-screen message (with support contact
// options) instead of the generic "Incorrect email or password." Any other
// outcome -- including "no such account", an active account with a wrong
// password, or the status RPC itself failing -- silently falls through to
// the same generic message, so this cannot be used to enumerate which
// emails exist.
//
// get_account_status() is STABLE SECURITY DEFINER and returns only
// (status, banned_until) for a single matched row -- no other user_profile
// data, and no row (not an error) for an unmatched email, confirmed live
// against project slrtjxtzhowhwhebjprv.

let authScreenSrc: string;

beforeAll(() => {
  authScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'AuthScreen.tsx'), 'utf8');
});

describe('AuthScreen.tsx: suspended/deleted account login handling', () => {
  it('checks account status only after signInWithPassword has already failed, never before', () => {
    const signInIdx = authScreenSrc.indexOf("supabase.auth.signInWithPassword({ email: loginEmail, password })");
    const statusCheckIdx = authScreenSrc.indexOf("supabase.rpc('get_account_status'");
    expect(signInIdx).toBeGreaterThan(-1);
    expect(statusCheckIdx).toBeGreaterThan(signInIdx);
  });

  it('resolves a username to an email before checking status, so username-based login is also covered', () => {
    const block = authScreenSrc.match(/if \(checkEmail && isValidEmail\(checkEmail\)\) \{[\s\S]*?get_account_status[\s\S]*?\}/);
    expect(block).toBeTruthy();
    expect(authScreenSrc).toMatch(/resolve_username_to_email', \{ p_username: checkEmail\.toLowerCase\(\) \}/);
  });

  it('shows a dedicated message for suspended vs deleted, not a shared generic string', () => {
    expect(authScreenSrc).toMatch(/row\?\.status === 'suspended' \|\| row\?\.status === 'deleted'/);
    expect(authScreenSrc).toMatch(/isSuspended \? 'Account Suspended' : 'Account Deleted'/);
    expect(authScreenSrc).toMatch(/Your account has been suspended until/);
    expect(authScreenSrc).toMatch(/Your account has been removed from VENTS/);
  });

  it('does not expose internal/admin fields in the ban screen (only status and an optional suspension end date)', () => {
    const banBlock = authScreenSrc.slice(authScreenSrc.indexOf('if (banInfo) {'), authScreenSrc.indexOf('// 3.1: TOTP 2FA prompt'));
    expect(banBlock).not.toMatch(/admin_logs|suspended_by|suspension_reason|internal/i);
  });

  it('any failure to resolve status (RPC error, unmatched email, active account) falls through to the generic message, never a distinct "no such account" message', () => {
    expect(authScreenSrc).toMatch(/catch \{ \/\* ignore status check failure — fall through to normal error \*\/ \}/);
    expect(authScreenSrc).toMatch(/Login always shows generic message — never reveal whether email\/password is the issue/);
    expect(authScreenSrc).toMatch(/setErrorMessage\('Incorrect email or password\.'\);/);
  });

  it('a network/infra failure during signInWithPassword is never misreported as a suspension/ban or a wrong password', () => {
    expect(authScreenSrc).toMatch(/isNetworkOrInfraError && !msgL\.includes\('invalid login credentials'\)/);
    expect(authScreenSrc).toMatch(/We couldn't reach the server\. Please check your connection and try again\./);
  });

  it('the ban screen offers a way back to login rather than trapping the user', () => {
    expect(authScreenSrc).toMatch(/onClick=\{\(\) => setBanInfo\(null\)\}/);
  });
});

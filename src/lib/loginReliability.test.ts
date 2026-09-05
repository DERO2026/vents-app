import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the intermittent "incorrect username and password"
// production bug. Static-analysis style (same approach as every other
// *.test.ts in this repo -- no live Supabase Auth/Postgres harness
// available, and per the task's own security requirements this must never
// exercise real credentials). No password is ever written to this file.
//
// ROOT CAUSE (two independent bugs, both in the login path):
//
// 1. Error misclassification (the primary cause -- affects every account
//    equally, explaining "multiple accounts including Admin"): the login
//    branch's catch-all unconditionally set "Incorrect email or password"
//    for ANY error reaching it, including:
//      a) a resolve_username_to_email RPC/network failure (a lookup
//         failure, not a wrong password -- Supabase's password check never
//         even ran), and
//      b) a timeout on the post-auth profile read, which runs AFTER
//         signInWithPassword has already succeeded -- the user was
//         actually signed in with a real session, yet told their password
//         was wrong. A retry "worked" only because the profile query
//         happened to be faster the second time, not because the
//         credentials were ever incorrect.
//
// 2. Non-deterministic/case-sensitive username lookup (explains a symptom
//    tied to one specific username, e.g. "jojo"): resolve_username_to_email
//    compared the lowercased INPUT against the RAW stored username column
//    (case-sensitive for any legacy mixed-case row) and used `LIMIT 1`
//    with no ORDER BY, so if a case-duplicate ever existed for one
//    username, which row's email got returned was not guaranteed stable
//    across calls -- resolving to the wrong account's email fails
//    Supabase's password check even with the correct password typed.
//
// Both are fixed without weakening any security boundary: Supabase Auth
// remains the sole password verifier (nothing here bypasses
// signInWithPassword or trusts a client-supplied role/admin field), the
// username resolver stays a SECURITY DEFINER RPC (never a client-side
// query subject to RLS), and no password appears in any log/error path.

let authScreenSrc: string;
let m0049: string;

beforeAll(() => {
  authScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'AuthScreen.tsx'), 'utf8');
  m0049 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0049_harden_username_lookup.sql'), 'utf8');
});

describe('login: username-lookup failures are never shown as "wrong password"', () => {
  it('a resolve_username_to_email RPC error is tagged distinctly, not thrown raw', () => {
    const loginBlock = authScreenSrc.match(/if \(!isValidEmail\(loginEmail\)\) \{[\s\S]*?loginEmail = resolvedEmail;\s*\n\s*\}/)?.[0] ?? '';
    expect(loginBlock).toMatch(/if \(resolveError\) throw new Error\(`LOGIN_LOOKUP_FAILED: /);
  });

  it('the catch block shows an honest lookup-failure message, checked before the generic wrong-password fallback', () => {
    const lookupCheckIdx = authScreenSrc.indexOf("msg.includes('LOGIN_LOOKUP_FAILED')");
    const genericFallbackIdx = authScreenSrc.indexOf("setErrorMessage('Incorrect email or password.');");
    expect(lookupCheckIdx).toBeGreaterThan(-1);
    expect(genericFallbackIdx).toBeGreaterThan(-1);
    expect(lookupCheckIdx).toBeLessThan(genericFallbackIdx);
  });

  it('the lookup-failure message never claims the password was wrong', () => {
    const block = authScreenSrc.match(/if \(msg\.includes\('LOGIN_LOOKUP_FAILED'\)\) \{[\s\S]*?\n\s{8}\}/)?.[0] ?? '';
    expect(block).toMatch(/couldn't verify your login/i);
    expect(block).not.toMatch(/incorrect|wrong password/i);
  });

  it('a genuine "no account found" (username really does not exist) is a distinct, separate error from a lookup failure', () => {
    expect(authScreenSrc).toMatch(/if \(!resolvedEmail\) throw new Error\('No account found with this username\.'\);/);
  });
});

describe('login: a post-auth profile-read timeout never reverts an already-successful login', () => {
  it('the profile fetch supplies a fallback (degrades to null) instead of throwing on timeout', () => {
    const fetchBlock = authScreenSrc.match(/const \{ data: profile \} = await withTimeoutFallback\(([\s\S]*?)\n\s{10}\);/)?.[0] ?? '';
    expect(fetchBlock).toMatch(/fallback: \(\) => \(\{ data: null/);
  });

  it('this fetch runs strictly after signInWithPassword has already succeeded (password already verified by Supabase)', () => {
    const signInIdx = authScreenSrc.indexOf('await supabase.auth.signInWithPassword(');
    const profileFetchIdx = authScreenSrc.indexOf("const { data: profile } = await withTimeoutFallback(");
    expect(signInIdx).toBeGreaterThan(-1);
    expect(profileFetchIdx).toBeGreaterThan(signInIdx);
  });

  it('profile fields all have a user_metadata fallback for when the row read degrades to null', () => {
    const payloadBlock = authScreenSrc.match(/const profilePayload = \{[\s\S]*?\n\s{10}\};/)?.[0] ?? '';
    expect(payloadBlock).toMatch(/profile\?\.full_name \|\| data\.user\.user_metadata\?\.full_name/);
    expect(payloadBlock).toMatch(/profile\?\.username \|\| data\.user\.user_metadata\?\.username/);
  });
});

describe('resolve_username_to_email (0049): case-insensitive and deterministic', () => {
  it('compares lower(trim(...)) on BOTH the stored column and the input, not just the input', () => {
    const fn = m0049.match(/CREATE OR REPLACE FUNCTION public\.resolve_username_to_email[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/WHERE lower\(trim\(username\)\) = lower\(trim\(p_username\)\)/);
  });

  it('orders deterministically (oldest account wins) instead of an unordered LIMIT 1', () => {
    const fn = m0049.match(/CREATE OR REPLACE FUNCTION public\.resolve_username_to_email[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/ORDER BY created_at ASC/);
    expect(fn).toMatch(/LIMIT 1/);
  });

  it('stays a SECURITY DEFINER RPC, not a client-side query subject to RLS', () => {
    const fn = m0049.match(/CREATE OR REPLACE FUNCTION public\.resolve_username_to_email[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/SECURITY DEFINER/);
  });

  it('adds a functional index so the new lower(trim()) comparison stays an index lookup, not a sequential scan', () => {
    expect(m0049).toMatch(/CREATE INDEX IF NOT EXISTS idx_users_username_lower_trim ON public\.users \(lower\(trim\(username\)\)\)/);
  });

  it('does not delete, merge, or alter any existing user row -- read-path fix only', () => {
    expect(m0049).not.toMatch(/^\s*(DELETE FROM|UPDATE public\.users SET username|MERGE)\b/mi);
  });
});

describe('login path: Admin/Sub-Admin use the exact same authentication code as normal users', () => {
  it('there is no separate admin/sub-admin sign-in branch in AuthScreen', () => {
    expect(authScreenSrc).not.toMatch(/if \(role === 'admin'|isAdmin.*signInWithPassword|admin.*signInWithPassword/i);
  });

  it('role is read only from the users table after auth, never trusted from client input', () => {
    expect(authScreenSrc).toMatch(/const dbRole = profile\?\.role \|\| 'attendee';/);
  });

  it('Supabase Auth remains the sole password verifier -- signInWithPassword is not bypassed anywhere in this file', () => {
    // Excludes the one comment line that merely mentions the function name
    // (explaining what it replaced) -- counts only actual call sites.
    const matches = authScreenSrc.match(/const \{ data, error \} = await supabase\.auth\.signInWithPassword\(/g) || [];
    expect(matches.length).toBe(1); // one call site, used for every account type alike
  });
});

describe('login path: no password ever appears in a log, error, or Sentry payload', () => {
  it('the raw error trace log never includes the password field', () => {
    const logLine = authScreenSrc.match(/console\.error\(`\$\{mode[\s\S]*?\}, err\);/)?.[0] ?? '';
    expect(logLine).not.toMatch(/password/i);
  });

  it('this test file itself contains no literal password value', () => {
    const thisFile = readFileSync(__filename, 'utf8');
    expect(thisFile).not.toMatch(/password\s*[:=]\s*['"][^'"]+['"]/i);
  });
});

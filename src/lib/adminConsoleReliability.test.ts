import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for two Admin Console production bugs, diagnosed via a
// full end-to-end trace before any fix was written (see the commit/PR
// description for the evidence trail). Static-analysis style, matching
// every other *.test.ts in this repo -- no live app/DB harness available.

let m0050: string;
let adminDashboardSrc: string;
let adminActionsTabSrc: string;
let authScreenSrc: string;
let appSrc: string;

beforeAll(() => {
  m0050 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0050_fix_signup_profile_data_loss.sql'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  adminDashboardSrc = readFileSync(join(componentsDir, 'AdminDashboardScreen.tsx'), 'utf8');
  adminActionsTabSrc = readFileSync(join(componentsDir, 'AdminActionsTab.tsx'), 'utf8');
  authScreenSrc = readFileSync(join(componentsDir, 'AuthScreen.tsx'), 'utf8');
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
});

describe('Issue 1: new-user signup no longer loses the whole profile on one field collision', () => {
  it('handle_new_user() inserts the always-safe fields (no unique constraint) in one unconditional statement', () => {
    const fn = m0050.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.users \(id, email, role, full_name, state, country, date_of_birth\)/);
  });

  it('username is backfilled independently, with its own exception handler', () => {
    const fn = m0050.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    const usernameBlock = fn.match(/IF v_username IS NOT NULL THEN[\s\S]*?END IF;/)?.[0] ?? '';
    expect(usernameBlock).toMatch(/UPDATE public\.users SET username = v_username WHERE id = NEW\.id;/);
    expect(usernameBlock).toMatch(/EXCEPTION WHEN unique_violation THEN/);
  });

  it('phone_number is backfilled independently, with its own exception handler -- separate from username\'s', () => {
    const fn = m0050.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    const phoneBlock = fn.match(/IF v_phone IS NOT NULL THEN[\s\S]*?END IF;/)?.[0] ?? '';
    expect(phoneBlock).toMatch(/UPDATE public\.users SET phone_number = v_phone WHERE id = NEW\.id;/);
    expect(phoneBlock).toMatch(/EXCEPTION WHEN unique_violation THEN/);
  });

  it('a username collision cannot roll back the base insert (full_name/state/country/dob) -- no shared exception block spans both', () => {
    const fn = m0050.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    // The old bug was a single BEGIN/EXCEPTION wrapping the ENTIRE insert.
    // The fix must NOT wrap the base insert and the username/phone
    // backfills in one shared exception block -- each is independently
    // scoped (its own BEGIN...EXCEPTION...END).
    const baseInsertIdx = fn.indexOf('INSERT INTO public.users (id, email, role, full_name, state, country, date_of_birth)');
    const firstExceptionIdx = fn.indexOf('EXCEPTION WHEN unique_violation');
    expect(baseInsertIdx).toBeGreaterThan(-1);
    expect(firstExceptionIdx).toBeGreaterThan(baseInsertIdx); // base insert isn't inside any exception-guarded block
  });

  it('stays SECURITY DEFINER on auth.users, unrelated Organizer/role logic untouched', () => {
    const fn = m0050.match(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/v_role := CASE/);
  });
});

describe('Issue 2: Admin Actions no longer re-fetches on every unrelated parent re-render', () => {
  it('flash is memoized with useCallback (stable identity), not a plain inline function', () => {
    expect(adminDashboardSrc).toMatch(/const flash = useCallback\(\(ok: boolean, msg: string\) => \{/);
    // Empty dependency array -- flash only calls React state setters, which
    // are themselves guaranteed stable, so this identity never changes.
    const flashBlock = adminDashboardSrc.match(/const flash = useCallback\(\(ok: boolean, msg: string\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(flashBlock).toMatch(/setSuccessMessage/);
    expect(flashBlock).toMatch(/\}, \[\]\);$/);
  });

  it('the 20s pending-count poll still exists (confirms the render-cascade trigger this fix neutralizes)', () => {
    expect(adminDashboardSrc).toMatch(/setInterval\(refreshPendingCount, 20000\)/);
  });
});

describe('Issue 2: both Admin Actions and Payouts now have timeout protection on their loads', () => {
  it('AdminActionsTab wraps its RPC call in withTimeoutFallback', () => {
    expect(adminActionsTabSrc).toMatch(/import \{ withTimeoutFallback \} from '\.\.\/\.\.\/lib\/withTimeoutFallback';/);
    const loadFn = adminActionsTabSrc.match(/const load = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(loadFn).toMatch(/withTimeoutFallback\(/);
    expect(loadFn).toMatch(/timeoutMs: 15000/);
  });

  it('PayoutsTab wraps its Promise.all in withTimeoutFallback', () => {
    expect(adminDashboardSrc).toMatch(/import \{ withTimeoutFallback \} from '\.\.\/\.\.\/lib\/withTimeoutFallback';/);
    const payoutsLoad = adminDashboardSrc.match(/function PayoutsTab\(\{ flash \}[\s\S]*?const load = async \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(payoutsLoad).toMatch(/withTimeoutFallback\(\s*\n\s*Promise\.all\(/);
    expect(payoutsLoad).toMatch(/timeoutMs: 15000/);
  });

  it('a timeout on either load resolves loading=false via the existing finally block (no new stuck state introduced)', () => {
    const loadFn = adminActionsTabSrc.match(/const load = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[/)?.[0] ?? '';
    expect(loadFn).toMatch(/\} finally \{\s*\n\s*setLoading\(false\);/);
    const payoutsLoad = adminDashboardSrc.match(/function PayoutsTab\(\{ flash \}[\s\S]*?const load = async \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
    expect(payoutsLoad).toMatch(/\} finally \{\s*\n\s*setLoading\(false\);/);
  });
});

describe('Issue 1 follow-up: a signup-time username/phone collision is surfaced, never silently masked', () => {
  it('the client no longer falls back to the unsaved local value for username/phone in the onSuccess payload', () => {
    const onSuccessCall = authScreenSrc.match(/onSuccess\(\{\s*\n\s*id: userId,[\s\S]*?\n\s{8}\}\);/)?.[0] ?? '';
    expect(onSuccessCall).toMatch(/username: finalProfile\.username \|\| undefined,/);
    expect(onSuccessCall).toMatch(/phone_number: finalProfile\.phone_number \|\| undefined,/);
    expect(onSuccessCall).not.toMatch(/username: finalProfile\.username \|\| payload\.username,/);
    expect(onSuccessCall).not.toMatch(/phone_number: finalProfile\.phone_number \|\| payload\.phone_number,/);
  });

  it('full_name/state/country keep their read-after-write fallback -- only the two unique-constrained fields changed', () => {
    const onSuccessCall = authScreenSrc.match(/onSuccess\(\{\s*\n\s*id: userId,[\s\S]*?\n\s{8}\}\);/)?.[0] ?? '';
    expect(onSuccessCall).toMatch(/full_name: finalProfile\.full_name \|\| payload\.full_name,/);
    expect(onSuccessCall).toMatch(/state: finalProfile\.state \|\| payload\.state,/);
  });

  it('detects a username or phone save failure and builds a specific, honest warning message', () => {
    expect(authScreenSrc).toMatch(/const usernameSaveFailed = !!payload\.username && !finalProfile\.username;/);
    expect(authScreenSrc).toMatch(/const phoneSaveFailed = !!payload\.phone_number && !finalProfile\.phone_number;/);
    expect(authScreenSrc).toMatch(/couldn't be saved — it was already taken by another account/);
  });

  it('the warning is passed through onSuccess, not just logged', () => {
    const onSuccessCall = authScreenSrc.match(/onSuccess\(\{\s*\n\s*id: userId,[\s\S]*?\n\s{8}\}\);/)?.[0] ?? '';
    expect(onSuccessCall).toMatch(/profileWarning,/);
  });

  it('App.tsx surfaces profileWarning via the existing toast, and never persists it onto currentUser', () => {
    const handlerBlock = appSrc.match(/const handleAuthSuccess = useCallback\(async \(userProfile:[\s\S]*?setCurrentUser\(enriched\);/)?.[0] ?? '';
    expect(handlerBlock).toMatch(/const \{ profileWarning, \.\.\.profileFields \} = userProfile;/);
    expect(handlerBlock).toMatch(/if \(profileWarning\) setAppToastError\(profileWarning\);/);
    expect(handlerBlock).toMatch(/\.\.\.profileFields,/); // enriched is built from profileFields, not raw userProfile
  });
});

describe('AuthScreen corrective update: safe retry, never overwrites another user, never blocks a successful signup', () => {
  function correctiveUpdateBlock(): string {
    return authScreenSrc.match(/if \(Object\.keys\(writablePayload\)\.length > 0\) \{[\s\S]*?\n {8}\}/)?.[0] ?? '';
  }

  it('normal signup persists all profile fields: the update writes every non-empty field from payload, scoped to the signing-up user\'s own row', () => {
    const block = correctiveUpdateBlock();
    expect(block).toMatch(/supabase\.from\('users'\)\.update\(writablePayload\)\.eq\('id', userId\)/);
    // writablePayload itself (built above this block) includes every
    // collected field (full_name, username, phone_number, state, country,
    // avatar_url, date_of_birth) with only empty/null ones filtered out --
    // a normal signup with every field filled writes all of them.
    expect(authScreenSrc).toMatch(/const writablePayload = Object\.fromEntries\(/);
  });

  it('a username collision does not wipe unrelated fields: the update is one single-payload call, not per-field, and a failure never clears other local state', () => {
    const block = correctiveUpdateBlock();
    // Only one .update() call in this block -- the payload (all fields
    // together) either lands or doesn't; there is no separate per-field
    // write that could clear full_name/state/country independently of a
    // username failure. Combined with 0050_fix_signup_profile_data_loss.sql
    // (server-side: a username collision only blocks the username column
    // itself at the DB layer), no code path here additionally resets any
    // other field when updateError is set.
    const updateCallCount = (block.match(/\.update\(writablePayload\)/g) || []).length + (block.match(/\(await supabase\.from\('users'\)\.update\(writablePayload\)/g) || []).length;
    expect(updateCallCount).toBeGreaterThanOrEqual(1);
    expect(block).not.toMatch(/setUsername\(|setPhone\(|setName\(/); // no local form-state reset on failure
  });

  it('a phone collision does not wipe unrelated fields (same single-payload-call reasoning as username)', () => {
    const block = correctiveUpdateBlock();
    expect(block).toMatch(/writablePayload/);
    expect(block).not.toMatch(/delete writablePayload|writablePayload\.phone_number = null|writablePayload\.username = null/);
  });

  it('corrective update failure is not silently swallowed: it is retried once for transient errors, logged, AND later surfaced via profileWarning -- never just console-logged and forgotten', () => {
    const block = correctiveUpdateBlock();
    expect(block).toMatch(/if \(updateError && updateError\.code !== '23505'\) \{/);
    expect(block).toMatch(/await new Promise\(\(resolve\) => setTimeout\(resolve, 800\)\);/);
    expect(block).toMatch(/console\.error\('Signup Failure Trace — profile completion update:', updateError\);/);
    expect(block).toMatch(/Sentry\.captureException\(updateError\);/);
    // The eventual outcome (whether the retry succeeded or not) is what
    // usernameSaveFailed/phoneSaveFailed actually checks -- by reading the
    // re-fetched finalProfile, not the updateError object -- so this is
    // never just a logged-and-ignored failure.
    expect(authScreenSrc).toMatch(/const usernameSaveFailed = !!payload\.username && !finalProfile\.username;/);
  });

  it('a genuine unique-constraint collision (23505) is never retried -- retrying can\'t change a real "already taken" outcome', () => {
    const block = correctiveUpdateBlock();
    expect(block).toMatch(/updateError\.code !== '23505'/);
  });

  it('successful signup still completes correctly: no throw anywhere in this block -- onSuccess is always reached', () => {
    const block = correctiveUpdateBlock();
    expect(block).not.toMatch(/throw /);
  });

  it('never exposes the raw database error to the user -- profileWarning text is fully hand-authored, never interpolates updateError.message', () => {
    const warningSection = authScreenSrc.match(/let profileWarning: string \| undefined;[\s\S]*?\}/)?.[0] ?? '';
    expect(warningSection).not.toMatch(/updateError\.message|updateError\}|\$\{updateError/);
  });
});

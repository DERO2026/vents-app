import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 0227 (H2, L4, M8, L5 in docs/repair-tracker.md). Behaviour is proven against
// a real PostgreSQL by scripts/local-pg-test/run-auth-lookup-verification.sh;
// these static guards keep the shape from regressing in CI.

const root = join(__dirname, '..', '..');
let m: string; let undo: string; let m0004: string; let m0027: string; let appSrc = '';
const fnIn = (t: string, name: string) =>
  [...t.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$(function|b)\\$([\\s\\S]*?)\\$\\1\\$`, 'g'))].pop()?.[2] ?? '';
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

beforeAll(() => {
  m = readFileSync(join(root, 'supabase', 'migrations', '0227_auth_lookup_hardening.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0227.sql'), 'utf8');
  m0004 = readFileSync(join(root, 'supabase', 'migrations', '0004_functions.sql'), 'utf8');
  m0027 = readFileSync(join(root, 'supabase', 'migrations', '0027_check_user_exists_authoritative_email.sql'), 'utf8');
  appSrc = [...walk(join(root, 'src')), ...walk(join(root, 'api'))].map((f) => readFileSync(f, 'utf8')).join('\n');
});

describe('H2: no client code can turn a username into an email', () => {
  it('the app never calls the old open lookups (except the guarded pre-0227 fallback in loginLookup.ts)', () => {
    // P0 2026-11-27: production lacks 0227, so username login fell back to
    // nothing. src/lib/loginLookup.ts may call the pre-0227 functions ONLY
    // after the server says the 0227 function does not exist; with 0227
    // present (always, once 0228 can run) the fallback never runs.
    const appNoFallback = [...walk(join(root, 'src')), ...walk(join(root, 'api'))]
      .filter((f) => !f.endsWith(join('src', 'lib', 'loginLookup.ts')))
      .map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const fn of ['resolve_username_to_email', 'get_account_status', 'email_exists']) {
      expect(appNoFallback).not.toMatch(new RegExp(`rpc\\(\\s*'${fn}'`));
    }
    const lookup = readFileSync(join(root, 'src', 'lib', 'loginLookup.ts'), 'utf8');
    expect(lookup).not.toMatch(/rpc\(\s*'email_exists'/);
    // Each legacy call sits after the function-missing guard of its own function.
    for (const [fnStart, guard, legacy] of [
      ['export async function resolveUsernameToLoginEmail', 'if (!isMissingRpc(res)) throw lookupFailure(res);', "client.rpc('resolve_username_to_email'"],
      ['export async function getLoginAccountStatus', 'if (!isMissingRpc(res)) return null;', "client.rpc('get_account_status'"],
    ] as const) {
      const body = lookup.slice(lookup.indexOf(fnStart));
      expect(body.indexOf(guard)).toBeGreaterThan(-1);
      expect(body.indexOf(legacy)).toBeGreaterThan(body.indexOf(guard));
    }
    expect(lookup).toMatch(/e\.code === 'PGRST202' \|\| e\.code === '42883'/);
  });
  it('0228 revokes the old lookups from every client role (server keeps them); 0227 stays safe for old app builds', () => {
    const m28 = readFileSync(join(root, 'supabase', 'migrations', '0228_revoke_open_auth_lookups.sql'), 'utf8');
    for (const sig of ['resolve_username_to_email(text)', 'get_account_status(text)']) {
      expect(m28).toContain(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).not.toContain(`ON FUNCTION public.${sig}`);
    }
    expect(m).toContain('REVOKE EXECUTE ON FUNCTION public.email_exists(text) FROM PUBLIC, anon, authenticated;');
    expect(m28).toContain("IF to_regprocedure('public.resolve_login_email(text,text)') IS NULL");
    expect(m28).not.toMatch(/REVOKE[^;]*project_admin/);
  });
  it('resolve_login_email returns the email only after the password check, and is rate limited first', () => {
    const b = fnIn(m, 'resolve_login_email');
    const limit = b.indexOf("PERFORM public.check_rate_limit('auth:login_lookup:id:'");
    const lookup = b.indexOf('SELECT u.id, au.email INTO v_user, v_email');
    const check = b.indexOf('IF v_user IS NULL OR NOT public.login_password_matches(v_user, p_password) THEN\n    RETURN NULL;');
    const ret = b.indexOf('RETURN v_email;');
    expect(limit).toBeGreaterThan(-1);
    expect(limit).toBeLessThan(lookup);
    expect(check).toBeGreaterThan(lookup);
    expect(ret).toBeGreaterThan(check);
    expect(b.match(/RETURN v_email;/g)).toHaveLength(1);
    expect(b).toContain("ORDER BY u.created_at ASC"); // same account the old lookup picked
  });
  it('the password check verifies against Supabase Auth\'s own hash and is never granted to clients', () => {
    expect(m).toMatch(/%1\$I\.crypt\(p_password, au\.encrypted_password\) = au\.encrypted_password/);
    expect(m).toContain('REVOKE ALL ON FUNCTION public.login_password_matches(uuid, text) FROM PUBLIC, anon, authenticated;');
    expect(m).not.toMatch(/GRANT[^;]*login_password_matches/);
  });
});

describe('L4: account status only for the owner', () => {
  it('get_login_account_status checks the password before returning anything, and only reports suspended/deleted', () => {
    const b = fnIn(m, 'get_login_account_status');
    expect(b.indexOf('NOT public.login_password_matches(v_user, p_password)')).toBeLessThan(b.indexOf('RETURN QUERY'));
    expect(b).toContain("u.status IN ('suspended', 'deleted')");
    expect(b).toContain("PERFORM public.check_rate_limit('auth:status_lookup:id:'");
  });
  it('check_user_exists (sign-up) stays, rate limited per IP before any lookup', () => {
    expect(m).toContain("PERFORM public.check_rate_limit('auth:exists:ip:' || COALESCE(public.client_ip(), 'unknown'), 60, 300);");
  });
});

describe('M8: reclaim only abandoned sign-ups', () => {
  it('the window moves from 3 minutes to 1 hour, and reclaim is rate limited', () => {
    expect(m).toContain("ARRAY[$a$AND au.created_at < now() - interval '3 minutes'$a$, $a$AND au.created_at < now() - interval '1 hour'$a$]");
    expect(m).toContain("PERFORM public.check_rate_limit('auth:reclaim:ip:' || COALESCE(public.client_ip(), 'unknown'), 10, 300);");
  });
});

describe('L5: profile email columns', () => {
  it('client roles cannot change email or original_email', () => {
    expect(m).toContain("IF current_user IN ('anon', 'authenticated')");
    expect(m).toContain('BEFORE UPDATE OF email, original_email ON public.users');
  });
});

describe('patching and undo', () => {
  it('patches in place with exact anchors and refuses on drift or a second run', () => {
    expect(m).toContain("is not the expected version (anchor % not found exactly once); refusing to patch");
    expect(m).toContain("is already patched; refusing to run twice");
  });
  it('undo is gated, refuses while 0228 is applied, and restores the exact pre-0227 bodies', () => {
    expect(undo).toContain("IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0227' THEN");
    expect(undo).toContain("Refusing: 0228 is applied; run undo_0228 first");
    expect(fnIn(undo, 'reclaim_unverified_signup')).toBe(fnIn(m0004, 'reclaim_unverified_signup'));
    expect(fnIn(undo, 'check_user_exists')).toBe(fnIn(m0027, 'check_user_exists'));
  });
});

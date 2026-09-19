import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// WHAT THESE TESTS VERIFY, AND WHAT THEY DO NOT.
//
// Same static-analysis approach as serviceProviderKyc.security.test.ts and
// organizerPayoutSecurity.security.test.ts: this repo has NO live Postgres
// harness, so these assert that the security properties are actually
// ENCODED IN THE MIGRATION SQL that ships to production.
//
// They do NOT execute Postgres. They cannot prove that Postgres enforces a
// policy at runtime, that RLS is active on the table, or that a real
// Sub-Admin JWT is rejected end-to-end. They prove the shipped SQL says the
// right thing — which is what regressed here in the first place, and what a
// future edit is most likely to silently undo.

let m0087: string;
let m0004: string;
let m0008: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0087 = readFileSync(join(dir, '0087_admin_logs_integrity.sql'), 'utf8');
  m0004 = readFileSync(join(dir, '0004_functions.sql'), 'utf8');
  m0008 = readFileSync(join(dir, '0008_rls_and_policies.sql'), 'utf8');
});

describe('admin_logs (0087): the actor is taken from execution context, never the client', () => {
  it('a BEFORE INSERT trigger overwrites admin_id and actor_role', () => {
    expect(m0087).toMatch(/CREATE OR REPLACE FUNCTION public\.stamp_admin_log_actor/);
    expect(m0087).toMatch(/NEW\.admin_id\s*:=\s*auth\.uid\(\);/);
    expect(m0087).toMatch(/NEW\.actor_role\s*:=\s*public\.actor_role\(\);/);
    expect(m0087).toMatch(/CREATE TRIGGER trg_stamp_admin_log_actor\s*\n\s*BEFORE INSERT ON public\.admin_logs/);
  });

  it('a Sub-Admin cannot forge an entry attributed to Root: the supplied admin_id is discarded', () => {
    // The forgery vector was: insert a row with admin_id = ROOT_UID.
    // Because the trigger assigns admin_id unconditionally from auth.uid()
    // whenever there IS an authenticated user, the client-supplied value
    // never survives to the stored row.
    const fn = m0087.match(/CREATE OR REPLACE FUNCTION public\.stamp_admin_log_actor[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN[\s\S]*NEW\.admin_id\s*:=\s*auth\.uid\(\)/);
    // And it must not be conditional on the client's value being absent.
    expect(fn).not.toMatch(/NEW\.admin_id IS NULL/);
    expect(fn).not.toMatch(/COALESCE\(NEW\.admin_id/);
  });

  it('the server-side (project_admin / webhook) path is preserved: NULL auth.uid() is left alone', () => {
    // complete_/fail_organizer_payout (0084) log with the
    // 'system:project_admin' sentinel and no auth.uid(). The trigger must
    // not clobber that, or payout auditing loses its actor entirely.
    const fn = m0087.match(/CREATE OR REPLACE FUNCTION public\.stamp_admin_log_actor[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN/);
  });
});

describe('admin_logs (0087): INSERT policy requires admin identity AND self-attribution', () => {
  it('both permissive INSERT policies that allowed forgery are dropped', () => {
    expect(m0087).toMatch(/DROP POLICY IF EXISTS admin_insert_logs ON public\.admin_logs;/);
    expect(m0087).toMatch(/DROP POLICY IF EXISTS self_organizer_promotion_log ON public\.admin_logs;/);
  });

  it('the replacement policy constrains admin_id to the caller and requires is_admin()', () => {
    expect(m0087).toMatch(
      /CREATE POLICY admin_logs_insert_self_admin ON public\.admin_logs\s*\n\s*FOR INSERT TO authenticated\s*\n\s*WITH CHECK \(admin_id = \(SELECT auth\.uid\(\)\) AND public\.is_admin\(\)\);/,
    );
  });

  it('the old policies really were the forgery vector (regression pin against 0008)', () => {
    // Pins the original weakness so this file documents what was fixed.
    expect(m0008).toMatch(/CREATE POLICY admin_insert_logs ON admin_logs FOR INSERT TO authenticated WITH CHECK \(is_admin\(\)\);/);
    expect(m0008).toMatch(/CREATE POLICY self_organizer_promotion_log ON admin_logs FOR INSERT TO authenticated WITH CHECK \(\(\(\( SELECT auth\.uid\(\) AS uid\) = admin_id\) OR is_admin\(\)\)\);/);
    // Neither constrained admin_id when is_admin() was true.
  });

  it('a normal (non-admin) authenticated user can no longer insert at all', () => {
    // The old self_organizer_promotion_log allowed ANY user to insert a row
    // for their own uuid with an arbitrary `action` string. The new policy
    // ANDs in is_admin(), so that path is gone.
    const policy = m0087.match(/CREATE POLICY admin_logs_insert_self_admin[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toContain('public.is_admin()');
    expect(policy).not.toContain(' OR ');
  });
});

describe('admin_logs (0087): log is append-only for clients', () => {
  it('UPDATE and DELETE are revoked from anon and authenticated', () => {
    expect(m0087).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.admin_logs FROM anon, authenticated;/);
  });

  it('only authenticated regains INSERT — anon does not', () => {
    const grant = m0087.match(/GRANT INSERT ON public\.admin_logs TO [^;]*;/)?.[0] ?? '';
    expect(grant).toContain('authenticated');
    expect(grant).not.toContain('anon');
  });

  it('SELECT is deliberately untouched so the audit tab keeps working', () => {
    expect(m0087).not.toMatch(/DROP POLICY IF EXISTS admin_select_logs/);
    expect(m0087).not.toMatch(/REVOKE SELECT/);
  });
});

describe('admin_logs (0087): self_organizer_promotion_log behavior is preserved, not broken', () => {
  // This is the load-bearing justification for dropping that policy. If a
  // future edit makes log_organizer_promotion a non-SECURITY-DEFINER
  // function, or has it write a row for someone other than the caller, the
  // dropped policy WOULD have mattered and these assertions fail loudly.
  it('log_organizer_promotion is SECURITY DEFINER, so it bypasses RLS and never needed the policy', () => {
    const fn = m0004.match(/CREATE OR REPLACE FUNCTION public\.log_organizer_promotion[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
  });

  it('it self-authorizes: the caller must be the target, and must actually be an organizer', () => {
    const fn = m0004.match(/CREATE OR REPLACE FUNCTION public\.log_organizer_promotion[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    expect(fn).toMatch(/IF auth\.uid\(\) <> p_user_id THEN\s*\n\s*RAISE EXCEPTION 'caller must be the target user';/);
    expect(fn).toMatch(/WHERE id = p_user_id AND role IN \('organizer', 'organiser'\)/);
  });

  it('it writes admin_id = the caller, so the new trigger stamps an identical value (no behavior change)', () => {
    const fn = m0004.match(/CREATE OR REPLACE FUNCTION public\.log_organizer_promotion[\s\S]*?\$function\$\s*\n?;/)?.[0] ?? '';
    // admin_id is p_user_id, and p_user_id is asserted == auth.uid() above.
    expect(fn).toMatch(/VALUES \(\s*\n\s*p_user_id,\s*\n\s*'organizer_promoted',/);
  });
});

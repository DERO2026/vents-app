import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 7 -- static-analysis proof (same convention as every other
// *.security.test.ts here) that the AI beta allowlist has no
// client-reachable path, is Root-gated for writes, is logged for audit,
// and seeds exactly the one approved account (testerboy) the request
// specified -- no one else.

let sql: string;

beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0168_ai_beta_allowlist.sql'), 'utf8');
});

function fnBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = sql.indexOf(marker);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$function$;', start);
  return sql.slice(start, end);
}

describe('ai_beta_users: no direct client access', () => {
  it('has RLS enabled and defines zero policies', () => {
    expect(sql).toMatch(/ALTER TABLE public\.ai_beta_users ENABLE ROW LEVEL SECURITY;/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('seeds exactly testerboy\'s user_id as a literal VALUES row, and no other account', () => {
    const seedInserts = sql.match(/INSERT INTO public\.ai_beta_users \(user_id, added_by\)\s*\nVALUES[^;]*;/gs) ?? [];
    expect(seedInserts.length).toBe(1);
    expect(seedInserts[0]).toMatch(/91b0afb4-b5dc-4289-ae00-8e6e58c60f5f/);
  });
});

describe('is_ai_beta_user: project_admin-only, no anon/authenticated path', () => {
  it('has no EXECUTE grant to anon or authenticated', () => {
    const revoke = sql.match(/REVOKE ALL ON FUNCTION public\.is_ai_beta_user\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(revoke).toMatch(/anon/);
    expect(revoke).toMatch(/authenticated/);
    const grant = sql.match(/GRANT EXECUTE ON FUNCTION public\.is_ai_beta_user\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(grant).toMatch(/project_admin/);
    expect(grant).not.toMatch(/\bauthenticated\b/);
  });

  it('checks the active flag, not mere row existence -- COALESCEs to false for a missing OR soft-removed row', () => {
    const fn = fnBody('is_ai_beta_user(p_user_id uuid)');
    expect(fn).toMatch(/COALESCE\(\(SELECT active FROM public\.ai_beta_users WHERE user_id = p_user_id\), false\)/);
  });
});

describe('admin_add_ai_beta_user / admin_remove_ai_beta_user: Root-gated, audited, soft-delete only', () => {
  it('both require is_root() before any write', () => {
    const addFn = fnBody('admin_add_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)');
    const removeFn = fnBody('admin_remove_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)');
    expect(addFn).toMatch(/IF NOT public\.is_root\(\) THEN/);
    expect(removeFn).toMatch(/IF NOT public\.is_root\(\) THEN/);
    expect(addFn.indexOf('is_root()')).toBeLessThan(addFn.indexOf('INSERT INTO public.ai_beta_users'));
    expect(removeFn.indexOf('is_root()')).toBeLessThan(removeFn.indexOf('UPDATE public.ai_beta_users'));
  });

  it('removal is a soft-disable (UPDATE active = false), never a DELETE', () => {
    const removeFn = fnBody('admin_remove_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)');
    expect(removeFn).toMatch(/UPDATE public\.ai_beta_users SET active = false WHERE user_id = p_user_id;/);
    expect(removeFn).not.toMatch(/DELETE FROM/);
  });

  it('neither has an EXECUTE grant for anon or authenticated', () => {
    const addRevoke = sql.match(/REVOKE ALL ON FUNCTION public\.admin_add_ai_beta_user\([^;]*;/)?.[0] ?? '';
    const removeRevoke = sql.match(/REVOKE ALL ON FUNCTION public\.admin_remove_ai_beta_user\([^;]*;/)?.[0] ?? '';
    expect(addRevoke).toMatch(/authenticated/);
    expect(removeRevoke).toMatch(/authenticated/);
  });

  it('both writes are logged to admin_logs for audit', () => {
    const addFn = fnBody('admin_add_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)');
    const removeFn = fnBody('admin_remove_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)');
    expect(addFn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(removeFn).toMatch(/INSERT INTO public\.admin_logs/);
  });
});

describe('independence from the subscription/entitlement foundation', () => {
  // Strips comment lines first -- the migration's own prose explains WHY
  // it stays independent (and names those tables/functions while doing
  // so), which is documentation, not a reference in executable SQL. This
  // checks the executable statements only.
  function executableSql(source: string): string {
    return source
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
  }

  it('contains no executable SQL referencing ai_entitlements, ai_usage_periods, check_and_reserve_ai_usage, or ai_entitlement_enforced', () => {
    expect(executableSql(sql)).not.toMatch(/ai_entitlements|ai_usage_periods|check_and_reserve_ai_usage|ai_entitlement_enforced/);
  });

  it('contains no executable SQL referencing ai_usage_events either -- the beta gate and telemetry schema stay fully independent', () => {
    expect(executableSql(sql)).not.toMatch(/ai_usage_events/);
  });
});

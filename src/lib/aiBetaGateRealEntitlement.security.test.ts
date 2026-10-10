import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Root-cause fix for production AI_BETA_RESTRICTED: 0168's is_ai_beta_user()
// never consulted ai_entitlements, so a real, Paystack-verified subscriber
// (0175) was rejected before the entitlement system was ever reached. This
// migration adds has_ai_chat_access(), which aiBeta.ts now calls instead
// (see aiBeta.test.ts for that wiring). Static-analysis proof, same
// convention as aiBeta.security.test.ts, that the new function: has no
// client-reachable path, preserves the legacy allowlist's own effect
// untouched, and applies the exact same valid-entitlement logic
// check_and_reserve_ai_usage() already uses -- not a weaker or different
// check invented just for this gate.

let sql: string;

beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0176_ai_beta_gate_allows_real_entitlement.sql'), 'utf8');
});

function fnBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = sql.indexOf(marker);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$function$;', start);
  return sql.slice(start, end);
}

describe('has_ai_chat_access: no direct client access', () => {
  it('has no EXECUTE grant to anon or authenticated -- only project_admin', () => {
    const revoke = sql.match(/REVOKE ALL ON FUNCTION public\.has_ai_chat_access\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(revoke).toMatch(/anon/);
    expect(revoke).toMatch(/authenticated/);
    const grant = sql.match(/GRANT EXECUTE ON FUNCTION public\.has_ai_chat_access\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(grant).toMatch(/project_admin/);
    expect(grant).not.toMatch(/\bauthenticated\b/);
  });

  it('is SECURITY DEFINER with search_path locked down', () => {
    const fn = fnBody('has_ai_chat_access(p_user_id uuid)');
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });
});

describe('has_ai_chat_access: preserves the legacy beta allowlist unchanged', () => {
  it('checks ai_beta_users.active exactly the same way is_ai_beta_user() does, as its own first branch', () => {
    const fn = fnBody('has_ai_chat_access(p_user_id uuid)');
    expect(fn).toMatch(/COALESCE\(\(SELECT active FROM public\.ai_beta_users WHERE user_id = p_user_id\), false\)/);
  });

  it('never redefines or drops is_ai_beta_user itself -- the original function and its one seeded account are untouched', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.is_ai_beta_user/);
    expect(sql).not.toMatch(/DROP FUNCTION/i);
  });
});

describe('has_ai_chat_access: real entitlement check matches check_and_reserve_ai_usage, not a weaker invention', () => {
  it('requires status to be trialing, active, or grace -- same allowed-status set as usage enforcement', () => {
    const fn = fnBody('has_ai_chat_access(p_user_id uuid)');
    expect(fn).toMatch(/v_ent\.status NOT IN \('trialing', 'active', 'grace'\)/);
  });

  it('rejects a lapsed period with no remaining grace window, same as check_and_reserve_ai_usage\'s own period check', () => {
    const fn = fnBody('has_ai_chat_access(p_user_id uuid)');
    expect(fn).toMatch(/v_ent\.period_end IS NOT NULL AND v_ent\.period_end < now\(\)/);
    expect(fn).toMatch(/v_ent\.grace_until IS NULL OR v_ent\.grace_until < now\(\)/);
  });

  it('returns false (not an error) for a user with no ai_entitlements row at all', () => {
    const fn = fnBody('has_ai_chat_access(p_user_id uuid)');
    expect(fn).toMatch(/IF v_ent IS NULL THEN\s*\n\s*RETURN false;/);
  });
});

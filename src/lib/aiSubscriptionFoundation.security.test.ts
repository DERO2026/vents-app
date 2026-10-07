import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 4 -- AI subscription backend foundation. This repo has no live
// Postgres integration harness (same limitation as every other
// *.security.test.ts here, e.g. nearbyAndFuzzySearchHardening.security.test.ts) --
// these are static-analysis tests proving the SQL actually committed in
// 0165_ai_subscription_foundation.sql has the specific properties this
// feature depends on for security (grants, RLS, no client-reachable write
// path) and for concurrency correctness (row lock before read, single
// atomic upsert for the increment). A future edit that accidentally
// removes any of these is caught here, not discovered live in production.

let sql: string;
// Phase 4A (0166) replaces check_and_reserve_ai_usage() in place to fix the
// expiry/compensating-decrement transaction-semantics bug found during live
// Phase 4 verification -- see that migration's own comment for the full
// explanation. 0165 is read for everything else (tables, grants, trial,
// admin RPCs, seed data), none of which 0166 touches; fnBody166 reads the
// CURRENT (post-fix) body of check_and_reserve_ai_usage specifically.
let sql166: string;

beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0165_ai_subscription_foundation.sql'), 'utf8');
  sql166 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0166_fix_ai_usage_expiry_transaction_semantics.sql'), 'utf8');
});

function fnBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = sql.indexOf(marker);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$function$;', start);
  return sql.slice(start, end);
}

function fnBody166(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = sql166.indexOf(marker);
  expect(start, `function ${name} not found in 0166`).toBeGreaterThan(-1);
  const end = sql166.indexOf('\n$function$;', start);
  return sql166.slice(start, end);
}

describe('ai_entitlements / ai_usage_periods / ai_plans: no direct client access', () => {
  it('all three tables have RLS enabled', () => {
    expect(sql).toMatch(/ALTER TABLE public\.ai_plans ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/ALTER TABLE public\.ai_entitlements ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/ALTER TABLE public\.ai_usage_periods ENABLE ROW LEVEL SECURITY;/);
  });

  it('defines no CREATE POLICY at all for these tables -- RLS-enabled with zero policies denies anon/authenticated direct access entirely', () => {
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});

describe('check_and_reserve_ai_usage: reachability and concurrency', () => {
  it('has no EXECUTE grant to anon or authenticated, and is explicitly revoked from them', () => {
    const grantLine = sql.match(/REVOKE ALL ON FUNCTION public\.check_and_reserve_ai_usage\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(grantLine).toMatch(/PUBLIC/);
    expect(grantLine).toMatch(/anon/);
    expect(grantLine).toMatch(/authenticated/);
    const grantOnly = sql.match(/GRANT EXECUTE ON FUNCTION public\.check_and_reserve_ai_usage\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(grantOnly).toMatch(/project_admin/);
    expect(grantOnly).not.toMatch(/\bauthenticated\b/);
    expect(grantOnly).not.toMatch(/\banon\b/);
  });

  it('locks the entitlement row (FOR UPDATE) before reading it, so two concurrent calls for the same user serialize', () => {
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).toMatch(/SELECT \* INTO v_ent FROM public\.ai_entitlements WHERE user_id = p_user_id FOR UPDATE;/);
    // The lock must happen before any usage-period mutation.
    expect(fn.indexOf('FOR UPDATE')).toBeLessThan(fn.indexOf('INSERT INTO public.ai_usage_periods'));
  });

  it('reserves usage via a single atomic upsert (INSERT ... ON CONFLICT ... RETURNING), the same idiom as check_rate_limit -- unchanged by the Phase 4A fix', () => {
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).toMatch(/INSERT INTO public\.ai_usage_periods[\s\S]*?ON CONFLICT \(user_id, surface, period_start\)[\s\S]*?DO UPDATE SET used_units = public\.ai_usage_periods\.used_units \+ 1[\s\S]*?RETURNING used_units INTO v_used;/);
  });

  // Phase 4A fix: the pre-0166 version wrote a compensating decrement
  // before RAISEing on a ceiling violation. That write was dead code --
  // an uncaught RAISE EXCEPTION rolls back the entire call, including the
  // increment the decrement was "undoing", so Postgres was already
  // discarding it for free. 0166 removes the decrement outright; this
  // test proves it stays gone (a regression here would silently
  // reintroduce dead code, not a bug, but exactly what Phase 4A set out
  // to remove).
  it('Phase 4A: does NOT contain a compensating decrement on the ceiling path -- the rollback already discards the increment', () => {
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).not.toMatch(/used_units = used_units - 1/);
    const ceilingCheckIdx = fn.indexOf('IF v_used > v_plan.hard_ceiling THEN');
    const raiseIdx = fn.indexOf("RAISE EXCEPTION 'usage_ceiling_exceeded'");
    expect(ceilingCheckIdx).toBeGreaterThan(-1);
    expect(raiseIdx).toBeGreaterThan(ceilingCheckIdx);
  });

  // Phase 4A fix: the pre-0166 version also wrote status = 'expired'
  // immediately before RAISEing entitlement_expired -- rolled back by the
  // same mechanism, so it never reached disk. 0166 removes that write and
  // relies entirely on re-deriving expiry from period_end on every call.
  it('Phase 4A: does NOT attempt to persist status = \'expired\' before raising -- enforcement is derived from period_end, not a cached status', () => {
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).not.toMatch(/UPDATE public\.ai_entitlements SET status = 'expired'/);
    expect(fn).toMatch(/v_ent\.period_end IS NOT NULL AND v_ent\.period_end < now\(\)/);
    const periodCheckIdx = fn.indexOf('v_ent.period_end IS NOT NULL');
    const raiseIdx = fn.indexOf("RAISE EXCEPTION 'entitlement_expired'");
    expect(periodCheckIdx).toBeGreaterThan(-1);
    expect(raiseIdx).toBeGreaterThan(periodCheckIdx);
  });

  // The grace transition is the one write on this path that genuinely
  // persists -- it does NOT raise afterward in the same call (falls
  // through to a normal successful return), so Phase 4A correctly leaves
  // it in place.
  it('still persists the grace-period status transition (that path never raises afterward, so it genuinely commits)', () => {
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).toMatch(/UPDATE public\.ai_entitlements SET status = 'grace'/);
  });

  it('rejects when the entitlement is missing, inactive, or expired, before ever touching the usage table', () => {
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).toMatch(/RAISE EXCEPTION 'no_entitlement'/);
    expect(fn).toMatch(/RAISE EXCEPTION 'entitlement_inactive'/);
    expect(fn).toMatch(/RAISE EXCEPTION 'entitlement_expired'/);
    const firstExceptionIdx = fn.indexOf("RAISE EXCEPTION 'no_entitlement'");
    const usageInsertIdx = fn.indexOf('INSERT INTO public.ai_usage_periods');
    expect(firstExceptionIdx).toBeLessThan(usageInsertIdx);
  });

  it('separates chat/extraction/vision into independent usage buckets (surface is part of the table primary key and the function validates it)', () => {
    expect(sql).toMatch(/surface\s+text NOT NULL CHECK \(surface IN \('chat', 'extraction', 'vision'\)\)/);
    expect(sql).toMatch(/PRIMARY KEY \(user_id, surface, period_start\)/);
    const fn = fnBody166('check_and_reserve_ai_usage(p_user_id uuid, p_surface text)');
    expect(fn).toMatch(/IF p_surface NOT IN \('chat', 'extraction', 'vision'\) THEN/);
  });
});

describe('start_ai_trial: one-time, account-bound, never resettable by a user-reachable path', () => {
  it('has no EXECUTE grant to anon or authenticated', () => {
    const revoke = sql.match(/REVOKE ALL ON FUNCTION public\.start_ai_trial\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(revoke).toMatch(/anon/);
    expect(revoke).toMatch(/authenticated/);
    const grant = sql.match(/GRANT EXECUTE ON FUNCTION public\.start_ai_trial\([^)]*\)[^;]*;/)?.[0] ?? '';
    expect(grant).not.toMatch(/\bauthenticated\b/);
  });

  it('locks the entitlement row before checking trial_used, so two concurrent trial starts cannot both succeed', () => {
    const fn = fnBody('start_ai_trial(p_user_id uuid)');
    expect(fn).toMatch(/SELECT \* INTO v_ent FROM public\.ai_entitlements WHERE user_id = p_user_id FOR UPDATE;/);
    expect(fn.indexOf('FOR UPDATE')).toBeLessThan(fn.indexOf("IF v_ent IS NOT NULL AND v_ent.trial_used THEN"));
  });

  it('rejects outright if trial_used is already true, rather than granting a second trial', () => {
    const fn = fnBody('start_ai_trial(p_user_id uuid)');
    expect(fn).toMatch(/RAISE EXCEPTION 'trial_already_used'/);
  });

  it('sets trial_used = true on grant, and no function anywhere in this migration ever sets it back to false', () => {
    expect(sql).toMatch(/trial_used = true/);
    expect(sql).not.toMatch(/trial_used = false/);
    expect(sql).not.toMatch(/trial_used,?\s*=?\s*false\)/);
  });

  it('the trial plan is bounded by total units, not a calendar period (period_end left NULL)', () => {
    const fn = fnBody('start_ai_trial(p_user_id uuid)');
    expect(fn).toMatch(/period_end = NULL/);
  });
});

describe('admin_set_ai_entitlement / admin_set_ai_plan: Root-gated, never exposed to ordinary users', () => {
  it('both require is_root() before making any change', () => {
    const entFn = fnBody('admin_set_ai_entitlement(');
    const planFn = fnBody('admin_set_ai_plan(');
    expect(entFn).toMatch(/IF NOT public\.is_root\(\) THEN/);
    expect(planFn).toMatch(/IF NOT public\.is_root\(\) THEN/);
    // The is_root() check must come before any UPDATE/INSERT in each body.
    expect(entFn.indexOf('is_root()')).toBeLessThan(entFn.search(/INSERT INTO public\.ai_entitlements|UPDATE public\.ai_entitlements/));
    expect(planFn.indexOf('is_root()')).toBeLessThan(planFn.indexOf('UPDATE public.ai_plans'));
  });

  it('neither has an EXECUTE grant for anon or authenticated', () => {
    const entRevoke = sql.match(/REVOKE ALL ON FUNCTION public\.admin_set_ai_entitlement\([^;]*;/)?.[0] ?? '';
    const planRevoke = sql.match(/REVOKE ALL ON FUNCTION public\.admin_set_ai_plan\([^;]*;/)?.[0] ?? '';
    expect(entRevoke).toMatch(/authenticated/);
    expect(planRevoke).toMatch(/authenticated/);
  });

  it('both admin writes are logged to admin_logs for audit', () => {
    const entFn = fnBody('admin_set_ai_entitlement(');
    const planFn = fnBody('admin_set_ai_plan(');
    expect(entFn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(planFn).toMatch(/INSERT INTO public\.admin_logs/);
  });
});

describe('get_my_ai_entitlement: self-read-only, no parameterized identity', () => {
  it('uses auth.uid() internally, never a p_user_id argument -- a caller cannot ask for someone else\'s entitlement', () => {
    const fn = fnBody('get_my_ai_entitlement()');
    expect(fn).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_my_ai_entitlement\(\)/);
  });

  it('is granted to authenticated (read-only, safe) but the function body contains no UPDATE/INSERT/DELETE', () => {
    const grant = sql.match(/GRANT EXECUTE ON FUNCTION public\.get_my_ai_entitlement\(\)[^;]*;/)?.[0] ?? '';
    expect(grant).toMatch(/authenticated/);
    const fn = fnBody('get_my_ai_entitlement()');
    expect(fn).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });
});

describe('app_config.ai_entitlement_enforced: rollout flag, defaults to OFF', () => {
  it('defaults to false so this migration does not change behavior for any existing user on its own', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_entitlement_enforced boolean NOT NULL DEFAULT false;/);
  });

  it('ai_entitlement_enforced() fails OPEN (COALESCE to false), the opposite of ai_disabled()\'s fail-closed pattern', () => {
    const fn = fnBody('ai_entitlement_enforced()');
    expect(fn).toMatch(/COALESCE\(\(SELECT ai_entitlement_enforced FROM public\.app_config LIMIT 1\), false\)/);
  });

  it('is wired into the existing Root-gated admin_update_app_config CASE statement, not a brand-new writer', () => {
    const fn = fnBody('admin_update_app_config(p_field text, p_value text, p_reason text DEFAULT NULL)');
    expect(fn).toMatch(/WHEN 'ai_entitlement_enforced' THEN/);
    expect(fn).toMatch(/IF NOT public\.is_root\(\) THEN/);
  });
});

describe('ai_plans seed data matches the agreed planning values (placeholders, not final pricing)', () => {
  it('trial / ai / ai_plus / ai_pro included+ceiling values match', () => {
    expect(sql).toMatch(/\('trial',\s*'VENTS AI Trial',\s*15,\s*15,\s*true,\s*true\)/);
    expect(sql).toMatch(/\('ai',\s*'VENTS AI',\s*50,\s*75,\s*false,\s*true\)/);
    expect(sql).toMatch(/\('ai_plus',\s*'VENTS AI\+',\s*100,\s*150,\s*false,\s*true\)/);
    expect(sql).toMatch(/\('ai_pro',\s*'VENTS AI Pro',\s*220,\s*320,\s*false,\s*true\)/);
  });

  it('every plan\'s hard_ceiling is >= its included_units at the column-constraint level', () => {
    expect(sql).toMatch(/hard_ceiling\s+integer NOT NULL CHECK \(hard_ceiling >= included_units\)/);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Production incident: rate_limits had ROW LEVEL SECURITY enabled with
// ZERO policies, so every write from project_admin (not a bypass-RLS
// role) was default-denied -- confirmed directly from Vercel production
// runtime error logs ("new row violates row-level security policy for
// table rate_limits", recurring on /api/extract-events since 2026-10-07,
// newly surfaced on /api/wallet/resolve-account on 2026-10-10). This
// silently broke check_rate_limit() for every caller going through
// callProjectAdminRpc; enforceRateLimit's callers failed open (no visible
// symptom -- no real rate limiting at all), resolve-account's
// fail-closed gate is what made it visible.
//
// No live Postgres integration harness exists in this test suite (same
// limitation as every other *.security.test.ts here) -- this locks in
// the specific fix (0178) statically so a future migration can't drop
// this policy again without a test failing.

let sql: string;

beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0178_rate_limits_project_admin_rls_policy.sql'), 'utf8');
});

describe('rate_limits: project_admin can actually write under RLS', () => {
  it('creates a policy granting project_admin unrestricted access to rate_limits', () => {
    expect(sql).toMatch(/CREATE POLICY project_admin_full_access ON public\.rate_limits/);
    expect(sql).toMatch(/FOR ALL TO project_admin/);
    expect(sql).toMatch(/USING \(true\) WITH CHECK \(true\)/);
  });

  it('is scoped to project_admin only -- never anon or authenticated, which have no table grant on rate_limits to begin with', () => {
    expect(sql).not.toMatch(/TO\s+(anon|authenticated|PUBLIC)\b/);
  });
});

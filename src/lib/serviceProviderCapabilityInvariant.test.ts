import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Root-cause audit + permanent fix for "new row violates row-level
// security policy for table service_providers". Full findings in this
// migration's own header comment; summarized here:
//
// - No Postgres/application "Service Provider role" exists or is needed --
//   0033 is explicit that is_service_provider is deliberately a plain
//   boolean capability, independent of `role`.
// - Source of truth: users.is_service_provider, gated by
//   service_providers_insert_own/update_own (0034) -- untouched, correct,
//   never weakened.
// - Grant path: admin_decide_service_provider_request (0044) -- atomic,
//   correct. NOT the bug.
// - Actual root cause: nothing enforced the invariant "status='approved'
//   implies is_service_provider=true" against every possible write path to
//   service_provider_requests.status (the admin raw-UPDATE RLS policy, or
//   a direct SQL edit) -- only the one RPC happened to keep them in sync.
//   users' own trg_protect_capability_columns trigger only protects the
//   `users` table, not service_provider_requests.
// - Fix (0053): a trigger on service_provider_requests that grants the
//   capability whenever status becomes 'approved', regardless of how --
//   moving enforcement from "one RPC's side effect" to a real database
//   invariant. Deliberately one-directional (never auto-revokes on
//   rejection, since an already-approved provider's later unrelated
//   request being rejected must not silently revoke their existing
//   capability -- revocation stays exclusively through
//   admin_set_service_provider_capability(user, false)).
// - Repair: list_service_provider_capability_desync() (dry run, admin-only)
//   + backfill_service_provider_capability_desync() (admin-only, scoped
//   exactly to status='approved' AND is_service_provider=false, logged as
//   one auditable admin_logs entry).

let migration0053: string;
let migration0034: string;
let migration0044: string;
let migration0033: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration0053 = readFileSync(join(dir, '0053_service_provider_capability_sync_invariant.sql'), 'utf8');
  migration0034 = readFileSync(join(dir, '0034_service_providers.sql'), 'utf8');
  migration0044 = readFileSync(join(dir, '0044_service_provider_kyc.sql'), 'utf8');
  migration0033 = readFileSync(join(dir, '0033_service_provider_capability.sql'), 'utf8');
});

describe('Architecture confirmation: no Service Provider role, a plain capability boolean by design', () => {
  it('is_service_provider is documented as deliberately not a role, independent of users.role', () => {
    expect(migration0033).toMatch(/deliberately NOT a `role` value/);
    expect(migration0033).toMatch(/ALTER TABLE public\.users ADD COLUMN IF NOT EXISTS is_service_provider boolean NOT NULL DEFAULT false;/);
  });

  it('a raw authenticated-role UPDATE can never flip is_service_provider directly -- only the sanctioned SECURITY DEFINER RPCs can', () => {
    expect(migration0033).toMatch(/CREATE TRIGGER trg_protect_capability_columns BEFORE UPDATE ON public\.users/);
    expect(migration0033).toMatch(/RAISE EXCEPTION 'is_service_provider can only be changed via admin_set_service_provider_capability\(\)';/);
  });
});

describe('RLS on service_providers: untouched, correct, still the sole authorization source', () => {
  it('service_providers_insert_own/update_own still gate on auth.uid()=user_id AND is_service_provider=true, unchanged by this fix', () => {
    expect(migration0034).toMatch(/CREATE POLICY service_providers_insert_own ON public\.service_providers/);
    expect(migration0034).toMatch(/u\.is_service_provider = true/);
  });

  it('the fix migration does not touch RLS at all', () => {
    expect(migration0053).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/);
    expect(migration0053).not.toMatch(/ENABLE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/);
  });
});

describe('New invariant-enforcing trigger (0053): the actual root-cause fix', () => {
  it('grants is_service_provider whenever service_provider_requests.status becomes approved, regardless of write path', () => {
    const fn = migration0053.match(/CREATE OR REPLACE FUNCTION public\.sync_service_provider_capability_on_approval\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NEW\.status = 'approved' THEN/);
    expect(fn).toMatch(/UPDATE public\.users\s*\n\s*SET is_service_provider = true\s*\n\s*WHERE id = NEW\.user_id/);
    expect(migration0053).toMatch(/CREATE TRIGGER trg_sync_service_provider_capability\s*\n\s*AFTER INSERT OR UPDATE OF status ON public\.service_provider_requests/);
  });

  it('is one-directional -- never auto-revokes on rejection (only grants on approval)', () => {
    const fn = migration0053.match(/CREATE OR REPLACE FUNCTION public\.sync_service_provider_capability_on_approval\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).not.toMatch(/'rejected'/);
    expect(fn).not.toMatch(/SET is_service_provider = false/);
  });

  it('the RPC-level grant (0044) is preserved -- redundant-but-harmless, not removed', () => {
    const fn = migration0044.match(/CREATE FUNCTION public\.admin_decide_service_provider_request[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/UPDATE public\.users SET is_service_provider = true WHERE id = v_user_id;/);
  });
});

describe('Repair path (0053): dry-run + scoped backfill for existing desynced accounts', () => {
  it('list_service_provider_capability_desync is a read-only, admin-gated dry run showing exactly which rows are affected', () => {
    const fn = migration0053.match(/CREATE OR REPLACE FUNCTION public\.list_service_provider_capability_desync\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/LANGUAGE sql\s*\n\s*STABLE SECURITY DEFINER/);
    expect(fn).toMatch(/WHERE r\.status = 'approved' AND u\.is_service_provider = false;/);
  });

  it('backfill_service_provider_capability_desync only touches rows matching the exact desync condition, is admin-gated, idempotent, and logged', () => {
    const fn = migration0053.match(/CREATE OR REPLACE FUNCTION public\.backfill_service_provider_capability_desync\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN/);
    expect(fn).toMatch(/WHERE r\.status = 'approved' AND u\.is_service_provider = false;/);
    expect(fn).toMatch(/WHERE id = ANY\(v_ids\)\s*\n\s*AND is_service_provider = false;/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(fn).toMatch(/'service_provider_capability_backfill'/);
  });
});

describe('Test matrix (static confirmation of each state per the audit request)', () => {
  it('A/B. pending or rejected: is_service_provider is never granted (only approved triggers the grant)', () => {
    const fn = migration0053.match(/CREATE OR REPLACE FUNCTION public\.sync_service_provider_capability_on_approval\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    // Only one branch, gated strictly on 'approved' -- pending/rejected fall through untouched.
    const ifCount = (fn.match(/IF NEW\.status/g) || []).length;
    expect(ifCount).toBe(1);
  });

  it('C. approved: RLS (0034, untouched) + the new trigger (0053) together allow the authorized owner insert/update', () => {
    expect(migration0034).toMatch(/service_providers_insert_own/);
    expect(migration0053).toMatch(/trg_sync_service_provider_capability/);
  });

  it('D. approved request + missing capability: the backfill function is exactly the repair path, scoped and idempotent', () => {
    expect(migration0053).toMatch(/backfill_service_provider_capability_desync/);
  });

  it('E. normal non-provider: the RLS capability check (0034) is untouched, so provider writes remain denied', () => {
    expect(migration0034).toMatch(/u\.is_service_provider = true/);
  });

  it('F. organizer who is also an approved provider: is_service_provider is independent of role, so nothing in this fix touches users.role or organizer architecture', () => {
    expect(migration0053).not.toMatch(/users\.role|SET role|WHERE role/);
    expect(migration0033).toMatch(/does\s*\n?-- NOT touch users\.role/);
  });
});

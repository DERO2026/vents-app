import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Security-hardening follow-up for admin_decide_service_provider_request
// (see 0082_service_provider_kyc_maker_checker.sql for the full rationale).
//
// IMPORTANT — what these assertions do and don't prove: this repo has no
// live Postgres harness, so every assertion below is a STATIC TEXT match
// against the migration SQL and the TS call-site source, exactly like this
// repo's other `.security.test.ts` files (serviceProviderKyc.security.test.ts,
// organizerPayoutSecurity.security.test.ts). They prove the SQL/TS *say* the
// right thing — role checks, dispatch branches, self-approval guard,
// audit-log inserts — not that a live database actually behaves this way at
// runtime (concurrency, RLS interaction, trigger ordering, etc. would need a
// real Postgres instance to verify). Where a claim can only be verified live,
// it is called out explicitly rather than asserted as proven.

let migration: string;
let adminDashboardSrc: string;
let providerDetailSrc: string;
let actionsTabSrc: string;
let sharedActionsSrc: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(migrationsDir, '0082_service_provider_kyc_maker_checker.sql'), 'utf8');
  adminDashboardSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'AdminDashboardScreen.tsx'), 'utf8');
  providerDetailSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'admin', 'AdminProviderDetail.tsx'), 'utf8');
  actionsTabSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'AdminActionsTab.tsx'), 'utf8');
  sharedActionsSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'admin', 'adminUserEventActions.ts'), 'utf8');
});

describe('migration 0082 does not touch the historical 0044 file', () => {
  it('0044_service_provider_kyc.sql is untouched (this is an additive migration)', () => {
    // Static guard: assert the new migration file exists at the expected,
    // additive path (a non-0044 filename) rather than editing 0044 in place.
    const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
    expect(() => readFileSync(join(migrationsDir, '0044_service_provider_kyc.sql'), 'utf8')).not.toThrow();
    const original044 = readFileSync(join(migrationsDir, '0044_service_provider_kyc.sql'), 'utf8');
    // 0044's own text must still show its original (looser-looking) gate --
    // proving we did not rewrite history, only shadow it with a later
    // CREATE OR REPLACE in the new file.
    expect(original044).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
  });
});

describe('0082: admin_decide_service_provider_request role check tightened to Root+Admin', () => {
  it('re-declares admin_decide_service_provider_request via CREATE OR REPLACE', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.admin_decide_service_provider_request\(/);
  });

  it('the new definition gates on is_super_admin(), not is_admin_or_root()', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.admin_decide_service_provider_request[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN RAISE EXCEPTION 'Admin access required'; END IF;/);
    expect(fn).not.toMatch(/is_admin_or_root/);
  });

  it('preserves the atomic request-update + capability-grant + notification + admin_logs write', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.admin_decide_service_provider_request[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/UPDATE public\.service_provider_requests\s*\n\s*SET status = p_status/);
    expect(fn).toMatch(/UPDATE public\.users SET is_service_provider = true WHERE id = v_user_id;/);
    expect(fn).toMatch(/INSERT INTO public\.notifications/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs[\s\S]*'service_provider_request_decision'/);
  });

  it('keeps the function authenticated-only (no anon grant)', () => {
    const grantLine = migration.match(/GRANT EXECUTE ON FUNCTION public\.admin_decide_service_provider_request[^;]*;/)?.[0] ?? '';
    expect(grantLine).toContain('authenticated');
    expect(grantLine).not.toMatch(/\banon\b/);
  });
});

describe('0082: approve_admin_action dispatches the new provider-KYC action types', () => {
  it('re-declares approve_admin_action via CREATE OR REPLACE', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.approve_admin_action\(p_request_id uuid\)/);
  });

  it('adds WHEN branches for service_provider_kyc_approve/_reject calling admin_decide_service_provider_request', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/WHEN 'service_provider_kyc_approve' THEN PERFORM public\.admin_decide_service_provider_request\(\(r\.payload->>'request_id'\)::uuid, 'approved', r\.payload->>'reason'\);/);
    expect(fn).toMatch(/WHEN 'service_provider_kyc_reject'\s+THEN PERFORM public\.admin_decide_service_provider_request\(\(r\.payload->>'request_id'\)::uuid, 'rejected', r\.payload->>'reason'\);/);
  });

  it('resolves the target server-side from the stored request row, never from a client-supplied label', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    // The only client input to approve_admin_action is p_request_id; the
    // executed decision (request id + status + reason) is read back out of
    // the already-stored `r.payload`/`r` row fetched by that id, not out of
    // any parameter the approving admin's client passes at approval time.
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.approve_admin_action\(p_request_id uuid\)/);
    expect(fn).toMatch(/SELECT \* INTO r FROM public\.admin_action_requests WHERE id = p_request_id FOR UPDATE;/);
  });

  it('preserves every pre-existing WHEN branch unchanged (no regression to other action types)', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    for (const branch of [
      "WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);",
      "WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');",
      'WHEN \'hide_event\'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>\'reason\');',
      "WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');",
      "WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');",
    ]) {
      expect(fn).toContain(branch);
    }
  });

  it('still writes admin_logs (action_approved) and notifies the requester on approval, unchanged from the existing pattern', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.admin_logs[\s\S]*'action_approved'/);
    expect(fn).toMatch(/INSERT INTO public\.notifications[\s\S]*'Your request has been approved'/);
  });

  it('keeps the double-execution guard: an already-non-pending request is rejected before dispatch', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF r\.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r\.status; END IF;/);
    // The row is locked (FOR UPDATE) and only then transitioned pending ->
    // approved; a concurrent second approval attempt would block on the lock
    // and then hit this same guard once the first transaction commits. This
    // is inherited, unmodified, from the pre-existing approve_admin_action --
    // proving the SQL still says this is not the same as proving the
    // concurrent-transaction behavior live against Postgres.
    expect(fn).toMatch(/FOR UPDATE;/);
  });
});

describe('0082: Sub-Admin cannot approve their own submitted provider-KYC request', () => {
  it('adds a self-approval guard scoped to the two new action types', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF r\.action_type IN \('service_provider_kyc_approve', 'service_provider_kyc_reject'\)\s*\n\s*AND r\.requested_by = auth\.uid\(\) THEN\s*\n\s*RAISE EXCEPTION 'Cannot approve your own request';\s*\n\s*END IF;/);
  });

  it('honest disclosure: approve_admin_action has no GENERIC self-approval guard for other action types today', () => {
    // Verified by reading the live 0004_functions.sql definition of
    // approve_admin_action/reject_admin_action: neither checks
    // `r.requested_by = auth.uid()` for any action type. The guard added by
    // 0082 is therefore intentionally scoped to service_provider_kyc_approve/
    // _reject only, rather than claimed as inherited from an existing
    // generic mechanism that does not exist. This assertion documents that
    // fact rather than fabricating a passing test for a protection this
    // codebase does not generically have.
    const functionsSql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0004_functions.sql'), 'utf8');
    const originalApprove = functionsSql.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(originalApprove).not.toMatch(/requested_by\s*=\s*auth\.uid\(\)/);
  });
});

describe('0082: double-execution / idempotency is inherited from the generic admin_action_requests status machine', () => {
  it('the request row transitions pending -> approved/rejected exactly once (status guard + FOR UPDATE lock), unchanged by 0082', () => {
    // Cited from the live 0004_functions.sql (not re-declared by 0082):
    // approve_admin_action and reject_admin_action both SELECT ... FOR UPDATE
    // the request row, then RAISE EXCEPTION if status <> 'pending' before
    // doing anything else, then UPDATE the status away from 'pending'. This
    // status-machine — not a new mechanism 0082 invents — is what prevents a
    // second approval/rejection of the same request, generically, for every
    // action type including the new provider-KYC ones. Confirmed by static
    // read of the SQL; true concurrent-transaction proof would need a live
    // Postgres instance.
    const functionsSql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0004_functions.sql'), 'utf8');
    const originalApprove = functionsSql.match(/CREATE OR REPLACE FUNCTION public\.approve_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    const originalReject = functionsSql.match(/CREATE OR REPLACE FUNCTION public\.reject_admin_action[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    for (const fn of [originalApprove, originalReject]) {
      expect(fn).toMatch(/FOR UPDATE;/);
      expect(fn).toMatch(/IF r\.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r\.status; END IF;/);
    }
  });
});

describe('call sites: Root/Admin still call admin_decide_service_provider_request directly', () => {
  it('AdminDashboardScreen.tsx routes the decision through submitOrExecute (direct execute for Super Admin, queued otherwise)', () => {
    const block = adminDashboardSrc.match(/const reviewSpRequest = async[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(block).toMatch(/await submitOrExecute\(actionType,/);
    expect(block).toMatch(/supabase\.rpc\('admin_decide_service_provider_request', \{/);
    expect(block).toMatch(/status === 'approved' \? 'service_provider_kyc_approve' : 'service_provider_kyc_reject'/);
  });

  it('AdminProviderDetail.tsx routes the decision through submitOrExecute the same way', () => {
    const block = providerDetailSrc.match(/const decide = async[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(block).toMatch(/await submitOrExecute\(isSuperAdmin, actionType,/);
    expect(block).toMatch(/supabase\.rpc\('admin_decide_service_provider_request' as any, \{/);
    expect(block).toMatch(/status === 'approved' \? 'service_provider_kyc_approve' : 'service_provider_kyc_reject'/);
  });

  it('shared submitOrExecute helper: Super Admin path calls execute() directly, no request_admin_action call', () => {
    const fn = sharedActionsSrc.match(/export async function submitOrExecute\([\s\S]*?\n\}/)?.[0] ?? '';
    const superAdminBranch = fn.match(/if \(isSuperAdmin\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(superAdminBranch).toMatch(/await execute\(\);/);
    expect(superAdminBranch).not.toMatch(/request_admin_action/);
  });
});

describe('call sites: Sub-Admin never calls admin_decide_service_provider_request directly — it goes through request_admin_action', () => {
  it('the shared submitOrExecute helper only calls request_admin_action on the non-Super-Admin path', () => {
    const fn = sharedActionsSrc.match(/export async function submitOrExecute\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/supabase\.rpc\('request_admin_action' as any, \{/);
    // The request_admin_action call must be reached only after the
    // `if (isSuperAdmin) { ...; return; }` branch, i.e. only for Sub-Admins.
    const superAdminReturnIdx = fn.indexOf('return { ok: true, message: \'Done.\' };');
    const requestCallIdx = fn.indexOf("supabase.rpc('request_admin_action'");
    expect(superAdminReturnIdx).toBeGreaterThan(-1);
    expect(requestCallIdx).toBeGreaterThan(superAdminReturnIdx);
  });

  it('AdminDashboardScreen.tsx never calls admin_decide_service_provider_request outside the submitOrExecute-wrapped execute callback', () => {
    const rpcCalls = [...adminDashboardSrc.matchAll(/supabase\.rpc\('admin_decide_service_provider_request'/g)];
    expect(rpcCalls.length).toBe(1);
  });

  it('AdminProviderDetail.tsx never calls admin_decide_service_provider_request outside the submitOrExecute-wrapped execute callback', () => {
    const rpcCalls = [...providerDetailSrc.matchAll(/supabase\.rpc\('admin_decide_service_provider_request'/g)];
    expect(rpcCalls.length).toBe(1);
  });
});

describe('call sites: Sub-Admin can submit an approval/rejection request with the correct action type and payload', () => {
  it('AdminDashboardScreen.tsx passes request_id + reason in the payload for both action types', () => {
    const block = adminDashboardSrc.match(/const reviewSpRequest = async[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(block).toMatch(/payload: \{ request_id: id, reason: adminNote \|\| null \}/);
    expect(block).toMatch(/target_type: 'service_provider_request'/);
  });

  it('AdminProviderDetail.tsx passes request_id + reason in the payload for both action types', () => {
    const block = providerDetailSrc.match(/const decide = async[\s\S]*?\n  \};/)?.[0] ?? '';
    expect(block).toMatch(/payload: \{ request_id: request\.id, reason: adminNote \}/);
    expect(block).toMatch(/target_type: 'service_provider_request'/);
  });
});

describe('AdminActionsTab: pending provider-KYC requests display with a description', () => {
  it('describe() has entries for both new action types', () => {
    expect(actionsTabSrc).toMatch(/service_provider_kyc_approve: `\$\{who\} requested to APPROVE service provider application/);
    expect(actionsTabSrc).toMatch(/service_provider_kyc_reject: `\$\{who\} requested to REJECT service provider application/);
  });

  it('the generic approve/reject controls and detail modal apply to every pending row regardless of action_type (no per-type gating needed)', () => {
    expect(actionsTabSrc).toMatch(/isSuperAdmin && r\.status === 'pending'/);
    expect(actionsTabSrc).toMatch(/supabase\.rpc\('approve_admin_action' as any, \{ p_request_id: r\.id \}\)/);
    expect(actionsTabSrc).toMatch(/supabase\.rpc\('reject_admin_action' as any, \{/);
  });
});

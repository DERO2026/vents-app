import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit findings F15/F16 (MASTER_AUDIT.md) -- static-analysis test for
// 0170_drop_legacy_vc_rpc_overloads_and_harden_anon_grants.sql. NOT YET
// APPLIED TO PRODUCTION; this suite verifies the drafted SQL text itself,
// not live database behavior (same approach as every other
// *.security.test.ts in this repo with no live Postgres connection).
//
// No test file existed for this migration before this one -- confirmed by
// grepping src/ for "0170_drop_legacy" with zero results. A prior audit
// note (MASTER_AUDIT.md's F16 entry) said this fix was "included in the
// same drafted migration (0164) as F15" -- that is INCORRECT: 0164 is an
// unrelated cost/performance-index migration (trigram + partial indexes for
// search_services_fuzzy/get_nearby_service_providers) with zero VC-related
// content at all, confirmed by reading 0164 in full. The real F15/F16 fix
// lives in 0170, whose own filename and header comment say so correctly --
// only the cross-reference in MASTER_AUDIT.md's F16 row was stale/wrong.

let sql: string;

beforeAll(() => {
  sql = readFileSync(
    join(__dirname, '../../supabase/migrations/0170_drop_legacy_vc_rpc_overloads_and_harden_anon_grants.sql'),
    'utf8'
  );
});

describe('F15: approve_admin_action() repoints credit/debit_vents_cents at the pool-safe signatures', () => {
  it('credit_vents_cents branch calls the 5-arg signature with p_counts_toward_lifetime=false and the request id as idempotency key', () => {
    expect(sql).toMatch(
      /WHEN 'credit_vents_cents'\s+THEN PERFORM public\.admin_credit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::numeric, r\.payload->>'reason', false, r\.id\);/
    );
  });

  it('debit_vents_cents branch calls the 4-arg signature with the request id as idempotency key', () => {
    expect(sql).toMatch(
      /WHEN 'debit_vents_cents'\s+THEN PERFORM public\.admin_debit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::integer, r\.payload->>'reason', r\.id\);/
    );
  });

  it('drops both old pool-bypassing 3-arg overloads after repointing the executor, never before', () => {
    const replaceIdx = sql.indexOf('CREATE OR REPLACE FUNCTION public.approve_admin_action');
    const dropCreditIdx = sql.indexOf('DROP FUNCTION IF EXISTS public.admin_credit_vents_cents(uuid, numeric, text);');
    const dropDebitIdx = sql.indexOf('DROP FUNCTION IF EXISTS public.admin_debit_vents_cents(uuid, integer, text);');
    expect(replaceIdx).toBeGreaterThan(-1);
    expect(dropCreditIdx).toBeGreaterThan(replaceIdx);
    expect(dropDebitIdx).toBeGreaterThan(replaceIdx);
  });

  it('preserves every other action_type branch unchanged (this is a targeted repoint, not a rewrite)', () => {
    for (const branch of [
      'organizer_verification_approve', 'organizer_verification_reject', 'hide_event', 'reinstate_event',
      'soft_delete_event', 'restore_deleted_event', 'restore_event', 'set_user_role', 'suspend_user',
      'unsuspend_user', 'soft_delete_user', 'reinstate_user', 'toggle_user_verified', 'approve_payout',
      'reject_payout', 'cancel_payout', 'toggle_event_featured', 'decide_organizer_request',
      'decide_service_provider_request',
    ]) {
      expect(sql).toContain(`WHEN '${branch}'`);
    }
  });

  it('still requires is_super_admin() and blocks self-approval, unchanged from the live function', () => {
    expect(sql).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(sql).toMatch(/IF r\.requested_by = auth\.uid\(\) THEN\s*\n\s*RAISE EXCEPTION 'Cannot approve your own request';/);
  });
});

describe('F16: anon EXECUTE revoked on the newer VC-economy RPCs', () => {
  it('revokes anon on admin_debit_vents_cents (4-arg), admin_get_user_vc_summary, and admin_get_vc_pool_status', () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.admin_debit_vents_cents\(uuid, integer, text, uuid\) FROM anon;/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.admin_get_user_vc_summary\(uuid\) FROM anon;/);
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.admin_get_vc_pool_status\(\) FROM anon;/);
  });

  it('does NOT touch authenticated or project_admin', () => {
    const revokeLines = sql.split('\n').filter((l) => l.includes('REVOKE EXECUTE'));
    for (const line of revokeLines) {
      expect(line).not.toMatch(/FROM (authenticated|project_admin)/);
    }
  });

  // KNOWN GAP, deliberately left failing rather than loosened to pass:
  // live has_function_privilege('anon', admin_credit_vents_cents(uuid,
  // numeric, text, boolean, uuid), 'EXECUTE') is also currently TRUE
  // (confirmed live, 2026-10-14, Release-Critical Audit 3) -- a fourth
  // anon-executable VC RPC this draft does not revoke. F16's own
  // MASTER_AUDIT.md text says "the 3 confirmed functions", but a live
  // re-check during this audit found a 4th. This test documents the gap
  // rather than silently expecting it, so fixing the migration (adding the
  // missing REVOKE line) is what turns this red, not a definition of done
  // that's already satisfied.
  it.fails('[KNOWN GAP] does not yet revoke anon on the 5-arg admin_credit_vents_cents, which is also anon-executable live', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.admin_credit_vents_cents\(uuid, numeric, text, boolean, uuid\) FROM anon;/
    );
  });
});

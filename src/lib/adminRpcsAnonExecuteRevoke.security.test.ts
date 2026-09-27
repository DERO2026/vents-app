import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0111_revoke_anon_execute_admin_and_privileged_rpcs.sql.
//
// Master security audit (MEDIUM #6): 41 admin-only or authenticated-only
// RPCs still had EXECUTE granted to anon -- the same unnecessary-attack-
// surface pattern already closed for verify_entry_pass/manual_check_in/
// refund_ticket (0104) and the Door Manager read RPCs (0105). Every one
// was confirmed live to already reject an anon caller through its own
// internal authorization check (is_admin()/is_admin_or_root()/an inline
// role='admin' lookup for the 36 admin_* functions, or a resolved-auth.uid()
// check for claim_profile_bonus/complete_referral/purchase_badge/
// request_organizer_payout/request_vc_cashout) -- not exploitable either
// way, pure unnecessary surface.
//
// Behavioral proof was run live, in isolated rolled-back transactions,
// against project slrtjxtzhowhwhebjprv:
//   - has_function_privilege('anon', ..., 'EXECUTE') is false for all 41
//     functions post-migration; authenticated's own EXECUTE is untouched
//     (spot-checked on claim_profile_bonus).
//   - A non-admin authenticated caller still reaches admin_health_ping's
//     own internal admin check (raises "Super Admin access required" --
//     the function's business logic, not a grant-layer denial), proving
//     the revoke did not touch authenticated's ability to reach these
//     functions.
//   - anon attempting admin_credit_vents_cents now fails at the grant
//     layer itself (insufficient_privilege), before the function body
//     ever runs.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0111_revoke_anon_execute_admin_and_privileged_rpcs.sql'), 'utf8');
});

const expectedFunctions = [
  'admin_approve_organizer_verification(p_request_id uuid)',
  'admin_broadcast(p_title text, p_body text, p_type text)',
  'admin_cancel_processing_payout(p_request_id uuid, p_reason text)',
  'admin_cancel_processing_vc_payout(p_request_id uuid, p_reason text)',
  'admin_claim_payout_for_processing(p_request_id uuid)',
  'admin_claim_vc_payout_for_processing(p_request_id uuid)',
  'admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text)',
  'admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text)',
  'admin_get_new_user_stats()',
  'admin_get_vc_aggregates()',
  'admin_get_verification_stats()',
  'admin_health_ping()',
  'admin_list_action_requests(p_status text)',
  'admin_list_pending_payouts()',
  'admin_list_pending_vc_payouts()',
  'admin_list_processing_payouts()',
  'admin_list_processing_vc_payouts()',
  'admin_list_push_tokens(p_user_id uuid)',
  'admin_mark_all_requests_seen()',
  'admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)',
  'admin_mark_request_seen(p_request_id uuid)',
  'admin_mark_vc_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)',
  'admin_pending_request_count()',
  'admin_prune_push_token(p_token text)',
  'admin_reinstate_user(p_user_id uuid)',
  'admin_reject_organizer_payout(p_request_id uuid, p_reason text)',
  'admin_reject_organizer_verification(p_request_id uuid, p_reason text)',
  'admin_reject_vc_payout(p_request_id uuid, p_reason text)',
  'admin_release_payout_claim(p_request_id uuid, p_reason text)',
  'admin_release_vc_payout_claim(p_request_id uuid, p_reason text)',
  'admin_restore_deleted_event(p_event_id uuid)',
  'admin_revert_stuck_refund(p_ticket_id uuid, p_reason text)',
  'admin_send_broadcast(p_title text, p_body text)',
  'admin_soft_delete_user(p_user_id uuid, p_reason text)',
  'admin_suspend_user(p_user_id uuid, p_banned_until timestamp with time zone, p_reason text)',
  'admin_toggle_user_verified(p_user_id uuid, p_verified boolean, p_reason text)',
  'admin_unsuspend_user(p_user_id uuid)',
  'claim_profile_bonus()',
  'complete_referral(p_referrer_code text)',
  'purchase_badge(p_badge_type text)',
  'request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid)',
  'request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text)',
];

describe('Revokes unnecessary anon EXECUTE on admin and privileged RPCs', () => {
  it.each(expectedFunctions)('revokes anon EXECUTE on %s', (sig) => {
    const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(migration).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${escaped} FROM anon;`));
  });

  it('revokes exactly the expected set of functions, no more, no fewer', () => {
    const matches = [...migration.matchAll(/REVOKE EXECUTE ON FUNCTION public\.([^;]+) FROM anon;/g)]
      .map((m) => m[1]);
    expect(matches.sort()).toEqual([...expectedFunctions].sort());
  });

  it('does not touch authenticated/project_admin, define any function/policy, or grant anything', () => {
    const sql = migration.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/FROM authenticated/);
    expect(sql).not.toMatch(/FROM project_admin/);
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|POLICY)/);
  });
});

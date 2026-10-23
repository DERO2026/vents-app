import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0187_fix_payout_reject_cancel_toctou_race.sql
// (NOT YET APPLIED TO PRODUCTION -- drafted for review).
//
// The bug: admin_reject_organizer_payout and admin_cancel_processing_payout
// (both last defined, pre-fix, in 0124_emergency_kill_switches.sql, and
// confirmed live in production via pg_get_functiondef) each read the
// request's current status with a plain, unlocked SELECT, check it in
// application logic, then perform a SEPARATE UPDATE that is NOT
// reconditioned on that status. Two concurrent calls for the same
// request_id can both read the same pre-write status, both pass the
// check, and both execute the wallet-refund UPDATE -- double-crediting
// the organizer's wallet for one rejected or cancelled withdrawal
// request. 0187 closes this by moving the status check INTO the UPDATE's
// WHERE clause, the same atomic-claim pattern admin_claim_payout_for_
// processing (the Approve path) already uses correctly.
//
// A second, read-only audit of this migration's first draft found two
// discrepancies against the live bodies, both fixed in the current
// version this file tests: an undocumented new reason-required check
// added to admin_reject_organizer_payout (live doesn't have one; removed
// to keep the migration scoped to only the race fix), and a lost
// current-status detail in admin_cancel_processing_payout's "wrong
// status" error message (restored via a post-failure, non-gating read).

let preFix: string; // 0124_emergency_kill_switches.sql -- last known-good source matching live pre-fix bodies
let fix: string; // 0187_fix_payout_reject_cancel_toctou_race.sql

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  preFix = readFileSync(join(dir, '0124_emergency_kill_switches.sql'), 'utf8');
  fix = readFileSync(join(dir, '0187_fix_payout_reject_cancel_toctou_race.sql'), 'utf8');
});

function fnIn(src: string, name: string): string {
  return src.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$function\\$\\s*;`))?.[0] ?? '';
}

describe('0187: confirms the race existed pre-fix (0124, matches live production)', () => {
  it('admin_reject_organizer_payout: unlocked SELECT followed by an UPDATE not reconditioned on status', () => {
    const fn = fnIn(preFix, 'admin_reject_organizer_payout');
    expect(fn).not.toBe('');
    expect(fn).toMatch(/SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status\s*\n\s*FROM public\.organizer_withdrawal_requests WHERE id = p_request_id;/);
    expect(fn).toMatch(/UPDATE public\.organizer_withdrawal_requests\s*\n\s*SET status = 'rejected'.*\n\s*WHERE id = p_request_id;/);
  });

  it('admin_cancel_processing_payout: unlocked SELECT followed by an UPDATE not reconditioned on status', () => {
    const fn = fnIn(preFix, 'admin_cancel_processing_payout');
    expect(fn).not.toBe('');
    expect(fn).toMatch(/SELECT r\.organizer_id, r\.amount_kobo, r\.status\s*\n\s*INTO v_organizer_id, v_amount_kobo, v_status/);
    expect(fn).toMatch(/UPDATE public\.organizer_withdrawal_requests\s*\n\s*SET status = 'cancelled'.*\n\s*WHERE id = p_request_id;/);
  });
});

describe('0187: atomic-claim fix, matching admin_claim_payout_for_processing\'s proven pattern', () => {
  it('admin_claim_payout_for_processing (the reference pattern) is unchanged: status check lives in the UPDATE\'s WHERE clause', () => {
    const fn = fnIn(preFix, 'admin_claim_payout_for_processing');
    expect(fn).toMatch(/WHERE id = p_request_id AND public\.organizer_withdrawal_requests\.status = 'pending'\s*\n\s*RETURNING id INTO v_claimed_id;/);
  });

  it('admin_reject_organizer_payout: status check moved into the UPDATE\'s WHERE clause, no prior unlocked SELECT', () => {
    const fn = fnIn(fix, 'admin_reject_organizer_payout');
    expect(fn).not.toBe('');
    expect(fn).not.toMatch(/SELECT organizer_id, amount_kobo, status INTO/);
    expect(fn).toMatch(/UPDATE public\.organizer_withdrawal_requests\s*\n\s*SET status = 'rejected', admin_note = p_reason, resolved_by = auth\.uid\(\), updated_at = now\(\)\s*\n\s*WHERE id = p_request_id AND status = 'pending'\s*\n\s*RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;/);
  });

  it('admin_cancel_processing_payout: status check moved into the UPDATE\'s WHERE clause, no prior unlocked SELECT', () => {
    const fn = fnIn(fix, 'admin_cancel_processing_payout');
    expect(fn).not.toBe('');
    expect(fn).not.toMatch(/SELECT r\.organizer_id, r\.amount_kobo, r\.status\s*\n\s*INTO v_organizer_id, v_amount_kobo, v_status/);
    expect(fn).toMatch(/UPDATE public\.organizer_withdrawal_requests\s*\n\s*SET status = 'cancelled', admin_note = p_reason, resolved_by = auth\.uid\(\), updated_at = now\(\)\s*\n\s*WHERE id = p_request_id AND status = 'processing'\s*\n\s*RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;/);
  });

  it('neither fixed function performs a wallet-refund UPDATE except after its own atomic claim succeeded (claim, then refund, in that order)', () => {
    const rejectFn = fnIn(fix, 'admin_reject_organizer_payout');
    const cancelFn = fnIn(fix, 'admin_cancel_processing_payout');
    for (const fn of [rejectFn, cancelFn]) {
      const claimIdx = fn.search(/RETURNING organizer_id, amount_kobo INTO/);
      const refundIdx = fn.search(/UPDATE public\.organizer_wallets/);
      expect(claimIdx).toBeGreaterThan(-1);
      expect(refundIdx).toBeGreaterThan(claimIdx);
    }
  });
});

describe('0187: second-audit corrections -- no undisclosed reason-check addition, current-status detail restored', () => {
  it('admin_reject_organizer_payout does NOT add a reason-required check the live function never had', () => {
    const fn = fnIn(fix, 'admin_reject_organizer_payout');
    expect(fn).not.toMatch(/A rejection reason is required/);
  });

  it('admin_cancel_processing_payout still requires a reason, unchanged from live', () => {
    const fn = fnIn(fix, 'admin_cancel_processing_payout');
    expect(fn).toMatch(/IF p_reason IS NULL OR trim\(p_reason\) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;/);
  });

  it('admin_cancel_processing_payout restores the live function\'s specific current-status detail in its "wrong status" error, via a read that happens strictly after the atomic claim has already failed (not a gate on the claim itself)', () => {
    const fn = fnIn(fix, 'admin_cancel_processing_payout');
    const returningIdx = fn.search(/RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;/);
    const statusReadIdx = fn.search(/SELECT r\.status INTO v_current_status FROM public\.organizer_withdrawal_requests r WHERE r\.id = p_request_id;/);
    const raiseIdx = fn.search(/RAISE EXCEPTION 'Only requests in Processing status can be cancelled \(current status: %\)', v_current_status;/);
    expect(returningIdx).toBeGreaterThan(-1);
    expect(statusReadIdx).toBeGreaterThan(returningIdx);
    expect(raiseIdx).toBeGreaterThan(statusReadIdx);
  });
});

describe('0187: authorization, kill switch, refund arithmetic, audit logging and return shape are all preserved', () => {
  it('both functions keep is_admin_or_root() and the payouts_disabled() kill switch, unchanged', () => {
    for (const name of ['admin_reject_organizer_payout', 'admin_cancel_processing_payout']) {
      const fn = fnIn(fix, name);
      expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION 'Super Admin access required'; END IF;/);
      expect(fn).toMatch(/IF public\.payouts_disabled\(\) THEN\s*\n\s*RAISE EXCEPTION 'payouts_disabled';\s*\n\s*END IF;/);
    }
  });

  it('both functions keep the identical wallet refund arithmetic', () => {
    for (const name of ['admin_reject_organizer_payout', 'admin_cancel_processing_payout']) {
      const fn = fnIn(fix, name);
      expect(fn).toMatch(/balance_kobo = balance_kobo \+ v_amount_kobo,?\s*\n?\s*pending_kobo = GREATEST\(0, pending_kobo - v_amount_kobo\)/);
    }
  });

  it('admin_reject_organizer_payout keeps its admin_logs insert and "rejected" return value', () => {
    const fn = fnIn(fix, 'admin_reject_organizer_payout');
    expect(fn).toMatch(/INSERT INTO public\.admin_logs \(admin_id, action, target_user_id, details, actor_role\)\s*\n\s*VALUES \(auth\.uid\(\), 'reject_payout_request'/);
    expect(fn).toMatch(/RETURN 'rejected';/);
    expect(fn).toMatch(/RETURNS text/);
  });

  it('admin_cancel_processing_payout keeps its organizer_transactions insert, admin_logs insert, and RETURN QUERY shape', () => {
    const fn = fnIn(fix, 'admin_cancel_processing_payout');
    expect(fn).toMatch(/INSERT INTO public\.organizer_transactions \(organizer_id, type, amount_kobo, description, withdrawal_request_id\)\s*\n\s*VALUES \(v_organizer_id, 'cancelled_payout_refund'/);
    expect(fn).toMatch(/INSERT INTO public\.admin_logs \(admin_id, action, target_user_id, details, actor_role\)\s*\n\s*VALUES \(auth\.uid\(\), 'cancel_processing_payout'/);
    expect(fn).toMatch(/RETURN QUERY\s*\n\s*SELECT 'cancelled'::text, u\.email, u\.full_name, v_amount_kobo\s*\n\s*FROM public\.users u WHERE u\.id = v_organizer_id;/);
    expect(fn).toMatch(/RETURNS TABLE\(status text, organizer_email text, organizer_name text, amount_kobo bigint\)/);
  });

  it('neither function\'s signature changed', () => {
    expect(fnIn(fix, 'admin_reject_organizer_payout')).toMatch(/admin_reject_organizer_payout\(p_request_id uuid, p_reason text\)/);
    expect(fnIn(fix, 'admin_cancel_processing_payout')).toMatch(/admin_cancel_processing_payout\(p_request_id uuid, p_reason text\)/);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for three critical defects found during a financial/
// accounting audit of the organizer/provider earnings withdrawal path
// (0076_fix_withdrawal_rls_hole_and_payout_ambiguity_bugs.sql). All three
// were confirmed against real, live Production function/policy
// definitions -- not hypothesized -- and the RLS defect was confirmed
// exploitable using a real, non-superuser Postgres role with RLS actually
// enforced (not a mocked or superuser-bypassed check). The third defect
// was found only during this migration's own final pre-deployment gate,
// after an earlier /code-review pass incorrectly cleared it.

let m0076: string;
let m0008: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0076 = readFileSync(join(dir, '0076_fix_withdrawal_rls_hole_and_payout_ambiguity_bugs.sql'), 'utf8');
  m0008 = readFileSync(join(dir, '0008_rls_and_policies.sql'), 'utf8');
});

describe('Defect 1 (critical): client-writable INSERT policy on organizer_withdrawal_requests', () => {
  it('the original policy existed in 0008 -- confirms this was a real, shipped hole, not a hypothetical', () => {
    expect(m0008).toMatch(/CREATE POLICY org_withdraw_own_insert ON organizer_withdrawal_requests FOR INSERT TO authenticated WITH CHECK \(\(\( SELECT auth\.uid\(\) AS uid\) = organizer_id\)\);/);
  });

  it('0076 drops it, and does not replace it with any other client INSERT policy on this table', () => {
    expect(m0076).toMatch(/DROP POLICY IF EXISTS org_withdraw_own_insert ON public\.organizer_withdrawal_requests;/);
    expect(m0076).not.toMatch(/CREATE POLICY[^;]*organizer_withdrawal_requests[^;]*FOR INSERT/);
  });

  it('request_organizer_payout (the legitimate path) is SECURITY DEFINER, so it does not need or use this policy to perform its own INSERT', () => {
    const m0004 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0004_functions.sql'), 'utf8');
    const fn = m0004.match(/CREATE OR REPLACE FUNCTION public\.request_organizer_payout[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/INSERT INTO public\.organizer_withdrawal_requests/);
  });

  it('no frontend/backend code performs a direct table INSERT into organizer_withdrawal_requests (only request_organizer_payout does)', () => {
    const walletScreen = readFileSync(join(__dirname, '..', 'app', 'components', 'WalletScreen.tsx'), 'utf8');
    expect(walletScreen).toMatch(/supabase\.rpc\('request_organizer_payout'/);
    expect(walletScreen).not.toMatch(/\.from\('organizer_withdrawal_requests'\)\s*\.insert/);
  });
});

describe('Defect 2 (critical, live in Production): fail_organizer_payout ambiguous-column bug', () => {
  function fixedFn(): string {
    return m0076.match(/CREATE OR REPLACE FUNCTION public\.fail_organizer_payout[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
  }

  it('the fixed function qualifies every organizer_withdrawal_requests column with the r alias in its initial SELECT INTO, avoiding the RETURNS TABLE OUT-parameter collision', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/SELECT r\.id, r\.organizer_id, r\.amount_kobo, r\.status\s*\n\s*INTO v_id, v_organizer_id, v_amount_kobo, v_status\s*\n\s*FROM public\.organizer_withdrawal_requests r/);
  });

  it('preserves the exact-row-id match (not amount/status) that avoids matching a sibling request, unchanged from the original', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/WHERE r\.id::text = p_request_id OR r\.transfer_code = p_request_id OR r\.paystack_reference = p_request_id/);
  });

  it('preserves idempotency: already-finalized statuses short-circuit before any write, and the conditional UPDATE + ROW_COUNT check catches a concurrent/replayed finalize', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/IF v_status IN \('completed', 'failed', 'rejected'\) THEN\s*\n\s*RETURN QUERY SELECT 'already_finalized'/);
    expect(fn).toMatch(/WHERE id = v_id AND public\.organizer_withdrawal_requests\.status IN \('pending', 'processing'\);/);
    expect(fn).toMatch(/GET DIAGNOSTICS v_rows = ROW_COUNT;\s*\n\s*IF v_rows = 0 THEN\s*\n\s*RETURN QUERY SELECT 'already_finalized'/);
  });

  it('preserves the fund-restoration logic: balance_kobo is credited back, pending_kobo clamped at 0, no other columns touched', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/SET balance_kobo = balance_kobo \+ v_amount_kobo,\s*\n\s*pending_kobo = GREATEST\(0, pending_kobo - v_amount_kobo\),/);
  });
});

describe('Defect 3 (critical, live in Production, found during 0076\'s own final pre-deployment gate): admin_cancel_processing_payout has the identical ambiguous-column bug', () => {
  function fixedFn(): string {
    return m0076.match(/CREATE OR REPLACE FUNCTION public\.admin_cancel_processing_payout[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
  }

  it('qualifies every organizer_withdrawal_requests column with the r alias, avoiding the same RETURNS TABLE OUT-parameter collision as Defect 2', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/SELECT r\.organizer_id, r\.amount_kobo, r\.status\s*\n\s*INTO v_organizer_id, v_amount_kobo, v_status\s*\n\s*FROM public\.organizer_withdrawal_requests r\s*\n\s*WHERE r\.id = p_request_id;/);
  });

  it('preserves admin-only authorization and the disable_payouts kill switch, unchanged', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION 'Super Admin access required'; END IF;/);
    expect(fn).toMatch(/IF \(SELECT disable_payouts FROM public\.app_config LIMIT 1\) THEN\s*\n\s*RAISE EXCEPTION 'payouts_disabled';/);
  });

  it('preserves the pre-existing exception-based rejection of an already-finalized request (its own idempotency style, unlike its two siblings) -- unchanged, since it was not itself broken', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled \(current status: %\)', v_status; END IF;/);
  });

  it('preserves the fund-restoration logic identically to Defect 2\'s fix', () => {
    const fn = fixedFn();
    expect(fn).toMatch(/SET balance_kobo = balance_kobo \+ v_amount_kobo,\s*\n\s*pending_kobo = GREATEST\(0, pending_kobo - v_amount_kobo\),/);
  });

  it('records the migration\'s own admission that an earlier /code-review pass on this file incorrectly cleared this function', () => {
    expect(m0076).toMatch(/incorrectly\s*\n?\s*-- cleared admin_cancel_processing_payout/);
  });
});

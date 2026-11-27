import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Batch 1 (2026-11-27): financial integrity and access hardening.
// Behaviour is proven on a real PostgreSQL by the local suites named below
// (with concurrency, mutation/baseline and undo checks); these static guards
// keep the essential properties in CI, which does not run those suites.
//
//   AZ-09  run-payout-reject-concurrency-verification.sh (no migration: the
//          live reject is already atomic; 0187 must never be applied)
//   AZ-08  0233 + run-transfer-fee-attempts-verification.sh
//   AZ-10  0234 + run-payment-exception-refund-verification.sh
//   AZ-32, AZ-16, AZ-33  0235-0237 + run-access-hardening-verification.sh

const root = join(__dirname, '..', '..');
const mig = (f: string) => readFileSync(join(root, 'supabase', 'migrations', f), 'utf8');
const undo = (n: string) => readFileSync(join(root, 'supabase', 'rollback', `undo_${n}.sql`), 'utf8');
const suite = (f: string) => existsSync(join(root, 'scripts', 'local-pg-test', f));

describe('AZ-09: payout rejection stays atomic', () => {
  it('the captured production reject claims the row in one statement (status check inside the UPDATE)', () => {
    const live = readFileSync(join(root, 'scripts', 'local-pg-test', 'schema-live-payout-extras.sql'), 'utf8');
    const body = live.slice(live.indexOf('FUNCTION public.admin_reject_organizer_payout'));
    expect(body).toMatch(/UPDATE public\.organizer_withdrawal_requests[\s\S]*?WHERE id = p_request_id AND status = 'pending'\s*RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;/);
  });
  it('no migration after 0187 redefines reject (it must not be overwritten with the old unlocked body)', () => {
    for (const f of ['0233_transfer_fee_payment_attempts.sql', '0234_payment_exception_two_admin_refund.sql', '0235_revoke_boost_event_vc.sql',
      '0236_event_read_privacy.sql', '0237_organizer_review_attendance.sql']) {
      expect(mig(f)).not.toMatch(/FUNCTION public\.admin_reject_organizer_payout/);
    }
  });
  it('has a concurrency suite with a mutation check', () => {
    expect(suite('run-payout-reject-concurrency-verification.sh')).toBe(true);
    expect(readFileSync(join(root, 'scripts', 'local-pg-test', 'run-payout-reject-concurrency-verification.sh'), 'utf8')).toMatch(/MUTATION DETECTED/);
  });
});

describe('AZ-08 (0233): every transfer-fee attempt is kept', () => {
  let m: string; beforeAll(() => { m = mig('0233_transfer_fee_payment_attempts.sql'); });
  it('records each attempt and resolves confirmations through the attempt', () => {
    expect(m).toContain('INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id)');
    expect(m).toMatch(/SELECT a\.transfer_id INTO v_transfer_id FROM public\.ticket_transfer_fee_attempts a WHERE a\.reference = p_reference/);
  });
  it('a second payment is recorded as a payment exception, never re-applied and never auto-refunded', () => {
    expect(m).toContain("'duplicate_payment'");
    expect(m).toContain("RETURN 'duplicate_payment';");
    const dup = m.slice(m.indexOf("RETURN 'duplicate_payment';") - 800, m.indexOf("RETURN 'duplicate_payment';"));
    expect(dup).not.toMatch(/fee_refund_needed_at = now\(\)/);
    expect(dup).not.toMatch(/UPDATE public\.tickets/);
  });
  it('refuses drift and a second run; gated undo refuses while money records exist', () => {
    expect(m).toContain('refusing to run twice');
    expect(m).toContain('is not the expected version');
    expect(undo('0233')).toContain("'undo-0233'");
    expect(undo('0233')).toContain('resolve them before undoing');
  });
  it('has a database suite', () => { expect(suite('run-transfer-fee-attempts-verification.sh')).toBe(true); });
});

describe('AZ-10 (0234): payments captured without a ticket are refunded only with two admins', () => {
  let m: string; beforeAll(() => { m = mig('0234_payment_exception_two_admin_refund.sql'); });
  it('goes through the maker-checker and the approver must differ from the requester', () => {
    expect(m).toContain("public.request_admin_action('refund_payment_exception'");
    expect(m).toContain("RAISE EXCEPTION 'Cannot approve your own request'");
    expect(m).toContain('payment_exceptions_refund_parties_ck');
  });
  it('binds the approval to the same reference, amount and reason, never above what was captured', () => {
    expect(m).toMatch(/r\.payload->>'reference' IS DISTINCT FROM x\.reference/);
    expect(m).toMatch(/\(r\.payload->>'amount_kobo'\)::bigint IS DISTINCT FROM x\.refund_amount_kobo/);
    expect(m).toMatch(/r\.payload->>'reason' IS DISTINCT FROM x\.refund_reason/);
    expect(m).toContain('refund_amount_kobo <= amount_kobo');
  });
  it('nothing can be sent to Paystack before approval, and it is claimed exactly once', () => {
    expect(m).toContain("RAISE EXCEPTION 'This refund has not been approved by two admins'");
    expect(m).toContain("RAISE EXCEPTION 'This refund was already sent to Paystack'");
  });
  it('webhook completion is server-only', () => {
    expect(m).toMatch(/GRANT EXECUTE ON FUNCTION public\.finalize_payment_exception_refund\(text\) TO project_admin;/);
    expect(m).not.toMatch(/finalize_payment_exception_refund\(text\) TO (authenticated|anon)/);
  });
  it('the withdrawal policy is untouched (Super Admin + PIN, 0213)', () => {
    expect(m).not.toMatch(/admin_approve_withdrawal_for_payment|admin_authorize_and_claim_payout|organizer_withdrawal_requests/);
  });
  it('has a gated undo and a database suite', () => {
    expect(undo('0234')).toContain("'undo-0234'");
    expect(undo('0234')).toContain('approved or in flight');
    expect(suite('run-payment-exception-refund-verification.sh')).toBe(true);
  });
});

describe('0238: transfer-fee refunds need two admins (owner decision 2026-11-27)', () => {
  let m: string; beforeAll(() => { m = mig('0238_transfer_fee_refunds_two_admin.sql'); });
  it('the confirm function never claims an automatic refund any more; it queues a payment exception', () => {
    const confirm = m.slice(m.indexOf('CREATE OR REPLACE FUNCTION public.confirm_transfer_fee_payment('), m.indexOf('-- ── 3.'));
    expect(confirm).not.toContain(':refund_claimed');
    expect(confirm.match(/':refund_queued'/g)?.length).toBe(4);
    expect(confirm.match(/'transfer_not_completed'/g)?.length).toBe(4);
    expect(confirm).not.toMatch(/fee_refund_status = 'needed'/);
  });
  it('the webhook never refunds a transfer fee automatically (two admins, 2026-11-27); a queued answer is never "claimed"', () => {
    const hook = readFileSync(join(root, 'api', 'webhook', 'paystack.ts'), 'utf8');
    expect(hook).toMatch(/if \(raw\.endsWith\(':refund_queued'\)\) return \{ \.\.\.none, feeStatus: [^}]*refundQueued: true \}/);
    expect(hook).not.toMatch(/attemptTransferFeeRefund|attach_transfer_fee_refund_id|mark_transfer_fee_refund_initiation_failed/);
  });
  it('refunds already in flight are left alone; owed ones are backfilled; gated undo; suite exists', () => {
    expect(m).toMatch(/t\.fee_refund_status = 'needed' AND t\.fee_refund_id IS NULL\) OR t\.fee_refund_status = 'failed'/);
    expect(undo('0238')).toContain("'undo-0238'");
    expect(suite('run-transfer-fee-refund-two-admin-verification.sh')).toBe(true);
  });
});

describe('AZ-32 / AZ-16 / AZ-33 (0235-0237): least privilege', () => {
  it('0235 revokes boost_event_vc from anon and signed-in users', () => {
    expect(mig('0235_revoke_boost_event_vc.sql')).toMatch(/REVOKE ALL ON FUNCTION public\.boost_event_vc\(uuid\) FROM PUBLIC, anon, authenticated;/);
  });
  it('0236: the public sees only non-deleted, non-draft, non-hidden events; owners, admins and ticket holders keep access', () => {
    const m = mig('0236_event_read_privacy.sql');
    expect(m).toContain("(deleted_at IS NULL AND status <> 'draft' AND NOT hidden_by_admin)");
    expect(m).toContain('(organizer_id = (SELECT auth.uid() AS uid))');
    expect(m).toContain('OR public.is_admin()');
    expect(m).toContain('public.user_holds_ticket_for_event(id)');
    expect(m).toContain('STABLE SECURITY DEFINER');
  });
  it('0237: reviews need an active, paid, checked-in ticket; no self-reviews', () => {
    const m = mig('0237_organizer_review_attendance.sql');
    expect(m).toContain("t.status = 'active'");
    expect(m).toContain("t.payment_status = 'paid'");
    expect(m).toContain('t.checked_in');
    expect(m).toContain('reviewer_id <> organizer_id');
  });
  it('each has a gated undo and the database suite exists', () => {
    for (const n of ['0235', '0236', '0237']) expect(undo(n)).toContain(`'undo-${n}'`);
    expect(suite('run-access-hardening-verification.sh')).toBe(true);
  });
});

describe('confirmed financial policies are unchanged by Batch 1', () => {
  const batch = ['0233_transfer_fee_payment_attempts.sql', '0234_payment_exception_two_admin_refund.sql', '0235_revoke_boost_event_vc.sql',
    '0236_event_read_privacy.sql', '0237_organizer_review_attendance.sql', '0238_transfer_fee_refunds_two_admin.sql'];
  it('no fee, settlement-hold or withdrawal-approval function is redefined', () => {
    for (const f of batch) {
      const m = mig(f);
      expect(m).not.toMatch(/FUNCTION public\.(ticket_fee_[a-z_]+|settle_earnings|earnings_release_[a-z_]+|admin_approve_withdrawal_for_payment|admin_authorize_and_claim_payout|request_withdrawal)\(/);
      expect(m).not.toMatch(/interval '7 days'\s*;?\s*--\s*hold/i);
    }
  });
});

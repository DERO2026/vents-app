import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for 0219 (event cancellation safety fixes) and the refund API's
// uncertain-outcome rule. Real execution: scripts/local-pg-test/run-event-
// cancellation-review-verification.sh and api/_lib/refundUncertainOutcome.security.test.ts.
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const m = read('supabase/migrations/0219_event_cancellation_safety_fixes.sql');
const undo = read('supabase/rollback/undo_0219.sql');
const api = read('api/wallet/refund-ticket.ts');

describe('0219 moves no money and changes no amount', () => {
  it('writes no wallet, ledger, earnings or ticket payment field, and leaves the refund functions alone', () => {
    expect(m).not.toMatch(/(INSERT INTO|UPDATE)\s+public\.(user_wallets|user_wallet_transactions|organizer_wallets|organizer_transactions|earnings_holds|earnings_recoveries)/);
    expect(m).not.toMatch(/UPDATE\s+public\.tickets/);
    expect(m).not.toMatch(/FUNCTION public\.(refund_ticket|finalize_ticket_refund|fail_ticket_refund|attach_ticket_refund_id|admin_revert_stuck_refund|earnings_debit_for_refund|ticket_fee_[a-z_]+)\b/);
  });
});

describe('0219 fixes', () => {
  it('check-in is refused at a cancelled event, on every path (trigger on tickets.checked_in)', () => {
    expect(m).toContain('CREATE TRIGGER tickets_cancelled_event_checkin_guard BEFORE UPDATE OF checked_in ON public.tickets');
    expect(m).toContain("RAISE EXCEPTION 'This event was cancelled; its tickets cannot be checked in'");
  });
  it('only a Super Admin claims refunds or re-queues one', () => {
    expect(m).toMatch(/FUNCTION public\.admin_claim_event_cancellation_refunds[\s\S]*?IF NOT public\.is_super_admin\(\) THEN RAISE EXCEPTION 'Super Admin access required to process refunds'/);
    expect(m).toMatch(/FUNCTION public\.admin_requeue_event_cancellation_refund[\s\S]*?IF NOT public\.is_super_admin\(\) THEN RAISE EXCEPTION 'Super Admin access required'/);
  });
  it('re-queue only for a failed row whose ticket is still paid (no refund in flight), with a note, audited', () => {
    expect(m).toContain("RAISE EXCEPTION 'Only a failed refund can be re-queued (status: %)', x.status;");
    expect(m).toContain("IF v_pay IS DISTINCT FROM 'paid' THEN");
    expect(m).toContain("'event_cancellation_refund_requeued'");
  });
  it('a checked-in ticket is recorded as blocked, not retried', () => {
    expect(m).toContain("SET status = CASE WHEN t.checked_in THEN 'blocked' ELSE 'failed' END");
  });
  it('the undo restores 0218 and is confirmation-gated', () => {
    expect(undo).toContain(`IS DISTINCT FROM 'undo-0219' THEN`);
    expect(undo).toContain("IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;");
    expect(undo).toContain('DROP FUNCTION IF EXISTS public.admin_requeue_event_cancellation_refund(uuid, uuid, text);');
  });
});

describe('refund API: only a definitive Paystack rejection releases a refund', () => {
  it('reverts only on 4xx with status:false; everything else is held as unconfirmed', () => {
    expect(api).toContain('const definitive = refundRes.status >= 400 && refundRes.status < 500 && refundJson?.status === false;');
    expect(api).toContain('signal: AbortSignal.timeout(PAYSTACK_REFUND_TIMEOUT_MS)');
    expect(api).toContain('REFUND UNCONFIRMED: check Paystack before reverting.');
  });
  it('the amount sent to Paystack is still the server amount', () => {
    expect(api).toContain('amount: state.amount_kobo,');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for migration 0218 (event cancellation). Real execution
// against Postgres -- deletion guard, request/decision, refunds through
// refund_ticket + mocked Paystack + webhook, duplicates, failures, retries,
// concurrency -- lives in scripts/local-pg-test/run-event-cancellation-
// verification.sh. This pins what a later edit could silently drop.
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const m = read('supabase/migrations/0218_event_cancellation_workflow.sql');
const undo = read('supabase/rollback/undo_0218.sql');
const lib = read('src/lib/eventCancellation.ts');

describe('0218 moves no money itself: refunds only through the existing refund path', () => {
  it('never writes a wallet, ledger, earnings or Paystack record, and does not redefine refund_ticket', () => {
    expect(m).not.toMatch(/(INSERT INTO|UPDATE)\s+public\.(user_wallets|user_wallet_transactions|organizer_wallets|organizer_transactions|earnings_holds|earn_profit_pool)/);
    expect(m).not.toMatch(/FUNCTION public\.(refund_ticket|finalize_ticket_refund|fail_ticket_refund|attach_ticket_refund_id|admin_revert_stuck_refund|earnings_debit_for_refund)\b/);
    expect(m).not.toMatch(/api\.paystack\.co|secret_key|http_post|net\.http/i);   // no provider call from the database
  });
  it('refund amounts are the server charge function (same as refund_ticket), never a parameter', () => {
    expect(m).toContain('public.ticket_fee_buyer_charge_kobo(t.amount, 1, COALESCE(t.discount_percentage, 0), t.fee_model)');
    // No function a client can call takes an amount: exactly these signatures are granted.
    const granted = m.slice(m.lastIndexOf('GRANT EXECUTE ON FUNCTION'));
    expect(granted).toContain('public.request_event_cancellation(uuid, text)');
    expect(granted).toContain('public.admin_decide_event_cancellation(uuid, boolean, text)');
    expect(granted).toContain('public.admin_claim_event_cancellation_refunds(uuid, integer)');
    expect(granted).toContain('public.admin_record_event_cancellation_refund_error(uuid, uuid, text)');
    expect(granted).not.toMatch(/amount|bigint|numeric/);
    // The client runner sends only ticket_id + reason to the existing API.
    expect(lib).toContain("body: JSON.stringify({ ticket_id, reason: claim.reason })");
    expect(lib).not.toMatch(/amount_kobo\s*[:,]\s*[^)]*JSON\.stringify|finalize_ticket_refund/);
  });
  it('completion only follows the ticket itself (wallet ledger or webhook), never a client report', () => {
    expect(m).toContain(`ELSIF NEW.payment_status = 'refunded' THEN
        UPDATE public.event_cancellation_refunds SET status = 'refunded'`);
    const rec = m.slice(m.indexOf('FUNCTION public.admin_record_event_cancellation_refund_error'), m.indexOf('FUNCTION public.event_cancellation_ticket_sync'));
    expect(rec).toContain("SET status = 'failed'");
    expect(rec).not.toContain("'refunded'");
  });
});

describe('0218 authorization and integrity', () => {
  it('deletion with ticket obligations is refused for everyone, by trigger (direct UPDATEs included)', () => {
    expect(m).toContain('CREATE TRIGGER events_cancellation_guard BEFORE UPDATE OR DELETE ON public.events');
    expect(m).toContain("request a cancellation instead of deleting it");
    expect(m).toContain("payment_status IN ('paid', 'refund_pending')");
  });
  it('a cancelled event can never return to sale, be un-cancelled or deleted', () => {
    expect(m).toContain("RAISE EXCEPTION 'This event was cancelled; it cannot be put back on sale'");
    expect(m).toContain("RAISE EXCEPTION 'An event is cancelled only through an approved cancellation request'");
  });
  it('only the organizer requests; only a Super Admin (not the organizer) decides; one open request per event', () => {
    expect(m).toMatch(/e\.organizer_id IS DISTINCT FROM v_uid THEN\s+RAISE EXCEPTION 'Only the organizer of this event can request its cancellation'/);
    expect(m).toMatch(/FUNCTION public\.admin_decide_event_cancellation[\s\S]*?IF NOT public\.is_super_admin\(\) THEN RAISE EXCEPTION 'Super Admin access required'/);
    expect(m).toContain("RAISE EXCEPTION 'You cannot decide a cancellation of your own event'");
    expect(m).toContain('ON public.event_cancellation_requests (event_id) WHERE status <> \'rejected\'');
    expect(m).toMatch(/SELECT \* INTO r FROM public\.event_cancellation_requests WHERE id = p_request_id FOR UPDATE;\s+IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation request not found'; END IF;\s+IF r\.status <> 'requested'/);
  });
  it('no client writes: tables are read-only to clients; internal helpers are not callable', () => {
    expect(m).toContain('REVOKE ALL ON public.event_cancellation_requests, public.event_cancellation_refunds FROM PUBLIC, anon, authenticated;');
    expect(m).toContain('GRANT SELECT ON public.event_cancellation_requests, public.event_cancellation_refunds TO authenticated;');
    expect(m).toMatch(/REVOKE ALL ON FUNCTION public\.event_ticket_obligations\(uuid\)[\s\S]*?public\.event_cancellation_ticket_sync\(\) FROM PUBLIC, anon, authenticated;/);
  });
  it('concurrent processing hands out disjoint tickets and never refunds a ticket that is not paid', () => {
    expect(m).toContain('FOR UPDATE OF x SKIP LOCKED');
    expect(m).toContain("WHERE x.request_id = p_request_id AND t.payment_status = 'paid' AND x.attempts < 5");
  });
  it('the rollback refuses once any cancellation exists', () => {
    expect(undo).toContain("RAISE EXCEPTION 'undo_0218 refused: event cancellation requests exist (their history must be kept)'");
    expect(undo).toContain(`IS DISTINCT FROM 'undo-0218' THEN`);
  });
});

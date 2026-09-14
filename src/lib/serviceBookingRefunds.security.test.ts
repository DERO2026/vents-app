import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0077_service_booking_refunds.sql -- the Services
// refund lifecycle audit found NO cancel/refund mechanism existed at all
// for service_bookings (confirmed via live pg_proc/RLS/schema queries).
// These tests lock in the invariants the design explicitly derived from
// the existing ticket-refund architecture and the Services payment rules,
// rather than assuming the ticket model transfers unchanged.

let m0077: string;
let refundTicketSrc: string;
let webhookSrc: string;

beforeAll(() => {
  m0077 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0077_service_booking_refunds.sql'), 'utf8');
  refundTicketSrc = readFileSync(join(__dirname, '..', '..', 'api', 'wallet', 'refund-ticket.ts'), 'utf8');
  webhookSrc = readFileSync(join(__dirname, '..', '..', 'api', 'webhook', 'paystack.ts'), 'utf8');
});

describe('cancel_service_booking: authorization diverges correctly from refund_ticket', () => {
  it('authorizes the provider who owns the booking (via service_providers.user_id), or admin -- never the customer, and never "organizer" (Services has no event/organizer concept)', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/v_booking\.provider_user_id IS DISTINCT FROM auth\.uid\(\)\s*\n\s*AND NOT public\.is_admin\(\)/);
    // organizer_wallets/organizer_transactions are the real, existing
    // provider-earnings tables (shared naming with event organizers) --
    // what must never appear is an events/organizer *authorization* check.
    expect(fn).not.toMatch(/e\.organizer_id/);
    expect(fn).not.toMatch(/JOIN public\.events/);
  });

  it('is REVOKEd from anon/project_admin and only GRANTed to authenticated (client-reachable, same as refund_ticket)', () => {
    expect(m0077).toMatch(/REVOKE ALL ON FUNCTION public\.cancel_service_booking\(uuid, text\) FROM PUBLIC, anon, project_admin;/);
    expect(m0077).toMatch(/GRANT EXECUTE ON FUNCTION public\.cancel_service_booking\(uuid, text\) TO authenticated;/);
  });
});

describe('cancel_service_booking: amount derivation is server-authoritative, never client-supplied', () => {
  it('takes only (p_booking_id, p_reason) -- no amount parameter of any kind', () => {
    expect(m0077).toMatch(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking\(p_booking_id uuid, p_reason text\)/);
  });

  it('refunds the customer the full total_kobo (fee-inclusive), and claws back only subtotal_kobo from the provider (fee_kobo was never credited to them)', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/v_booking\.customer_id, 'refund', v_booking\.total_kobo/);
    expect(fn).toMatch(/LEAST\(COALESCE\(v_wallet_bal, 0\), v_booking\.subtotal_kobo\)/);
  });

  it('records fee_kobo as the platform_fee_absorbed_kobo VENTS gives up, purely informational (admin_logs), no separate balance move', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/platform_fee_absorbed_kobo['"]?,\s*v_booking\.fee_kobo/);
    expect(fn).toMatch(/refund_platform_fee_absorbed/);
  });
});

describe('cancel_service_booking: idempotency reuses the existing generic refund index, no new index needed', () => {
  it('inserts into user_wallet_transactions keyed on the booking UUID as reference_id, guarded by the existing partial unique index from 0067', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/v_booking\.id::text/);
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'refund' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(m0077).not.toMatch(/CREATE UNIQUE INDEX/); // no new idempotency index -- 0067's is reused as-is
  });

  it('a wallet refund tx insert that hits the conflict returns already_refunded rather than double-crediting the wallet', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_wallet_refund_tx_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('status', 'already_refunded'/);
  });

  it('a repeat call on an already-refunded or refund_pending booking short-circuits before touching any balance', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_booking\.payment_status = 'refunded' THEN/);
    expect(fn).toMatch(/IF v_booking\.payment_status = 'refund_pending' THEN/);
  });
});

describe('cancel_service_booking: row locking guards the refund-vs-payment-completion race', () => {
  it('locks the booking row FOR UPDATE before reading payment_status, and only paid bookings proceed past the guard', () => {
    const fn = m0077.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/FOR UPDATE OF b;/);
    expect(fn).toMatch(/IF v_booking\.payment_status <> 'paid' THEN\s*\n\s*RAISE EXCEPTION 'Only paid bookings can be refunded/);
  });
});

describe('finalize/fail_service_booking_refund: project_admin-only, same reasoning as the ticket equivalents', () => {
  it('finalize_service_booking_refund has EXECUTE revoked from anon/authenticated and granted only to project_admin', () => {
    expect(m0077).toMatch(/REVOKE ALL ON FUNCTION public\.finalize_service_booking_refund\(text\) FROM PUBLIC, anon, authenticated, project_admin;/);
    expect(m0077).toMatch(/GRANT EXECUTE ON FUNCTION public\.finalize_service_booking_refund\(text\) TO project_admin;/);
  });

  it('fail_service_booking_refund has the identical revoke/grant shape', () => {
    expect(m0077).toMatch(/REVOKE ALL ON FUNCTION public\.fail_service_booking_refund\(text, text\) FROM PUBLIC, anon, authenticated, project_admin;/);
    expect(m0077).toMatch(/GRANT EXECUTE ON FUNCTION public\.fail_service_booking_refund\(text, text\) TO project_admin;/);
  });

  it('both are keyed only on refund_id (Paystack\'s enumerable id), never on booking_id or any caller-supplied identity', () => {
    const finFn = m0077.match(/CREATE OR REPLACE FUNCTION public\.finalize_service_booking_refund[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(finFn).toMatch(/WHERE b\.refund_id = p_refund_id/);
  });
});

describe('api/wallet/refund-ticket.ts: extended, not duplicated, to stay within the Vercel Hobby 12-function cap', () => {
  it('dispatches on booking_id vs ticket_id in the same handler rather than adding a new API file', () => {
    expect(refundTicketSrc).toMatch(/booking_id/);
    expect(refundTicketSrc).toMatch(/cancel_service_booking/);
    expect(refundTicketSrc).toMatch(/attach_service_booking_refund_id/);
    expect(refundTicketSrc).toMatch(/admin_revert_stuck_service_refund/);
  });

  it('rejects a request that supplies both ticket_id and booking_id, and one that supplies neither', () => {
    expect(refundTicketSrc).toMatch(/Pass either ticket_id or booking_id, not both/);
    expect(refundTicketSrc).toMatch(/ticket_id or booking_id is required/);
  });
});

describe('api/webhook/paystack.ts: refund.processed/refund.failed fallback chain gets one more link', () => {
  it('tries finalize_service_booking_refund only after both finalize_ticket_refund and finalize_transfer_fee_refund report not_found', () => {
    expect(webhookSrc).toMatch(/finalize_service_booking_refund/);
    const idx1 = webhookSrc.indexOf('finalize_ticket_refund');
    const idx2 = webhookSrc.indexOf('finalize_transfer_fee_refund');
    const idx3 = webhookSrc.indexOf('finalize_service_booking_refund');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('the same three-deep fallback exists for the failed-refund path', () => {
    const idx1 = webhookSrc.indexOf('fail_ticket_refund');
    const idx2 = webhookSrc.indexOf('fail_transfer_fee_refund');
    const idx3 = webhookSrc.indexOf('fail_service_booking_refund');
    expect(idx3).toBeGreaterThan(idx2);
    expect(idx2).toBeGreaterThan(idx1);
  });
});

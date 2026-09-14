// Pure classification logic for a customer wallet transaction row, kept
// separate from userWallet.ts (which imports the Supabase client and can't
// be unit-tested without a live/stubbed env) so this can be tested in
// isolation. No side effects, no imports.

export interface ClassifiableWalletTransaction {
  type: 'deposit' | 'spend' | 'refund';
  referenceId: string | null;
}

// reference_id is a stable, server-assigned identifier whose PREFIX already
// encodes what kind of purchase it was -- established, unchanged conventions
// from create_pending_purchase ('VNT-...') and create_service_booking
// ('BKG-...'); a refund's reference_id is the bare ticket UUID it refunded
// (0067's `v_ticket.id::text`), and a deposit's is the wallet_deposit_
// attempts reference ('wdep_...', 0065). Classifying by these existing,
// already-authoritative conventions rather than fragile description-string
// matching, and never inventing a classification the data doesn't support.
export type WalletTransactionKind = 'deposit' | 'ticket_purchase' | 'service_purchase' | 'ticket_refund' | 'other';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function classifyWalletTransaction(tx: ClassifiableWalletTransaction): WalletTransactionKind {
  const ref = tx.referenceId || '';
  if (tx.type === 'deposit') return 'deposit';
  if (tx.type === 'refund') {
    // A refund's reference_id is a bare ticket UUID only for the ticket
    // refund path (0067) -- there is no service-booking refund path yet
    // (confirmed: no refund function exists for service_bookings anywhere
    // in this schema), so every refund row today is a ticket refund. Not
    // asserted for any ref shape that doesn't look like a UUID, to avoid
    // mis-classifying a future refund type this code hasn't seen.
    return UUID_RE.test(ref) ? 'ticket_refund' : 'other';
  }
  if (tx.type === 'spend') {
    if (ref.startsWith('VNT-')) return 'ticket_purchase';
    if (ref.startsWith('BKG-')) return 'service_purchase';
  }
  return 'other';
}

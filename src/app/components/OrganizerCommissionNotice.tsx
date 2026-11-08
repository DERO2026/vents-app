import React from 'react';
import { Info } from 'lucide-react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { ticketFaceKobo, organizerCommissionKobo, organizerNetKobo, formatKobo } from '../../lib/ticketFees';

// Shown in the ticket pricing step of Create / Edit Event, before publishing
// (owner instruction 2026-11-08, item 2). Amounts use the same per-ticket
// arithmetic the database settles with (ticket_fee_commission_kobo, 0208).

export const ORGANIZER_COMMISSION_NOTICE =
  'VENTS charges a 3.5% commission on every ticket sold. Your earnings will automatically reflect this deduction. ' +
  'For example, a ₦10,000 ticket earns you ₦9,650 before any other applicable adjustments.';

export function OrganizerCommissionNotice() {
  return (
    <div
      data-testid="organizer-commission-notice"
      role="note"
      style={{
        display: 'flex', gap: '10px', alignItems: 'flex-start',
        background: 'rgba(142,92,247,0.10)', border: '1px solid rgba(142,92,247,0.32)',
        borderRadius: '14px', padding: '12px 14px',
      }}
    >
      <Info size={16} color={ventsColors.accentSoft} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden />
      <p style={{ color: ventsColors.ink1, fontSize: '13px', lineHeight: 1.5, margin: 0 }}>{ORGANIZER_COMMISSION_NOTICE}</p>
    </div>
  );
}

/** "You earn ₦9,650 per ticket" line under a ticket type's price input. */
export function TicketNetEarnings({ price }: { price: string | number }) {
  const face = ticketFaceKobo(Number(price) || 0);
  if (face <= 0) {
    return (
      <p data-testid="ticket-net-earnings" style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0 }}>
        Free ticket: no commission is charged.
      </p>
    );
  }
  return (
    <p data-testid="ticket-net-earnings" style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0, fontVariantNumeric: 'tabular-nums' }}>
      You earn <span style={{ color: ventsColors.success, fontWeight: 700 }}>{formatKobo(organizerNetKobo(face))}</span> per ticket
      {' '}({formatKobo(face)} − {formatKobo(organizerCommissionKobo(face))} VENTS commission).
    </p>
  );
}

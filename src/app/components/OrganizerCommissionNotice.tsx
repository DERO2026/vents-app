import React from 'react';
import { Info } from 'lucide-react';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { formatKobo } from '../../lib/ticketFees';
import { useTicketQuote, formatBps } from '../../lib/ticketQuote';

// Shown in the ticket pricing step of Create / Edit Event, before publishing
// (owner instruction 2026-11-08, item 2). Every number -- the commission rate
// and the example -- comes from the database's own quote (ticket_fee_quote,
// 0208), the same functions that settle organizers. Nothing is restated here.

export function organizerCommissionNoticeText(rateText: string, exampleNetText: string): string {
  return `VENTS charges a ${rateText} commission on every ticket sold. Your earnings will automatically reflect this deduction. ` +
    `For example, a ₦10,000 ticket earns you ${exampleNetText} before any other applicable adjustments.`;
}

export function OrganizerCommissionNotice() {
  const { status, quote } = useTicketQuote(10000, 1);
  const text = quote
    ? organizerCommissionNoticeText(formatBps(quote.organizer_commission_bps), formatKobo(quote.organizer_net_kobo))
    : status === 'unavailable'
      ? 'VENTS commission details could not be loaded. They will be shown here before you publish.'
      : 'Loading VENTS commission…';
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
      <p style={{ color: ventsColors.ink1, fontSize: '13px', lineHeight: 1.5, margin: 0 }}>{text}</p>
    </div>
  );
}

/** "You earn ₦9,650 per ticket" line under a ticket type's price input. */
export function TicketNetEarnings({ price }: { price: string | number }) {
  const value = Number(price) || 0;
  const { quote } = useTicketQuote(value > 0 ? value : null, 1);
  if (!(value > 0)) {
    return (
      <p data-testid="ticket-net-earnings" style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0 }}>
        Free ticket: no commission is charged.
      </p>
    );
  }
  if (!quote) {
    return <p data-testid="ticket-net-earnings" style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0 }}>Calculating your earnings…</p>;
  }
  return (
    <p data-testid="ticket-net-earnings" style={{ color: ventsColors.ink2, fontSize: '12px', margin: 0, fontVariantNumeric: 'tabular-nums' }}>
      You earn <span style={{ color: ventsColors.success, fontWeight: 700 }}>{formatKobo(quote.organizer_net_kobo)}</span> per ticket
      {' '}({formatKobo(quote.face_kobo)} − {formatKobo(quote.organizer_commission_kobo)} VENTS commission).
    </p>
  );
}

/** Commission row for the review step, from the server's rate. */
export function useCommissionRateText(): string | null {
  const { quote } = useTicketQuote(10000, 1);
  return quote ? formatBps(quote.organizer_commission_bps) : null;
}

import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import { ventsColors, ventsTypography } from '../../lib/ventsDesignTokens';
import { supabase } from '../../lib/supabase';
import { formatPrice } from './data';

interface TicketRefundScreenProps {
  ticketId: string;
  onBack: () => void;
  onViewWallet: () => void;
}

interface RefundTicketRow {
  id: string;
  ticket_type: string | null;
  quantity: number;
  amount: number;
  discount_percentage: number;
  payment_status: string;
  payment_method: 'paystack' | 'wallet' | null;
  refund_reason: string | null;
  checked_in: boolean;
  events: { title: string; event_date: string | null; location: string | null } | null;
}

// Handoff S6 ("Event ticket refund — attendee side"): the real gap this
// closes is that refund_ticket/finalize_ticket_refund already flip a
// ticket's status to 'cancelled' the moment a refund starts, which drops
// it out of MyTicketsScreen's `.eq('status', 'active')` query entirely --
// so an attendee whose ticket got refunded had no page that could ever
// show it, even though every notification about it already carries a
// working `push_data: { ticketId }` (0061/0067 migrations). This screen is
// that destination.
//
// Unlike the design mock, the money doesn't always "come back to your
// wallet" -- only a wallet-paid ticket's refund is a synchronous wallet
// credit; a Paystack-paid ticket is refunded to the original card/bank via
// Paystack's own refund API (api/wallet/refund-ticket.ts + the
// refund.processed webhook), and never touches the VENTS wallet at all.
// Copy below is written to be honest about which of those actually
// happened, rather than reusing the mock's wallet-specific wording
// unconditionally. There's also no refund-initiated/refunded timestamp
// column on `tickets` -- the status list below shows real states, not
// invented times.
export function TicketRefundScreen({ ticketId, onBack, onViewWallet }: TicketRefundScreenProps) {
  const [ticket, setTicket] = useState<RefundTicketRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setNotFound(false);
      try {
        const { data, error } = await supabase
          .from('tickets')
          .select('id, ticket_type, quantity, amount, discount_percentage, payment_status, payment_method, refund_reason, checked_in, events(title, event_date, location)')
          .eq('id', ticketId)
          .maybeSingle();
        if (cancelled) return;
        if (error || !data) { setNotFound(true); return; }
        setTicket(data as unknown as RefundTicketRow);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ticketId]);

  if (loading) {
    return (
      <div style={{ background: ventsColors.bg, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '32px', height: '32px', borderRadius: '50%', border: '3px solid rgba(142,92,247,0.2)', borderTopColor: ventsColors.accent, animation: 'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  if (notFound || !ticket || (ticket.payment_status !== 'refund_pending' && ticket.payment_status !== 'refunded')) {
    return (
      <div style={{ background: ventsColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', color: ventsColors.ink1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
          <button onClick={onBack} style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color={ventsColors.ink2} />
          </button>
          <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'Manrope, sans-serif' }}>Ticket Refund</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 30px', textAlign: 'center' }}>
          <AlertCircle size={32} color={ventsColors.ink2} />
          <p style={{ color: ventsColors.ink2, fontSize: '14px', marginTop: '14px' }}>
            This refund record isn't available right now.
          </p>
        </div>
      </div>
    );
  }

  const isWallet = ticket.payment_method === 'wallet';
  const isDone = ticket.payment_status === 'refunded';
  const ticketPriceKobo = Math.round(ticket.amount * 100);
  const feeKobo = Math.round(ticketPriceKobo * 0.05);
  const discountKobo = Math.round(ticketPriceKobo * ((ticket.discount_percentage || 0) / 100));
  const refundTotalKobo = ticketPriceKobo + feeKobo - discountKobo;

  const eventTitle = ticket.events?.title || 'Event';
  const eventDate = ticket.events?.event_date
    ? new Date(ticket.events.event_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : null;
  const venue = (ticket.events?.location || '').split(',')[0]?.trim();

  return (
    <div style={{ background: ventsColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', scrollbarWidth: 'none', color: ventsColors.ink1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color={ventsColors.ink2} />
        </button>
        <span style={{ fontSize: '18px', fontWeight: 700, fontFamily: 'Manrope, sans-serif' }}>Ticket Refund</span>
      </div>

      <div style={{ flex: 1, padding: '0 16px 32px' }}>
        {/* Ticket summary */}
        <div style={{ display: 'flex', gap: '12px', padding: '14px', borderRadius: '18px', background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.09)', marginBottom: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: ventsColors.white }}>{eventTitle}</p>
            <p style={{ margin: '3px 0 0', fontSize: '12.5px', fontWeight: 600, color: ventsColors.ink2 }}>
              {[eventDate, ticket.ticket_type ? `${ticket.ticket_type} ×${ticket.quantity}` : null].filter(Boolean).join(' · ')}
            </p>
            {venue && <p style={{ margin: '2px 0 0', fontSize: '12px', color: ventsColors.ink3 }}>{venue}</p>}
          </div>
        </div>

        {/* Refund reason banner */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '14px 16px', borderRadius: '14px', background: isDone ? 'rgba(52,211,153,0.08)' : 'rgba(251,191,36,0.08)', border: `1px solid ${isDone ? 'rgba(52,211,153,0.25)' : 'rgba(251,191,36,0.25)'}`, marginBottom: '16px' }}>
          {isDone
            ? <CheckCircle2 size={16} color={ventsColors.success} style={{ flexShrink: 0, marginTop: '1px' }} />
            : <Clock size={16} color={ventsColors.pending} style={{ flexShrink: 0, marginTop: '1px' }} />}
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'rgba(237,234,245,0.8)' }}>
            {ticket.refund_reason ? `Refund reason: ${ticket.refund_reason}. ` : ''}
            {isDone
              ? (isWallet
                  ? 'This refund has been credited to your VENTS Wallet.'
                  : 'This refund has been sent back to your original payment method via Paystack.')
              : (isWallet
                  ? 'Your wallet credit is being processed.'
                  : "Paystack is processing your refund back to your original payment method. This can take a few business days, depending on your bank.")}
          </p>
        </div>

        {/* Breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '18px', borderRadius: '18px', background: ventsColors.surface, border: '1px solid rgba(255,255,255,0.09)', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
            <span style={{ color: ventsColors.ink2 }}>Ticket price</span>
            <span style={{ color: ventsColors.ink1, fontWeight: 700, fontVariantNumeric: 'tabular-nums lining-nums' }}>{formatPrice(ticketPriceKobo / 100)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
            <span style={{ color: ventsColors.ink2 }}>VENTS service fee</span>
            <span style={{ color: ventsColors.ink1, fontWeight: 700, fontVariantNumeric: 'tabular-nums lining-nums' }}>{formatPrice(feeKobo / 100)}</span>
          </div>
          {discountKobo > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
              <span style={{ color: ventsColors.ink2 }}>Promo discount</span>
              <span style={{ color: ventsColors.success, fontWeight: 700, fontVariantNumeric: 'tabular-nums lining-nums' }}>-{formatPrice(discountKobo / 100)}</span>
            </div>
          )}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.09)', margin: '2px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: '15px', fontWeight: 700, color: ventsColors.white }}>Refund total</span>
            <span style={{ fontSize: '20px', fontWeight: 800, fontVariantNumeric: 'tabular-nums lining-nums', color: ventsColors.success }}>{formatPrice(refundTotalKobo / 100)}</span>
          </div>
        </div>

        {/* Status */}
        <div style={{ marginBottom: '20px' }}>
          <p style={{ fontFamily: ventsTypography.fontMono, fontSize: '11px', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(237,234,245,0.55)', marginBottom: '14px' }}>Status</p>
          {[
            { label: 'Refund initiated', done: true },
            { label: isWallet ? 'Credited to your Wallet' : 'Refunded to your original payment method', done: isDone },
          ].map((step, i, arr) => (
            <div key={step.label} style={{ display: 'flex', gap: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                <span style={{ width: '12px', height: '12px', borderRadius: '50%', marginTop: '5px', background: step.done ? ventsColors.success : 'transparent', border: step.done ? 'none' : '2px solid rgba(255,255,255,0.2)', flexShrink: 0 }} />
                {i < arr.length - 1 && <span style={{ flex: 1, width: '2px', background: 'rgba(255,255,255,0.12)' }} />}
              </div>
              <div style={{ paddingBottom: i < arr.length - 1 ? '20px' : 0 }}>
                <span style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: step.done ? ventsColors.white : ventsColors.ink2 }}>{step.label}</span>
              </div>
            </div>
          ))}
        </div>

        {isWallet && isDone && (
          <button
            onClick={onViewWallet}
            style={{ width: '100%', height: '52px', borderRadius: '15px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}
          >
            View Wallet
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ArrowLeft, Minus, Plus, CheckCircle, Maximize2 } from 'lucide-react';
import { Event, TicketType } from './types';
import { formatPrice } from './data';
import { supabase } from '../../lib/supabase';
import { haptics } from '../../lib/haptics';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { TICKET_SERVICE_FEE_LABEL, ticketServiceFee } from '../../lib/ticketFees';

interface TicketSelectScreenProps {
  event: Event;
  onBack: () => void;
  onContinue: (ticketType: TicketType, quantity: number) => void;
}

export function TicketSelectScreen({ event, onBack, onContinue }: TicketSelectScreenProps) {
  const baseTicketTypes = event.ticketTypes || [];
  // `event.ticketTypes[].available` comes from the event's static
  // ticket_types JSON (its original quantity, never decremented by sales) —
  // it can be stale by however long since the feed/search query that
  // produced this `event` ran. Re-derive real availability live, right
  // before the buyer picks a quantity, using the exact same capacity rule
  // purchase_ticket enforces server-side (active tickets, any payment
  // status) — see migrations/20260731212751_get-event-ticket-type-availability.sql.
  const [liveSoldByType, setLiveSoldByType] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .rpc('get_event_ticket_type_availability', { p_event_id: event.id });
        if (cancelled || error || !Array.isArray(data)) return;
        const map: Record<string, number> = {};
        (data as any[]).forEach((row: any) => { map[row.ticket_type] = Number(row.sold_count) || 0; });
        setLiveSoldByType(map);
      } catch {
        /* fall back to the static available count below */
      }
    })();
    return () => { cancelled = true; };
  }, [event.id]);

  const ticketTypes = liveSoldByType
    ? baseTicketTypes.map((t) => ({
        ...t,
        available: Math.max(0, t.available - (liveSoldByType[t.name] ?? 0)),
      }))
    : baseTicketTypes;

  const [selectedId, setSelectedId] = useState(ticketTypes[0]?.id ?? '');
  const [flyerOpen, setFlyerOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(ticketTypes.map((t) => [t.id, 0]))
  );

  const selected = ticketTypes.find((t) => t.id === selectedId);
  const qty = selectedId ? quantities[selectedId] ?? 0 : 0;
  const subtotal = selected ? selected.price * qty : 0;
  const serviceFee = ticketServiceFee(subtotal);
  const total = subtotal + serviceFee;

  const changeQty = (id: string, delta: number) => {
    setQuantities((prev) => {
      const next = (prev[id] ?? 0) + delta;
      const max = ticketTypes.find((t) => t.id === id)?.available ?? Infinity;
      return { ...prev, [id]: Math.max(0, Math.min(max, next)) };
    });
  };

  const canContinue = selected && qty > 0;

  return (
    <div
      style={{
        background: ventsColors.bg,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {/* Full-screen flyer lightbox */}
      {flyerOpen && (
        <div
          onClick={() => setFlyerOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0,0,0,0.95)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <img
            src={event.image}
            alt={event.title}
            style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: '12px', objectFit: 'contain' }}
          />
          <button
            onClick={() => setFlyerOpen(false)}
            style={{
              position: 'absolute',
              top: 'calc(16px + env(safe-area-inset-top))',
              right: '16px',
              background: 'rgba(255,255,255,0.12)',
              border: 'none',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              color: ventsColors.white,
              fontSize: '18px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Full-width hero flyer */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <img
          src={event.image}
          alt={event.title}
          style={{ width: '100%', height: '220px', objectFit: 'cover', display: 'block' }}
        />
        <div style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '45%',
          background: 'rgba(6,10,18,0.75)',
        }} />
        {/* Back button */}
        <button
          onClick={onBack}
          style={{
            position: 'absolute',
            top: 'calc(14px + env(safe-area-inset-top))',
            left: '16px',
            background: 'rgba(6,10,18,0.6)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color={ventsColors.ink1} />
        </button>
        {/* Tap to expand */}
        <button
          onClick={() => setFlyerOpen(true)}
          style={{
            position: 'absolute',
            top: 'calc(14px + env(safe-area-inset-top))',
            right: '16px',
            background: 'rgba(6,10,18,0.6)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <Maximize2 size={14} color={ventsColors.ink1} />
        </button>
        {/* Event info overlay */}
        <div style={{ position: 'absolute', bottom: '12px', left: '16px', right: '16px' }}>
          <span
            style={{
              color: '#A78BFA',
              fontSize: '10px',
              fontWeight: 600,
              background: 'rgba(167,139,250,0.2)',
              backdropFilter: 'blur(4px)',
              padding: '2px 8px',
              borderRadius: '4px',
              display: 'inline-block',
              marginBottom: '4px',
            }}
          >
            {event.category}
          </span>
          <h1 style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 800, margin: 0, lineHeight: 1.2 }}>{event.title}</h1>
          <p style={{ color: 'rgba(240,240,255,0.7)', fontSize: '12px', margin: '3px 0 0' }}>{event.date} · {event.venue}</p>
        </div>
      </div>

      <div style={{ flex: 1, padding: '16px 16px 140px' }}>

        {/* Ticket types */}
        <p style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.06em', marginBottom: '12px' }}>
          TICKET TYPE
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {ticketTypes.map((ticket) => {
            const isSelected = selectedId === ticket.id;
            const ticketQty = quantities[ticket.id] ?? 0;
            const soldOut = ticket.available === 0;

            return (
              <div
                key={ticket.id}
                onClick={() => { if (!soldOut) { haptics.light(); setSelectedId(ticket.id); } }}
                style={{
                  background: isSelected ? 'rgba(124,58,237,0.1)' : ventsColors.elevated,
                  border: isSelected
                    ? '1.5px solid rgba(124,58,237,0.5)'
                    : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '16px',
                  padding: '14px',
                  cursor: soldOut ? 'not-allowed' : 'pointer',
                  opacity: soldOut ? 0.5 : 1,
                  transition: 'all 0.2s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                      <div
                        style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '50%',
                          border: isSelected ? 'none' : '2px solid rgba(255,255,255,0.2)',
                          background: isSelected
                            ? '#8E5CF7'
                            : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {isSelected && <CheckCircle size={12} color={ventsColors.white} />}
                      </div>
                      <span style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 700 }}>
                        {ticket.name}
                      </span>
                      {soldOut && (
                        <span
                          style={{
                            background: '#EF444420',
                            color: '#EF4444',
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 7px',
                            borderRadius: '4px',
                          }}
                        >
                          Sold Out
                        </span>
                      )}
                    </div>
                    <p style={{ color: '#8B8FA8', fontSize: '12px', marginLeft: '26px' }}>
                      {ticket.description}
                    </p>
                    {!soldOut && (
                      <p style={{ color: '#8B8FA8', fontSize: '11px', marginLeft: '26px', marginTop: '2px' }}>
                        {ticket.available} available
                      </p>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: '#FFB830', fontSize: '16px', fontWeight: 800, fontVariantNumeric: 'tabular-nums lining-nums' }}>
                      {formatPrice(ticket.price)}
                    </div>
                  </div>
                </div>

                {/* Quantity selector for selected ticket */}
                {isSelected && !soldOut && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: '12px',
                      paddingTop: '12px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <span style={{ color: '#C4C9E0', fontSize: '13px', fontWeight: 500 }}>Quantity</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (ticketQty > 0) haptics.light();
                          changeQty(ticket.id, -1);
                        }}
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: ticketQty === 0 ? ventsColors.elevated : 'rgba(124,58,237,0.2)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: ticketQty === 0 ? 'not-allowed' : 'pointer',
                          opacity: ticketQty === 0 ? 0.5 : 1,
                        }}
                      >
                        <Minus size={14} color="#C4C9E0" />
                      </button>
                      <span style={{ color: ventsColors.ink1, fontSize: '18px', fontWeight: 700, minWidth: '24px', textAlign: 'center' }}>
                        {ticketQty}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          haptics.light();
                          changeQty(ticket.id, 1);
                        }}
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: '#8E5CF7',
                          border: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Plus size={14} color={ventsColors.white} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Order summary */}
        {canContinue && (
          <div
            style={{
              background: ventsColors.surface,
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '16px',
              padding: '14px',
            }}
          >
            <p style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, letterSpacing: '0.06em', marginBottom: '10px' }}>
              ORDER SUMMARY
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#C4C9E0', fontSize: '13px' }}>
                  {selected?.name} × {qty}
                </span>
                <span style={{ color: ventsColors.ink1, fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums lining-nums' }}>
                  {formatPrice(subtotal)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{TICKET_SERVICE_FEE_LABEL}</span>
                <span style={{ color: ventsColors.ink1, fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums lining-nums' }}>
                  {formatPrice(serviceFee)}
                </span>
              </div>
              <div
                style={{
                  height: '1px',
                  background: 'rgba(255,255,255,0.07)',
                  margin: '4px 0',
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: ventsColors.ink1, fontSize: '14px', fontWeight: 700 }}>Total</span>
                <span style={{ color: '#FFB830', fontSize: '16px', fontWeight: 800, fontVariantNumeric: 'tabular-nums lining-nums' }}>
                  {formatPrice(total)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Sticky CTA */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(6,10,18,0.95)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '14px 16px 28px',
        }}
      >
        <button
          onClick={() => { if (canContinue) { haptics.medium(); onContinue(selected!, qty); } }}
          disabled={!canContinue}
          style={{
            width: '100%',
            background: canContinue
              ? '#7B2FBE'
              : ventsColors.elevated,
            border: 'none',
            borderRadius: '16px',
            padding: '15px',
            color: canContinue ? ventsColors.white : '#8B8FA8',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Manrope, sans-serif',
            cursor: canContinue ? 'pointer' : 'not-allowed',
            boxShadow: canContinue ? '0 6px 24px rgba(123,47,190,0.45)' : 'none',
            transition: 'all 0.2s ease',
          }}
        >
          {canContinue ? `Continue · ${formatPrice(total)}` : 'Select a ticket type'}
        </button>
      </div>
    </div>
  );
}

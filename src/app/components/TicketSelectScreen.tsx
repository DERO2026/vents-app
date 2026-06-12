import { useState } from 'react';
import { ArrowLeft, Minus, Plus, CheckCircle } from 'lucide-react';
import { Event, TicketType } from './types';
import { formatPrice } from './data';

interface TicketSelectScreenProps {
  event: Event;
  onBack: () => void;
  onContinue: (ticketType: TicketType, quantity: number) => void;
}

export function TicketSelectScreen({ event, onBack, onContinue }: TicketSelectScreenProps) {
  const ticketTypes = event.ticketTypes || [];
  const [selectedId, setSelectedId] = useState(ticketTypes[0]?.id ?? '');
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(ticketTypes.map((t) => [t.id, 0]))
  );

  const selected = ticketTypes.find((t) => t.id === selectedId);
  const qty = selectedId ? quantities[selectedId] ?? 0 : 0;
  const subtotal = selected ? selected.price * qty : 0;
  const SERVICE_FEE_PCT = 0.05;
  const serviceFee = Math.round(subtotal * SERVICE_FEE_PCT);
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
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '20px 16px 14px',
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>Select Tickets</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{event.title}</p>
        </div>
      </div>

      <div style={{ flex: 1, padding: '4px 16px 140px' }}>
        {/* Event mini card */}
        <div
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '16px',
            display: 'flex',
            overflow: 'hidden',
            marginBottom: '20px',
          }}
        >
          <img
            src={event.image}
            alt={event.title}
            style={{ width: '80px', height: '80px', objectFit: 'cover', flexShrink: 0 }}
          />
          <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <span
              style={{
                color: '#A78BFA',
                fontSize: '10px',
                fontWeight: 600,
                background: 'rgba(167,139,250,0.12)',
                padding: '2px 6px',
                borderRadius: '4px',
                alignSelf: 'flex-start',
                marginBottom: '4px',
              }}
            >
              {event.category}
            </span>
            <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{event.title}</span>
            <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
              {event.date} · {event.venue}
            </span>
          </div>
        </div>

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
                onClick={() => !soldOut && setSelectedId(ticket.id)}
                style={{
                  background: isSelected ? 'rgba(124,58,237,0.1)' : '#131629',
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
                            ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)'
                            : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {isSelected && <CheckCircle size={12} color="#fff" />}
                      </div>
                      <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>
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
                    <div style={{ color: '#FFB830', fontSize: '16px', fontWeight: 800 }}>
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
                          changeQty(ticket.id, -1);
                        }}
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: ticketQty === 0 ? '#1A1D2E' : 'rgba(124,58,237,0.2)',
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
                      <span style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, minWidth: '24px', textAlign: 'center' }}>
                        {ticketQty}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          changeQty(ticket.id, 1);
                        }}
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
                          border: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Plus size={14} color="#fff" />
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
              background: '#131629',
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
                <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>
                  {formatPrice(subtotal)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#C4C9E0', fontSize: '13px' }}>Service fee (5%)</span>
                <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>
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
                <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Total</span>
                <span style={{ color: '#FFB830', fontSize: '16px', fontWeight: 800 }}>
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
          onClick={() => canContinue && onContinue(selected!, qty)}
          disabled={!canContinue}
          style={{
            width: '100%',
            background: canContinue
              ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)'
              : '#1A1D2E',
            border: 'none',
            borderRadius: '16px',
            padding: '15px',
            color: canContinue ? '#fff' : '#8B8FA8',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
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

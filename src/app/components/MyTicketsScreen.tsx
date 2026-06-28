import { useState, useRef } from 'react';
import { Ticket, Calendar, MapPin, QrCode, RefreshCw } from 'lucide-react';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import { SkeletonCard } from './SkeletonCard';

interface MyTicketsScreenProps {
  tickets: PurchasedTicket[];
  loading?: boolean;
  onBack: () => void;
  onViewTicket: (ticket: PurchasedTicket) => void;
  onRefresh?: () => Promise<void>;
}

export function MyTicketsScreen({ tickets, loading, onBack, onViewTicket, onRefresh }: MyTicketsScreenProps) {
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past'>('upcoming');
  const [refreshing, setRefreshing] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const handleRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (dy > 120 && Math.abs(dy) > Math.abs(dx)) {
      // Pull-to-refresh
      handleRefresh();
    } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx < 0) setActiveTab('past');
      else setActiveTab('upcoming');
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  const now = Date.now();
  const upcoming = tickets.filter((t) => {
    try {
      return new Date(`${t.event.date} ${t.event.time}`).getTime() > now;
    } catch {
      return true;
    }
  });
  const past = tickets.filter((t) => {
    try {
      return new Date(`${t.event.date} ${t.event.time}`).getTime() <= now;
    } catch {
      return false;
    }
  });

  const displayed = activeTab === 'upcoming' ? upcoming : past;

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {refreshing && (
        <div style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)', zIndex: 200,
        }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '50%',
            border: '3px solid rgba(123,47,247,0.2)',
            borderTop: '3px solid #7B2FF7',
            animation: 'spin 0.8s linear infinite',
          }} />
        </div>
      )}
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
        }}
      >
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700, flex: 1 }}>My Tickets</h1>
        {onRefresh && (
          <button
            onClick={handleRefresh}
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
            <RefreshCw
              size={16}
              color="#A78BFA"
              style={{ animation: refreshing ? 'spin 0.8s linear infinite' : 'none' }}
            />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ padding: '0 16px 14px' }}>
        <div
          style={{
            display: 'flex',
            background: '#131629',
            borderRadius: '12px',
            padding: '3px',
            gap: '3px',
          }}
        >
          {(['upcoming', 'past'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1,
                padding: '9px',
                borderRadius: '10px',
                border: 'none',
                background:
                  activeTab === tab
                    ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)'
                    : 'transparent',
                color: activeTab === tab ? '#fff' : '#8B8FA8',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {tab === 'upcoming' ? 'Upcoming' : 'Past'}{' '}
              <span
                style={{
                  background: activeTab === tab ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
                  borderRadius: '4px',
                  padding: '1px 6px',
                  fontSize: '11px',
                }}
              >
                {tab === 'upcoming' ? upcoming.length : past.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Ticket list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 16px 24px',
          scrollbarWidth: 'none',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <SkeletonCard variant="ticket" />
            <SkeletonCard variant="ticket" />
          </div>
        ) : displayed.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '70px',
              gap: '16px',
            }}
          >
            <div
              style={{
                width: '72px',
                height: '72px',
                borderRadius: '20px',
                background: '#131629',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ticket size={32} color="#2A2D3E" />
            </div>
            <div style={{ textAlign: 'center', padding: '0 16px' }}>
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
                {activeTab === 'upcoming'
                  ? "Seems like you haven't reserved any ticket yet, we are here to help!"
                  : 'Your expired tickets will appear here!'}
              </p>
              {activeTab === 'past' && (
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '16px' }}>
                  Please come back later or start exploring events now!
                </p>
              )}
              <button
                onClick={() => {
                  // Signal parent to switch to home tab
                  onBack();
                }}
                style={{
                  marginTop: activeTab === 'upcoming' ? '12px' : '0',
                  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                  border: 'none',
                  borderRadius: '12px',
                  padding: '10px 24px',
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Explore events
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {displayed.map((ticket) => (
              <div
                key={ticket.ticketId}
                onClick={() => onViewTicket(ticket)}
                style={{
                  background: '#131629',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '20px',
                  overflow: 'hidden',
                  cursor: 'pointer',
                }}
              >
                {/* Event image strip */}
                <div style={{ position: 'relative', height: '100px' }}>
                  <img
                    src={ticket.event.image}
                    alt={ticket.event.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(to bottom, transparent, rgba(19,22,41,0.9))',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: '10px',
                      left: '12px',
                      background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
                      borderRadius: '6px',
                      padding: '3px 8px',
                    }}
                  >
                    <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>
                      {ticket.ticketType.name.toUpperCase()}
                    </span>
                  </div>
                  <div
                    style={{
                      position: 'absolute',
                      top: '10px',
                      right: '12px',
                      background: 'rgba(0,0,0,0.5)',
                      backdropFilter: 'blur(8px)',
                      borderRadius: '8px',
                      padding: '5px 8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    <QrCode size={13} color="#A78BFA" />
                    <span style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 600 }}>
                      View QR
                    </span>
                  </div>
                </div>

                {/* Ticket info */}
                <div style={{ padding: '14px' }}>
                  <h3
                    style={{
                      color: '#F0F0FF',
                      fontSize: '15px',
                      fontWeight: 700,
                      marginBottom: '8px',
                    }}
                  >
                    {ticket.event.title}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Calendar size={12} color="#8B8FA8" />
                      <span style={{ color: '#C4C9E0', fontSize: '12px' }}>
                        {ticket.event.date} · {ticket.event.time}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <MapPin size={12} color="#8B8FA8" />
                      <span style={{ color: '#C4C9E0', fontSize: '12px' }}>
                        {ticket.event.venue}, {ticket.event.city}
                      </span>
                    </div>
                  </div>

                  {/* Footer row */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingTop: '10px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div>
                      <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
                        {ticket.quantity} × {ticket.ticketType.name}
                      </span>
                    </div>
                    <span style={{ color: '#FFB830', fontSize: '15px', fontWeight: 800 }}>
                      {formatPrice(ticket.totalAmount)}
                    </span>
                  </div>

                  {/* Ticket ID */}
                  <div
                    style={{
                      marginTop: '8px',
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: '8px',
                      padding: '6px 10px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Ticket ID</span>
                    <span style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 600, fontFamily: 'monospace' }}>
                      {ticket.ticketId}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

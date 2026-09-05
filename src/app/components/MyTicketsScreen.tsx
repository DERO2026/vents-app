import { useState, useRef, useEffect, useCallback } from 'react';
import { Ticket, Calendar, MapPin, QrCode, RefreshCw, Send, Check, X, Clock } from 'lucide-react';
import { PurchasedTicket, TicketTransfer } from './types';
import { formatPrice } from './data';
import { SkeletonCard } from './SkeletonCard';
import { ticketDisplayCode } from '../../lib/ticketCode';
import { prefetchTicketTokens } from '../../lib/ticketToken';
import { supabase } from '../../lib/supabase';

interface MyTicketsScreenProps {
  tickets: PurchasedTicket[];
  loading?: boolean;
  onBack: () => void;
  onViewTicket: (ticket: PurchasedTicket) => void;
  onRefresh?: () => Promise<void>;
  currentUserId?: string;
}

export function MyTicketsScreen({ tickets, loading, onBack, onViewTicket, onRefresh, currentUserId }: MyTicketsScreenProps) {
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past' | 'transfers'>('upcoming');
  const [refreshing, setRefreshing] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  // Warm the signed-token cache for every visible ticket the moment the list
  // loads, so tapping a ticket renders its QR instantly instead of showing
  // "Generating secure pass…" while a token is minted on demand.
  useEffect(() => {
    prefetchTicketTokens(tickets.map((t) => t.ticketId));
  }, [tickets]);

  // Pending ticket transfers involving this user, either direction --
  // fetched client-side same as WalletScreen fetches its own supplementary
  // data. RLS (ticket_transfers_involved_read) already scopes this to only
  // rows where the caller is from_user_id or to_user_id.
  const [transfers, setTransfers] = useState<TicketTransfer[]>([]);
  const [transferActionBusy, setTransferActionBusy] = useState<string | null>(null);
  const [transferActionError, setTransferActionError] = useState('');

  const loadTransfers = useCallback(async () => {
    if (!currentUserId) return;
    const { data, error } = await supabase
      .from('ticket_transfers')
      .select('id, ticket_id, from_user_id, to_user_id, to_identifier, status, created_at, expires_at, tickets(ticket_type, events(title))')
      .or(`from_user_id.eq.${currentUserId},to_user_id.eq.${currentUserId}`)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) { console.error('Failed to load ticket transfers:', error); return; }
    const mapped: TicketTransfer[] = (data || []).map((r: any) => ({
      id: r.id,
      ticketId: r.ticket_id,
      fromUserId: r.from_user_id,
      toUserId: r.to_user_id,
      toIdentifier: r.to_identifier,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      eventTitle: r.tickets?.events?.title,
      ticketTypeLabel: r.tickets?.ticket_type,
    }));
    setTransfers(mapped);
  }, [currentUserId]);

  useEffect(() => { loadTransfers(); }, [loadTransfers]);

  const handleAcceptTransfer = async (transferId: string) => {
    setTransferActionBusy(transferId);
    setTransferActionError('');
    try {
      const { error } = await supabase.rpc('accept_ticket_transfer', { p_transfer_id: transferId });
      if (error) throw new Error(error.message);
      await loadTransfers();
      if (onRefresh) await onRefresh();
    } catch (e: any) {
      setTransferActionError(e?.message || 'Could not accept this transfer.');
    } finally {
      setTransferActionBusy(null);
    }
  };

  const handleDeclineTransfer = async (transferId: string) => {
    setTransferActionBusy(transferId);
    setTransferActionError('');
    try {
      const { error } = await supabase.rpc('decline_ticket_transfer', { p_transfer_id: transferId });
      if (error) throw new Error(error.message);
      await loadTransfers();
    } catch (e: any) {
      setTransferActionError(e?.message || 'Could not decline this transfer.');
    } finally {
      setTransferActionBusy(null);
    }
  };

  const handleCancelTransfer = async (transferId: string) => {
    setTransferActionBusy(transferId);
    setTransferActionError('');
    try {
      const { error } = await supabase.rpc('cancel_ticket_transfer', { p_transfer_id: transferId });
      if (error) throw new Error(error.message);
      await loadTransfers();
    } catch (e: any) {
      setTransferActionError(e?.message || 'Could not cancel this transfer.');
    } finally {
      setTransferActionBusy(null);
    }
  };

  const incomingTransfers = transfers.filter((t) => t.toUserId === currentUserId);
  const outgoingTransfers = transfers.filter((t) => t.fromUserId === currentUserId);

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
    if (dy > 400 && Math.abs(dy) > Math.abs(dx)) {
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

  // 'transfers' doesn't use `displayed` at all -- it renders the incoming/
  // outgoing transfer lists below instead of ticket cards.
  const displayed = activeTab === 'upcoming' ? upcoming : activeTab === 'past' ? past : [];

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        background: '#020005',
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
          justifyContent: 'space-between',
          gap: '12px',
          padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
          position: 'relative',
        }}
      >
        <div style={{ width: '36px', flexShrink: 0 }} />
        <h1
          style={{
            color: '#FFFFFF',
            fontSize: '20px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            position: 'absolute',
            left: 0,
            right: 0,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          My Tickets
        </h1>
        {onRefresh && (
          <button
            onClick={handleRefresh}
            style={{
              background: '#090514',
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
            background: '#090514',
            borderRadius: '100px',
            padding: '4px',
            gap: '3px',
          }}
        >
          {(['upcoming', 'past', 'transfers'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1,
                padding: '9px',
                borderRadius: '100px',
                border: 'none',
                background:
                  activeTab === tab
                    ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)'
                    : 'transparent',
                color: activeTab === tab ? '#FFFFFF' : '#94A3B8',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {tab === 'upcoming' ? 'Upcoming' : tab === 'past' ? 'Past' : 'Transfers'}{' '}
              <span
                style={{
                  background: activeTab === tab ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
                  borderRadius: '4px',
                  padding: '1px 6px',
                  fontSize: '11px',
                }}
              >
                {tab === 'upcoming' ? upcoming.length : tab === 'past' ? past.length : transfers.length}
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
          // BottomNav is position:absolute, 70px tall + its own safe-area
          // padding — a flat 24px left the last ticket card partially hidden
          // behind it on shorter-safe-area devices. Matches the same
          // clearance convention already used by Home/Explore/Profile/Saved.
          padding: '0 16px calc(90px + env(safe-area-inset-bottom))',
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
        }}
      >
        {/* Transfers is now its own tab (Upcoming | Past | Transfers)
            instead of these lists sitting above Upcoming regardless of
            which tab was selected -- same accept/decline/cancel RPCs and
            handlers below, just gated on activeTab now. */}
        {activeTab === 'transfers' && transferActionError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '10px 14px', marginBottom: '12px' }}>
            <span style={{ color: '#F87171', fontSize: '12px' }}>{transferActionError}</span>
          </div>
        )}

        {activeTab === 'transfers' && incomingTransfers.length === 0 && outgoingTransfers.length === 0 && (
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
                background: '#090514',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Send size={32} color="#94A3B8" />
            </div>
            <p style={{ color: '#94A3B8', fontSize: '14px', fontWeight: 600, textAlign: 'center', padding: '0 16px' }}>
              No pending ticket transfers right now.
            </p>
          </div>
        )}

        {activeTab === 'transfers' && incomingTransfers.length > 0 && (
          <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, color: '#8B8FA8', letterSpacing: '0.06em', textTransform: 'uppercase', margin: 0 }}>Incoming Ticket Transfers</p>
            {incomingTransfers.map((t) => (
              <div key={t.id} style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '16px', padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <Send size={14} color="#C4B5FD" />
                  <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>{t.eventTitle || 'A ticket'} {t.ticketTypeLabel ? `· ${t.ticketTypeLabel}` : ''}</span>
                </div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 10px' }}>Someone wants to transfer this ticket to you · expires {new Date(t.expiresAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => handleAcceptTransfer(t.id)}
                    disabled={transferActionBusy === t.id}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '10px', padding: '9px', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: transferActionBusy === t.id ? 0.6 : 1 }}
                  >
                    <Check size={13} /> Accept
                  </button>
                  <button
                    onClick={() => handleDeclineTransfer(t.id)}
                    disabled={transferActionBusy === t.id}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '9px', color: '#C4C9E0', fontSize: '12px', fontWeight: 600, cursor: 'pointer', opacity: transferActionBusy === t.id ? 0.6 : 1 }}
                  >
                    <X size={13} /> Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'transfers' && outgoingTransfers.length > 0 && (
          <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ fontSize: '12px', fontWeight: 700, color: '#8B8FA8', letterSpacing: '0.06em', textTransform: 'uppercase', margin: 0 }}>Pending Outgoing Transfers</p>
            {outgoingTransfers.map((t) => (
              <div key={t.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <Clock size={13} color="#F59E0B" />
                  <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>{t.eventTitle || 'A ticket'} {t.ticketTypeLabel ? `· ${t.ticketTypeLabel}` : ''}</span>
                </div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 10px' }}>Awaiting {t.toIdentifier} to accept · expires {new Date(t.expiresAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</p>
                <button
                  onClick={() => handleCancelTransfer(t.id)}
                  disabled={transferActionBusy === t.id}
                  style={{ width: '100%', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '9px', color: '#F87171', fontSize: '12px', fontWeight: 600, cursor: 'pointer', opacity: transferActionBusy === t.id ? 0.6 : 1 }}
                >
                  Cancel Transfer
                </button>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'transfers' ? null : loading ? (
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
                background: '#090514',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ticket size={32} color="#94A3B8" />
            </div>
            <div style={{ textAlign: 'center', padding: '0 16px' }}>
              <p style={{ color: '#94A3B8', fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
                {activeTab === 'upcoming'
                  ? (past.length > 0
                      ? "You don't have any upcoming tickets right now."
                      : "Seems like you haven't reserved any ticket yet, we are here to help!")
                  : 'Your expired tickets will appear here!'}
              </p>
              {activeTab === 'past' && (
                <p style={{ color: '#94A3B8', fontSize: '14px', marginBottom: '16px' }}>
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
                  background: '#090514',
                  border: '1px solid rgba(255,255,255,0.05)',
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
                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '20px 20px 0 0' }}
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
                      background: 'rgba(123,47,190,0.15)',
                      border: '1px solid #7B2FBE',
                      borderRadius: '100px',
                      padding: '3px 8px',
                    }}
                  >
                    <span style={{ color: '#C084FC', fontSize: '10px', fontWeight: 700 }}>
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
                    <QrCode size={13} color="#7B2FBE" />
                    <span style={{ color: '#7B2FBE', fontSize: '14px', fontWeight: 600 }}>
                      View QR
                    </span>
                  </div>
                </div>

                {/* Ticket info */}
                <div style={{ padding: '14px' }}>
                  <h3
                    style={{
                      color: '#FFFFFF',
                      fontSize: '16px',
                      fontWeight: 700,
                      marginBottom: '8px',
                    }}
                  >
                    {ticket.event.title}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Calendar size={12} color="#94A3B8" />
                      <span style={{ color: '#94A3B8', fontSize: '14px' }}>
                        {ticket.event.date} · {ticket.event.time}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <MapPin size={12} color="#94A3B8" />
                      <span style={{ color: '#94A3B8', fontSize: '14px' }}>
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
                      borderTop: '1px dashed rgba(255,255,255,0.1)',
                    }}
                  >
                    <div>
                      <span style={{ color: '#94A3B8', fontSize: '14px' }}>
                        {ticket.quantity} × {ticket.ticketType.name}
                      </span>
                    </div>
                    <span style={{ color: '#94A3B8', fontSize: '14px' }}>
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
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Ticket Reference No.</span>
                    <span style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 600, fontFamily: 'monospace', letterSpacing: '0.03em' }}>
                      {ticketDisplayCode(ticket.ticketId)}
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

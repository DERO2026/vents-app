import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Ticket, Calendar, MapPin, QrCode, RefreshCw, Send, Check, X, Clock, AlertCircle, CheckCircle, XCircle, Ban } from 'lucide-react';
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

// Short, consistent date/time format for transfer cards -- expiry, sent-at,
// and resolved-at all read the same way instead of three different styles.
function formatTransferDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', { dateStyle: 'medium' }) +
    ' · ' + new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
}

// Visual treatment for each terminal transfer status in History -- a
// resolved transfer is never shown as if it's still pending.
function transferStatusBadge(status: TicketTransfer['status']) {
  switch (status) {
    case 'accepted':
      return { label: 'Accepted', color: '#10B981', bg: 'rgba(16,185,129,0.14)', Icon: CheckCircle };
    case 'declined':
      return { label: 'Declined', color: '#EF4444', bg: 'rgba(239,68,68,0.14)', Icon: XCircle };
    case 'cancelled':
      return { label: 'Cancelled', color: '#94A3B8', bg: 'rgba(148,163,184,0.14)', Icon: Ban };
    case 'expired':
      return { label: 'Expired', color: '#F59E0B', bg: 'rgba(245,158,11,0.14)', Icon: Clock };
    default:
      return { label: status, color: '#94A3B8', bg: 'rgba(148,163,184,0.14)', Icon: Clock };
  }
}

function TransferEmptyState({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '56px', gap: '16px' }}>
      <div style={{ width: '64px', height: '64px', borderRadius: '18px', background: '#090514', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Send size={28} color="#94A3B8" />
      </div>
      <p style={{ color: '#94A3B8', fontSize: '13.5px', fontWeight: 600, textAlign: 'center', padding: '0 24px' }}>{text}</p>
    </div>
  );
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

  // ALL ticket transfers involving this user, either direction and any
  // status -- fetched client-side same as WalletScreen fetches its own
  // supplementary data. RLS (ticket_transfers_involved_read) already scopes
  // this to only rows where the caller is from_user_id or to_user_id.
  // Previously this only loaded status='pending' rows (there was no
  // History view yet); now it loads everything so accepted/declined/
  // cancelled transfers have somewhere to appear instead of just vanishing
  // once resolved.
  const [transfers, setTransfers] = useState<TicketTransfer[]>([]);
  const [transferActionBusy, setTransferActionBusy] = useState<string | null>(null);
  const [transferActionError, setTransferActionError] = useState('');
  const [transferSubTab, setTransferSubTab] = useState<'incoming' | 'outgoing' | 'history'>('incoming');

  const loadTransfers = useCallback(async () => {
    if (!currentUserId) return;
    const { data, error } = await supabase
      .from('ticket_transfers')
      .select('id, ticket_id, from_user_id, to_user_id, to_identifier, status, created_at, responded_at, expires_at, tickets(ticket_type, events(title))')
      .or(`from_user_id.eq.${currentUserId},to_user_id.eq.${currentUserId}`)
      .order('created_at', { ascending: false });
    if (error) { console.error('Failed to load ticket transfers:', error); return; }
    const rows = data || [];

    // Resolve a display name for whichever party ISN'T the current user, via
    // public_profiles (the same public-safe, RLS-open view used everywhere
    // else in the app to show another user's name by id) -- never a raw
    // email/phone, and never a direct query against `users` (which RLS
    // restricts to the row owner).
    const otherIds = Array.from(new Set(
      rows.map((r: any) => (r.from_user_id === currentUserId ? r.to_user_id : r.from_user_id))
    ));
    const profileMap: Record<string, string> = {};
    if (otherIds.length > 0) {
      const { data: profiles } = await supabase
        .from('public_profiles')
        .select('id, username, full_name')
        .in('id', otherIds);
      (profiles || []).forEach((p: any) => {
        profileMap[p.id] = p.username || p.full_name || 'a VENTS user';
      });
    }

    const mapped: TicketTransfer[] = rows.map((r: any) => {
      const otherId = r.from_user_id === currentUserId ? r.to_user_id : r.from_user_id;
      return {
        id: r.id,
        ticketId: r.ticket_id,
        fromUserId: r.from_user_id,
        toUserId: r.to_user_id,
        toIdentifier: r.to_identifier,
        status: r.status,
        createdAt: r.created_at,
        respondedAt: r.responded_at || undefined,
        expiresAt: r.expires_at,
        eventTitle: r.tickets?.events?.title,
        ticketTypeLabel: r.tickets?.ticket_type,
        counterpartyLabel: profileMap[otherId] || r.to_identifier,
      };
    });
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

  // Incoming/Outgoing show only what's actionable (status === 'pending');
  // everything resolved (accepted/declined/cancelled/expired) moves to
  // History instead -- a transfer is never shown as still-pending once the
  // server has resolved it.
  const incomingPending = transfers.filter((t) => t.toUserId === currentUserId && t.status === 'pending');
  const outgoingPending = transfers.filter((t) => t.fromUserId === currentUserId && t.status === 'pending');
  const transferHistory = transfers.filter((t) => t.status !== 'pending');

  // Ticket ids with an already-pending outgoing transfer -- initiate_ticket_
  // transfer's own unique index (ticket_transfers_one_pending_per_ticket)
  // is the real guard against a duplicate; this only hides the "Transfer
  // Ticket" button so a user doesn't tap it and get a server error for a
  // transfer they can already see pending in the Transfers tab.
  const ticketsWithPendingTransfer = useMemo(
    () => new Set(outgoingPending.map((t) => t.ticketId)),
    [outgoingPending]
  );

  // Standalone "Transfer this ticket" flow, reachable any time from an
  // eligible ticket in Upcoming -- not just right after purchase
  // (PaymentSuccessScreen has the same flow for that moment). Same RPC,
  // same recipient-identifier collection; initiate_ticket_transfer does
  // every real eligibility/ownership/recipient check server-side, this UI
  // gate (isTicketTransferable below) just avoids showing the action where
  // it would obviously fail.
  const [transferTicket, setTransferTicket] = useState<PurchasedTicket | null>(null);
  const [transferIdentifier, setTransferIdentifier] = useState('');
  const [transferSending, setTransferSending] = useState(false);
  const [initiateError, setInitiateError] = useState('');
  const [transferSent, setTransferSent] = useState(false);

  const isTicketTransferable = useCallback((ticket: PurchasedTicket) => {
    if (ticket.checkedIn) return false;
    const eventDate = ticket.event.event_date ? new Date(ticket.event.event_date) : null;
    if (eventDate && eventDate.getTime() < Date.now()) return false;
    if (ticketsWithPendingTransfer.has(ticket.ticketId)) return false;
    return true;
  }, [ticketsWithPendingTransfer]);

  const closeTransferModal = () => {
    setTransferTicket(null);
    setTransferIdentifier('');
    setInitiateError('');
    setTransferSent(false);
  };

  const handleSendTransfer = async () => {
    if (!transferTicket) return;
    const identifier = transferIdentifier.trim();
    if (!identifier) { setInitiateError("Enter the recipient's email or username"); return; }
    setTransferSending(true);
    setInitiateError('');
    try {
      const { error } = await supabase.rpc('initiate_ticket_transfer', {
        p_ticket_id: transferTicket.ticketId,
        p_recipient_identifier: identifier,
      });
      if (error) throw new Error(error.message);
      setTransferSent(true);
      setTransferIdentifier('');
      await loadTransfers();
    } catch (e: any) {
      setInitiateError(e?.message || 'Could not start the transfer. Please try again.');
    } finally {
      setTransferSending(false);
    }
  };

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

      {/* Tabs -- a single indicator glides between positions (translateX,
          transitioned) instead of each button's own background flipping on
          and off, so switching tabs reads as one smooth, premium motion. */}
      <div style={{ padding: '0 16px 14px' }}>
        <div
          style={{
            position: 'relative',
            display: 'flex',
            background: '#090514',
            borderRadius: '100px',
            padding: '4px',
            gap: '3px',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '4px',
              left: '4px',
              bottom: '4px',
              width: 'calc((100% - 8px) / 3)',
              borderRadius: '100px',
              background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
              transform: `translateX(${(['upcoming', 'past', 'transfers'] as const).indexOf(activeTab) * 100}%)`,
              transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
          {(['upcoming', 'past', 'transfers'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                position: 'relative',
                zIndex: 1,
                flex: 1,
                padding: '9px',
                borderRadius: '100px',
                border: 'none',
                background: 'transparent',
                color: activeTab === tab ? '#FFFFFF' : '#94A3B8',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'color 0.2s ease',
              }}
            >
              {tab === 'upcoming' ? 'Upcoming' : tab === 'past' ? 'Past' : 'Transfers'}{' '}
              <span
                style={{
                  background: activeTab === tab ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
                  borderRadius: '4px',
                  padding: '1px 6px',
                  fontSize: '11px',
                  transition: 'background 0.2s ease',
                }}
              >
                {tab === 'upcoming' ? upcoming.length : tab === 'past' ? past.length : incomingPending.length + outgoingPending.length}
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
        {/* Transfers is its own tab (Upcoming | Past | Transfers), split
            into Incoming / Outgoing / History sub-sections so a resolved
            transfer never sits mixed in with ones that still need action --
            same accept/decline/cancel RPCs and handlers as before, just
            reorganized. */}
        {activeTab === 'transfers' && (
          <>
            {transferActionError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '10px 14px', marginBottom: '12px' }}>
                <AlertCircle size={14} color="#F87171" style={{ flexShrink: 0 }} />
                <span style={{ color: '#F87171', fontSize: '12px' }}>{transferActionError}</span>
              </div>
            )}

            {/* Incoming / Outgoing / History segmented control */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
              {([
                { key: 'incoming' as const, label: 'Incoming', count: incomingPending.length },
                { key: 'outgoing' as const, label: 'Outgoing', count: outgoingPending.length },
                { key: 'history' as const, label: 'History', count: 0 },
              ]).map((sub) => (
                <button
                  key={sub.key}
                  onClick={() => setTransferSubTab(sub.key)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    padding: '9px 8px',
                    borderRadius: '12px',
                    border: transferSubTab === sub.key ? '1px solid rgba(168,85,247,0.4)' : '1px solid rgba(255,255,255,0.08)',
                    background: transferSubTab === sub.key ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.02)',
                    color: transferSubTab === sub.key ? '#C4B5FD' : '#8B8FA8',
                    fontSize: '12.5px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {sub.label}
                  {sub.count > 0 && (
                    <span style={{
                      minWidth: '16px', height: '16px', padding: '0 4px', borderRadius: '8px',
                      background: '#A855F7', color: '#fff', fontSize: '10px', fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {sub.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Incoming -- action required. Purple-accented cards make it
                obvious these need a response; Accept/Decline are disabled
                (not hidden) mid-request to block accidental double-taps
                without the buttons jumping around. */}
            {transferSubTab === 'incoming' && (
              incomingPending.length === 0 ? (
                <TransferEmptyState text="No incoming transfer requests right now." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {incomingPending.map((t) => (
                    <div key={t.id} style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '16px', padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                          <Send size={14} color="#C4B5FD" style={{ flexShrink: 0 }} />
                          <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.eventTitle || 'A ticket'}{t.ticketTypeLabel ? ` · ${t.ticketTypeLabel}` : ''}
                          </span>
                        </div>
                        <span style={{ flexShrink: 0, background: 'rgba(168,85,247,0.2)', color: '#C4B5FD', fontSize: '9px', fontWeight: 800, letterSpacing: '0.05em', padding: '3px 7px', borderRadius: '100px', textTransform: 'uppercase' }}>
                          Action needed
                        </span>
                      </div>
                      <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 10px' }}>
                        From <strong style={{ color: '#C4C9E0' }}>{t.counterpartyLabel}</strong> · {formatTransferDate(t.createdAt)} · expires {formatTransferDate(t.expiresAt)}
                      </p>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => handleAcceptTransfer(t.id)}
                          disabled={transferActionBusy === t.id}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '10px', padding: '9px', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: transferActionBusy === t.id ? 'not-allowed' : 'pointer', opacity: transferActionBusy === t.id ? 0.6 : 1 }}
                        >
                          <Check size={13} /> Accept
                        </button>
                        <button
                          onClick={() => handleDeclineTransfer(t.id)}
                          disabled={transferActionBusy === t.id}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '9px', color: '#C4C9E0', fontSize: '12px', fontWeight: 600, cursor: transferActionBusy === t.id ? 'not-allowed' : 'pointer', opacity: transferActionBusy === t.id ? 0.6 : 1 }}
                        >
                          <X size={13} /> Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* Outgoing -- pending only; terminal states live in History. */}
            {transferSubTab === 'outgoing' && (
              outgoingPending.length === 0 ? (
                <TransferEmptyState text="No outgoing transfers pending." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {outgoingPending.map((t) => (
                    <div key={t.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <Clock size={13} color="#F59E0B" />
                        <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.eventTitle || 'A ticket'}{t.ticketTypeLabel ? ` · ${t.ticketTypeLabel}` : ''}
                        </span>
                      </div>
                      <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 10px' }}>
                        Awaiting <strong style={{ color: '#C4C9E0' }}>{t.counterpartyLabel}</strong> to accept · expires {formatTransferDate(t.expiresAt)}
                      </p>
                      <button
                        onClick={() => handleCancelTransfer(t.id)}
                        disabled={transferActionBusy === t.id}
                        style={{ width: '100%', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '9px', color: '#F87171', fontSize: '12px', fontWeight: 600, cursor: transferActionBusy === t.id ? 'not-allowed' : 'pointer', opacity: transferActionBusy === t.id ? 0.6 : 1 }}
                      >
                        Cancel Transfer
                      </button>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* History -- read-only. Every terminal transfer (accepted/
                declined/cancelled/expired) lands here permanently; no
                action is ever offered on a resolved transfer. */}
            {transferSubTab === 'history' && (
              transferHistory.length === 0 ? (
                <TransferEmptyState text="No past transfers yet." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {transferHistory.map((t) => {
                    const badge = transferStatusBadge(t.status);
                    const BadgeIcon = badge.Icon;
                    const isOutgoing = t.fromUserId === currentUserId;
                    return (
                      <div key={t.id} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', gap: '8px' }}>
                          <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.eventTitle || 'A ticket'}{t.ticketTypeLabel ? ` · ${t.ticketTypeLabel}` : ''}
                          </span>
                          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px', background: badge.bg, color: badge.color, fontSize: '10px', fontWeight: 800, padding: '3px 8px', borderRadius: '100px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            <BadgeIcon size={11} /> {badge.label}
                          </span>
                        </div>
                        <p style={{ color: '#8B8FA8', fontSize: '11px', margin: 0 }}>
                          {isOutgoing ? 'To' : 'From'} <strong style={{ color: '#C4C9E0' }}>{t.counterpartyLabel}</strong> · {formatTransferDate(t.respondedAt || t.createdAt)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </>
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

                  {/* Transfer Ticket -- reachable any time on an eligible
                      owned ticket, not just right after purchase.
                      stopPropagation so this doesn't also open the QR view
                      underneath it. */}
                  {activeTab === 'upcoming' && isTicketTransferable(ticket) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setTransferTicket(ticket); }}
                      style={{
                        width: '100%', marginTop: '10px', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', gap: '6px', background: 'rgba(168,85,247,0.08)',
                        border: '1px solid rgba(168,85,247,0.25)', borderRadius: '10px', padding: '9px',
                        color: '#C4B5FD', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      <Send size={13} /> Transfer Ticket
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transfer Ticket modal -- same recipient-identifier flow and RPC as
          PaymentSuccessScreen's post-purchase transfer prompt; initiate_
          ticket_transfer does every real eligibility/ownership/recipient
          check server-side, this just collects the identifier and surfaces
          the RPC's own error message. */}
      {transferTicket && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#090514', borderRadius: '20px 20px 0 0', padding: '24px', width: '100%', maxWidth: '390px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <p style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: '#F0F0FF' }}>Transfer Ticket</p>
              <button onClick={closeTransferModal} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#8B8FA8' }}>
                <X size={18} />
              </button>
            </div>

            {transferSent ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '12px', padding: '14px 16px', margin: '16px 0' }}>
                  <CheckCircle size={18} color="#10B981" />
                  <span style={{ color: '#10B981', fontSize: '13px', lineHeight: 1.5 }}>
                    Transfer request sent. They have 48 hours to accept it from their own My Tickets — this ticket stays yours until then.
                  </span>
                </div>
                <button onClick={closeTransferModal} style={{ width: '100%', background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
                  Done
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: '13px', color: '#8B8FA8', margin: '0 0 18px', lineHeight: 1.5 }}>
                  Enter the VENTS email or username of the person you're transferring "{transferTicket.event.title}" to. They must already have a VENTS account. The request expires in 48 hours if not accepted.
                </p>
                <input
                  placeholder="Recipient email or username"
                  value={transferIdentifier}
                  onChange={e => setTransferIdentifier(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '15px', boxSizing: 'border-box', outline: 'none', marginBottom: '12px' }}
                />
                {initiateError && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
                    <AlertCircle size={14} color="#EF4444" />
                    <span style={{ color: '#EF4444', fontSize: '13px' }}>{initiateError}</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={closeTransferModal} style={{ flex: 1, background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '12px', padding: '14px', color: '#8B8FA8', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                  <button
                    onClick={handleSendTransfer}
                    disabled={transferSending || !transferIdentifier.trim()}
                    style={{ flex: 1, background: 'linear-gradient(135deg,#7C3AED,#A855F7)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontWeight: 700, cursor: (transferSending || !transferIdentifier.trim()) ? 'not-allowed' : 'pointer', opacity: (transferSending || !transferIdentifier.trim()) ? 0.6 : 1 }}
                  >
                    {transferSending ? 'Sending…' : 'Send Request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

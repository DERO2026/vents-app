import { useState, useEffect } from 'react';
import { ArrowLeft, Search, CheckCircle, XCircle, Download, Undo2 } from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { apiUrl } from '../../lib/apiBase';

interface AttendeeListScreenProps {
  onBack: () => void;
  eventId?: string;
  eventTitle?: string;
}

type CheckInStatus = 'checked-in' | 'pending' | 'cancelled';

interface Attendee {
  id: string;
  name: string;
  email: string;
  ticketType: string;
  ticketId: string;
  ticketIdShort: string;
  quantity: number;
  status: CheckInStatus;
  paymentStatus: string;
  initials: string;
  avatarColor: string;
  checkedInAt: string | null;
}

const AVATAR_COLORS = ['#EC4899', '#3B82F6', '#F59E0B', '#22C55E', '#8B5CF6', '#06B6D4', '#F97316', '#EF4444'];

function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const STATUS_CONFIG: Record<CheckInStatus, { color: string; bg: string; label: string; icon: React.ElementType }> = {
  'checked-in': { color: '#10B981', bg: 'rgba(16,185,129,0.1)', label: 'Checked In', icon: CheckCircle },
  pending: { color: '#F59E0B', bg: 'rgba(245,158,11,0.1)', label: 'Pending', icon: XCircle },
  cancelled: { color: '#EF4444', bg: 'rgba(239,68,68,0.1)', label: 'Cancelled', icon: XCircle },
};

export function AttendeeListScreen({ onBack, eventId, eventTitle }: AttendeeListScreenProps) {
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CheckInStatus | 'all'>('all');

  useEffect(() => {
    if (!eventId) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        // Uses the same gated, single-query RPC as the Door Manager dashboard
        // (get_event_attendees — authorized via is_event_door_manager) instead
        // of a raw `tickets -> users(*)` embed, which depended on an
        // over-broad `public.users` RLS policy that let ANY authenticated
        // user read every other user's row (email, phone, DOB, TOTP secret,
        // ban history) via any table/embed touching `users`. That policy has
        // been removed; this RPC only ever returns the safe attendee fields
        // needed here (holder_name/holder_email), scoped to the caller's own
        // event.
        //
        // The RPC itself caps p_limit at 200 per call (LEAST(p_limit, 200)),
        // so a single call was a hard ceiling on total attendees shown, and
        // this screen's "N / total" and search/filter all silently only ever
        // saw that first page. Loop pages of 200 by offset until a partial
        // page comes back — for a ticketing app, "the attendee list stops
        // working past 200 people" is a hard failure on the day it matters
        // most, not an edge case.
        const PAGE_SIZE = 200;
        let offset = 0;
        const allRows: any[] = [];
        for (;;) {
          const { data, error } = await insforge.database.rpc('get_event_attendees' as any, {
            p_event_id: eventId,
            p_search: null,
            p_filter: 'all',
            p_limit: PAGE_SIZE,
            p_offset: offset,
          });
          if (error) throw error;
          const rows = Array.isArray(data) ? data : [];
          allRows.push(...rows);
          if (rows.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
          // Sanity cap so a data anomaly can't spin this into an infinite
          // fetch loop — 20,000 attendees is far beyond any real event here.
          if (offset >= 20000) break;
        }

        if (cancelled) return;
        setAttendees(allRows.map((t) => {
          const name = t.holder_name || t.buyer_name || 'Unknown';
          const initials = name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
          const status: CheckInStatus =
            t.status !== 'active' ? 'cancelled' : t.checked_in ? 'checked-in' : 'pending';
          return {
            id: t.ticket_id,
            name,
            email: t.holder_email || '',
            ticketType: t.ticket_type || 'Regular',
            ticketId: t.ticket_id,
            ticketIdShort: t.ticket_id.slice(0, 8).toUpperCase(),
            quantity: 1,
            status,
            paymentStatus: t.payment_status,
            initials,
            avatarColor: colorForName(name),
            checkedInAt: t.checked_in_at || null,
          };
        }));
      } catch (err: any) {
        // A failed load previously rendered as an empty attendee list —
        // indistinguishable from "this event genuinely has no attendees",
        // with no retry.
        console.error('AttendeeListScreen load error', err);
        if (!cancelled) setLoadError(err?.message || 'Could not load attendees. Pull to refresh or try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [eventId, reloadKey]);

  const checkedIn = attendees.filter((a) => a.status === 'checked-in').length;
  const total = attendees.filter((a) => a.status !== 'cancelled').length;

  const filtered = attendees.filter((a) => {
    const matchQ =
      !query ||
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.email.toLowerCase().includes(query.toLowerCase()) ||
      a.ticketIdShort.toLowerCase().includes(query.toLowerCase());
    const matchS = statusFilter === 'all' || a.status === statusFilter;
    return matchQ && matchS;
  });

  const [refundingId, setRefundingId] = useState<string | null>(null);
  // Replaces window.prompt (reason) + window.confirm + window.alert(error) —
  // unreliable inside a Capacitor WebView, and jarring where they do work;
  // every other confirm/error surface in this app uses in-app UI.
  const [refundTarget, setRefundTarget] = useState<Attendee | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [refundError, setRefundError] = useState<string | null>(null);

  const openRefundDialog = (attendee: Attendee) => {
    setRefundTarget(attendee);
    setRefundReason('');
    setRefundError(null);
  };

  const confirmRefund = async () => {
    const attendee = refundTarget;
    if (!attendee) return;
    if (!refundReason.trim()) { setRefundError('A reason is required — this is shown to the attendee.'); return; }

    setRefundingId(attendee.id);
    setRefundError(null);
    try {
      const token = await getAuthToken();
      const res = await fetch(apiUrl('/api/wallet/refund-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ticket_id: attendee.ticketId, reason: refundReason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Refund failed');

      setAttendees((prev) =>
        prev.map((a) =>
          a.id === attendee.id
            ? { ...a, status: 'cancelled', paymentStatus: json.status === 'refunded' ? 'refunded' : 'refund_pending' }
            : a
        )
      );
      setRefundTarget(null);
    } catch (err: any) {
      setRefundError(err.message || 'Refund failed');
    } finally {
      setRefundingId(null);
    }
  };

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`input::placeholder { color: #8B8FA8; }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={onBack} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
          <div>
            <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Attendees</h1>
            <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{eventTitle || 'Event attendees'}</p>
          </div>
        </div>
        <button style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
          <Download size={14} color="#A78BFA" />
          <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 600 }}>Export</span>
        </button>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontSize: '14px' }}>
          Loading attendees…
        </div>
      ) : loadError ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center', gap: '12px' }}>
          <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Couldn't load attendees</p>
          <p style={{ color: '#8B8FA8', fontSize: '13px' }}>{loadError}</p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            style={{ background: 'rgba(123,47,190,0.15)', border: '1px solid rgba(123,47,190,0.4)', borderRadius: '10px', padding: '8px 16px', color: '#C4B5FD', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      ) : !eventId ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontSize: '14px', padding: '24px', textAlign: 'center' }}>
          Select an event from Manage Events to view its attendees.
        </div>
      ) : (
        <>
          {/* Check-in progress */}
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Check-in Progress</p>
                <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 800 }}>{checkedIn} / {total}</span>
              </div>
              <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px' }}>
                <div style={{ height: '100%', width: `${total > 0 ? (checkedIn / total) * 100 : 0}%`, borderRadius: '3px', background: 'linear-gradient(90deg, #10B981, #06B6D4)', transition: 'width 0.3s ease' }} />
              </div>
              <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '5px' }}>
                {total > 0 ? Math.round((checkedIn / total) * 100) : 0}% checked in
              </p>
            </div>
          </div>

          {/* Search */}
          <div style={{ padding: '0 16px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '10px 14px' }}>
              <Search size={16} color="#8B8FA8" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email or ticket ID..." style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }} />
            </div>
          </div>

          {/* Status filter */}
          <div style={{ display: 'flex', gap: '8px', padding: '0 16px 12px', overflowX: 'auto', scrollbarWidth: 'none' }}>
            {(['all', 'checked-in', 'pending', 'cancelled'] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{ flexShrink: 0, padding: '7px 14px', borderRadius: '20px', border: 'none', background: statusFilter === s ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629', color: statusFilter === s ? '#fff' : '#8B8FA8', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                {s === 'all' ? 'All' : s === 'checked-in' ? 'Checked In' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {/* Attendee list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px', scrollbarWidth: 'none' }}>
            {attendees.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 16px', color: '#8B8FA8', fontSize: '14px' }}>No attendees yet.</div>
            ) : (
              <>
                <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '10px' }}>{filtered.length} attendee{filtered.length !== 1 ? 's' : ''}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {filtered.map((attendee) => {
                    const sc = STATUS_CONFIG[attendee.status];
                    const StatusIcon = sc.icon;
                    return (
                      <div key={attendee.id} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '14px', padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: attendee.avatarColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: '#fff', fontWeight: 700, flexShrink: 0 }}>
                          {attendee.initials}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{attendee.name}</p>
                          <p style={{ color: '#8B8FA8', fontSize: '11px' }}>{attendee.email}</p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                            <span style={{ background: 'rgba(167,139,250,0.1)', color: '#A78BFA', fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px' }}>{attendee.ticketType}</span>
                            <span style={{ color: '#8B8FA8', fontSize: '10px', fontFamily: 'monospace' }}>{attendee.ticketIdShort}</span>
                            {attendee.quantity > 1 && <span style={{ color: '#8B8FA8', fontSize: '10px' }}>×{attendee.quantity}</span>}
                            {attendee.paymentStatus === 'refunded' && (
                              <span style={{ color: '#EF4444', fontSize: '10px', fontWeight: 600 }}>Refunded</span>
                            )}
                            {attendee.paymentStatus === 'refund_pending' && (
                              <span style={{ color: '#F59E0B', fontSize: '10px', fontWeight: 600 }}>Refund pending</span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                          {attendee.paymentStatus === 'paid' && (
                            <button
                              onClick={() => openRefundDialog(attendee)}
                              disabled={refundingId === attendee.id}
                              title="Refund this ticket"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '8px', width: '30px', height: '30px', cursor: refundingId === attendee.id ? 'wait' : 'pointer' }}
                            >
                              <Undo2 size={13} color="#EF4444" />
                            </button>
                          )}
                          {/* Read-only — reflects the real check-in ledger. Use Door Manager to check attendees in. */}
                          <div title={attendee.checkedInAt ? `Checked in ${new Date(attendee.checkedInAt).toLocaleString()}` : undefined} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: sc.bg, borderRadius: '8px', padding: '6px 10px' }}>
                            <StatusIcon size={13} color={sc.color} />
                            <span style={{ color: sc.color, fontSize: '11px', fontWeight: 600 }}>{sc.label}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {refundTarget && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
          onClick={() => { if (refundingId !== refundTarget.id) setRefundTarget(null); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#0B0B14', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '20px', width: '100%', maxWidth: '360px' }}
          >
            <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, marginBottom: '6px' }}>
              Refund {refundTarget.name}'s ticket?
            </p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '14px' }}>
              This cancels the {refundTarget.ticketType} ticket and cannot be undone.
            </p>
            <textarea
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="Reason for the refund (shown to the attendee)"
              rows={3}
              style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', resize: 'none', marginBottom: '8px', boxSizing: 'border-box' }}
            />
            {refundError && (
              <p style={{ color: '#EF4444', fontSize: '12px', marginBottom: '8px' }}>{refundError}</p>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <button
                onClick={() => setRefundTarget(null)}
                disabled={refundingId === refundTarget.id}
                style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: '12px', padding: '12px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmRefund}
                disabled={refundingId === refundTarget.id}
                style={{ flex: 1, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '12px', padding: '12px', color: '#EF4444', fontSize: '14px', fontWeight: 700, cursor: refundingId === refundTarget.id ? 'wait' : 'pointer' }}
              >
                {refundingId === refundTarget.id ? 'Refunding…' : 'Refund Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

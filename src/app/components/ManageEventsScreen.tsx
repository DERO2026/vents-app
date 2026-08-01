import { useMemo, useState } from 'react';
import {
  ArrowLeft, Users, Search, Calendar, MapPin, Edit2, Lock, Zap, MoreVertical,
  Trash2, EyeOff, Eye, Wifi, WifiOff, ArrowUpDown, RefreshCw, AlertCircle,
  ScanLine, DoorOpen, BarChart3, Ticket, Clock, Flame,
} from 'lucide-react';
import { formatPrice } from './data';
import { OrganizerEventOverview, OrganizerEventDisplayStatus } from './types';
import { useOrganizerEvents, OrganizerEventSort } from '../../lib/useOrganizerEvents';
import { insforge } from '../../lib/insforge';

interface ManageEventsScreenProps {
  onBack: () => void;
  currentUser: { id: string } | null;
  onOpenEdit: (eventId: string) => void;
  onCreateEvent: () => void;
  onViewAttendees: (event: OrganizerEventOverview) => void;
  onViewAnalytics: (event: OrganizerEventOverview) => void;
  onOpenDoorManager: (event: OrganizerEventOverview) => void;
  onOpenScanner: (event: OrganizerEventOverview) => void;
  onPromoteEvent?: (eventId: string) => void;
  // Called immediately after a successful soft-delete so the caller can
  // evict the event from any other in-memory cache it holds (Home feed,
  // Saved, event-details) — this screen's own list already self-heals via
  // useOrganizerEvents' refresh, but nothing else in the app knows to.
  onEventDeleted?: (eventId: string) => void;
}

// ─── Midnight Neon palette (shared with Door Manager for a consistent
// organizer-tools look) ────────────────────────────────────────────────────
const C = {
  bg: '#020005', card: '#090514', line: 'rgba(255,255,255,0.06)',
  text: '#F0F0FF', sub: '#8B8FA8', faint: '#555C7A',
  purple: '#A78BFA', purpleDeep: '#7B2FBE',
  green: '#10B981', greenGlow: 'rgba(16,185,129,0.16)',
  red: '#EF4444', gold: '#FFB830', blue: '#3B82F6',
};

const STATUS_META: Record<OrganizerEventDisplayStatus, { bg: string; color: string; border: string; label: string; icon: any; dot?: boolean }> = {
  live:      { bg: 'rgba(16,185,129,0.12)', color: C.green, border: 'rgba(16,185,129,0.3)', label: 'Live',      icon: Zap, dot: true },
  draft:     { bg: 'rgba(139,143,168,0.1)', color: C.sub,   border: 'rgba(139,143,168,0.2)', label: 'Draft',     icon: Edit2 },
  ended:     { bg: 'rgba(139,143,168,0.1)', color: C.faint, border: 'rgba(255,255,255,0.08)', label: 'Ended',    icon: Clock },
  sold_out:  { bg: 'rgba(255,184,48,0.12)', color: C.gold,  border: 'rgba(255,184,48,0.35)',  label: 'Sold Out', icon: Flame },
};

function isEditLocked(ev: OrganizerEventOverview): boolean {
  if (!ev.eventDate || ev.status !== 'live') return false;
  const days = (new Date(ev.eventDate).getTime() - Date.now()) / 86400000;
  return days >= 0 && days <= 3;
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'No date set';
  try { return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}

export function ManageEventsScreen({
  onBack, currentUser, onOpenEdit, onCreateEvent, onViewAttendees, onViewAnalytics,
  onOpenDoorManager, onOpenScanner, onPromoteEvent, onEventDeleted,
}: ManageEventsScreenProps) {
  const { events, loading, error, sort, setSort, live, refresh } = useOrganizerEvents(currentUser?.id);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [optionsEvent, setOptionsEvent] = useState<OrganizerEventOverview | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrganizerEventOverview | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  // Confirmation gate specifically for hiding a LIVE event that already has
  // sold tickets — flipping it to draft pulls it from every public feed
  // instantly, with no warning to the organizer and no notice to buyers who
  // already hold a ticket for it.
  const [hideWarningTarget, setHideWarningTarget] = useState<OrganizerEventOverview | null>(null);

  const filtered = useMemo(
    () => events.filter((e) => !query || e.title.toLowerCase().includes(query.toLowerCase())),
    [events, query]
  );

  async function handleRefresh() {
    setRefreshing(true);
    await refresh(true);
    setRefreshing(false);
  }

  async function toggleHide(event: OrganizerEventOverview) {
    // Only warn on the live -> draft direction, and only when it actually
    // has buyers — going draft -> live, or hiding an event nobody has
    // bought into yet, needs no extra confirmation.
    if (event.status !== 'draft' && (event.soldCount > 0 || event.soldQuantity > 0) && hideWarningTarget?.id !== event.id) {
      setHideWarningTarget(event);
      return;
    }
    setHideWarningTarget(null);
    setToggling(event.id);
    const newStatus = event.status === 'draft' ? 'live' : 'draft';
    try {
      const { error: err } = await insforge.database.from('events').update({ status: newStatus }).eq('id', event.id);
      if (err) throw err;
      setActionMsg({ id: event.id, text: newStatus === 'live' ? 'Event is now live' : 'Event hidden as a draft' });
      refresh(true);
    } catch (e: any) {
      setActionMsg({ id: event.id, text: e?.message || 'Could not update event', error: true });
    } finally {
      setToggling(null);
      setOptionsEvent(null);
      setTimeout(() => setActionMsg(null), 3000);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // Soft delete only — public.tickets.event_id is ON DELETE RESTRICT, so
      // a real DELETE would be rejected once any ticket exists anyway. This
      // preserves ticket/payment history and can be restored by an admin.
      const { error: err } = await insforge.database.rpc('soft_delete_event', { p_event_id: deleteTarget.id });
      if (err) throw err;
      onEventDeleted?.(deleteTarget.id);
      setDeleteTarget(null);
      refresh(true);
    } catch (e: any) {
      setActionMsg({ id: deleteTarget.id, text: e?.message || 'Could not delete event', error: true });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div style={{ background: C.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', fontFamily: 'Inter, sans-serif' }}>
      <style>{`
        input::placeholder { color: ${C.sub}; }
        @keyframes ventsCardIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes ventsSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes ventsFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .vents-manage-card { animation: ventsCardIn 0.28s ease-out backwards; transition: border-color 0.2s ease, transform 0.15s ease; }
        .vents-manage-card:active { transform: scale(0.99); }
        .vents-action-btn { transition: transform 0.12s ease, opacity 0.12s ease; }
        .vents-action-btn:active { transform: scale(0.95); }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button onClick={onBack} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <h1 style={{ color: C.text, fontSize: '20px', fontWeight: 700, margin: 0 }}>My Events</h1>
            <span title={live ? 'Live' : 'Reconnecting'} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 700, color: live ? C.green : C.faint }}>
              {live ? <Wifi size={11} /> : <WifiOff size={11} />}
            </span>
          </div>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} aria-label="Refresh" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: refreshing ? 'wait' : 'pointer', flexShrink: 0 }}>
          <RefreshCw size={15} color={C.sub} style={{ animation: refreshing ? 'ventsSpin 0.8s linear infinite' : 'none' }} />
          <style>{`@keyframes ventsSpin { to { transform: rotate(360deg); } }`}</style>
        </button>
      </div>

      {/* Search + sort */}
      <div style={{ padding: '0 16px 12px', display: 'flex', gap: '8px' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', background: C.card, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '10px 14px', minWidth: 0 }}>
          <Search size={16} color={C.sub} style={{ flexShrink: 0 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your events..."
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: C.text, fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
        </div>
        <button
          onClick={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest') as OrganizerEventSort)}
          title="Toggle sort order"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: C.card, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '0 14px', color: C.purple, fontSize: '12px', fontWeight: 700, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          <ArrowUpDown size={14} />
          {sort === 'newest' ? 'Newest' : 'Oldest'}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 100px', scrollbarWidth: 'none' }}>

        {/* Error banner */}
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '14px', padding: '12px 14px', marginBottom: '16px', animation: 'ventsFadeIn 0.2s ease-out' }}>
            <AlertCircle size={18} color={C.red} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ color: C.red, fontSize: '12.5px', fontWeight: 700, margin: 0 }}>Couldn't load your events</p>
              <p style={{ color: C.sub, fontSize: '11.5px', margin: '2px 0 0' }}>{error}</p>
            </div>
            <button onClick={() => refresh(false)} style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '6px 12px', color: C.red, fontSize: '11.5px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
              Retry
            </button>
          </div>
        )}

        {/* Loading skeletons */}
        {loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ height: 190, borderRadius: 18, background: C.card, border: `1px solid ${C.line}`, opacity: 0.6 - i * 0.1 }} />
            ))}
          </div>
        )}

        {/* Event cards */}
        {!loading && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filtered.map((event, idx) => {
              const meta = STATUS_META[event.displayStatus];
              const StatusIcon = meta.icon;
              const locked = isEditLocked(event);
              const pct = event.ticketGoal > 0 ? Math.min(100, Math.round((event.soldQuantity / event.ticketGoal) * 100)) : 0;
              return (
                <div
                  key={event.id}
                  className="vents-manage-card"
                  style={{ background: C.card, border: `1px solid ${meta.border}`, borderRadius: '18px', overflow: 'hidden', animationDelay: `${Math.min(idx, 8) * 30}ms` }}
                >
                  <div style={{ height: '4px', background: event.displayStatus === 'live' ? 'linear-gradient(90deg, #10B981, #3B82F6)' : event.displayStatus === 'sold_out' ? '#FFB830' : event.displayStatus === 'ended' ? '#2A2D3E' : '#2A2D3E' }} />

                  <div style={{ padding: '14px' }}>
                    {/* Status + title */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: C.text, fontSize: '15px', fontWeight: 700, marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {event.title || '(Untitled Event)'}
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          {meta.dot && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: meta.color, display: 'inline-block', boxShadow: `0 0 6px ${meta.color}` }} />}
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: meta.bg, color: meta.color, fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', border: `1px solid ${meta.border}` }}>
                            <StatusIcon size={10} />{meta.label}
                          </span>
                        </div>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); setOptionsEvent(event); }} className="vents-action-btn" style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '8px', padding: '7px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <MoreVertical size={16} color={C.purple} />
                      </button>
                    </div>

                    {actionMsg?.id === event.id && (
                      <div style={{ color: actionMsg.error ? C.red : C.green, fontSize: '11.5px', fontWeight: 600, marginBottom: '8px' }}>{actionMsg.text}</div>
                    )}

                    {/* Meta */}
                    <div style={{ display: 'flex', gap: '14px', marginBottom: '12px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Calendar size={11} color={C.sub} />
                        <span style={{ color: C.sub, fontSize: '11px' }}>{fmtDate(event.eventDate)}</span>
                      </div>
                      {event.location && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                          <MapPin size={11} color={C.sub} style={{ flexShrink: 0 }} />
                          <span style={{ color: C.sub, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>{event.location}</span>
                        </div>
                      )}
                      <span style={{ color: C.purple, fontSize: '11px', fontWeight: 600 }}>
                        {event.price > 0 ? formatPrice(event.price) : 'Free'}
                      </span>
                    </div>

                    {/* Live stats row — always real DB data, never placeholder */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '12px' }}>
                      <Stat label="Sold" value={`${event.soldQuantity}${event.ticketGoal > 0 ? `/${event.ticketGoal}` : ''}`} />
                      <Stat label="Revenue" value={formatPrice(event.revenueKobo / 100)} />
                      <Stat label="Checked In" value={String(event.checkedInCount)} />
                    </div>
                    {event.ticketGoal > 0 && (
                      <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '100px', height: '5px', overflow: 'hidden', marginBottom: '12px' }}>
                        <div style={{ background: event.isSoldOut ? C.gold : 'linear-gradient(90deg,#7B2FBE,#4F46E5)', borderRadius: '100px', height: '100%', width: `${pct}%`, transition: 'width 0.4s ease' }} />
                      </div>
                    )}

                    {/* Lock notice */}
                    {locked && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '8px 12px', marginBottom: '10px' }}>
                        <Lock size={13} color={C.red} />
                        <span style={{ color: C.red, fontSize: '11px', fontWeight: 600 }}>Event is within 3 days — editing is locked</span>
                      </div>
                    )}

                    {/* Primary actions */}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <ActionBtn icon={locked ? <Lock size={12} /> : <Edit2 size={12} />} label={locked ? 'Locked' : 'Edit'} color={C.purple} disabled={locked} onClick={() => onOpenEdit(event.id)} />
                      <ActionBtn icon={<Users size={12} />} label="Attendees" color={C.blue} onClick={() => onViewAttendees(event)} />
                      <ActionBtn icon={<BarChart3 size={12} />} label="Analytics" color={C.green} onClick={() => onViewAnalytics(event)} />
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <ActionBtn icon={<DoorOpen size={12} />} label="Door Manager" color={C.gold} onClick={() => onOpenDoorManager(event)} />
                      <ActionBtn icon={<ScanLine size={12} />} label="Scan Tickets" color={C.gold} onClick={() => onOpenScanner(event)} />
                    </div>

                    {/* Promote — only meaningful for a live, not-yet-ended, not-sold-out event */}
                    {event.displayStatus === 'live' && onPromoteEvent && (
                      <button
                        onClick={() => onPromoteEvent(event.id)}
                        className="vents-action-btn"
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(79,70,229,0.15))', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '10px', padding: '9px', color: '#A855F7', fontSize: '12px', fontWeight: 700, cursor: 'pointer', marginTop: '8px' }}
                      >
                        <Zap size={12} />
                        Promote Event
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state — no events at all */}
        {!loading && !error && filtered.length === 0 && !query && (
          <div style={{ background: 'rgba(168,85,247,0.06)', border: '1.5px dashed rgba(168,85,247,0.2)', borderRadius: '18px', padding: '28px 20px', marginTop: '20px', textAlign: 'center', animation: 'ventsFadeIn 0.3s ease-out' }}>
            <div style={{ marginBottom: '10px' }}><Ticket size={36} color="#A855F7" strokeWidth={1.5} /></div>
            <p style={{ color: C.text, fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>No events yet</p>
            <p style={{ color: C.sub, fontSize: '13px', lineHeight: 1.6, marginBottom: '16px' }}>
              Create your first event and manage everything — tickets, attendees, and live sales — right here.
            </p>
            <button onClick={onCreateEvent} style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', padding: '11px 24px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
              + Create Event
            </button>
          </div>
        )}

        {/* Empty state — search matched nothing */}
        {!loading && !error && filtered.length === 0 && query && (
          <div style={{ textAlign: 'center', padding: '40px 16px', color: C.sub, fontSize: '13px' }}>
            No events match "{query}".
          </div>
        )}
      </div>

      {/* Options bottom sheet */}
      {optionsEvent && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 60, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', animation: 'ventsFadeIn 0.15s ease-out' }} onClick={() => setOptionsEvent(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: '24px 24px 0 0', border: `1px solid ${C.line}`, padding: '16px 0 calc(24px + env(safe-area-inset-bottom))', animation: 'ventsSheetUp 0.25s cubic-bezier(0.16,1,0.3,1)' }}>
            <div style={{ width: '36px', height: '4px', background: 'rgba(255,255,255,0.12)', borderRadius: '2px', margin: '0 auto 16px' }} />
            <p style={{ color: C.text, fontSize: '14px', fontWeight: 700, padding: '0 20px 12px', borderBottom: `1px solid ${C.line}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{optionsEvent.title}</p>
            {[
              { icon: <Edit2 size={18} />, label: isEditLocked(optionsEvent) ? 'Edit (locked)' : 'Edit', color: C.purple, disabled: isEditLocked(optionsEvent), action: () => { onOpenEdit(optionsEvent.id); setOptionsEvent(null); } },
              ...(onPromoteEvent && optionsEvent.displayStatus === 'live' ? [{ icon: <Zap size={18} />, label: 'Promote', color: C.gold, action: () => { onPromoteEvent(optionsEvent.id); setOptionsEvent(null); } }] : []),
              { icon: <Users size={18} />, label: 'Attendees', color: C.blue, action: () => { onViewAttendees(optionsEvent); setOptionsEvent(null); } },
              { icon: <BarChart3 size={18} />, label: 'Analytics', color: C.green, action: () => { onViewAnalytics(optionsEvent); setOptionsEvent(null); } },
              { icon: <DoorOpen size={18} />, label: 'Door Manager', color: C.gold, action: () => { onOpenDoorManager(optionsEvent); setOptionsEvent(null); } },
              { icon: <ScanLine size={18} />, label: 'Scan Tickets', color: C.gold, action: () => { onOpenScanner(optionsEvent); setOptionsEvent(null); } },
              { icon: optionsEvent.status === 'draft' ? <Eye size={18} /> : <EyeOff size={18} />, label: toggling === optionsEvent.id ? 'Working…' : (optionsEvent.status === 'draft' ? 'Make Live' : 'Hide as Draft'), color: C.sub, disabled: toggling === optionsEvent.id, action: () => toggleHide(optionsEvent) },
              { icon: <Trash2 size={18} />, label: 'Delete Event', color: C.red, action: () => { setDeleteTarget(optionsEvent); setOptionsEvent(null); } },
            ].map((item: any, i) => (
              <button key={i} onClick={item.action} disabled={item.disabled} className="vents-action-btn" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 20px', background: 'none', border: 'none', cursor: item.disabled ? 'not-allowed' : 'pointer', textAlign: 'left', opacity: item.disabled ? 0.5 : 1 }}>
                <span style={{ color: item.color }}>{item.icon}</span>
                <span style={{ color: item.color === C.red ? C.red : C.text, fontSize: '15px', fontWeight: 600 }}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Hide-as-draft warning (only when the event already has sold tickets) */}
      {hideWarningTarget && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', animation: 'ventsFadeIn 0.15s ease-out' }}>
          <div style={{ background: C.card, border: '1px solid rgba(245,158,11,0.3)', borderRadius: '20px', padding: '24px', width: '100%', maxWidth: '340px' }}>
            <EyeOff size={32} color="#F59E0B" style={{ marginBottom: '12px' }} />
            <p style={{ color: C.text, fontSize: '17px', fontWeight: 700, marginBottom: '8px' }}>Hide an event with sold tickets?</p>
            <p style={{ color: C.sub, fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
              "{hideWarningTarget.title}" has {hideWarningTarget.soldQuantity || hideWarningTarget.soldCount} ticket(s) already sold. Hiding it removes the event page from every public feed immediately — ticket holders will lose access to the event details and won't be notified.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setHideWarningTarget(null)} style={{ flex: 1, background: C.card, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '12px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => toggleHide(hideWarningTarget)} style={{ flex: 1, background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '12px', padding: '12px', color: '#F59E0B', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
                Hide Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', animation: 'ventsFadeIn 0.15s ease-out' }}>
          <div style={{ background: C.card, border: '1px solid rgba(239,68,68,0.3)', borderRadius: '20px', padding: '24px', width: '100%', maxWidth: '340px' }}>
            <Trash2 size={32} color={C.red} style={{ marginBottom: '12px' }} />
            <p style={{ color: C.text, fontSize: '17px', fontWeight: 700, marginBottom: '8px' }}>Delete Event?</p>
            <p style={{ color: C.sub, fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
              "{deleteTarget.title}" will be removed from your dashboard and the public feed. Ticket and payment history is preserved — an admin can restore it if needed.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setDeleteTarget(null)} style={{ flex: 1, background: C.card, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '12px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmDelete} disabled={deleting} style={{ flex: 1, background: deleting ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '12px', padding: '12px', color: C.red, fontSize: '14px', fontWeight: 700, cursor: deleting ? 'not-allowed' : 'pointer' }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${C.line}`, borderRadius: '10px', padding: '8px 6px', textAlign: 'center' }}>
      <div style={{ color: C.text, fontSize: '13px', fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      <div style={{ color: C.faint, fontSize: '9.5px', fontWeight: 600, marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

function ActionBtn({ icon, label, color, disabled, onClick }: { icon: React.ReactNode; label: string; color: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className="vents-action-btn"
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        background: disabled ? 'rgba(255,255,255,0.03)' : `${color}1A`,
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.06)' : color + '33'}`,
        borderRadius: '10px', padding: '9px',
        color: disabled ? C.faint : color,
        fontSize: '12px', fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

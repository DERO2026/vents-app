import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ScanLine, Shield, CalendarX, Search, X, CheckCircle2,
  Clock, Wand2, RefreshCw, Ticket as TicketIcon, Mail, Phone, Hash, Wifi, WifiOff,
} from 'lucide-react';
import { Event } from './types';
import { useDoorManager, Attendee, DoorFilter, FeedItem } from '../../lib/useDoorManager';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

// ─── Midnight Neon palette (low-light door environments) ──────────────────────
const C = {
  bg: '#020005', card: '#090514', line: 'rgba(255,255,255,0.06)',
  text: '#F0F0FF', sub: '#8B8FA8', faint: '#555C7A',
  purple: '#A78BFA', purpleDeep: '#7B2FBE',
  green: '#10B981', greenGlow: 'rgba(16,185,129,0.16)',
  red: '#EF4444', gold: '#FFB830',
};

const FILTERS: { id: DoorFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'checked_in', label: 'Checked In' },
  { id: 'pending', label: 'Pending' },
  { id: 'vip', label: 'VIP' },
  { id: 'regular', label: 'Regular' },
  { id: 'refunded', label: 'Refunded' },
  { id: 'cancelled', label: 'Cancelled' },
];

interface DoorManagerScreenProps {
  event: Event;
  currentUser: any;
  onBack: () => void;
  onOpenScanner: () => void;
  scanningDisabled?: boolean;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
}
function isVip(t: string | null | undefined) { return !!t && /vip/i.test(t); }

function Avatar({ url, name, size = 40 }: { url?: string | null; name?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
  if (url && !broken) {
    return <img src={url} alt="" onError={() => setBroken(true)}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, background: C.card }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', color: '#fff', fontSize: size * 0.36, fontWeight: 700 }}>
      {initials}
    </div>
  );
}

// ── Local, transient feed entries (e.g. a duplicate rejected from THIS screen) —
interface LocalFeed { id: string; kind: 'manual' | 'rejected'; name: string; detail: string; at: number; }

export function DoorManagerScreen({ event, currentUser, onBack, onOpenScanner, scanningDisabled = false }: DoorManagerScreenProps) {
  const isAuthorized =
    currentUser?.role === 'organizer' || currentUser?.role === 'organiser' ||
    currentUser?.role === 'admin' || currentUser?.role === 'sub-admin' ||
    currentUser?.id === ROOT_UID || currentUser?.id === event.organizer_id;

  const dm = useDoorManager(isAuthorized ? event.id : undefined, currentUser?.id);
  const [selected, setSelected] = useState<Attendee | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing] = useState(false);
  const [localFeed, setLocalFeed] = useState<LocalFeed[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Infinite scroll: load the next page when the sentinel enters view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) dm.loadMore();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [dm.loadMore]);

  const mergedFeed = useMemo(() => {
    const remote: (FeedItem & { _local?: false })[] = dm.feed;
    return { remote, local: localFeed };
  }, [dm.feed, localFeed]);

  if (!isAuthorized) {
    return <Guard icon={<Shield size={46} color={C.red} />} title="Organizers Only"
      body="The Door Manager is only accessible to the event's organizer or platform staff." onBack={onBack} />;
  }
  if (!event?.id) {
    return <Guard icon={<CalendarX size={46} color={C.gold} />} title="No Event Selected"
      body="Open the Door Manager from a specific event." onBack={onBack} />;
  }

  const pct = dm.stats.attendance_pct;

  const doManualCheckIn = async () => {
    if (!selected) return;
    setActing(true);
    const res = await dm.manualCheckIn(selected.ticket_id);
    setActing(false);
    setConfirming(false);
    const nm = selected.holder_name || 'Attendee';
    if (res.ok) {
      setLocalFeed((f) => [{ id: `l${Date.now()}`, kind: 'manual' as const, name: nm, detail: `${selected.ticket_type || 'Ticket'} · Manual entry`, at: Date.now() }, ...f].slice(0, 12));
      setSelected(null);
    } else {
      setLocalFeed((f) => [{ id: `l${Date.now()}`, kind: 'rejected' as const, name: nm, detail: res.message || 'Rejected', at: Date.now() }, ...f].slice(0, 12));
      if (res.reason === 'already_scanned') setSelected((s) => s ? { ...s, checked_in: true, checked_in_at: res.checked_in_at || new Date().toISOString() } : s);
    }
  };

  return (
    <div style={{ background: C.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(18px + env(safe-area-inset-top)) 18px 12px', flexShrink: 0, borderBottom: `1px solid ${C.line}` }}>
        <button onClick={onBack} aria-label="Back" style={iconBtn}>
          <ArrowLeft size={18} color="#C4C9E0" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <h1 style={{ color: C.text, fontSize: '17px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>Door Manager</h1>
            <span title={dm.live ? 'Live' : 'Reconnecting'} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 700, color: dm.live ? C.green : C.faint }}>
              {dm.live ? <Wifi size={11} /> : <WifiOff size={11} />}{dm.live ? 'LIVE' : '···'}
            </span>
          </div>
          <p style={{ color: C.sub, fontSize: '11px', margin: '1px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{event.title}</p>
        </div>
        <button onClick={onOpenScanner} style={{ ...scanBtn, opacity: scanningDisabled ? 0.5 : 1 }} disabled={scanningDisabled}>
          <ScanLine size={16} color="#fff" /><span style={{ color: '#fff', fontSize: '13px', fontWeight: 700 }}>Scan</span>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none' }}>
        {/* Stats */}
        <div style={{ padding: '14px 18px 4px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '10px' }}>
            <Stat label="Checked In" value={dm.stats.checked_in} color={C.green} glow />
            <Stat label="Remaining" value={dm.stats.remaining} color={C.text} />
            <Stat label="Sold" value={dm.stats.total} color={C.purple} />
          </div>
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: '16px', padding: '13px 15px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <span style={{ color: C.sub, fontSize: '12px', fontWeight: 600 }}>Attendance</span>
              <span style={{ color: C.text, fontSize: '15px', fontWeight: 800 }}>{pct}%</span>
            </div>
            <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '100px', height: '9px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, borderRadius: '100px',
                background: `linear-gradient(90deg, ${C.purpleDeep}, ${C.green})`, boxShadow: `0 0 14px ${C.greenGlow}`, transition: 'width 0.5s ease' }} />
            </div>
          </div>
        </div>

        {/* Live activity feed */}
        <Section title="Live Activity">
          {mergedFeed.remote.length === 0 && mergedFeed.local.length === 0 ? (
            <Empty text="No check-ins yet. Scanned guests appear here in real time." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {mergedFeed.local.map((l) => (
                <FeedRow key={l.id} time={fmtTime(new Date(l.at).toISOString())} name={l.name} detail={l.detail}
                  tone={l.kind === 'rejected' ? 'red' : 'purple'} icon={l.kind === 'rejected' ? '⚠️' : '⚙️'} />
              ))}
              {mergedFeed.remote.slice(0, 25).map((f) => (
                <FeedRow key={f.checkin_id} time={fmtTime(f.checked_in_at)}
                  name={f.holder_name || 'Verified Attendee'}
                  detail={`${f.ticket_type || 'Ticket'}${f.is_manual_override ? ' · Manual' : ''}${f.gate_name ? ` · ${f.gate_name}` : ''}`}
                  tone={f.is_manual_override ? 'purple' : 'green'} icon={f.is_manual_override ? '⚙️' : '✅'} vip={isVip(f.ticket_type)} />
              ))}
            </div>
          )}
        </Section>

        {/* Guest list */}
        <Section title="Guest List" right={<button onClick={dm.refresh} aria-label="Refresh" style={{ ...iconBtn, width: 30, height: 30 }}><RefreshCw size={14} color={C.sub} /></button>}>
          {/* Search */}
          <div style={{ position: 'relative', marginBottom: '10px' }}>
            <Search size={15} color={C.faint} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
            <input value={dm.search} onChange={(e) => dm.setSearch(e.target.value)}
              placeholder="Search name, email, phone, ticket ID"
              style={{ width: '100%', boxSizing: 'border-box', background: C.card, border: `1px solid ${C.line}`, borderRadius: '12px',
                padding: '11px 34px 11px 34px', color: C.text, fontSize: '13px', outline: 'none' }} />
            {dm.search && <button onClick={() => dm.setSearch('')} aria-label="Clear" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}><X size={15} color={C.sub} /></button>}
          </div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: '7px', overflowX: 'auto', paddingBottom: '10px', scrollbarWidth: 'none' }}>
            {FILTERS.map((f) => {
              const on = dm.filter === f.id;
              return (
                <button key={f.id} onClick={() => dm.setFilter(f.id)} style={{
                  flexShrink: 0, padding: '7px 13px', borderRadius: '100px', cursor: 'pointer', fontSize: '12px', fontWeight: 700,
                  background: on ? 'rgba(124,58,237,0.18)' : C.card, color: on ? C.purple : C.sub,
                  border: `1px solid ${on ? 'rgba(167,139,250,0.5)' : C.line}`, whiteSpace: 'nowrap',
                }}>{f.label}</button>
              );
            })}
          </div>

          {dm.loadingList ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {[0, 1, 2, 3].map((i) => <div key={i} style={{ height: 62, borderRadius: 14, background: C.card, border: `1px solid ${C.line}` }} />)}
            </div>
          ) : dm.attendees.length === 0 ? (
            <Empty text="No attendees match this view." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {dm.attendees.map((a) => <AttendeeRow key={a.ticket_id} a={a} onClick={() => { setSelected(a); setConfirming(false); }} />)}
              <div ref={sentinelRef} style={{ height: 1 }} />
              {dm.loadingMore && <p style={{ color: C.faint, fontSize: '12px', textAlign: 'center', padding: '6px 0' }}>Loading more…</p>}
              {!dm.hasMore && dm.attendees.length > 0 && <p style={{ color: C.faint, fontSize: '11px', textAlign: 'center', padding: '8px 0 2px' }}>End of list</p>}
            </div>
          )}
        </Section>
        <div style={{ height: '24px' }} />
      </div>

      {/* Attendee details sheet */}
      {selected && (
        <DetailsSheet
          a={selected}
          scanningDisabled={scanningDisabled}
          confirming={confirming}
          acting={acting}
          onConfirmStart={() => setConfirming(true)}
          onConfirmCancel={() => setConfirming(false)}
          onConfirm={doManualCheckIn}
          onClose={() => { setSelected(null); setConfirming(false); }}
        />
      )}
    </div>
  );
}

// ─── Presentational pieces ────────────────────────────────────────────────────
const iconBtn: React.CSSProperties = { background: C.card, border: `1px solid ${C.line}`, borderRadius: '50%', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 };
const scanBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '9px 14px', cursor: 'pointer', flexShrink: 0, boxShadow: '0 4px 16px rgba(123,47,190,0.4)' };

function Stat({ label, value, color, glow }: { label: string; value: number; color: string; glow?: boolean }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${glow ? 'rgba(16,185,129,0.3)' : C.line}`, borderRadius: '16px', padding: '13px 10px', textAlign: 'center', boxShadow: glow ? `0 0 22px ${C.greenGlow}` : 'none' }}>
      <div style={{ color, fontSize: '26px', fontWeight: 800, lineHeight: 1.05, fontFamily: 'Space Grotesk, sans-serif' }}>{value}</div>
      <div style={{ color: C.sub, fontSize: '10.5px', fontWeight: 600, marginTop: '3px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 18px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <h2 style={{ color: C.text, fontSize: '13px', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', margin: 0 }}>{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ background: C.card, border: `1px dashed ${C.line}`, borderRadius: '14px', padding: '20px 16px', textAlign: 'center' }}><p style={{ color: C.faint, fontSize: '12.5px', margin: 0, lineHeight: 1.5 }}>{text}</p></div>;
}

function FeedRow({ time, name, detail, tone, icon, vip }: { time: string; name: string; detail: string; tone: 'green' | 'purple' | 'red'; icon: string; vip?: boolean }) {
  const border = tone === 'green' ? 'rgba(16,185,129,0.28)' : tone === 'red' ? 'rgba(239,68,68,0.3)' : 'rgba(167,139,250,0.3)';
  const glow = tone === 'green' ? C.greenGlow : 'transparent';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: C.card, border: `1px solid ${border}`, borderRadius: '13px', padding: '10px 12px', boxShadow: tone === 'green' ? `0 0 16px ${glow}` : 'none', contentVisibility: 'auto' as any, containIntrinsicSize: '58px' as any }}>
      <span style={{ fontSize: '17px', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: C.text, fontSize: '13.5px', fontWeight: 700, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}{vip && <span style={vipChip}>VIP</span>}
        </p>
        <p style={{ color: C.sub, fontSize: '11.5px', margin: '1px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail}</p>
      </div>
      <span style={{ color: C.faint, fontSize: '11px', fontWeight: 600, flexShrink: 0 }}>{time}</span>
    </div>
  );
}

const vipChip: React.CSSProperties = { marginLeft: 6, color: C.gold, fontSize: '9px', fontWeight: 800, letterSpacing: '0.06em', background: 'rgba(255,184,48,0.14)', border: '1px solid rgba(255,184,48,0.4)', borderRadius: '100px', padding: '1px 6px', verticalAlign: 'middle' };

function StatusBadge({ a }: { a: Attendee }) {
  if (a.status === 'refunded') return <Badge text="Refunded" color={C.red} />;
  if (a.status === 'cancelled') return <Badge text="Cancelled" color={C.faint} />;
  if (a.checked_in) return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: C.green, fontSize: '12px', fontWeight: 800 }}>
        <CheckCircle2 size={14} />{a.is_manual_override ? 'Manual' : 'In'}
      </div>
      <div style={{ color: C.faint, fontSize: '10.5px', marginTop: '1px' }}>{fmtTime(a.checked_in_at)}</div>
    </div>
  );
  return <Badge text="Pending" color={C.sub} dim />;
}
function Badge({ text, color, dim }: { text: string; color: string; dim?: boolean }) {
  return <span style={{ color, fontSize: '11px', fontWeight: 700, background: dim ? 'transparent' : 'rgba(255,255,255,0.03)', border: `1px solid ${dim ? C.line : color + '55'}`, borderRadius: '100px', padding: '4px 10px', whiteSpace: 'nowrap' }}>{text}</span>;
}

function AttendeeRow({ a, onClick }: { a: Attendee; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: '11px', width: '100%', textAlign: 'left', cursor: 'pointer',
      background: C.card, border: `1px solid ${a.checked_in ? 'rgba(16,185,129,0.22)' : C.line}`, borderRadius: '14px', padding: '11px 13px',
      contentVisibility: 'auto' as any, containIntrinsicSize: '64px' as any }}>
      <Avatar url={a.avatar_url} name={a.holder_name || a.buyer_name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: C.text, fontSize: '14px', fontWeight: 700, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {a.holder_name || 'Guest'}{isVip(a.ticket_type) && <span style={vipChip}>VIP</span>}
        </p>
        <p style={{ color: C.sub, fontSize: '11.5px', margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.ticket_type || 'Ticket'}</p>
      </div>
      <StatusBadge a={a} />
    </button>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '11px 0', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ width: 30, height: 30, borderRadius: '9px', background: 'rgba(168,85,247,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</div>
      <span style={{ color: C.sub, fontSize: '12.5px', flex: '0 0 auto', minWidth: 92 }}>{label}</span>
      <span style={{ color: C.text, fontSize: '12.5px', fontWeight: 600, marginLeft: 'auto', textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

function DetailsSheet({ a, scanningDisabled, confirming, acting, onConfirmStart, onConfirmCancel, onConfirm, onClose }: {
  a: Attendee; scanningDisabled: boolean; confirming: boolean; acting: boolean;
  onConfirmStart: () => void; onConfirmCancel: () => void; onConfirm: () => void; onClose: () => void;
}) {
  const canCheckIn = a.status === 'active' && !a.checked_in;
  const payColor = a.payment_status === 'paid' ? C.green : a.payment_status === 'pending' ? C.gold : C.sub;
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(2,0,5,0.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: C.bg, borderRadius: '24px 24px 0 0', borderTop: `1px solid ${C.line}`, maxHeight: '86%', overflowY: 'auto', scrollbarWidth: 'none', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))' }}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 2px' }}><div style={{ width: 38, height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.15)' }} /></div>
        <div style={{ padding: '10px 20px 0', display: 'flex', alignItems: 'center', gap: '13px' }}>
          <Avatar url={a.avatar_url} name={a.holder_name || a.buyer_name} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ color: C.text, fontSize: '18px', fontWeight: 800, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.holder_name || 'Guest'}</h3>
            <div style={{ marginTop: '4px' }}>{a.checked_in
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.green, fontSize: '12.5px', fontWeight: 700 }}><CheckCircle2 size={14} />Checked in {fmtTime(a.checked_in_at)}{a.is_manual_override ? ' · Manual' : ''}</span>
              : a.status === 'active' ? <span style={{ color: C.sub, fontSize: '12.5px', fontWeight: 700 }}>Pending entry</span>
              : <span style={{ color: a.status === 'refunded' ? C.red : C.faint, fontSize: '12.5px', fontWeight: 700, textTransform: 'capitalize' }}>{a.status}</span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ ...iconBtn, width: 32, height: 32 }}><X size={17} color={C.sub} /></button>
        </div>

        <div style={{ padding: '10px 20px 0' }}>
          <Row icon={<TicketIcon size={15} color={C.purple} />} label="Ticket" value={`${a.ticket_type || 'Ticket'}${a.amount != null ? ` · ₦${Number(a.amount).toLocaleString()}` : ''}`} />
          <Row icon={<Hash size={15} color={C.purple} />} label="Order ID" value={a.order_ref || '—'} />
          <Row icon={<Hash size={15} color={C.purple} />} label="Ticket ID" value={a.ticket_id.slice(0, 8) + '…' + a.ticket_id.slice(-4)} />
          {a.holder_email && <Row icon={<Mail size={15} color={C.purple} />} label="Email" value={a.holder_email} />}
          {a.buyer_phone && <Row icon={<Phone size={15} color={C.purple} />} label="Phone" value={a.buyer_phone} />}
          <Row icon={<Clock size={15} color={C.purple} />} label="Purchased" value={fmtDate(a.purchased_at)} />
          <Row icon={<CheckCircle2 size={15} color={payColor} />} label="Payment" value={(a.payment_status || 'unknown').replace(/^\w/, (c) => c.toUpperCase())} />
          {a.checked_in && <Row icon={<Clock size={15} color={C.green} />} label="Checked in" value={`${fmtDate(a.checked_in_at)} · ${fmtTime(a.checked_in_at)}`} />}
        </div>

        {/* Manual override */}
        <div style={{ padding: '14px 20px 0' }}>
          {a.checked_in ? (
            <div style={{ background: C.greenGlow, border: `1px solid rgba(16,185,129,0.4)`, borderRadius: '14px', padding: '14px', textAlign: 'center', color: C.green, fontSize: '13px', fontWeight: 700 }}>
              <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />Already admitted
            </div>
          ) : !canCheckIn ? (
            <div style={{ background: 'rgba(239,68,68,0.08)', border: `1px solid rgba(239,68,68,0.3)`, borderRadius: '14px', padding: '14px', textAlign: 'center', color: C.red, fontSize: '12.5px', fontWeight: 600 }}>
              This ticket is {a.status} and cannot be admitted.
            </div>
          ) : confirming ? (
            <div style={{ background: C.card, border: `1px solid rgba(167,139,250,0.4)`, borderRadius: '16px', padding: '15px' }}>
              <p style={{ color: C.text, fontSize: '13.5px', fontWeight: 700, margin: '0 0 4px' }}>Manually admit {a.holder_name || 'this guest'}?</p>
              <p style={{ color: C.sub, fontSize: '12px', margin: '0 0 13px', lineHeight: 1.5 }}>Use only when the guest's phone is dead or their QR won't scan. This is logged as a manual override for audit.</p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={onConfirmCancel} disabled={acting} style={ghostBtn}>Cancel</button>
                <button onClick={onConfirm} disabled={acting} style={{ ...primaryBtn, opacity: acting ? 0.6 : 1 }}>
                  {acting ? 'Admitting…' : 'Confirm Entry'}
                </button>
              </div>
            </div>
          ) : (
            <button onClick={onConfirmStart} disabled={scanningDisabled}
              style={{ ...primaryBtn, width: '100%', height: 54, opacity: scanningDisabled ? 0.5 : 1, boxShadow: '0 6px 22px rgba(123,47,190,0.45)' }}>
              <Wand2 size={18} color="#fff" /><span style={{ marginLeft: 8 }}>{scanningDisabled ? 'Scanning Paused' : 'Manual Check-In'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const ghostBtn: React.CSSProperties = { flex: 1, height: 46, background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.line}`, borderRadius: '13px', color: '#C4C9E0', fontSize: '14px', fontWeight: 700, cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { flex: 1, height: 46, background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '13px', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };

function Guard({ icon, title, body, onBack }: { icon: React.ReactNode; title: string; body: string; onBack: () => void }) {
  return (
    <div style={{ background: C.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
      <div style={{ marginBottom: 16 }}>{icon}</div>
      <h2 style={{ color: C.text, fontSize: '18px', fontWeight: 800 }}>{title}</h2>
      <p style={{ color: C.sub, fontSize: '13px', marginTop: '8px', lineHeight: 1.6, maxWidth: 300 }}>{body}</p>
      <button onClick={onBack} style={{ marginTop: 24, background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', borderRadius: '12px', padding: '12px 28px', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '14px' }}>Go Back</button>
    </div>
  );
}

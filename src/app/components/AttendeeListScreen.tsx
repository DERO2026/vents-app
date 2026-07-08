import { useState, useEffect } from 'react';
import { ArrowLeft, Search, CheckCircle, XCircle, Download } from 'lucide-react';
import { insforge } from '../../lib/insforge';

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
  quantity: number;
  status: CheckInStatus;
  initials: string;
  avatarColor: string;
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
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CheckInStatus | 'all'>('all');

  useEffect(() => {
    if (!eventId) { setLoading(false); return; }
    async function load() {
      try {
        const { data, error } = await insforge.database
          .from('tickets')
          .select('id, quantity, ticket_type, payment_status, created_at, users(full_name, email, username)')
          .eq('event_id', eventId)
          .eq('status', 'active')
          .order('created_at', { ascending: false });

        if (error) throw error;
        if (data) {
          setAttendees((data as any[]).map((t) => {
            const u = t.users || {};
            const name = u.full_name || u.username || 'Unknown';
            const initials = name.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
            return {
              id: t.id,
              name,
              email: u.email || '',
              ticketType: t.ticket_type || 'Regular',
              ticketId: t.id.slice(0, 8).toUpperCase(),
              quantity: t.quantity || 1,
              status: (t.payment_status === 'paid' ? 'pending' : 'cancelled') as CheckInStatus,
              initials,
              avatarColor: colorForName(name),
            };
          }));
        }
      } catch (err) {
        console.error('AttendeeListScreen load error', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [eventId]);

  const checkedIn = attendees.filter((a) => a.status === 'checked-in').length;
  const total = attendees.filter((a) => a.status !== 'cancelled').length;

  const filtered = attendees.filter((a) => {
    const matchQ =
      !query ||
      a.name.toLowerCase().includes(query.toLowerCase()) ||
      a.email.toLowerCase().includes(query.toLowerCase()) ||
      a.ticketId.toLowerCase().includes(query.toLowerCase());
    const matchS = statusFilter === 'all' || a.status === statusFilter;
    return matchQ && matchS;
  });

  const toggleCheckIn = (id: string) => {
    setAttendees((prev) =>
      prev.map((a) =>
        a.id === id && a.status !== 'cancelled'
          ? { ...a, status: a.status === 'checked-in' ? 'pending' : 'checked-in' }
          : a
      )
    );
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
              <button key={s} onClick={() => setStatusFilter(s)} style={{ flexShrink: 0, padding: '5px 12px', borderRadius: '16px', border: 'none', background: statusFilter === s ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629', color: statusFilter === s ? '#fff' : '#8B8FA8', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
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
                            <span style={{ color: '#8B8FA8', fontSize: '10px', fontFamily: 'monospace' }}>{attendee.ticketId}</span>
                            {attendee.quantity > 1 && <span style={{ color: '#8B8FA8', fontSize: '10px' }}>×{attendee.quantity}</span>}
                          </div>
                        </div>
                        <button onClick={() => toggleCheckIn(attendee.id)} disabled={attendee.status === 'cancelled'} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: sc.bg, border: 'none', borderRadius: '8px', padding: '6px 10px', cursor: attendee.status === 'cancelled' ? 'not-allowed' : 'pointer', flexShrink: 0 }}>
                          <StatusIcon size={13} color={sc.color} />
                          <span style={{ color: sc.color, fontSize: '11px', fontWeight: 600 }}>{sc.label}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

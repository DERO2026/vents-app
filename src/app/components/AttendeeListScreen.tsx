import { useState } from 'react';
import { ArrowLeft, Search, CheckCircle, XCircle, Download } from 'lucide-react';

interface AttendeeListScreenProps {
  onBack: () => void;
}

type CheckInStatus = 'checked-in' | 'pending' | 'cancelled';

interface Attendee {
  id: string;
  name: string;
  email: string;
  ticketType: string;
  ticketId: string;
  status: CheckInStatus;
  avatarColor: string;
  initials: string;
}

const ATTENDEES: Attendee[] = [
  { id: 'a1', name: 'Chisom Okafor', email: 'chisom@gmail.com', ticketType: 'VIP', ticketId: 'VNT-A4K2', status: 'checked-in', avatarColor: '#EC4899', initials: 'CO' },
  { id: 'a2', name: 'Emeka Nwosu', email: 'emeka@tech.ng', ticketType: 'Regular', ticketId: 'VNT-B7L9', status: 'pending', avatarColor: '#3B82F6', initials: 'EN' },
  { id: 'a3', name: 'Fatima Al-Hassan', email: 'fati@vibes.com', ticketType: 'VVIP Table', ticketId: 'VNT-C2M5', status: 'checked-in', avatarColor: '#F59E0B', initials: 'FA' },
  { id: 'a4', name: 'Tunde Adeyemi', email: 'tunde@lagos.ng', ticketType: 'Regular', ticketId: 'VNT-D8P3', status: 'pending', avatarColor: '#22C55E', initials: 'TA' },
  { id: 'a5', name: 'Ngozi Eze', email: 'ngozi@arts.com', ticketType: 'VIP', ticketId: 'VNT-E1R7', status: 'checked-in', avatarColor: '#8B5CF6', initials: 'NE' },
  { id: 'a6', name: 'Bello Musa', email: 'bello@ent.ng', ticketType: 'Regular', ticketId: 'VNT-F6S4', status: 'cancelled', avatarColor: '#EF4444', initials: 'BM' },
  { id: 'a7', name: 'Ada Obi', email: 'ada@obi.ng', ticketType: 'Regular', ticketId: 'VNT-G9T1', status: 'pending', avatarColor: '#06B6D4', initials: 'AO' },
  { id: 'a8', name: 'Kunle Ibrahim', email: 'kunle@ibr.com', ticketType: 'VIP', ticketId: 'VNT-H3U8', status: 'checked-in', avatarColor: '#F97316', initials: 'KI' },
];

const STATUS_CONFIG: Record<CheckInStatus, { color: string; bg: string; label: string; icon: React.ElementType }> = {
  'checked-in': { color: '#10B981', bg: 'rgba(16,185,129,0.1)', label: 'Checked In', icon: CheckCircle },
  pending: { color: '#F59E0B', bg: 'rgba(245,158,11,0.1)', label: 'Pending', icon: XCircle },
  cancelled: { color: '#EF4444', bg: 'rgba(239,68,68,0.1)', label: 'Cancelled', icon: XCircle },
};

export function AttendeeListScreen({ onBack }: AttendeeListScreenProps) {
  const [attendees, setAttendees] = useState<Attendee[]>(ATTENDEES);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CheckInStatus | 'all'>('all');

  const checkedIn = attendees.filter((a) => a.status === 'checked-in').length;
  const total = attendees.filter((a) => a.status !== 'cancelled').length;

  const filtered = attendees.filter((a) => {
    const matchQ =
      !query ||
      a.name.toLowerCase().includes(query.toLowerCase()) ||
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
    <div
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <style>{`input::placeholder { color: #8B8FA8; }`}</style>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 16px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
            <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Attendees</h1>
            <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Afrobeats Fest Lagos 2025</p>
          </div>
        </div>
        <button
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '10px',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            cursor: 'pointer',
          }}
        >
          <Download size={14} color="#A78BFA" />
          <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 600 }}>Export</span>
        </button>
      </div>

      {/* Check-in progress */}
      <div style={{ padding: '0 16px 12px' }}>
        <div
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '16px',
            padding: '14px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>Check-in Progress</p>
            <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 800 }}>
              {checkedIn} / {total}
            </span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px' }}>
            <div
              style={{
                height: '100%',
                width: `${(checkedIn / total) * 100}%`,
                borderRadius: '3px',
                background: 'linear-gradient(90deg, #10B981, #06B6D4)',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '5px' }}>
            {Math.round((checkedIn / total) * 100)}% checked in
          </p>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '0 16px 10px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '12px',
            padding: '10px 14px',
          }}
        >
          <Search size={16} color="#8B8FA8" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or ticket ID..."
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#F0F0FF',
              fontSize: '14px',
              fontFamily: 'Inter, sans-serif',
            }}
          />
        </div>
      </div>

      {/* Status filter */}
      <div
        style={{
          display: 'flex',
          gap: '8px',
          padding: '0 16px 12px',
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {(['all', 'checked-in', 'pending', 'cancelled'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              flexShrink: 0,
              padding: '5px 12px',
              borderRadius: '16px',
              border: 'none',
              background:
                statusFilter === s
                  ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)'
                  : '#131629',
              color: statusFilter === s ? '#fff' : '#8B8FA8',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {s === 'all' ? 'All' : s === 'checked-in' ? 'Checked In' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Attendee list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 16px 24px',
          scrollbarWidth: 'none',
        }}
      >
        <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '10px' }}>
          {filtered.length} attendee{filtered.length !== 1 ? 's' : ''}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map((attendee) => {
            const sc = STATUS_CONFIG[attendee.status];
            const StatusIcon = sc.icon;
            return (
              <div
                key={attendee.id}
                style={{
                  background: '#131629',
                  border: '1px solid rgba(255,255,255,0.05)',
                  borderRadius: '14px',
                  padding: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                {/* Avatar */}
                <div
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    background: attendee.avatarColor,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '13px',
                    color: '#fff',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {attendee.initials}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>
                    {attendee.name}
                  </p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px' }}>{attendee.email}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '3px' }}>
                    <span
                      style={{
                        background: 'rgba(167,139,250,0.1)',
                        color: '#A78BFA',
                        fontSize: '10px',
                        fontWeight: 600,
                        padding: '1px 6px',
                        borderRadius: '4px',
                      }}
                    >
                      {attendee.ticketType}
                    </span>
                    <span style={{ color: '#8B8FA8', fontSize: '10px', fontFamily: 'monospace' }}>
                      {attendee.ticketId}
                    </span>
                  </div>
                </div>

                {/* Status badge + toggle */}
                <button
                  onClick={() => toggleCheckIn(attendee.id)}
                  disabled={attendee.status === 'cancelled'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: sc.bg,
                    border: 'none',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    cursor: attendee.status === 'cancelled' ? 'not-allowed' : 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <StatusIcon size={13} color={sc.color} />
                  <span style={{ color: sc.color, fontSize: '11px', fontWeight: 600 }}>
                    {sc.label}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

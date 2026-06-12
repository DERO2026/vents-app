import { useState } from 'react';
import { ArrowLeft, Plus, Users, Search, Calendar, Edit2, Lock, CheckCircle, Clock, Zap, X, Phone, ChevronDown } from 'lucide-react';
import { EVENTS, formatPrice } from './data';
import { OrganizerEvent } from './types';

interface ManageEventsScreenProps {
  onBack: () => void;
  onNavigate: (screen: string) => void;
  orgEvents: OrganizerEvent[];
  onEditEvent: (id: string, updates: Partial<OrganizerEvent>) => void;
  onPromoteEvent?: (eventId: string) => void;
}

type EventStatus = 'on-sale' | 'sold-out' | 'draft' | 'past';

const MOCK_EVENTS = EVENTS.slice(0, 4).map((e, i) => ({
  ...e,
  eventStatus: (['on-sale', 'on-sale', 'sold-out', 'past'] as EventStatus[])[i],
  revenue: Math.round(e.attendees * e.price * 0.4),
}));

const STATUS_STYLE = {
  under_review: { bg: 'rgba(245,158,11,0.12)', color: '#F59E0B', border: 'rgba(245,158,11,0.3)', label: 'Under Review', icon: Clock },
  approved: { bg: 'rgba(16,185,129,0.12)', color: '#10B981', border: 'rgba(16,185,129,0.3)', label: 'Approved ✓', icon: CheckCircle },
  live: { bg: 'rgba(16,185,129,0.12)', color: '#10B981', border: 'rgba(16,185,129,0.3)', label: 'Live', icon: Zap },
  draft: { bg: 'rgba(139,143,168,0.1)', color: '#8B8FA8', border: 'rgba(139,143,168,0.2)', label: 'Draft', icon: Edit2 },
};

const MOCK_STATUS_STYLE: Record<EventStatus, { bg: string; color: string; label: string }> = {
  'on-sale': { bg: 'rgba(16,185,129,0.1)', color: '#10B981', label: 'On Sale' },
  'sold-out': { bg: 'rgba(239,68,68,0.1)', color: '#EF4444', label: 'Sold Out' },
  draft: { bg: 'rgba(245,158,11,0.1)', color: '#F59E0B', label: 'Draft' },
  past: { bg: 'rgba(139,143,168,0.1)', color: '#8B8FA8', label: 'Past' },
};

const CATEGORIES = [
  'Music', 'Technology', 'Food & Drinks', 'Comedy Shows',
  'Arts & Culture', 'Sports & Wellness', 'Conferences', 'Family Events',
];

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: '#1A1D2E',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px',
  padding: '11px 14px',
  color: '#F0F0FF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
  outline: 'none',
  boxSizing: 'border-box',
};

function daysUntil(dateStr: string): number {
  if (!dateStr) return Infinity;
  const eventDate = new Date(dateStr + 'T00:00:00');
  return (eventDate.getTime() - Date.now()) / 86400000;
}

function isEditLocked(event: OrganizerEvent): boolean {
  const days = daysUntil(event.date);
  return days >= 0 && days <= 3;
}

export function ManageEventsScreen({ onBack, onNavigate, orgEvents, onEditEvent, onPromoteEvent }: ManageEventsScreenProps) {
  const [query, setQuery] = useState('');
  const [editingEvent, setEditingEvent] = useState<OrganizerEvent | null>(null);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editVenue, setEditVenue] = useState('');
  const [editCity, setEditCity] = useState('');
  const [editCapacity, setEditCapacity] = useState('');
  const [editTicketPrice, setEditTicketPrice] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editShowPhone, setEditShowPhone] = useState(false);

  const filteredMock = MOCK_EVENTS.filter(
    (e) => !query || e.title.toLowerCase().includes(query.toLowerCase())
  );
  const filteredOrg = orgEvents.filter(
    (e) => !query || e.title.toLowerCase().includes(query.toLowerCase())
  );

  function openEdit(event: OrganizerEvent) {
    setEditingEvent(event);
    setEditTitle(event.title);
    setEditCategory(event.category);
    setEditDescription(event.description);
    setEditDate(event.date);
    setEditTime(event.startTime);
    setEditVenue(event.venue);
    setEditCity(event.city);
    setEditCapacity(event.capacity);
    setEditTicketPrice(event.ticketPrice);
    setEditPhone(event.contactPhone);
    setEditShowPhone(event.showPhone);
  }

  function saveEdit() {
    if (!editingEvent) return;
    onEditEvent(editingEvent.id, {
      title: editTitle,
      category: editCategory,
      description: editDescription,
      date: editDate,
      startTime: editTime,
      venue: editVenue,
      city: editCity,
      capacity: editCapacity,
      ticketPrice: editTicketPrice,
      contactPhone: editShowPhone ? editPhone : '',
      showPhone: editShowPhone,
    });
    setEditingEvent(null);
  }

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <style>{`input::placeholder, textarea::placeholder { color: #8B8FA8; }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={onBack}
            style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>My Events</h1>
        </div>
        <button
          onClick={() => onNavigate('create-event')}
          style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
        >
          <Plus size={14} color="#fff" />
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>Create</span>
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#131629', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '10px 14px' }}>
          <Search size={16} color="#8B8FA8" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your events..."
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 100px', scrollbarWidth: 'none' }}>

        {/* Created events */}
        {filteredOrg.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>
              YOUR CREATED EVENTS
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {filteredOrg.map((event) => {
                const ss = STATUS_STYLE[event.status];
                const locked = isEditLocked(event);
                const days = daysUntil(event.date);
                const StatusIcon = ss.icon;
                return (
                  <div
                    key={event.id}
                    style={{ background: '#131629', border: `1px solid ${ss.border}`, borderRadius: '18px', overflow: 'hidden' }}
                  >
                    {/* Color accent bar */}
                    <div style={{ height: '4px', background: event.status === 'live' ? 'linear-gradient(90deg, #10B981, #3B82F6)' : event.status === 'approved' ? '#10B981' : event.status === 'under_review' ? '#F59E0B' : '#2A2D3E' }} />

                    <div style={{ padding: '14px' }}>
                      {/* Status badge + title */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {event.title || '(Untitled Event)'}
                          </p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {event.status === 'live' && (
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10B981', display: 'inline-block', boxShadow: '0 0 6px #10B981' }} />
                            )}
                            {event.status === 'under_review' && (
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#F59E0B', display: 'inline-block' }} />
                            )}
                            <span style={{ background: ss.bg, color: ss.color, fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', border: `1px solid ${ss.border}` }}>
                              {ss.label}
                            </span>
                            {event.status === 'under_review' && (
                              <span style={{ color: '#8B8FA8', fontSize: '11px' }}>Typically 24–48h</span>
                            )}
                          </div>
                        </div>
                        <StatusIcon size={20} color={ss.color} style={{ flexShrink: 0, marginTop: '2px' }} />
                      </div>

                      {/* Status message */}
                      {event.status === 'under_review' && (
                        <div style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.18)', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
                          <p style={{ color: '#F59E0B', fontSize: '12px', fontWeight: 600, marginBottom: '3px' }}>⏳ Your event is under review</p>
                          <p style={{ color: '#8B8FA8', fontSize: '11px', lineHeight: 1.5 }}>Our team is reviewing your event for quality and compliance. You'll be notified once it's approved.</p>
                        </div>
                      )}
                      {event.status === 'approved' && (
                        <div style={{ background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
                          <p style={{ color: '#10B981', fontSize: '12px', fontWeight: 600, marginBottom: '3px' }}>✅ Approved — publishing now</p>
                          <p style={{ color: '#8B8FA8', fontSize: '11px', lineHeight: 1.5 }}>Your event has been reviewed and approved. It will go live automatically within moments.</p>
                        </div>
                      )}
                      {event.status === 'live' && (
                        <div style={{ background: 'rgba(16,185,129,0.07)', border: '1px solid rgba(16,185,129,0.18)', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px' }}>
                          <p style={{ color: '#10B981', fontSize: '12px', fontWeight: 600, marginBottom: '3px' }}>🚀 Your event is live!</p>
                          <p style={{ color: '#8B8FA8', fontSize: '11px', lineHeight: 1.5 }}>Attendees can now discover and book tickets for your event.</p>
                        </div>
                      )}

                      {/* Meta */}
                      <div style={{ display: 'flex', gap: '14px', marginBottom: '12px', flexWrap: 'wrap' }}>
                        {event.date && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <Calendar size={11} color="#8B8FA8" />
                            <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.date}</span>
                          </div>
                        )}
                        {event.venue && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <span style={{ color: '#8B8FA8', fontSize: '11px' }}>📍 {event.venue}{event.city ? `, ${event.city}` : ''}</span>
                          </div>
                        )}
                        {event.ticketPrice && (
                          <span style={{ color: '#A855F7', fontSize: '11px', fontWeight: 600 }}>₦{Number(event.ticketPrice).toLocaleString()}</span>
                        )}
                      </div>

                      {/* Lock notice */}
                      {locked && event.status === 'live' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '8px 12px', marginBottom: '10px' }}>
                          <Lock size={13} color="#EF4444" />
                          <span style={{ color: '#EF4444', fontSize: '11px', fontWeight: 600 }}>
                            Event is within 3 days — editing is locked
                          </span>
                        </div>
                      )}

                      {/* Promote Event Button */}
                      {event.status === 'live' && (
                        <button
                          onClick={() => onPromoteEvent && onPromoteEvent(event.id)}
                          style={{
                            width: '100%',
                            background: 'linear-gradient(135deg, rgba(168,85,247,0.15) 0%, rgba(79,70,229,0.1) 100%)',
                            border: '1px solid rgba(168,85,247,0.35)',
                            borderRadius: '10px',
                            padding: '9px',
                            color: '#A855F7',
                            fontSize: '12px',
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            marginBottom: '10px',
                            transition: 'all 0.2s',
                          }}
                        >
                          <Zap size={13} color="#A855F7" />
                          Promote Event & Boost Visibility 🚀
                        </button>
                      )}

                      {/* Actions */}
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => !locked && openEdit(event)}
                          disabled={locked}
                          style={{
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            background: locked ? 'rgba(255,255,255,0.03)' : 'rgba(167,139,250,0.1)',
                            border: locked ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(167,139,250,0.2)',
                            borderRadius: '10px',
                            padding: '9px',
                            color: locked ? '#5A5A7A' : '#A78BFA',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: locked ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {locked ? <Lock size={12} /> : <Edit2 size={12} />}
                          {locked ? 'Locked' : 'Edit'}
                        </button>
                        <button
                          onClick={() => onNavigate('attendee-list')}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '10px', padding: '9px', color: '#3B82F6', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >
                          <Users size={12} />
                          Attendees
                        </button>
                        <button
                          onClick={() => onNavigate('sales-analytics')}
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '9px', color: '#10B981', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >
                          Analytics
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state for created events */}
        {filteredOrg.length === 0 && !query && (
          <div style={{ background: 'rgba(168,85,247,0.06)', border: '1.5px dashed rgba(168,85,247,0.2)', borderRadius: '18px', padding: '28px 20px', marginBottom: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: '36px', marginBottom: '10px' }}>🎪</div>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>No events yet</p>
            <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.6, marginBottom: '16px' }}>
              Create your first event and it will appear here with its review status.
            </p>
            <button
              onClick={() => onNavigate('create-event')}
              style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', borderRadius: '12px', padding: '11px 24px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
            >
              + Create Event
            </button>
          </div>
        )}

        {/* Previous / mock events */}
        <div>
          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>
            PREVIOUS EVENTS
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filteredMock.map((event) => {
              const ss = MOCK_STATUS_STYLE[event.eventStatus];
              const pct = Math.round((event.attendees / event.capacity) * 100);
              return (
                <div key={event.id} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '18px', overflow: 'hidden' }}>
                  <div style={{ position: 'relative', height: '80px' }}>
                    <img src={event.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent, rgba(19,22,41,0.9))' }} />
                    <span style={{ position: 'absolute', top: '10px', right: '12px', background: ss.bg, color: ss.color, fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px' }}>
                      {ss.label}
                    </span>
                  </div>
                  <div style={{ padding: '12px' }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>{event.title}</p>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Calendar size={11} color="#8B8FA8" />
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.date}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Users size={11} color="#8B8FA8" />
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.attendees.toLocaleString()} / {event.capacity.toLocaleString()}</span>
                      </div>
                    </div>
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{pct}% sold</span>
                        <span style={{ color: '#FFB830', fontSize: '12px', fontWeight: 700 }}>{formatPrice(event.revenue)}</span>
                      </div>
                      <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px' }}>
                        <div style={{ height: '100%', width: `${pct}%`, borderRadius: '2px', background: event.eventStatus === 'sold-out' ? '#EF4444' : 'linear-gradient(90deg, #7B2FBE, #4F46E5)' }} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button style={{ flex: 1, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '10px', padding: '8px', color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                      <button onClick={() => onNavigate('attendee-list')} style={{ flex: 1, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '10px', padding: '8px', color: '#3B82F6', fontSize: '12px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                        <Users size={11} />Attendees
                      </button>
                      <button onClick={() => onNavigate('sales-analytics')} style={{ flex: 1, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '8px', color: '#10B981', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Analytics</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {editingEvent && (
        <div
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 50, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
          onClick={() => setEditingEvent(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#0D1020', borderRadius: '24px 24px 0 0', border: '1px solid rgba(255,255,255,0.08)', maxHeight: '82%', display: 'flex', flexDirection: 'column' }}
          >
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700 }}>Edit Event</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '2px' }}>Changes will be re-reviewed if significant</p>
              </div>
              <button onClick={() => setEditingEvent(null)} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <X size={15} color="#C4C9E0" />
              </button>
            </div>

            {/* Scrollable fields */}
            <div style={{ overflowY: 'auto', padding: '16px 20px 8px', scrollbarWidth: 'none', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Event Title</p>
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={INPUT_STYLE} />
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Category</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setEditCategory(cat)}
                      style={{ background: editCategory === cat ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E', border: editCategory === cat ? 'none' : '1px solid rgba(255,255,255,0.08)', borderRadius: '20px', padding: '5px 12px', color: editCategory === cat ? '#fff' : '#8B8FA8', fontSize: '11px', fontWeight: 500, cursor: 'pointer' }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Description</p>
                <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={3} style={{ ...INPUT_STYLE, resize: 'none' }} />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Date</p>
                  <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} style={INPUT_STYLE} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Start Time</p>
                  <input type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} style={INPUT_STYLE} />
                </div>
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Venue</p>
                <input value={editVenue} onChange={(e) => setEditVenue(e.target.value)} style={INPUT_STYLE} />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>City</p>
                  <input value={editCity} onChange={(e) => setEditCity(e.target.value)} style={INPUT_STYLE} />
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Capacity</p>
                  <input type="number" value={editCapacity} onChange={(e) => setEditCapacity(e.target.value)} style={INPUT_STYLE} />
                </div>
              </div>
              <div>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginBottom: '6px' }}>Ticket Price (₦)</p>
                <input type="number" value={editTicketPrice} onChange={(e) => setEditTicketPrice(e.target.value)} style={INPUT_STYLE} />
              </div>

              {/* Phone toggle */}
              <div style={{ background: '#1A1D2E', border: editShowPhone ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setEditShowPhone((v) => !v)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Phone size={14} color={editShowPhone ? '#A855F7' : '#8B8FA8'} />
                    <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 500 }}>Show Contact Number</span>
                  </div>
                  <div style={{ width: '38px', height: '22px', borderRadius: '11px', background: editShowPhone ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#2A2D3E', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', width: '16px', height: '16px', borderRadius: '50%', background: '#fff', top: '3px', left: editShowPhone ? '19px' : '3px', transition: 'left 0.2s' }} />
                  </div>
                </div>
                {editShowPhone && (
                  <div style={{ marginTop: '10px', position: 'relative' }}>
                    <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#8B8FA8', fontSize: '13px', userSelect: 'none' }}>+234</span>
                    <input type="tel" value={editPhone} onChange={(e) => setEditPhone(e.target.value.replace(/\D/g, '').slice(0, 11))} placeholder="8012345678" style={{ ...INPUT_STYLE, paddingLeft: '50px' }} />
                  </div>
                )}
              </div>
            </div>

            {/* Save button */}
            <div style={{ padding: '12px 20px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
              <button
                onClick={saveEdit}
                style={{ width: '100%', background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '14px', padding: '14px', color: '#fff', fontSize: '15px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', cursor: 'pointer', boxShadow: '0 6px 24px rgba(123,47,190,0.4)' }}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, memo, useMemo, useRef, useCallback } from 'react';
import { Search, Bell, MapPin, Calendar, X, Filter, ChevronDown } from 'lucide-react';
import { Event } from './types';
import { insforge } from '../../lib/insforge';
import { VentsLogo } from './VentsLogo';
import { formatPrice } from './data';
import { CATEGORIES as CATEGORY_LIST } from './categories';
import { NIGERIA_STATES } from './StateSelectScreen';

interface HomeScreenProps {
  onEventPress: (event: Event) => void;
  savedEvents: string[];
  onToggleSave: (eventId: string) => void;
  onNotificationsPress?: () => void;
  onSearchPress?: () => void;
  onProfilePress?: () => void;
  selectedState?: string;
  onStateChange?: (stateName: string) => void;
  onLiveMapPress?: () => void;
  dbEvents: Event[];
  loading: boolean;
  fetchEvents: () => void;
  currentUser?: { id: string; email: string; full_name: string | null; role: string; avatar_url?: string } | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  unreadNotificationsCount?: number;
}

function useCardCountdown(eventDate?: string): string | null {
  const target = useMemo(() => {
    if (!eventDate) return NaN;
    const t = new Date(eventDate).getTime();
    return isNaN(t) ? NaN : t;
  }, [eventDate]);

  const [remaining, setRemaining] = useState(() => {
    if (isNaN(target)) return 0;
    return Math.max(0, target - Date.now());
  });

  useEffect(() => {
    if (isNaN(target) || target <= 0) return;
    const id = setInterval(() => {
      const r = target - Date.now();
      if (r <= 0) { setRemaining(0); clearInterval(id); } else { setRemaining(r); }
    }, 30000); // update every 30s on cards (not per-second)
    setRemaining(Math.max(0, target - Date.now()));
    return () => clearInterval(id);
  }, [target]);

  if (isNaN(target)) return null;
  const now = Date.now();
  // Happening now: event started but within 6h window
  if (target <= now && now - target < 6 * 3600000) return 'Happening now';
  if (target <= now) return null; // past
  const d = Math.floor(remaining / 86400000);
  const h = Math.floor((remaining % 86400000) / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  if (d > 30) return null; // too far out, don't clutter card
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const CATEGORIES = [{ id: 'all', label: 'All', icon: '✨' }, ...CATEGORY_LIST];

export function mapDbEventToFrontend(dbEvent: any): Event {
  const dt = new Date(dbEvent.event_date);
  const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  
  const parts = (dbEvent.location || '').split(',');
  const venue = (parts[0] || '').trim();
  // Location format from CreateEventScreen: "venue, stateName, city[, address]"
  const stateFromLocation = parts.length >= 3 ? (parts[1] || '').trim() : '';
  const city = parts.length >= 3 ? (parts[2] || '').trim() : (parts[1] || 'Lagos').trim();
  
  const categoryIconMap: Record<string, string> = {
    'Music': '🎵',
    'Technology': '💻',
    'Food & Drinks': '🍔',
    'Comedy Shows': '🎤',
    'Arts & Culture': '🎨',
    'Sports & Wellness': '⚽',
    'Conferences': '💼',
    'Family Events': '👨‍👩‍👧‍👦'
  };

  return {
    id: dbEvent.id,
    title: dbEvent.title,
    category: dbEvent.category || 'Music',
    categoryIcon: categoryIconMap[dbEvent.category] || '🎵',
    date: dateStr,
    time: timeStr,
    endTime: '',
    venue: venue,
    area: venue,
    city: city,
    state: stateFromLocation || city,
    price: Number(dbEvent.price || 0),
    image: dbEvent.image_url || 'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?w=800',
    description: dbEvent.description || '',
    organizer: dbEvent.organizer_name || dbEvent.organizer_username || 'Verified Organizer',
    organizerVerified: true,
    isFeatured: dbEvent.is_featured === true,
    isTrending: false,
    attendees: 150,
    capacity: 1000,
    rating: 4.9,
    reviewCount: 36,
    ticketTypes: Array.isArray(dbEvent.ticket_types) && dbEvent.ticket_types.length > 0
      ? dbEvent.ticket_types.map((t: any, idx: number) => ({
          id: t.id || `t_${idx}`,
          name: t.name || 'Regular',
          price: Number(t.price ?? dbEvent.price ?? 0),
          description: t.description || 'General Admission',
          available: Number(t.available ?? t.quantity ?? 500)
        }))
      : [
          {
            id: 't1',
            name: 'Regular',
            price: Number(dbEvent.price || 0),
            description: 'General Admission',
            available: 500
          }
        ],
    organizer_id: dbEvent.organizer_id,
    created_at: dbEvent.created_at,
    event_date: dbEvent.event_date
  };
}

const FeedCard = memo(function FeedCard({ event, onPress, isSaved, onToggleSave }: {
  event: Event;
  onPress: (e: Event) => void;
  isSaved: boolean;
  onToggleSave: (id: string) => void;
}) {
  const isSelling = (event.bookingsCount ?? 0) > 50;
  const fomoColors = ['#EC4899', '#A855F7', '#00E5FF'];
  const countdown = useCardCountdown(event.event_date);

  return (
    <div
      onClick={() => onPress(event)}
      className="relative overflow-hidden cursor-pointer active:opacity-90 flex flex-col"
      style={{
        width: '100%',
        background: '#0D0D1A',
        borderRadius: '16px',
        border: '1px solid rgba(168,85,247,0.1)',
        boxShadow: '0 0 12px rgba(168,85,247,0.04)',
      }}
    >
      <div style={{ height: '110px', position: 'relative' }}>
        <img
          src={event.image}
          alt={event.title}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {/* FOMO tag */}
        {isSelling && (
          <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'rgba(255,0,110,0.15)', border: '1px solid rgba(255,0,110,0.5)', borderRadius: '6px', padding: '2px 7px', display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span style={{ fontSize: '9px', color: '#FF006E', fontWeight: 800, letterSpacing: '0.02em' }}>🔥 Selling Fast!</span>
          </div>
        )}
        {/* Overlapping attendee avatars */}
        <div style={{ position: 'absolute', top: '8px', right: '30px', display: 'flex' }}>
          {fomoColors.map((c, i) => (
            <div key={i} style={{ width: '18px', height: '18px', borderRadius: '50%', background: c, border: '1.5px solid #000', marginLeft: i > 0 ? '-6px' : '0', fontSize: '7px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700 }}>
              {String.fromCharCode(65 + i)}
            </div>
          ))}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSave(event.id);
          }}
          className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', border: 'none', cursor: 'pointer' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill={isSaved ? '#A78BFA' : 'none'} stroke={isSaved ? '#A78BFA' : '#fff'} strokeWidth="2.5">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      </div>

      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
          <span
            style={{
              fontSize: '9px',
              color: '#A78BFA',
              fontWeight: 700,
              background: 'rgba(167,139,250,0.12)',
              padding: '2px 6px',
              borderRadius: '4px',
              width: 'fit-content',
            }}
          >
            {event.category.toUpperCase()}
          </span>
          {event.isPromoted && (
            <span
              style={{
                fontSize: '8px',
                color: event.promoPlan === 'trending' ? '#EF4444' : event.promoPlan === 'featured' ? '#F59E0B' : '#3B82F6',
                fontWeight: 800,
                background: event.promoPlan === 'trending' ? 'rgba(239,68,68,0.12)' : event.promoPlan === 'featured' ? 'rgba(245,158,11,0.12)' : 'rgba(59,130,246,0.12)',
                border: `1px solid ${event.promoPlan === 'trending' ? 'rgba(239,68,68,0.3)' : event.promoPlan === 'featured' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)'}`,
                padding: '2px 5px',
                borderRadius: '4px',
                letterSpacing: '0.05em',
              }}
            >
              {event.promoPlan === 'trending' ? '🔥 TRENDING' : event.promoPlan === 'featured' ? '⭐ FEATURED' : '⚡ SPOTLIGHT'}
            </span>
          )}
        </div>
        <h4
          style={{
            color: '#F0F0FF',
            fontSize: '12px',
            fontWeight: 700,
            lineHeight: 1.35,
            marginBottom: '4px',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            height: '32px',
          }}
        >
          {event.title}
        </h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
          <Calendar size={10} color="#8B8FA8" />
          <span style={{ fontSize: '10px', color: '#8B8FA8' }}>{event.date}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
          <MapPin size={10} color="#8B8FA8" />
          <span style={{ fontSize: '10px', color: '#8B8FA8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '120px' }}>
            {event.city}
          </span>
        </div>
        {event.organizer && event.organizer !== 'Verified Organizer' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
            <span style={{ fontSize: '9px', color: '#A78BFA', fontWeight: 600 }}>@{event.organizer}</span>
          </div>
        )}
        {countdown && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: countdown === 'Happening now' ? 'rgba(16,185,129,0.12)' : 'rgba(168,85,247,0.1)', border: `1px solid ${countdown === 'Happening now' ? 'rgba(16,185,129,0.3)' : 'rgba(168,85,247,0.25)'}`, borderRadius: '5px', padding: '2px 6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '9px', color: countdown === 'Happening now' ? '#10B981' : '#A855F7', fontWeight: 700 }}>
              {countdown === 'Happening now' ? '🟢 Now' : `⏱ ${countdown}`}
            </span>
          </div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12px', color: '#FFB830', fontWeight: 700 }}>
            {formatPrice(event.price)}
          </span>
        </div>
      </div>
    </div>
  );
});

function CardSkeleton() {
  return (
    <div
      style={{
        width: '100%',
        height: '210px',
        background: '#131629',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        opacity: 0.6,
      }}
    >
      <div style={{ height: '110px', background: '#1A1D36' }} />
      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
        <div style={{ width: '50px', height: '12px', background: '#1A1D36', borderRadius: '4px' }} />
        <div style={{ width: '80%', height: '14px', background: '#1A1D36', borderRadius: '4px' }} />
        <div style={{ width: '60%', height: '10px', background: '#1A1D36', borderRadius: '4px', marginTop: '4px' }} />
        <div style={{ width: '40%', height: '10px', background: '#1A1D36', borderRadius: '4px' }} />
      </div>
    </div>
  );
}

const HorizontalEventCard = memo(function HorizontalEventCard({ event, onPress, isSaved, onToggleSave, badgeText, badgeColor }: {
  event: Event;
  onPress: (e: Event) => void;
  isSaved: boolean;
  onToggleSave: (id: string) => void;
  badgeText?: string;
  badgeColor?: string;
}) {
  const countdown = useCardCountdown(event.event_date);
  return (
    <div
      onClick={() => onPress(event)}
      className="relative overflow-hidden cursor-pointer active:opacity-90 flex flex-col"
      style={{
        width: '180px',
        background: '#131629',
        borderRadius: '18px',
        border: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
      }}
    >
      <div style={{ height: '110px', position: 'relative' }}>
        <img
          src={event.image}
          alt={event.title}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {badgeText && (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              left: '8px',
              background: badgeColor || 'rgba(168,85,247,0.9)',
              backdropFilter: 'blur(4px)',
              padding: '3px 8px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
          >
            <span style={{ color: '#fff', fontSize: '9px', fontWeight: 800, letterSpacing: '0.05em' }}>
              {badgeText}
            </span>
          </div>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSave(event.id);
          }}
          className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', border: 'none', cursor: 'pointer' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill={isSaved ? '#A78BFA' : 'none'} stroke={isSaved ? '#A78BFA' : '#fff'} strokeWidth="2.5">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      </div>

      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', flex: 1, gap: '4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span
            style={{
              fontSize: '9px',
              color: '#A78BFA',
              fontWeight: 700,
              background: 'rgba(167,139,250,0.12)',
              padding: '2px 6px',
              borderRadius: '4px',
              width: 'fit-content',
            }}
          >
            {event.category.toUpperCase()}
          </span>
          {event.isPromoted && (
            <span
              style={{
                fontSize: '8px',
                color: event.promoPlan === 'trending' ? '#EF4444' : event.promoPlan === 'featured' ? '#F59E0B' : '#3B82F6',
                fontWeight: 800,
                background: event.promoPlan === 'trending' ? 'rgba(239,68,68,0.12)' : event.promoPlan === 'featured' ? 'rgba(245,158,11,0.12)' : 'rgba(59,130,246,0.12)',
                border: `1px solid ${event.promoPlan === 'trending' ? 'rgba(239,68,68,0.3)' : event.promoPlan === 'featured' ? 'rgba(245,158,11,0.3)' : 'rgba(59,130,246,0.3)'}`,
                padding: '2px 5px',
                borderRadius: '4px',
                letterSpacing: '0.05em',
              }}
            >
              {event.promoPlan === 'trending' ? '🔥 TRENDING' : event.promoPlan === 'featured' ? '⭐ FEATURED' : '⚡ SPOTLIGHT'}
            </span>
          )}
        </div>
        <h4
          style={{
            color: '#F0F0FF',
            fontSize: '13px',
            fontWeight: 700,
            lineHeight: 1.3,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            height: '34px',
            marginTop: '2px',
          }}
        >
          {event.title}
        </h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
          <Calendar size={10} color="#8B8FA8" />
          <span style={{ fontSize: '10px', color: '#8B8FA8' }}>{event.date}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <MapPin size={10} color="#8B8FA8" />
          <span style={{ fontSize: '10px', color: '#8B8FA8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
            {event.city}
          </span>
        </div>
        {event.organizer && event.organizer !== 'Verified Organizer' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontSize: '9px', color: '#A78BFA', fontWeight: 600 }}>@{event.organizer}</span>
          </div>
        )}
        {countdown && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: countdown === 'Happening now' ? 'rgba(16,185,129,0.12)' : 'rgba(168,85,247,0.1)', border: `1px solid ${countdown === 'Happening now' ? 'rgba(16,185,129,0.3)' : 'rgba(168,85,247,0.25)'}`, borderRadius: '5px', padding: '2px 6px', marginTop: '3px' }}>
            <span style={{ fontSize: '9px', color: countdown === 'Happening now' ? '#10B981' : '#A855F7', fontWeight: 700 }}>
              {countdown === 'Happening now' ? '🟢 Now' : `⏱ ${countdown}`}
            </span>
          </div>
        )}
        <div style={{ marginTop: 'auto', paddingTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '13px', color: '#FFB830', fontWeight: 800 }}>
            {formatPrice(event.price)}
          </span>
        </div>
      </div>
    </div>
  );
});

function HorizontalCardSkeleton() {
  return (
    <div
      style={{
        width: '180px',
        height: '220px',
        background: '#131629',
        borderRadius: '18px',
        border: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        opacity: 0.6,
        flexShrink: 0,
      }}
    >
      <div style={{ height: '110px', background: '#1A1D36' }} />
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
        <div style={{ width: '50px', height: '12px', background: '#1A1D36', borderRadius: '4px' }} />
        <div style={{ width: '80%', height: '14px', background: '#1A1D36', borderRadius: '4px' }} />
        <div style={{ width: '60%', height: '10px', background: '#1A1D36', borderRadius: '4px', marginTop: '4px' }} />
        <div style={{ width: '40%', height: '10px', background: '#1A1D36', borderRadius: '4px' }} />
      </div>
    </div>
  );
}

// ── Featured Carousel ─────────────────────────────────────────────
function FeaturedCarousel({
  events, currentIndex, onIndexChange, onEventPress, isSaved, onToggleSave,
}: {
  events: Event[];
  currentIndex: number;
  onIndexChange: (i: number) => void;
  onEventPress: (e: Event) => void;
  isSaved: string[];
  onToggleSave: (id: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartX = useRef<number | null>(null);

  const advance = useCallback(() => {
    onIndexChange((prev) => (prev + 1) % events.length);
  }, [events.length, onIndexChange]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (events.length <= 1) return;
    timerRef.current = setInterval(advance, 4000);
  }, [advance, events.length]);

  useEffect(() => {
    if (events.length <= 1) return;
    timerRef.current = setInterval(advance, 4000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [advance, events.length]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) {
      onIndexChange((prev) => (prev + 1) % events.length);
    } else {
      onIndexChange((prev) => (prev - 1 + events.length) % events.length);
    }
    resetTimer();
  };

  const event = events[currentIndex % events.length];
  if (!event) return null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between px-4 mb-3">
        <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          ⭐ Featured
        </h3>
        {events.length > 1 && (
          <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
            {events.map((_, i) => (
              <button
                key={i}
                onClick={() => onIndexChange(i)}
                style={{
                  width: i === currentIndex ? '18px' : '6px',
                  height: '6px',
                  borderRadius: '3px',
                  background: i === currentIndex ? '#A78BFA' : 'rgba(255,255,255,0.2)',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'width 0.3s, background 0.3s',
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div
        className="px-4"
        onClick={() => onEventPress(event)}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{ cursor: 'pointer' }}
      >
        <div style={{ borderRadius: '20px', overflow: 'hidden', position: 'relative', background: '#131629', border: '1px solid rgba(255,255,255,0.06)' }}>
          <img
            src={event.image}
            alt={event.title}
            style={{ width: '100%', height: '180px', objectFit: 'cover', display: 'block', minHeight: '180px' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'linear-gradient(to bottom, transparent 40%, rgba(6,10,18,0.92) 100%)' }} />
          <div style={{ position: 'absolute', top: '12px', left: '12px' }}>
            <span style={{ background: 'rgba(167,139,250,0.9)', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '3px 8px', borderRadius: '6px', letterSpacing: '0.05em' }}>⭐ FEATURED</span>
          </div>
          <button
            onClick={(ev) => { ev.stopPropagation(); onToggleSave(event.id); }}
            style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(0,0,0,0.4)', border: 'none', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <span style={{ fontSize: '14px' }}>{isSaved.includes(event.id) ? '🔖' : '🔖'}</span>
          </button>
          <div style={{ padding: '12px 14px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 800, margin: '0 0 6px', fontFamily: 'Space Grotesk, sans-serif', lineHeight: 1.2 }}>{event.title}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ color: '#C4C9E0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                📅 {event.date}
              </span>
              <span style={{ color: '#C4C9E0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                📍 {event.city}
              </span>
              <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 800 }}>{formatPrice(event.price)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomeScreen({
  onEventPress,
  savedEvents,
  onToggleSave,
  onNotificationsPress,
  onSearchPress: _onSearchPress,
  onProfilePress,
  onLiveMapPress,
  dbEvents,
  loading,
  fetchEvents,
  currentUser,
  hasMore,
  onLoadMore,
  unreadNotificationsCount: _unreadNotificationsCount,
}: HomeScreenProps) {
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [priceFilter, setPriceFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [upcomingOnly, setUpcomingOnly] = useState(true);
  const [featuredIndex, setFeaturedIndex] = useState(0);

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setSearchQuery(inputValue);
    }, 300);
    return () => clearTimeout(handler);
  }, [inputValue]);

  // Trigger fresh fetch on mount
  useEffect(() => {
    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Filter events locally based on requirements
  const filteredEvents = dbEvents.filter((event) => {
    // Search matches title, category, or location
    const matchQuery =
      !searchQuery.trim() ||
      event.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.venue.toLowerCase().includes(searchQuery.toLowerCase());

    // Category filter matches category name
    const matchCategory =
      activeCategory === 'all' ||
      event.category.toLowerCase() === activeCategory.toLowerCase();

    // State filter
    const matchState =
      stateFilter === 'all' ||
      event.state?.toLowerCase() === stateFilter.toLowerCase();

    // Price filter (free vs paid)
    const matchPrice =
      priceFilter === 'all' ||
      (priceFilter === 'free' && event.price === 0) ||
      (priceFilter === 'paid' && event.price > 0);

    // Upcoming events only validation (event_date >= now)
    const dt = event.event_date ? new Date(event.event_date) : new Date(event.date + ' ' + event.time);
    const matchUpcoming = !upcomingOnly || dt >= new Date();

    return matchQuery && matchCategory && matchState && matchPrice && matchUpcoming;
  });

  // Trending events (sort by bookingsCount DESC)
  const trendingEvents = [...dbEvents]
    .sort((a, b) => (b.bookingsCount || 0) - (a.bookingsCount || 0))
    .slice(0, 5);

  // Recently created events (sort by created_at DESC)
  const recentlyCreatedEvents = [...dbEvents]
    .sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeB - timeA;
    })
    .slice(0, 5);

  // Featured events (is_featured=true, randomized order)
  const featuredEvents = useMemo(() => {
    const arr = dbEvents.filter(e => e.isFeatured);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }, [dbEvents]);

  const isDefaultState = !searchQuery.trim() && activeCategory === 'all' && priceFilter === 'all';

  return (
    <div className="flex flex-col h-full" style={{ background: '#060A12', position: 'relative' }}>
      {/* Header */}
      <div 
        className="flex items-center justify-between px-5 pb-3"
        style={{ paddingTop: 'calc(20px + env(safe-area-inset-top))' }}
      >
        <div>
          <VentsLogo />
          <p style={{ marginTop: '3px', fontSize: '13px', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.01em' }}>
            Discover Nigeria's{' '}
            <em style={{ color: '#A855F7', fontStyle: 'normal', fontWeight: 600 }}>Best Events</em>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onLiveMapPress && (
            <button
              onClick={() => onLiveMapPress?.()}
              className="w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}
              title="Live Map"
            >
              <MapPin size={16} color="#C4C9E0" />
            </button>
          )}
          <button
            onClick={onNotificationsPress}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}
          >
            <Bell size={16} color="#C4C9E0" />
          </button>
          <button
            onClick={onProfilePress}
            className="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', cursor: 'pointer' }}
          >
            {currentUser?.avatar_url ? (
              <img src={currentUser.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>
                {(currentUser?.full_name || currentUser?.email || 'A').charAt(0).toUpperCase()}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(80px + env(safe-area-inset-bottom))' }}>
        {/* Search Bar */}
        <div className="px-4 mb-4">
          <div
            className="flex items-center gap-3 px-4"
            style={{
              height: '48px',
              background: '#131629',
              borderRadius: '14px',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <Search size={18} color="#8B8FA8" />
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Search title, category, location..."
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
            {inputValue && (
              <button
                onClick={() => { setInputValue(''); setSearchQuery(''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                <X size={16} color="#8B8FA8" />
              </button>
            )}
          </div>
        </div>



        {/* Filters and Sorting bar */}
        <div className="flex items-center gap-2 px-4 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#8B8FA8', fontSize: '11px', fontWeight: 600, marginRight: '4px', flexShrink: 0 }}>
            <Filter size={12} color="#8B8FA8" />
            FILTERS:
          </div>

          {/* State filter */}
          <div className="flex-shrink-0" style={{ position: 'relative' }}>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              style={{
                appearance: 'none',
                background: stateFilter !== 'all' ? 'rgba(167,139,250,0.12)' : '#131629',
                border: `1px solid ${stateFilter !== 'all' ? 'rgba(167,139,250,0.35)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '20px',
                fontSize: '11px',
                color: stateFilter !== 'all' ? '#A78BFA' : '#8B8FA8',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '4px 28px 4px 10px',
                outline: 'none',
              }}
            >
              <option value="all">📍 State: All</option>
              {NIGERIA_STATES.map((s) => (
                <option key={s.name} value={s.name}>📍 {s.name}</option>
              ))}
            </select>
            <ChevronDown size={10} color={stateFilter !== 'all' ? '#A78BFA' : '#8B8FA8'} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          </div>

          <button
            onClick={() => setPriceFilter(priceFilter === 'all' ? 'free' : priceFilter === 'free' ? 'paid' : 'all')}
            className="flex-shrink-0 px-3 py-1"
            style={{
              background: priceFilter !== 'all' ? 'rgba(167,139,250,0.12)' : '#131629',
              border: `1px solid ${priceFilter !== 'all' ? 'rgba(167,139,250,0.35)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: '20px',
              fontSize: '11px',
              color: priceFilter !== 'all' ? '#A78BFA' : '#8B8FA8',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {priceFilter === 'all' ? 'Price: All' : priceFilter === 'free' ? 'Free Only' : 'Paid Only'}
          </button>

          <button
            onClick={() => setUpcomingOnly(!upcomingOnly)}
            className="flex-shrink-0 px-3 py-1"
            style={{
              background: upcomingOnly ? 'rgba(16,185,129,0.12)' : '#131629',
              border: `1px solid ${upcomingOnly ? 'rgba(16,185,129,0.35)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: '20px',
              fontSize: '11px',
              color: upcomingOnly ? '#10B981' : '#8B8FA8',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {upcomingOnly ? '📅 Upcoming' : '📅 All Time'}
          </button>
        </div>

        {/* Category filter chips */}
        <div className="flex gap-2 px-4 mb-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {CATEGORIES.map((cat) => {
            const active = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(active ? 'all' : cat.id)}
                className="flex-shrink-0 flex items-center gap-1 px-3 py-1"
                style={{
                  background: active ? 'rgba(167,139,250,0.18)' : '#131629',
                  border: `1px solid ${active ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: '20px',
                  fontSize: '11px',
                  color: active ? '#C4B5FD' : '#8B8FA8',
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{cat.icon}</span>
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Results / Feed sections */}
        {loading ? (
          <>
            {isDefaultState && (
              <>
                <div className="mb-6">
                  <div className="px-4 mb-3">
                    <div style={{ width: '120px', height: '18px', background: '#1A1D36', borderRadius: '4px' }} />
                  </div>
                  <div className="flex gap-3 px-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <HorizontalCardSkeleton key={i} />
                    ))}
                  </div>
                </div>

                <div className="mb-6">
                  <div className="px-4 mb-3">
                    <div style={{ width: '140px', height: '18px', background: '#1A1D36', borderRadius: '4px' }} />
                  </div>
                  <div className="flex gap-3 px-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <HorizontalCardSkeleton key={i} />
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="px-4">
              <div className="mb-3">
                <div style={{ width: '100px', height: '16px', background: '#1A1D36', borderRadius: '4px' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            {isDefaultState && (
              <>
                {/* Featured Events Carousel */}
                {featuredEvents.length > 0 && (
                  <FeaturedCarousel
                    events={featuredEvents}
                    currentIndex={featuredIndex}
                    onIndexChange={setFeaturedIndex}
                    onEventPress={onEventPress}
                    isSaved={savedEvents}
                    onToggleSave={onToggleSave}
                  />
                )}

                {/* Trending Events */}
                {trendingEvents.length > 0 && (
                  <div className="mb-6">
                    <div className="flex items-center justify-between px-4 mb-3">
                      <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
                        🔥 Trending Events
                      </h3>
                    </div>
                    <div className="flex gap-3 px-4 overflow-x-auto" style={{ scrollbarWidth: 'none', paddingBottom: '4px' }}>
                      {trendingEvents.map((event) => (
                        <HorizontalEventCard
                          key={`trending-${event.id}`}
                          event={event}
                          onPress={onEventPress}
                          isSaved={savedEvents.includes(event.id)}
                          onToggleSave={onToggleSave}
                          badgeText={`${event.bookingsCount || 0} GOING`}
                          badgeColor="rgba(239, 68, 68, 0.9)"
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Recently Created Events section removed */}
              </>
            )}

            {/* Main grid of events */}
            <div className="px-4">
              <div className="flex items-center justify-between mb-3">
                <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
                  {isDefaultState ? '🎪 Explore Events' : '🔍 Search Results'}
                </h3>
                <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
                  {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
                </span>
              </div>

              {filteredEvents.length === 0 ? (
                <div className="flex flex-col items-center py-12 px-4 text-center">
                  {isDefaultState ? (
                    <>
                      <span style={{ fontSize: '48px', marginBottom: '12px' }}>🎪</span>
                      <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>
                        No events yet
                      </p>
                      <p style={{ color: '#6B7280', fontSize: '13px', marginTop: '6px', lineHeight: 1.6, maxWidth: '260px' }}>
                        We're just getting started. Check back soon — events are on the way.
                      </p>
                    </>
                  ) : (
                    <>
                      <Search size={48} color="#2A2D3E" strokeWidth={1.5} />
                      <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '12px' }}>
                        No matches
                      </p>
                      <p style={{ color: '#6B7280', fontSize: '13px', marginTop: '4px' }}>
                        Try a different search or clear the filters.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {filteredEvents.map((event) => (
                    <FeedCard
                      key={event.id}
                      event={event}
                      onPress={onEventPress}
                      isSaved={savedEvents.includes(event.id)}
                      onToggleSave={onToggleSave}
                    />
                  ))}
                </div>
              )}

              {hasMore && onLoadMore && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px', marginBottom: '8px' }}>
                  <button
                    onClick={onLoadMore}
                    style={{
                      background: 'rgba(167,139,250,0.1)',
                      border: '1px solid rgba(167,139,250,0.2)',
                      borderRadius: '12px',
                      padding: '10px 20px',
                      color: '#A78BFA',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      fontFamily: 'Space Grotesk, sans-serif',
                    }}
                  >
                    Load More Events
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

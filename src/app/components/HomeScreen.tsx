import { useState, useEffect, memo, useMemo, useRef, useCallback } from 'react';
import {
  Search, Bell, MapPin, X, SlidersHorizontal, Plus,
  Clock, Calendar, CalendarDays, LayoutGrid, Music, Cpu, UtensilsCrossed, Laugh, Palette,
  Dumbbell, Presentation, Heart, Moon, Sparkles, Activity, BookOpen, Diamond,
  Gamepad2, TrendingUp, Sun, Gift, Film, Landmark, Compass, Star, Image, Mic, Wrench,
} from 'lucide-react';
import { Event } from './types';
import { insforge } from '../../lib/insforge';
import { VentsLogo } from './VentsLogo';
import BadgeChip from './BadgeChip';
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
  onCreatePress?: () => void;
  onUserPress?: (user: { id: string; name: string; username: string; avatar_url?: string }) => void;
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

const CATEGORIES = [{ id: 'all', label: 'All', icon: '' }, ...CATEGORY_LIST];

export function mapDbEventToFrontend(dbEvent: any): Event {
  const dt = dbEvent.event_date ? new Date(dbEvent.event_date) : null;
  const dateStr = dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  
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
    organizerVcBadge: dbEvent.organizer_vc_badge || null,
    organizerVerified: true,
    isFeatured: dbEvent.is_featured === true && (
      !dbEvent.featured_until || new Date(dbEvent.featured_until) > new Date()
    ),
    isTrending: false,
    attendees: 0,
    capacity: Number(dbEvent.ticket_goal || dbEvent.capacity || 1000),
    rating: 0,
    reviewCount: 0,
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
    event_date: dbEvent.event_date,
    is_18_plus: dbEvent.is_18_plus === true,
  };
}

const FeedCard = memo(function FeedCard({ event, onPress, isSaved, onToggleSave }: {
  event: Event;
  onPress: (e: Event) => void;
  isSaved: boolean;
  onToggleSave: (id: string) => void;
}) {
  const isSelling = (event.bookingsCount ?? 0) > 50;
  const countdown = useCardCountdown(event.event_date);

  return (
    <div
      onClick={() => onPress(event)}
      className="relative overflow-hidden cursor-pointer active:opacity-90 flex flex-col"
      style={{
        width: '100%',
        background: '#0D0D1A',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ height: '110px', position: 'relative' }}>
        <img
          src={event.image}
          alt={event.title}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            const el = e.currentTarget as HTMLImageElement;
            el.style.display = 'none';
            const parent = el.parentElement;
            if (parent && !parent.querySelector('.img-fallback')) {
              const fb = document.createElement('div');
              fb.className = 'img-fallback';
              fb.style.cssText = 'width:100%;height:100%;background:linear-gradient(135deg,#1e1040 0%,#0f172a 100%);display:flex;align-items:center;justify-content:center;font-size:28px;';
              fb.textContent = '🎉';
              parent.insertBefore(fb, parent.firstChild);
            }
          }}
        />
        {/* FOMO tag */}
        {isSelling && (
          <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'rgba(255,0,110,0.15)', border: '1px solid rgba(255,0,110,0.5)', borderRadius: '6px', padding: '2px 7px', display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span style={{ fontSize: '9px', color: '#FF006E', fontWeight: 800, letterSpacing: '0.02em' }}>Selling Fast!</span>
          </div>
        )}
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

      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', flex: 1 }}>
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
              {event.promoPlan === 'trending' ? 'TRENDING' : event.promoPlan === 'featured' ? 'FEATURED' : 'SPOTLIGHT'}
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
        {event.organizer && event.organizer !== 'Verified Organizer' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '9px', color: '#A78BFA', fontWeight: 600 }}>@{event.organizer}</span>
            <BadgeChip tier={event.organizerVcBadge} />
          </div>
        )}
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
        {countdown && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: countdown === 'Happening now' ? 'rgba(16,185,129,0.12)' : 'rgba(168,85,247,0.1)', border: `1px solid ${countdown === 'Happening now' ? 'rgba(16,185,129,0.3)' : 'rgba(168,85,247,0.25)'}`, borderRadius: '5px', padding: '2px 6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '9px', color: countdown === 'Happening now' ? '#10B981' : '#A855F7', fontWeight: 700 }}>
              {countdown === 'Happening now' ? '🟢 Now' : `⏱ ${countdown}`}
            </span>
          </div>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12px', color: event.price === 0 ? '#06D6A0' : '#FFB830', fontWeight: 700 }}>
            {formatPrice(event.price)}
          </span>
          {event.is_18_plus && (
            <span style={{ fontSize: '10px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '5px', padding: '1px 5px', color: '#EF4444', fontWeight: 700 }}>18+</span>
          )}
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
        width: '162px',
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
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            const el = e.currentTarget as HTMLImageElement;
            el.style.display = 'none';
            const parent = el.parentElement;
            if (parent && !parent.querySelector('.img-fallback')) {
              const fb = document.createElement('div');
              fb.className = 'img-fallback';
              fb.style.cssText = 'width:100%;height:100%;background:linear-gradient(135deg,#1e1040 0%,#0f172a 100%);display:flex;align-items:center;justify-content:center;font-size:28px;';
              fb.textContent = '🎉';
              parent.insertBefore(fb, parent.firstChild);
            }
          }}
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
              {event.promoPlan === 'trending' ? 'TRENDING' : event.promoPlan === 'featured' ? 'FEATURED' : 'SPOTLIGHT'}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '9px', color: '#A78BFA', fontWeight: 600 }}>@{event.organizer}</span>
            <BadgeChip tier={event.organizerVcBadge} />
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
          <span style={{ fontSize: '13px', color: event.price === 0 ? '#06D6A0' : '#FFB830', fontWeight: 800 }}>
            {formatPrice(event.price)}
          </span>
        </div>
      </div>
    </div>
  );
});

const shimmerBg: React.CSSProperties = {
  background: 'linear-gradient(90deg, #1a1d2e 25%, #252840 50%, #1a1d2e 75%)',
  backgroundSize: '800px 100%',
  animation: 'shimmer 1.4s infinite linear',
};

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
        flexShrink: 0,
      }}
    >
      <div style={{ height: '110px', borderRadius: 0, ...shimmerBg }} />
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
        <div style={{ width: '50px', height: '12px', borderRadius: '4px', ...shimmerBg }} />
        <div style={{ width: '80%', height: '14px', borderRadius: '4px', ...shimmerBg }} />
        <div style={{ width: '60%', height: '10px', borderRadius: '4px', marginTop: '4px', ...shimmerBg }} />
        <div style={{ width: '40%', height: '10px', borderRadius: '4px', ...shimmerBg }} />
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
        <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Featured
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
        <div style={{ borderRadius: '20px', overflow: 'hidden', position: 'relative', height: '52vh', minHeight: '280px', maxHeight: '460px', background: '#131629', border: '1px solid rgba(255,255,255,0.06)' }}>
          <img
            src={event.image}
            alt={event.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
          {/* Deep gradient from transparent at top to almost-black at bottom */}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.08) 0%, transparent 30%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.92) 100%)' }} />
          {/* FEATURED badge */}
          <div style={{ position: 'absolute', top: '14px', left: '14px' }}>
            <span style={{ background: 'rgba(167,139,250,0.92)', backdropFilter: 'blur(8px)', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '4px 10px', borderRadius: '8px', letterSpacing: '0.05em' }}>FEATURED</span>
          </div>
          {/* Save button */}
          <button
            onClick={(ev) => { ev.stopPropagation(); onToggleSave(event.id); }}
            style={{ position: 'absolute', top: '14px', right: '14px', background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', border: 'none', borderRadius: '50%', width: '34px', height: '34px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <span style={{ fontSize: '14px' }}>{isSaved.includes(event.id) ? '🔖' : '🔖'}</span>
          </button>
          {/* Info overlay at bottom */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '20px 16px 18px' }}>
            {event.organizer && event.organizer !== 'Verified Organizer' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '4px' }}>
                <p style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 600, margin: 0 }}>@{event.organizer}</p>
                <BadgeChip tier={event.organizerVcBadge} />
              </div>
            )}
            <p style={{ color: '#FFFFFF', fontSize: '20px', fontWeight: 900, margin: '0 0 10px', fontFamily: 'Space Grotesk, sans-serif', lineHeight: 1.2, textShadow: '0 1px 8px rgba(0,0,0,0.6)' }}>{event.title}</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>{event.date}</span>
              <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>{event.city}</span>
              <span style={{ background: event.price === 0 ? 'rgba(6,214,160,0.15)' : 'rgba(167,139,250,0.2)', border: `1px solid ${event.price === 0 ? 'rgba(6,214,160,0.4)' : 'rgba(167,139,250,0.4)'}`, color: event.price === 0 ? '#06D6A0' : '#A78BFA', fontSize: '13px', fontWeight: 800, padding: '2px 10px', borderRadius: '20px' }}>{formatPrice(event.price)}</span>
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
  onCreatePress,
  onUserPress,
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [priceFilter, setPriceFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [upcomingOnly, setUpcomingOnly] = useState(true);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Temp states used inside the sheet before Apply
  const [tempCategory, setTempCategory] = useState('all');
  const [tempState, setTempState] = useState('all');
  const [tempPrice, setTempPrice] = useState<'all' | 'free' | 'paid'>('all');

  const openFilterSheet = () => {
    setTempCategory(activeCategory);
    setTempState(stateFilter);
    setTempPrice(priceFilter);
    setFilterSheetOpen(true);
  };
  const applyFilters = () => {
    setActiveCategory(tempCategory);
    setStateFilter(tempState);
    setPriceFilter(tempPrice);
    setFilterSheetOpen(false);
  };
  const clearFilters = () => {
    setTempCategory('all');
    setTempState('all');
    setTempPrice('all');
  };
  const hasActiveFilters = stateFilter !== 'all' || priceFilter !== 'all';

  // Pull-to-refresh
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const handlePullTouchStart = (e: React.TouchEvent) => {
    pullStartY.current = e.touches[0].clientY;
  };
  const handlePullTouchEnd = async (e: React.TouchEvent) => {
    if (pullStartY.current === null) return;
    const dy = e.changedTouches[0].clientY - pullStartY.current;
    pullStartY.current = null;
    if (dy > 120 && !pullRefreshing) {
      setPullRefreshing(true);
      try { await fetchEvents(); } finally { setPullRefreshing(false); }
    }
  };

  const ICON_CATEGORIES: { id: string; label: string; icon: React.ElementType; color: string }[] = [
    { id: 'today', label: 'Today', icon: Clock, color: '#A0A0A0' },
    { id: 'week', label: 'This Week', icon: CalendarDays, color: '#A8DADC' },
    { id: 'all', label: 'All', icon: LayoutGrid, color: '#7B2FF7' },
    { id: 'Music', label: 'Music', icon: Music, color: '#FF6B6B' },
    { id: 'Technology', label: 'Tech', icon: Cpu, color: '#4ECDC4' },
    { id: 'Food & Drinks', label: 'Food', icon: UtensilsCrossed, color: '#FFE66D' },
    { id: 'Comedy Shows', label: 'Comedy', icon: Laugh, color: '#FF8C42' },
    { id: 'Arts & Culture', label: 'Arts', icon: Palette, color: '#C77DFF' },
    { id: 'Sports & Wellness', label: 'Sports', icon: Dumbbell, color: '#06D6A0' },
    { id: 'Conferences', label: 'Conferences', icon: Presentation, color: '#4CC9F0' },
    { id: 'Family Events', label: 'Family', icon: Heart, color: '#FF6B9D' },
    { id: 'Nightlife', label: 'Nightlife', icon: Moon, color: '#9B5DE5' },
    { id: 'Fashion', label: 'Fashion', icon: Sparkles, color: '#F72585' },
    { id: 'Health & Wellness', label: 'Wellness', icon: Activity, color: '#43AA8B' },
    { id: 'Education', label: 'Education', icon: BookOpen, color: '#4361EE' },
    { id: 'Weddings', label: 'Weddings', icon: Diamond, color: '#FFD166' },
    { id: 'Gaming', label: 'Gaming', icon: Gamepad2, color: '#7209B7' },
    { id: 'Business & Finance', label: 'Finance', icon: TrendingUp, color: '#3A86FF' },
    { id: 'Religious & Spiritual', label: 'Religious', icon: Sun, color: '#FFBE0B' },
    { id: 'Charity & Fundraising', label: 'Charity', icon: Gift, color: '#FB5607' },
    { id: 'Film & Media', label: 'Film', icon: Film, color: '#8338EC' },
    { id: 'Politics', label: 'Politics', icon: Landmark, color: '#023E8A' },
    { id: 'Travel & Adventure', label: 'Travel', icon: Compass, color: '#0096C7' },
    { id: 'Kids & Family', label: 'Kids', icon: Star, color: '#FFCA3A' },
    { id: 'Art Exhibition', label: 'Exhibition', icon: Image, color: '#E9C46A' },
    { id: 'Open Mic', label: 'Open Mic', icon: Mic, color: '#F4A261' },
    { id: 'Workshop', label: 'Workshop', icon: Wrench, color: '#2EC4B6' },
  ];

  // Debounce search query
  useEffect(() => {
    const handler = setTimeout(() => {
      setSearchQuery(inputValue);
    }, 300);
    return () => clearTimeout(handler);
  }, [inputValue]);

  // People search state (for full-screen search overlay)
  const [searchPeople, setSearchPeople] = useState<any[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [suggestedPeople, setSuggestedPeople] = useState<any[]>([]);

  useEffect(() => {
    insforge.database
      .from('public_profiles')
      .select('id, full_name, username, avatar_url, is_verified, role, vc_badge')
      .eq('is_verified', true)
      .limit(5)
      .then(({ data }) => setSuggestedPeople(data || []));
  }, []);

  useEffect(() => {
    const q = inputValue.trim();
    if (!q) { setSearchPeople([]); return; }
    setLoadingPeople(true);
    const t = setTimeout(async () => {
      try {
        const like = `%${q.toLowerCase()}%`;
        const { data } = await insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, is_verified, role, vc_badge')
          .or(`username.ilike.${like},full_name.ilike.${like}`)
          .limit(8);
        setSearchPeople(data || []);
      } catch { /* ignore */ } finally { setLoadingPeople(false); }
    }, 300);
    return () => clearTimeout(t);
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

    // Category filter (today/week are date-based; featured events appear in all tabs)
    const matchCategory =
      activeCategory === 'all' ||
      activeCategory === 'today' ||
      activeCategory === 'week' ||
      event.isFeatured ||
      event.category.toLowerCase() === activeCategory.toLowerCase();

    const evtDt = event.event_date ? new Date(event.event_date) : (event.date ? new Date(event.date) : null);
    const _now = new Date();
    const _todayStart = new Date(_now.toISOString().split('T')[0]);
    const _todayEnd = new Date(_todayStart); _todayEnd.setDate(_todayEnd.getDate() + 1);
    const _weekEnd = new Date(_todayStart); _weekEnd.setDate(_weekEnd.getDate() + 7);
    const matchDateCategory =
      (activeCategory !== 'today' && activeCategory !== 'week') ||
      (activeCategory === 'today' && evtDt !== null && evtDt >= _todayStart && evtDt < _todayEnd) ||
      (activeCategory === 'week' && evtDt !== null && evtDt >= _now && evtDt <= _weekEnd);

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

    return matchQuery && matchCategory && matchDateCategory && matchState && matchPrice && matchUpcoming;
  }).sort((a, b) => {
    // On non-All tabs, featured events float to the top
    if (activeCategory !== 'all' && activeCategory !== 'today' && activeCategory !== 'week') {
      if (a.isFeatured && !b.isFeatured) return -1;
      if (!a.isFeatured && b.isFeatured) return 1;
    }
    return 0;
  });

  const todayStart = new Date(new Date().toISOString().split('T')[0]);
  const upcomingDbEvents = dbEvents.filter(e => {
    const d = e.event_date ? new Date(e.event_date) : (e.date ? new Date(e.date) : null);
    return d && d >= todayStart;
  });

  // Trending events (sort by bookingsCount DESC)
  const trendingEvents = [...upcomingDbEvents]
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

  // Featured events (is_featured=true, upcoming only, randomized order)
  const featuredEvents = useMemo(() => {
    const start = new Date(new Date().toISOString().split('T')[0]);
    const arr = dbEvents.filter(e => {
      if (!e.isFeatured) return false;
      const d = e.event_date ? new Date(e.event_date) : (e.date ? new Date(e.date) : null);
      return d && d >= start;
    });
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }, [dbEvents]);

  const isDefaultState = !searchQuery.trim() && activeCategory === 'all' && priceFilter === 'all';

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: '#060A12', position: 'relative' }}
      onTouchStart={handlePullTouchStart}
      onTouchEnd={handlePullTouchEnd}
    >
      {/* Pull-to-refresh spinner */}
      {pullRefreshing && (
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
      {/* Full-screen Search overlay */}
      {searchOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 100, background: '#060A12', display: 'flex', flexDirection: 'column' }}>
          {/* Search bar */}
          <div style={{ padding: 'calc(14px + env(safe-area-inset-top)) 16px 10px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', background: '#131629', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', padding: '0 14px', height: '46px' }}>
              <Search size={17} color="#8B8FA8" />
              <input
                autoFocus
                type="text"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                placeholder="Search people and events..."
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
              />
              {inputValue && (
                <button onClick={() => { setInputValue(''); setSearchQuery(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                  <X size={15} color="#8B8FA8" />
                </button>
              )}
            </div>
            <button
              onClick={() => { setSearchOpen(false); setInputValue(''); setSearchQuery(''); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#A78BFA', fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap' }}
            >
              Cancel
            </button>
          </div>

          {/* Results */}
          <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '0 16px 32px' }}>
            {!inputValue.trim() ? (
              <>
                {/* Suggested People */}
                {suggestedPeople.length > 0 && (
                  <>
                    <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>SUGGESTED PEOPLE</p>
                    {suggestedPeople.map((u: any) => (
                      <div
                        key={u.id}
                        onClick={() => { setSearchOpen(false); setInputValue(''); onUserPress?.({ id: u.id, name: u.full_name || u.username || 'Vents User', username: u.username || '', avatar_url: u.avatar_url }); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
                      >
                        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: '#7B2FBE', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>{(u.full_name || u.username || 'U')[0]?.toUpperCase()}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{u.full_name || u.username}</span>
                            <BadgeChip tier={u.vc_badge} />
                          </div>
                          <span style={{ color: '#8B8FA8', fontSize: '12px' }}>@{u.username}</span>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {/* Popular Events */}
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '16px 0 10px' }}>POPULAR EVENTS</p>
                {dbEvents.slice(0, 4).map(ev => (
                  <div
                    key={ev.id}
                    onClick={() => { setSearchOpen(false); setInputValue(''); onEventPress(ev); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
                  >
                    <div style={{ width: '44px', height: '44px', borderRadius: '10px', overflow: 'hidden', flexShrink: 0, background: '#131629' }}>
                      <img src={ev.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</span>
                      <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{ev.date} · {ev.venue}</span>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <>
                {/* People results */}
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>PEOPLE</p>
                {loadingPeople ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '16px' }}>Searching…</p>
                ) : searchPeople.length === 0 ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '16px' }}>No people found</p>
                ) : (
                  <>
                    {searchPeople.map((u: any) => (
                      <div
                        key={u.id}
                        onClick={() => { setSearchOpen(false); setInputValue(''); onUserPress?.({ id: u.id, name: u.full_name || u.username || 'Vents User', username: u.username || '', avatar_url: u.avatar_url }); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
                      >
                        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: '#7B2FBE', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>{(u.full_name || u.username || 'U')[0]?.toUpperCase()}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{u.full_name || u.username}</span>
                            <BadgeChip tier={u.vc_badge} />
                          </div>
                          <span style={{ color: '#8B8FA8', fontSize: '12px' }}>@{u.username}</span>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* Event results */}
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '14px 0 10px' }}>EVENTS</p>
                {filteredEvents.length === 0 ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px' }}>No events found</p>
                ) : (
                  filteredEvents.slice(0, 8).map(ev => (
                    <div
                      key={ev.id}
                      onClick={() => { setSearchOpen(false); onEventPress(ev); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}
                    >
                      <div style={{ width: '44px', height: '44px', borderRadius: '10px', overflow: 'hidden', flexShrink: 0, background: '#131629' }}>
                        <img src={ev.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</span>
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{ev.date} · {ev.venue}</span>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'calc(14px + env(safe-area-inset-top)) 16px 10px',
          flexShrink: 0,
        }}
      >
        {/* Logo + tagline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          <VentsLogo />
          <div style={{ fontSize: '10px', fontWeight: 400, paddingLeft: '2px' }}>
            <span style={{ color: '#888888' }}>Discover Nigeria's </span>
            <span style={{ color: '#7B2FF7', fontWeight: 700, textShadow: '0 0 8px rgba(123,47,247,0.8)' }}>Best</span>
            <span style={{ color: '#888888' }}> Events</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Filters button */}
          <button
            onClick={openFilterSheet}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '36px', height: '36px',
              background: 'rgba(123,47,247,0.1)',
              border: '1px solid rgba(123,47,247,0.3)',
              borderRadius: '50%', cursor: 'pointer', position: 'relative', flexShrink: 0,
            }}
          >
            <SlidersHorizontal size={15} color="#7B2FF7" />
            {hasActiveFilters && (
              <span style={{
                position: 'absolute', top: '-2px', right: '-2px',
                width: '8px', height: '8px', borderRadius: '50%',
                background: '#7B2FF7', border: '2px solid #060A12',
              }} />
            )}
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(123,47,247,0.15)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Search size={17} color="#A78BFA" />
          </button>
          <button
            onClick={onNotificationsPress}
            style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#131629', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Bell size={16} color="#C4C9E0" />
          </button>
          <button
            onClick={onProfilePress}
            style={{ width: '32px', height: '32px', borderRadius: '50%', overflow: 'hidden', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            {currentUser?.avatar_url ? (
              <img src={currentUser.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ color: '#fff', fontSize: '13px', fontWeight: 700 }}>
                {(currentUser?.full_name || currentUser?.email || 'A').charAt(0).toUpperCase()}
              </span>
            )}
          </button>
          {(currentUser?.role === 'organizer' || currentUser?.role === 'admin' || currentUser?.role === 'root') && (
            <button
              onClick={onCreatePress}
              style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#7B2FF7', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(123,47,247,0.45)' }}
            >
              <Plus size={17} color="#fff" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(80px + env(safe-area-inset-bottom))' }}>



        {/* Category icon bar */}
        <div style={{ display: 'flex', gap: '4px', paddingLeft: '12px', paddingRight: '12px', marginBottom: '16px', overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties}>
          {ICON_CATEGORIES.map((cat) => {
            const active = activeCategory === cat.id;
            const IconComp = cat.icon;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(active && cat.id !== 'all' ? 'all' : cat.id)}
                style={{
                  width: '64px', minWidth: '64px', padding: '8px 4px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0,
                }}
              >
                <div style={{
                  width: '44px', height: '44px', borderRadius: '12px',
                  background: active
                    ? (cat.id === 'today' ? 'rgba(160,160,160,0.2)' : cat.color)
                    : 'rgba(255,255,255,0.06)',
                  boxShadow: active && cat.id !== 'today' ? `0 0 12px ${cat.color}66` : 'none',
                  border: active && cat.id === 'today' ? '1.5px solid rgba(255,255,255,0.3)' : 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.2s, box-shadow 0.2s',
                }}>
                  <IconComp size={20} color={active ? '#FFFFFF' : cat.color} />
                </div>
                <span style={{
                  fontSize: '10px', fontWeight: 600,
                  color: active ? '#FFFFFF' : '#AAAAAA',
                  marginTop: '6px', maxWidth: '62px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textAlign: 'center',
                }}>
                  {cat.label}
                </span>
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
                      <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Trending Events
                      </h3>
                    </div>
                    <div className="flex gap-3 overflow-x-auto" style={{ scrollbarWidth: 'none', paddingBottom: '4px', paddingLeft: '16px', paddingRight: '0' }}>
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
                <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', textTransform: 'uppercase', letterSpacing: '1px' }}>
                  {isDefaultState ? 'Explore Events' : 'Search Results'}
                </h3>
                <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
                  {filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}
                </span>
              </div>

              {filteredEvents.length === 0 ? (
                <div className="flex flex-col items-center py-12 px-4 text-center">
                  {isDefaultState ? (
                    <>
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2A2D3E" strokeWidth="1.5" style={{ marginBottom: '12px' }}><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
                      <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>
                        No events yet
                      </p>
                      <p style={{ color: '#6B7280', fontSize: '13px', marginTop: '6px', lineHeight: 1.6, maxWidth: '260px' }}>
                        Check back soon — new events are added every day.
                      </p>
                    </>
                  ) : !searchQuery.trim() && activeCategory !== 'all' ? (
                    <>
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2A2D3E" strokeWidth="1.5" style={{ marginBottom: '12px' }}><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
                      <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '4px' }}>
                        No {activeCategory} events yet
                      </p>
                      <p style={{ color: '#6B7280', fontSize: '13px', marginTop: '6px', lineHeight: 1.6, maxWidth: '260px' }}>
                        Check back soon or browse <span style={{ color: '#A855F7', cursor: 'pointer' }} onClick={() => setActiveCategory('all')}>All events</span>.
                      </p>
                    </>
                  ) : (
                    <>
                      <Search size={48} color="#2A2D3E" strokeWidth={1.5} />
                      <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '12px' }}>
                        No matches
                      </p>
                      <p style={{ color: '#6B7280', fontSize: '13px', marginTop: '4px' }}>
                        Try a different search or browse all events.
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

      {/* Filter bottom sheet */}
      {filterSheetOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setFilterSheetOpen(false)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200 }}
          />
          {/* Sheet */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 201,
            background: '#0E1020', borderRadius: '24px 24px 0 0',
            border: '1px solid rgba(255,255,255,0.08)',
            paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
            maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          }}>
            {/* Handle */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
              <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.15)' }} />
            </div>
            {/* Title */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 20px 16px' }}>
              <span style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800 }}>Filters</span>
              <button onClick={() => setFilterSheetOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                <X size={20} color="#8B8FA8" />
              </button>
            </div>

            {/* Scrollable content */}
            <div style={{ overflowY: 'auto', flex: 1, scrollbarWidth: 'none', padding: '0 20px' }}>
              {/* STATE */}
              <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '10px' }}>STATE</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '24px' }}>
                {['All States', 'Lagos', 'Abuja', 'Rivers', 'Kano', 'Oyo', 'Enugu', 'Delta',
                  'Anambra', 'Edo', 'Ogun', 'Ondo', 'Kwara', 'Kogi', 'Benue', 'Plateau',
                  'Kaduna', 'Sokoto', 'Kebbi', 'Zamfara', 'Katsina', 'Jigawa', 'Bauchi',
                  'Gombe', 'Yobe', 'Borno', 'Adamawa', 'Taraba', 'Nasarawa', 'Niger',
                  'Ekiti', 'Imo', 'Abia', 'Ebonyi', 'Cross River', 'Akwa Ibom', 'Bayelsa'
                ].map((st) => {
                  const stId = st === 'All States' ? 'all' : st;
                  const active = tempState === stId;
                  return (
                    <button
                      key={st}
                      onClick={() => setTempState(stId)}
                      style={{
                        padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 500,
                        cursor: 'pointer', border: active ? 'none' : '1px solid #333',
                        background: active ? '#7B2FF7' : 'transparent',
                        color: active ? '#fff' : '#666666',
                      }}
                    >{st}</button>
                  );
                })}
              </div>

              {/* PRICE */}
              <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', marginBottom: '10px' }}>PRICE</p>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
                {(['all', 'free', 'paid'] as const).map((p) => {
                  const active = tempPrice === p;
                  return (
                    <button
                      key={p}
                      onClick={() => setTempPrice(p)}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '12px', fontSize: '13px', fontWeight: 600,
                        cursor: 'pointer', border: active ? 'none' : '1px solid #333',
                        background: active ? '#7B2FF7' : 'transparent',
                        color: active ? '#fff' : '#666666',
                      }}
                    >{p === 'all' ? 'All' : p === 'free' ? 'Free' : 'Paid'}</button>
                  );
                })}
              </div>
            </div>

            {/* Footer buttons */}
            <div style={{ display: 'flex', gap: '12px', padding: '16px 20px 0' }}>
              <button
                onClick={clearFilters}
                style={{
                  flex: 1, padding: '14px', borderRadius: '14px', fontSize: '14px', fontWeight: 700,
                  background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                  color: '#C4C9E0', cursor: 'pointer',
                }}
              >Clear All</button>
              <button
                onClick={applyFilters}
                style={{
                  flex: 2, padding: '14px', borderRadius: '14px', fontSize: '14px', fontWeight: 700,
                  background: '#7B2FF7', border: 'none', color: '#fff', cursor: 'pointer',
                  boxShadow: '0 4px 16px rgba(123,47,247,0.4)',
                }}
              >Apply</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

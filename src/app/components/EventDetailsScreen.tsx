import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import BadgeChip from './BadgeChip';
import {
  ArrowLeft,
  Share2,
  MapPin,
  Calendar,
  Clock,
  Users,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Mic2,
  Tag,
  Send,
  MessageSquarePlus,
  Phone,
  MessageCircle,
  Minus,
  Plus,
  Flag,
  CalendarPlus,
  Shield,
  ScanLine,
  LayoutDashboard,
} from 'lucide-react';
import { Event, TicketType } from './types';
import { formatPrice } from './data';
import { mapDbEventToFrontend } from './HomeScreen';
import { insforge } from '../../lib/insforge';
import { openExternalUrl } from '../../lib/externalLink';
import { analytics } from '../../lib/analyticsEvents';
import { EVENT_CARD_ASPECT_CSS } from '../../lib/eventCardAspect';
import { ReportModal } from './ReportModal';
import { ImageCarousel } from './ImageCarousel';
import { LazyImage } from './LazyImage';
import { FlyerLightbox } from './FlyerLightbox';
import { EventMap } from './EventMap';

interface EventDetailsScreenExtraProps {
  currentUserId?: string;
  onOrganizerPress?: (organizerId: string) => void;
  onMessageOrganizer?: (organizerId: string, eventId: string, eventTitle: string) => void;
}

interface EventDetailsScreenProps {
  event: Event;
  onBack: () => void;
  onGetTickets: (ticketType: TicketType, qty: number) => void;
  isSaved: boolean;
  onToggleSave: () => void;
  isBooked?: boolean;
  onBook?: () => void;
  bookingLoading?: boolean;
  onEventPress?: (event: Event) => void;
  currentUserId?: string;
  currentUserRole?: string;
  onOrganizerPress?: (organizerId: string) => void;
  onMessageOrganizer?: (organizerId: string, eventId: string, eventTitle: string) => void;
  onOpenDoorScanner?: () => void;
  onOpenDoorManager?: () => void;
  // Kill switch (app_config.disable_purchases) — server-side purchase_ticket
  // also rejects with 'purchases_disabled' if this is bypassed, so this
  // prop is purely a graceful-degradation UI state, not the real gate.
  purchasesDisabled?: boolean;
}

// Root admin account — same convention used in App.tsx / AdminDashboardScreen.tsx.
const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

function parseEventDate(eventDate?: string, dateStr?: string, timeStr?: string): number {
  if (eventDate) {
    const t = new Date(eventDate).getTime();
    if (!isNaN(t)) return t;
  }

  if (dateStr && timeStr) {
    try {
      const cleanDate = dateStr.replace(/^[A-Za-z]+,\s*/, '').trim();
      const parts = cleanDate.replace(/,/g, '').split(/\s+/);
      if (parts.length === 3) {
        const monthStr = parts[0];
        const day = parseInt(parts[1], 10);
        const year = parseInt(parts[2], 10);

        const months: Record<string, number> = {
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
          jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
        };
        const monthIndex = months[monthStr.toLowerCase().slice(0, 3)];

        const timeParts = timeStr.trim().split(/\s+/);
        if (timeParts.length >= 1) {
          const hm = timeParts[0].split(':');
          let hours = parseInt(hm[0], 10);
          const minutes = hm.length > 1 ? parseInt(hm[1], 10) : 0;
          const ampm = timeParts.length > 1 ? timeParts[1].toLowerCase() : '';

          if (ampm === 'pm' && hours < 12) {
            hours += 12;
          } else if (ampm === 'am' && hours === 12) {
            hours = 0;
          }

          if (monthIndex !== undefined && !isNaN(day) && !isNaN(year) && !isNaN(hours) && !isNaN(minutes)) {
            const dateObj = new Date(year, monthIndex, day, hours, minutes, 0, 0);
            return dateObj.getTime();
          }
        }
      }
    } catch (e) {
      console.error("Failed to parse fallback date:", e);
    }
  }

  return NaN;
}

function useCountdown(eventDate?: string, dateStr?: string, timeStr?: string) {
  const target = useMemo(() => {
    return parseEventDate(eventDate, dateStr, timeStr);
  }, [eventDate, dateStr, timeStr]);

  const [remaining, setRemaining] = useState(() => {
    if (isNaN(target)) return 0;
    const rem = target - Date.now();
    return rem > 0 ? rem : 0;
  });

  useEffect(() => {
    if (isNaN(target) || target <= 0) {
      setRemaining(0);
      return;
    }

    const initialRem = target - Date.now();
    if (initialRem <= 0) {
      setRemaining(0);
      return;
    }

    setRemaining(initialRem);

    const intervalId = setInterval(() => {
      const currentRem = target - Date.now();
      if (currentRem <= 0) {
        setRemaining(0);
        clearInterval(intervalId);
      } else {
        setRemaining(currentRem);
      }
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [target]);

  if (remaining <= 0) return null;

  const d = Math.floor(remaining / 86400000);
  const h = Math.floor((remaining % 86400000) / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);

  return { d, h, m, s };
}

function CountdownUnit({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          background: '#090514',
          border: '1px solid rgba(168,85,247,0.2)',
          borderRadius: '12px',
          padding: '8px 12px',
          minWidth: '50px',
        }}
      >
        <span style={{ color: '#FFFFFF', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          {String(value).padStart(2, '0')}
        </span>
      </div>
      <span style={{ color: '#94A3B8', fontSize: '10px', display: 'block', marginTop: '4px' }}>
        {label}
      </span>
    </div>
  );
}

// Isolates the 1-second countdown tick into its own memoized subtree.
// useCountdown used to be called directly inside the (1000+ line,
// non-memoized) EventDetailsScreen component, so every tick re-rendered the
// entire screen — organizer info, ticket cards, related-events carousel,
// everything — once a second for as long as the page stayed open. Wrapping
// it here means a tick only re-renders this small block.
const EventCountdown = memo(function EventCountdown({ event_date, date, time }: { event_date?: string; date?: string; time?: string }) {
  const countdown = useCountdown(event_date, date, time);
  if (!countdown) return null;
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '8px', fontWeight: 500 }}>
        EVENT STARTS IN
      </div>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <CountdownUnit value={countdown.d} label="Days" />
        <span style={{ color: '#8B8FA8', fontSize: '18px', fontWeight: 300, marginBottom: '16px' }}>:</span>
        <CountdownUnit value={countdown.h} label="Hours" />
        <span style={{ color: '#8B8FA8', fontSize: '18px', fontWeight: 300, marginBottom: '16px' }}>:</span>
        <CountdownUnit value={countdown.m} label="Mins" />
        <span style={{ color: '#8B8FA8', fontSize: '18px', fontWeight: 300, marginBottom: '16px' }}>:</span>
        <CountdownUnit value={countdown.s} label="Secs" />
      </div>
    </div>
  );
});

interface Review {
  id: string;
  name: string;
  avatar: string;
  initials: string;
  rating: number;
  text: string;
  date: string;
}

export function EventDetailsScreen({
  event,
  onBack,
  onGetTickets,
  isSaved,
  onToggleSave,
  isBooked = false,
  onBook,
  bookingLoading = false,
  onEventPress,
  currentUserId,
  currentUserRole,
  onOrganizerPress,
  onMessageOrganizer,
  onOpenDoorScanner,
  onOpenDoorManager,
  purchasesDisabled = false,
}: EventDetailsScreenProps) {
  const isEventOwner = !!currentUserId && !!event.organizer_id && currentUserId === event.organizer_id;
  const isSubAdmin = currentUserRole === 'sub-admin';
  const isRootAdmin = currentUserId === ROOT_UID;
  const isPlatformAdmin = currentUserRole === 'admin';
  const canManageDoor = isEventOwner || isSubAdmin || isRootAdmin || isPlatformAdmin;

  const [expanded, setExpanded] = useState(false);
  const [showMapDialog, setShowMapDialog] = useState(false);
  const [flyerFullScreen, setFlyerFullScreen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  // events only stores a single image_url today -- falls back to the
  // already-resolved event.image the moment a real gallery isn't present.
  const flyerImages = event.images && event.images.length > 0 ? event.images : (event.image ? [event.image] : []);
  const [userReviews, setUserReviews] = useState<Review[]>([]);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewHover, setReviewHover] = useState(0);

  // Inline ticket quantity selection
  const ticketTypes = event.ticketTypes || [];
  const [selectedTicketId, setSelectedTicketId] = useState<string>(ticketTypes[0]?.id ?? '');
  const [ticketQtys, setTicketQtys] = useState<Record<string, number>>(
    Object.fromEntries(ticketTypes.map((t, i) => [t.id, i === 0 ? 1 : 0]))
  );
  const changeTicketQty = useCallback((id: string, delta: number) => {
    setTicketQtys((prev) => {
      const max = ticketTypes.find((t) => t.id === id)?.available ?? 10;
      return { ...prev, [id]: Math.max(0, Math.min(max, (prev[id] ?? 0) + delta)) };
    });
  }, [ticketTypes]);
  const selectedTicket = ticketTypes.find((t) => t.id === selectedTicketId);
  const selectedQty = ticketQtys[selectedTicketId] ?? 0;
  const canBook = !isBooked && !!selectedTicket && selectedQty > 0;
  const [reviewText, setReviewText] = useState('');
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const [realAttendeeCount, setRealAttendeeCount] = useState(event.attendees);
  const [organizerProfile, setOrganizerProfile] = useState<any>(null);
  const [relatedEvents, setRelatedEvents] = useState<any[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);
  const [shared, setShared] = useState(false);
  const [showReport, setShowReport] = useState(false);

  // 1. Static metadata (organizer profile and related events) - fetch once per event
  useEffect(() => {
    const fetchOrganizerProfile = async () => {
      if (!event.organizer_id) return;
      try {
        const { data, error } = await insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, is_verified, state, vc_badge')
          .eq('id', event.organizer_id)
          .maybeSingle();
        
        if (error) throw error;
        if (data) {
          setOrganizerProfile(data);
        }
      } catch (err) {
        console.error('Failed to fetch organizer profile:', err);
      }
    };

    const fetchRelatedEvents = async () => {
      setLoadingRelated(true);
      try {
        let relatedQuery = insforge.database
          .from('events')
          .select('*')
          .eq('category', event.category)
          .in('status', ['live', 'published'])
          .is('deleted_at', null)
          .eq('hidden_by_admin', false)
          .neq('id', event.id);

        // Every other event surface (home feed, search) hides 18+ events
        // from users below the age threshold — this carousel had no such
        // gate at all. The viewer's own date_of_birth isn't threaded down
        // to this screen, but the event they're currently viewing is a
        // reliable proxy: if it's not 18+, never surface an 18+ related
        // event alongside it (the common case — an all-ages event's related
        // carousel should never suddenly include an 18+ one).
        if (!(event as any).is_18_plus) {
          relatedQuery = relatedQuery.eq('is_18_plus', false);
        }

        const { data, error } = await relatedQuery.limit(4);

        if (error) throw error;
        if (data) {
          const mapped = data.map(mapDbEventToFrontend);
          setRelatedEvents(mapped);
        }
      } catch (err) {
        console.error('Failed to fetch related events:', err);
      } finally {
        setLoadingRelated(false);
      }
    };

    fetchOrganizerProfile();
    fetchRelatedEvents();
  }, [event.id, event.category, event.organizer_id]);

  // 2. Dynamic attendee count - re-fetch when event changes or booking state updates.
  // Single source of truth (get_event_ticket_stats, see Data Consistency
  // migration) — previously counted any status='active' ticket regardless
  // of payment_status, which could show a different number here than on
  // SalesAnalyticsScreen/OrganizerDashboard for the same event.
  useEffect(() => {
    const fetchAttendeeCount = async () => {
      try {
        const { data, error } = await insforge.database.rpc('get_event_ticket_stats', { p_event_ids: [event.id] });
        if (error) throw error;
        setRealAttendeeCount(data?.[0]?.sold_count ?? 0);
      } catch (err) {
        console.error('Failed to fetch attendee count:', err);
      }
    };

    fetchAttendeeCount();
  }, [event.id, isBooked]);

  const handleShare = async () => {
    analytics.eventShared(event.id, event.title);
    const deepLink = `${window.location.origin}/?event=${event.id}`;
    const text =
      `🎟️ ${event.title}\n` +
      `📅 ${event.date} · ${event.time}\n` +
      `📍 ${event.venue}, ${event.city}\n` +
      `\nGet tickets on Vents 👇\n${deepLink}`;

    try {
      if (navigator.share) {
        await navigator.share({ title: event.title, text, url: deepLink });
      } else {
        await navigator.clipboard.writeText(deepLink).catch(() => {
          openExternalUrl(`https://wa.me/?text=${encodeURIComponent(text)}`);
        });
      }
    } catch {
      // User cancelled share
    }
    // Always copy to clipboard silently so users can paste the link
    navigator.clipboard.writeText(deepLink).catch(() => {});
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  };

  const allReviews = [...userReviews];

  function submitReview() {
    if (!reviewRating || !reviewText.trim()) return;
    setUserReviews((prev) => [
      {
        id: `user-${Date.now()}`,
        name: 'You',
        avatar: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
        initials: 'ME',
        rating: reviewRating,
        text: reviewText.trim(),
        date: 'Just now',
      },
      ...prev,
    ]);
    setReviewRating(0);
    setReviewText('');
    setShowReviewForm(false);
    setReviewSubmitted(true);
  }

  const openMap = (provider: 'google' | 'apple') => {
    const query = encodeURIComponent(`${event.venue}, ${event.area}, ${event.city}, Nigeria`);
    const url = provider === 'google'
      ? `https://www.google.com/maps/search/?api=1&query=${query}`
      : `https://maps.apple.com/?q=${query}`;
    openExternalUrl(url);
    setShowMapDialog(false);
  };
  const capacityPct = Math.round((realAttendeeCount / (event.capacity || 1000)) * 100);
  const lowestPrice = event.ticketTypes && event.ticketTypes.length > 0
    ? Math.min(...event.ticketTypes.map((t) => t.price))
    : event.price || 0;

  // "Add to Calendar" ICS content — memoized so it's computed once per
  // event, not on every render (this screen re-renders often).
  const icsContent = useMemo(() => {
    const eventDateRaw = (event as any).event_date || event.date;
    if (!eventDateRaw) return null;
    const dtStart = new Date(eventDateRaw);
    if (isNaN(dtStart.getTime())) return null;
    const dtEnd = (event as any).end_time
      ? (() => {
          const [h, m] = ((event as any).end_time as string).split(':').map(Number);
          const d = new Date(dtStart);
          d.setHours(h, m || 0, 0, 0);
          return d;
        })()
      : new Date(dtStart.getTime() + 2 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VENTS//EN',
      'BEGIN:VEVENT',
      `DTSTART:${fmt(dtStart)}`,
      `DTEND:${fmt(dtEnd)}`,
      `SUMMARY:${(event.title || '').replace(/,/g, '\\,')}`,
      `LOCATION:${(event.venue || '').replace(/,/g, '\\,')}`,
      `DESCRIPTION:${(event.description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,')}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
  }, [(event as any).event_date, event.date, (event as any).end_time, event.title, event.venue, event.description]);

  // Object URL is created once per icsContent change and explicitly
  // revoked on the next change/unmount — previously this was recreated on
  // every single render with no revocation at all, leaking a blob URL
  // per render for as long as the page stayed open.
  const [icsUrl, setIcsUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!icsContent) { setIcsUrl(null); return; }
    const blob = new Blob([icsContent], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    setIcsUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [icsContent]);

  return (
    <div
      style={{
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {/* Full-screen flyer lightbox */}
      {flyerFullScreen && (
        <FlyerLightbox
          images={flyerImages}
          initialIndex={lightboxIndex}
          alt={event.title}
          onClose={() => setFlyerFullScreen(false)}
        />
      )}

      {/* Hero — premium rounded flyer card (Sync Rwanda-style): inset card
          with generous corner radius, cover-fit image, bottom gradient for
          legibility, category pill + share/save/report overlaid on the
          image, and a subtle fade-in on mount. */}
      <div
        style={{
          padding: '0 16px',
          marginTop: 'calc(16px + env(safe-area-inset-top))',
          marginBottom: '16px',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'relative',
            aspectRatio: EVENT_CARD_ASPECT_CSS,
            borderRadius: '26px',
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
            animation: 'heroFadeIn 0.5s ease forwards',
          }}
        >
          <ImageCarousel
            images={flyerImages}
            alt={event.title}
            imageFit="cover"
            showArrows={flyerImages.length > 1}
            onImageTap={(i) => { setLightboxIndex(i); setFlyerFullScreen(true); }}
            style={{ width: '100%', height: '100%', cursor: 'zoom-in' }}
          />

          {/* Soft bottom gradient so the category pill and tap hint stay legible */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(to top, rgba(2,0,5,0.9) 0%, rgba(2,0,5,0.25) 40%, transparent 65%)',
              pointerEvents: 'none',
            }}
          />

          {/* Back button (top-left) */}
          <button
            onClick={(e) => { e.stopPropagation(); onBack(); }}
            style={{
              position: 'absolute',
              top: '16px',
              left: '16px',
              background: 'rgba(0,0,0,0.4)',
              backdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '50%',
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft size={18} color="#fff" />
          </button>

          {/* Share / Save / Report (top-right) */}
          <div style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px' }}>
            <button
              onClick={(e) => { e.stopPropagation(); handleShare(); }}
              style={{
                background: 'rgba(0,0,0,0.4)',
                backdropFilter: 'blur(10px)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '50%',
                width: '38px',
                height: '38px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <Share2 size={17} color="#fff" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSave(); }}
              style={{
                background: 'rgba(0,0,0,0.4)',
                backdropFilter: 'blur(10px)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '50%',
                width: '38px',
                height: '38px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill={isSaved ? '#A78BFA' : 'none'} stroke={isSaved ? '#A78BFA' : '#fff'} strokeWidth="2.5">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            {currentUserId && (
              <button
                onClick={(e) => { e.stopPropagation(); setShowReport(true); }}
                style={{
                  background: 'rgba(0,0,0,0.4)',
                  backdropFilter: 'blur(10px)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '50%',
                  width: '38px',
                  height: '38px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <Flag size={17} color="#fff" />
              </button>
            )}
          </div>

          {/* Tap-to-expand hint (bottom-right) */}
          <div style={{ position: 'absolute', bottom: '16px', right: '16px', background: 'rgba(0,0,0,0.5)', borderRadius: '8px', padding: '4px 8px', pointerEvents: 'none' }}>
            <span style={{ color: '#fff', fontSize: '10px' }}>Tap to expand</span>
          </div>

          {/* Category pill (bottom-left, inside the image) */}
          <div
            style={{
              position: 'absolute',
              bottom: '16px',
              left: '16px',
              background: 'rgba(123,47,190,0.2)',
              border: '1px solid #7B2FBE',
              borderRadius: '100px',
              padding: '4px 10px',
              backdropFilter: 'blur(6px)',
            }}
          >
            <span style={{ color: '#C084FC', fontSize: '12px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              {event.category.toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '0 16px 120px' }}>
        {/* Title + Rating */}
        <div style={{ marginBottom: '12px' }}>
          <h1
            style={{
              color: '#FFFFFF',
              fontSize: '24px',
              fontWeight: 700,
              fontFamily: 'Outfit, sans-serif',
              letterSpacing: '-0.5px',
              lineHeight: 1.25,
              marginBottom: '8px',
            }}
          >
            {event.title}
            {(event as any).is_18_plus && (
              <span style={{ fontSize: '11px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '6px', padding: '2px 7px', color: '#EF4444', fontWeight: 700, verticalAlign: 'middle', marginLeft: '8px' }}>18+</span>
            )}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Users size={13} color="#8B8FA8" />
              <span style={{ color: '#8B8FA8', fontSize: '13px' }}>
                {realAttendeeCount.toLocaleString()} attending
              </span>
            </div>
          </div>
        </div>

        {/* Organizer Tools — door-staff scanner access. Only ever visible to
            the event's own organizer, a Sub-Admin, or Root/platform admin;
            regular attendees never see this section at all. Placed at the
            very top of the content so it's the first thing door staff hit,
            no scrolling required. */}
        {canManageDoor && onOpenDoorScanner && (
          <div
            style={{
              background: 'linear-gradient(135deg, rgba(123,47,190,0.18), rgba(34,211,238,0.12))',
              border: '1px solid rgba(167,139,250,0.35)',
              borderRadius: '18px',
              padding: '14px',
              marginBottom: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
              <Shield size={13} color="#A78BFA" />
              <span style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Organizer Tools
              </span>
            </div>
            <button
              onClick={onOpenDoorScanner}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                border: 'none',
                borderRadius: '14px',
                padding: '16px',
                cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(123,47,190,0.4)',
              }}
            >
              <ScanLine size={20} color="#fff" />
              <span style={{ color: '#fff', fontSize: '15px', fontWeight: 800 }}>Open Door Scanner</span>
            </button>
            {onOpenDoorManager && (
              <button
                onClick={onOpenDoorManager}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(167,139,250,0.3)',
                  borderRadius: '14px',
                  padding: '14px',
                  cursor: 'pointer',
                  marginTop: '10px',
                }}
              >
                <LayoutDashboard size={18} color="#A78BFA" />
                <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 700 }}>Door Manager Dashboard</span>
              </button>
            )}
          </div>
        )}

        {/* Info cards */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {[
            {
              icon: Calendar,
              label: 'Date',
              value: event.date.replace(/^[A-Za-z]+, /, ''),
            },
            { icon: Clock, label: 'Time', value: event.endTime ? `${event.time} – ${event.endTime}` : (event.time || 'TBC') },
          ].map(({ icon: Icon, label, value }) => (
            <div
              key={label}
              style={{
                flex: 1,
                background: '#090514',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '20px',
                padding: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(168,85,247,0.12)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon size={16} color="#A855F7" />
              </div>
              <div>
                <div style={{ color: '#8B8FA8', fontSize: '10px', fontWeight: 500 }}>{label}</div>
                <div style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 600 }}>{value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Location */}
        <div
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '20px',
            padding: '16px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: 'rgba(168,85,247,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <MapPin size={16} color="#A855F7" />
            </div>
            <div>
              <div style={{ color: '#94A3B8', fontSize: '14px', fontWeight: 600 }}>
                {event.venue}
              </div>
              <div style={{ color: '#94A3B8', fontSize: '12px' }}>
                {event.area}, {event.city}, {event.state}
              </div>
            </div>
          </div>
          <EventMap
            latitude={event.latitude}
            longitude={event.longitude}
            venue={event.venue}
            address={`${event.area}, ${event.city}, ${event.state}`}
            onGetDirections={() => setShowMapDialog(true)}
          />
        </div>

        {/* Add to Calendar — icsUrl is memoized + explicitly revoked (see
            icsContent/icsUrl above), not recreated on every render. */}
        {icsUrl && (
          <button
            onClick={() => { const a = document.createElement('a'); a.href = icsUrl; a.download = `${event.title || 'event'}.ics`; a.click(); }}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '14px', padding: '12px', cursor: 'pointer', marginBottom: '16px' }}
          >
            <CalendarPlus size={16} color="#10B981" />
            <span style={{ color: '#10B981', fontSize: '13px', fontWeight: 600 }}>Add to Calendar</span>
          </button>
        )}

        {/* Countdown — isolated into its own memoized component so the
            1-second tick doesn't re-render this whole screen (see
            EventCountdown above). */}
        <EventCountdown event_date={event.event_date} date={event.date} time={event.time} />

        {/* Capacity */}
        <div
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '20px',
            padding: '16px',
            marginBottom: '16px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#C4C9E0', fontSize: '13px', fontWeight: 500 }}>Capacity</span>
            <span style={{ color: capacityPct > 80 ? '#EF4444' : '#10B981', fontSize: '13px', fontWeight: 600 }}>
              {capacityPct}% filled
            </span>
          </div>
          <div
            style={{
              height: '6px',
              background: 'rgba(255,255,255,0.07)',
              borderRadius: '3px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${capacityPct}%`,
                borderRadius: '3px',
                background:
                  capacityPct > 80
                    ? 'linear-gradient(90deg, #F59E0B, #EF4444)'
                    : 'linear-gradient(90deg, #7B2FBE, #4F46E5)',
                transition: 'width 0.5s ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
            <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
              {realAttendeeCount.toLocaleString()} attending
            </span>
            <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
              {(event.capacity ?? 0).toLocaleString()} total capacity
            </span>
          </div>
        </div>

        {/* Organizer */}
        <div
          onClick={() => event.organizer_id && onOrganizerPress?.(event.organizer_id)}
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '14px',
            padding: '14px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '16px',
            cursor: event.organizer_id && onOrganizerPress ? 'pointer' : 'default',
          }}
        >
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
              {(organizerProfile?.full_name || event.organizer || 'O')[0].toUpperCase()}
            </span>
            {organizerProfile?.avatar_url && (
              <img
                src={organizerProfile.avatar_url}
                alt=""
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
              <span style={{ color: '#C084FC', fontSize: '14px', fontWeight: 600 }}>
                {organizerProfile?.full_name || event.organizer}
              </span>
              {(event.organizerVerified || organizerProfile?.is_verified) && (
                <CheckCircle size={14} fill="#4F46E5" color="#fff" />
              )}
              <BadgeChip tier={organizerProfile?.vc_badge} />
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '12px', textTransform: 'capitalize' }}>
              {organizerProfile?.role || 'Event Organizer'}
            </span>
          </div>
        </div>

        {/* Contact number (if organizer chose to show it) */}
        {event.contactPhone && (
          <div
            style={{
              background: 'rgba(168,85,247,0.06)',
              border: '1px solid rgba(168,85,247,0.2)',
              borderRadius: '14px',
              padding: '14px 16px',
              marginBottom: '16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Phone size={14} color="#A855F7" />
              <span style={{ color: '#A855F7', fontSize: '12px', fontWeight: 700, letterSpacing: '0.05em' }}>
                ORGANISER CONTACT
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, letterSpacing: '0.02em' }}>
                  {event.contactPhone}
                </p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '2px' }}>
                  For event enquiries only
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <a
                  href={`tel:${event.contactPhone}`}
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '12px',
                    background: 'rgba(168,85,247,0.15)',
                    border: '1px solid rgba(168,85,247,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textDecoration: 'none',
                  }}
                >
                  <Phone size={16} color="#A855F7" />
                </a>
                <a
                  href={`https://wa.me/${event.contactPhone.replace(/\D/g, '')}`}
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '12px',
                    background: 'rgba(37,211,102,0.12)',
                    border: '1px solid rgba(37,211,102,0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textDecoration: 'none',
                  }}
                >
                  <MessageCircle size={16} color="#25D366" />
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Lineup */}
        {event.lineup && event.lineup.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Mic2 size={16} color="#A855F7" />
              <span style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Lineup</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {event.lineup.map((artist) => (
                <div
                  key={artist}
                  style={{
                    background: '#090514',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '50px',
                    padding: '7px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <div
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      background: `hsl(${artist.charCodeAt(0) * 37}deg 60% 50%)`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '10px',
                      color: '#fff',
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {artist[0]}
                  </div>
                  <span style={{ color: '#C4C9E0', fontSize: '13px', fontWeight: 500 }}>
                    {artist}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        <div style={{ marginBottom: '16px' }}>
          <span style={{ color: '#FFFFFF', fontSize: '16px', fontWeight: 600, display: 'block', marginBottom: '8px' }}>
            About
          </span>
          <p
            style={{
              color: '#94A3B8',
              fontSize: '14px',
              lineHeight: 1.5,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: expanded ? 'unset' : 3,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {event.description}
          </p>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'none',
              border: 'none',
              color: '#A78BFA',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              padding: '6px 0 0',
              display: 'flex',
              alignItems: 'center',
              gap: '3px',
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {/* Ticket Options */}
        {ticketTypes.length > 0 && !isBooked && (
          <div style={{ marginBottom: '24px' }}>
            <span style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, display: 'block', marginBottom: '12px', fontFamily: 'Space Grotesk, sans-serif' }}>
              Select Tickets
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {ticketTypes.map((t) => {
                const isSelected = selectedTicketId === t.id;
                const qty = ticketQtys[t.id] ?? 0;
                const soldOut = t.available === 0;
                return (
                  <div
                    key={t.id}
                    onClick={() => !soldOut && setSelectedTicketId(t.id)}
                    style={{
                      background: isSelected ? 'rgba(124,58,237,0.08)' : '#131629',
                      border: isSelected ? '1.5px solid rgba(124,58,237,0.4)' : '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '16px',
                      padding: '14px 16px',
                      cursor: soldOut ? 'not-allowed' : 'pointer',
                      opacity: soldOut ? 0.5 : 1,
                      transition: 'all 0.2s',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: 0 }}>{t.name}</p>
                        <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>{t.description || 'General Admission'}</p>
                        {!soldOut && <span style={{ color: '#6B7280', fontSize: '11px', display: 'block', marginTop: '4px' }}>{t.available} left</span>}
                        {soldOut && <span style={{ color: '#EF4444', fontSize: '11px', display: 'block', marginTop: '4px' }}>Sold out</span>}
                      </div>
                      <span style={{ color: '#FFB830', fontSize: '16px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginLeft: '8px' }}>
                        {formatPrice(t.price)}
                      </span>
                    </div>
                    {isSelected && !soldOut && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <span style={{ color: '#C4C9E0', fontSize: '13px' }}>Quantity</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                          <button onClick={(e) => { e.stopPropagation(); changeTicketQty(t.id, -1); }} style={{ width: '32px', height: '32px', borderRadius: '50%', background: qty === 0 ? '#1A1D2E' : 'rgba(124,58,237,0.2)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: qty === 0 ? 'not-allowed' : 'pointer', opacity: qty === 0 ? 0.5 : 1 }}>
                            <Minus size={14} color="#C4C9E0" />
                          </button>
                          <span style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700, minWidth: '24px', textAlign: 'center' }}>{qty}</span>
                          <button onClick={(e) => { e.stopPropagation(); changeTicketQty(t.id, 1); }} style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <Plus size={14} color="#fff" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tags */}
        {event.tags && event.tags.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <Tag size={15} color="#A855F7" />
              <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Tags</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {event.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    background: 'rgba(167,139,250,0.08)',
                    border: '1px solid rgba(167,139,250,0.15)',
                    borderRadius: '8px',
                    padding: '5px 12px',
                    color: '#A78BFA',
                    fontSize: '12px',
                    fontWeight: 500,
                  }}
                >
                  #{tag.replace(' ', '')}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Organizer actions */}
        {event.organizer_id && onMessageOrganizer && (
          <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {onMessageOrganizer && currentUserId && currentUserId !== event.organizer_id && (
              <button
                onClick={() => onMessageOrganizer(event.organizer_id!, event.id, event.title)}
                style={{
                  width: '100%', background: '#090514',
                  border: '1px solid rgba(167,139,250,0.2)', borderRadius: '14px',
                  padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
                }}
              >
                <MessageCircle size={16} color="#A78BFA" />
                <span style={{ color: '#C4C9E0', fontSize: '13px', fontWeight: 500, flex: 1, textAlign: 'left' }}>
                  Message organizer
                </span>
                <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 600 }}>Chat →</span>
              </button>
            )}
          </div>
        )}

        {/* Related Events Section */}
        <div style={{ marginTop: '24px', marginBottom: '16px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '12px', fontFamily: 'Space Grotesk, sans-serif' }}>
              Related Events
            </p>
            {loadingRelated ? (
              <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', scrollbarWidth: 'none' }}>
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} style={{ width: '140px', height: '120px', background: '#090514', borderRadius: '16px', opacity: 0.6 }} />
                ))}
              </div>
            ) : relatedEvents.length === 0 ? (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8B8FA8" strokeWidth="1.5" style={{ display: 'block', margin: '0 auto 4px' }}><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>No related events in this category</p>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '8px', scrollbarWidth: 'none' }}>
                {relatedEvents.map((evt) => (
                  <div
                    key={evt.id}
                    onClick={() => onEventPress && onEventPress(evt)}
                    style={{
                      width: '150px',
                      background: '#090514',
                      border: '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '16px',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <LazyImage
                      src={evt.image}
                      thumbnailUrl={(evt as any).thumbnail_url ?? null}
                      alt=""
                      objectFit="cover"
                      style={{ width: '100%', height: '80px' }}
                    />
                    <div style={{ padding: '8px' }}>
                      <p style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 700, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', height: '32px', lineHeight: 1.3, marginBottom: '4px' }}>
                        {evt.title}
                      </p>
                      <p style={{ color: '#8B8FA8', fontSize: '10px' }}>{evt.date}</p>
                      <p style={{ color: '#FFB830', fontSize: '11px', fontWeight: 700, marginTop: '2px' }}>
                        {formatPrice(evt.price)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      {/* Map dialog */}
      {showMapDialog && (
        <div
          onClick={() => setShowMapDialog(false)}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'flex-end',
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              background: '#090514',
              borderRadius: '24px 24px 0 0',
              padding: '24px 20px 36px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <div
                style={{
                  width: '40px',
                  height: '4px',
                  background: 'rgba(255,255,255,0.15)',
                  borderRadius: '2px',
                  margin: '0 auto 16px',
                }}
              />
              <p style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Open Location In</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '4px' }}>
                {event.venue}, {event.city}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={() => openMap('google')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  background: 'rgba(66,133,244,0.1)',
                  border: '1px solid rgba(66,133,244,0.25)',
                  borderRadius: '16px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                </div>
                <div style={{ textAlign: 'left' }}>
                  <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Google Maps</p>
                  <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Opens in browser</p>
                </div>
              </button>
              <button
                onClick={() => openMap('apple')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '16px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: '#1C1C1E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MapPin size={20} color="#fff" />
                </div>
                <div style={{ textAlign: 'left' }}>
                  <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Apple Maps</p>
                  <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Opens on iOS/macOS</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sticky bottom bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(2,0,5,0.85)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          padding: '14px 16px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ color: '#94A3B8', fontSize: '12px', textTransform: 'uppercase' }}>From</div>
          <div style={{ color: '#FFFFFF', fontSize: '18px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif' }}>
            {formatPrice(lowestPrice)}
          </div>
        </div>
        <button
          onClick={() => {
            try {
              if (!isBooked && canBook && !purchasesDisabled && selectedTicket) {
                onGetTickets(selectedTicket, selectedQty);
              }
            } catch (err: any) {
              console.error('BOOK BUTTON CRASH:', err);
              alert('Booking error: ' + (err?.message || String(err)));
            }
          }}
          disabled={isBooked || !canBook || purchasesDisabled}
          style={{
            flex: 1,
            background: isBooked
              ? 'rgba(16,185,129,0.12)'
              : purchasesDisabled
              ? '#1A1D2E'
              : canBook
              ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)'
              : '#1A1D2E',
            border: isBooked ? '1px solid rgba(16,185,129,0.3)' : 'none',
            borderRadius: '16px',
            padding: '14px 28px',
            color: isBooked ? '#10B981' : purchasesDisabled ? '#6B7280' : canBook ? '#fff' : '#8B8FA8',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: isBooked || !canBook || purchasesDisabled ? 'not-allowed' : 'pointer',
            boxShadow: canBook && !isBooked && !purchasesDisabled ? '0 8px 24px rgba(123,47,190,0.35)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          {isBooked ? '✓ You are going' : purchasesDisabled ? 'Purchases Temporarily Paused' : canBook ? `Book · ${formatPrice(selectedTicket!.price * selectedQty)}` : 'Select tickets above'}
        </button>
      </div>

      {shared && (
        <div style={{
          position: 'absolute',
          top: '30px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(16,185,129,0.95)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(16,185,129,0.3)',
          borderRadius: '10px',
          padding: '8px 16px',
          zIndex: 100,
          color: '#fff',
          fontSize: '13px',
          fontWeight: 600,
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <CheckCircle size={14} color="#fff" />
          Link copied to clipboard!
        </div>
      )}
      {showReport && currentUserId && (
        <ReportModal
          reporterId={currentUserId}
          targetType="event"
          targetId={event.id}
          targetName={event.title}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  );
}

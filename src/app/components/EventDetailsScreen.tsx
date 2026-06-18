import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Share2,
  Heart,
  Star,
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
} from 'lucide-react';
import { Event, TicketType } from './types';
import { formatPrice } from './data';
import { mapDbEventToFrontend } from './HomeScreen';
import { insforge } from '../../lib/insforge';

interface EventDetailsScreenProps {
  event: Event;
  onBack: () => void;
  onGetTickets: (ticketType: TicketType) => void;
  isSaved: boolean;
  onToggleSave: () => void;
  isBooked?: boolean;
  onBook?: () => void;
  bookingLoading?: boolean;
  onEventPress?: (event: Event) => void;
  following: string[];
  onToggleFollow: (userId: string) => void;
}

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
          background: 'rgba(168,85,247,0.12)',
          border: '1px solid rgba(168,85,247,0.2)',
          borderRadius: '10px',
          padding: '8px 12px',
          minWidth: '50px',
        }}
      >
        <span style={{ color: '#A855F7', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          {String(value).padStart(2, '0')}
        </span>
      </div>
      <span style={{ color: '#8B8FA8', fontSize: '10px', display: 'block', marginTop: '4px' }}>
        {label}
      </span>
    </div>
  );
}

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
  following,
  onToggleFollow,
}: EventDetailsScreenProps) {
  const [expanded, setExpanded] = useState(false);
  const [showMapDialog, setShowMapDialog] = useState(false);
  const isFollowingOrg = Array.isArray(following) && following.includes(event.organizer_id || '');
  const [userReviews, setUserReviews] = useState<Review[]>([]);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewHover, setReviewHover] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const [realAttendeeCount, setRealAttendeeCount] = useState(event.attendees);
  const [organizerProfile, setOrganizerProfile] = useState<any>(null);
  const [relatedEvents, setRelatedEvents] = useState<any[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);
  const [shared, setShared] = useState(false);

  // 1. Static metadata (organizer profile and related events) - fetch once per event
  useEffect(() => {
    const fetchOrganizerProfile = async () => {
      if (!event.organizer_id) return;
      try {
        const { data, error } = await insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, is_verified, state')
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
        const { data, error } = await insforge.database
          .from('events')
          .select('*')
          .eq('category', event.category)
          .neq('id', event.id)
          .limit(4);
        
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

  // 2. Dynamic attendee count - re-fetch when event changes or booking state updates
  useEffect(() => {
    const fetchAttendeeCount = async () => {
      try {
        const { data, error } = await insforge.database
          .from('tickets')
          .select('id')
          .eq('event_id', event.id)
          .eq('status', 'active');
        
        if (error) throw error;
        if (data) {
          setRealAttendeeCount(data.length);
        }
      } catch (err) {
        console.error('Failed to fetch attendee count:', err);
      }
    };

    fetchAttendeeCount();
  }, [event.id, isBooked]);

  const handleShare = async () => {
    const deepLink = `${window.location.origin}/?event=${event.id}`;
    const text =
      `🎟️ ${event.title}\n` +
      `📅 ${event.date} · ${event.time}\n` +
      `📍 ${event.venue}, ${event.city}\n` +
      `\nGet tickets on Vents 👇\n${deepLink}`;

    try {
      if (navigator.share) {
        // Native share sheet — WhatsApp, Messages, Twitter all appear automatically
        await navigator.share({ title: event.title, text, url: deepLink });
      } else {
        // Desktop fallback: open WhatsApp Web with pre-filled message
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      }
    } catch {
      // User cancelled share — silently ignore
    }
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
  const countdown = useCountdown(event.event_date, event.date, event.time);

  const openMap = (provider: 'google' | 'apple') => {
    const query = encodeURIComponent(`${event.venue}, ${event.area}, ${event.city}, Nigeria`);
    const url = provider === 'google'
      ? `https://www.google.com/maps/search/?api=1&query=${query}`
      : `https://maps.apple.com/?q=${query}`;
    window.open(url, '_blank');
    setShowMapDialog(false);
  };
  const capacityPct = Math.round((realAttendeeCount / (event.capacity || 1000)) * 100);
  const lowestPrice = event.ticketTypes && event.ticketTypes.length > 0
    ? Math.min(...event.ticketTypes.map((t) => t.price))
    : event.price || 0;

  return (
    <div
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {/* Hero */}
      <div style={{ position: 'relative', height: 'calc(290px + env(safe-area-inset-top))', flexShrink: 0 }}>
        <img
          src={event.image}
          alt={event.title}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to bottom, rgba(6,10,18,0.35) 0%, transparent 30%, rgba(6,10,18,1) 100%)',
          }}
        />

        {/* Controls */}
        <div
          style={{
            position: 'absolute',
            top: 'calc(20px + env(safe-area-inset-top))',
            left: '16px',
            right: '16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <button
            onClick={onBack}
            style={{
              background: 'rgba(0,0,0,0.45)',
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
            <ArrowLeft size={18} color="#fff" />
          </button>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleShare}
              style={{
                background: 'rgba(0,0,0,0.45)',
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
              onClick={onToggleSave}
              style={{
                background: 'rgba(0,0,0,0.45)',
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
              <Heart
                size={17}
                fill={isSaved ? '#EF4444' : 'none'}
                color={isSaved ? '#EF4444' : '#fff'}
              />
            </button>
          </div>
        </div>

        {/* Category badge */}
        <div
          style={{
            position: 'absolute',
            bottom: '16px',
            left: '16px',
            background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
            borderRadius: '8px',
            padding: '4px 10px',
          }}
        >
          <span style={{ color: '#fff', fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em' }}>
            {event.category.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '16px 16px 120px' }}>
        {/* Title + Rating */}
        <div style={{ marginBottom: '12px' }}>
          <h1
            style={{
              color: '#F0F0FF',
              fontSize: '22px',
              fontWeight: 800,
              fontFamily: 'Space Grotesk, sans-serif',
              lineHeight: 1.25,
              marginBottom: '8px',
            }}
          >
            {event.title}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Star size={14} fill="#FFB830" color="#FFB830" />
              <span style={{ color: '#FFB830', fontSize: '14px', fontWeight: 700 }}>
                {event.rating}
              </span>
              <span style={{ color: '#8B8FA8', fontSize: '13px' }}>
                ({event.reviewCount} reviews)
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Users size={13} color="#8B8FA8" />
              <span style={{ color: '#8B8FA8', fontSize: '13px' }}>
                {realAttendeeCount.toLocaleString()} attending
              </span>
            </div>
          </div>
        </div>

        {/* Info cards */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {[
            {
              icon: Calendar,
              label: 'Date',
              value: event.date.replace(/^[A-Za-z]+, /, ''),
            },
            { icon: Clock, label: 'Time', value: `${event.time} – ${event.endTime}` },
          ].map(({ icon: Icon, label, value }) => (
            <div
              key={label}
              style={{
                flex: 1,
                background: '#131629',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '14px',
                padding: '12px',
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
                <div style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }}>{value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Location */}
        <div
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '14px',
            padding: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '16px',
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
            <MapPin size={16} color="#A855F7" />
          </div>
          <div>
            <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>
              {event.venue}
            </div>
            <div style={{ color: '#8B8FA8', fontSize: '12px' }}>
              {event.area}, {event.city}, {event.state}
            </div>
          </div>
          <button
            onClick={() => setShowMapDialog(true)}
            style={{
              marginLeft: 'auto',
              background: 'rgba(168,85,247,0.12)',
              border: '1px solid rgba(168,85,247,0.2)',
              borderRadius: '8px',
              padding: '5px 10px',
              cursor: 'pointer',
            }}
          >
            <span style={{ color: '#A78BFA', fontSize: '11px', fontWeight: 600 }}>View Map</span>
          </button>
        </div>

        {/* Countdown */}
        {countdown && (
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
        )}

        {/* Capacity */}
        <div
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '14px',
            padding: '14px',
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
              {event.capacity.toLocaleString()} total capacity
            </span>
          </div>
        </div>

        {/* Organizer */}
        <div
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '14px',
            padding: '14px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '16px',
          }}
        >
          {organizerProfile?.avatar_url ? (
            <img
              src={organizerProfile.avatar_url}
              alt=""
              style={{ width: '44px', height: '44px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0 }}
            />
          ) : (
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
              }}
            >
              <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
                {(organizerProfile?.full_name || event.organizer || 'O')[0].toUpperCase()}
              </span>
            </div>
          )}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>
                {organizerProfile?.full_name || event.organizer}
              </span>
              {event.organizerVerified && (
                <CheckCircle size={14} fill="#4F46E5" color="#fff" />
              )}
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '12px', textTransform: 'capitalize' }}>
              {organizerProfile?.role || 'Event Organizer'}
            </span>
          </div>
          <button
            onClick={() => onToggleFollow && onToggleFollow(event.organizer_id || '')}
            style={{
              marginLeft: 'auto',
              background: isFollowingOrg ? 'rgba(16,185,129,0.1)' : 'rgba(167,139,250,0.1)',
              border: `1px solid ${isFollowingOrg ? 'rgba(16,185,129,0.3)' : 'rgba(167,139,250,0.2)'}`,
              borderRadius: '10px',
              padding: '7px 12px',
              color: isFollowingOrg ? '#10B981' : '#A78BFA',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            {isFollowingOrg ? '✓ Following' : 'Follow'}
          </button>
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
                    background: '#131629',
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
          <span style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, display: 'block', marginBottom: '8px' }}>
            About
          </span>
          <p
            style={{
              color: '#C4C9E0',
              fontSize: '14px',
              lineHeight: 1.7,
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
        {event.ticketTypes && event.ticketTypes.length > 0 && (
          <div style={{ marginBottom: '24px' }}>
            <span style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, display: 'block', marginBottom: '12px', fontFamily: 'Space Grotesk, sans-serif' }}>
              Select Ticket Category
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {event.ticketTypes.map((t) => (
                <div
                  key={t.id}
                  onClick={() => !isBooked && onGetTickets && onGetTickets(t)}
                  style={{
                    background: '#131629',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '16px',
                    padding: '14px 16px',
                    cursor: isBooked ? 'default' : 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: 0 }}>{t.name}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0', display: 'block' }}>{t.description || 'General Admission'}</p>
                    <span style={{ color: '#6B7280', fontSize: '11px', display: 'block', marginTop: '4px' }}>{t.available} tickets left</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: '#FFB830', fontSize: '16px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
                      {formatPrice(t.price)}
                    </span>
                    {!isBooked && (
                      <div style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '50%',
                        background: 'rgba(167,139,250,0.1)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#A78BFA'
                      }}>
                        →
                      </div>
                    )}
                  </div>
                </div>
              ))}
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

        {/* Reviews */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700 }}>Reviews</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Star size={14} fill="#FFB830" color="#FFB830" />
                <span style={{ color: '#FFB830', fontSize: '14px', fontWeight: 700 }}>{event.rating}</span>
                <span style={{ color: '#8B8FA8', fontSize: '13px' }}>/ 5</span>
              </div>
              {!reviewSubmitted && (
                <button
                  onClick={() => setShowReviewForm((v) => !v)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: showReviewForm ? 'rgba(168,85,247,0.2)' : 'rgba(168,85,247,0.1)',
                    border: '1px solid rgba(168,85,247,0.3)',
                    borderRadius: '20px',
                    padding: '5px 12px',
                    color: '#A855F7',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <MessageSquarePlus size={12} />
                  Write a review
                </button>
              )}
            </div>
          </div>

          {/* Write a review form */}
          {showReviewForm && (
            <div
              style={{
                background: '#131629',
                border: '1.5px solid rgba(168,85,247,0.25)',
                borderRadius: '16px',
                padding: '16px',
                marginBottom: '12px',
              }}
            >
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>
                Your Rating
              </p>
              {/* Star picker */}
              <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => setReviewRating(star)}
                    onMouseEnter={() => setReviewHover(star)}
                    onMouseLeave={() => setReviewHover(0)}
                    style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer' }}
                  >
                    <Star
                      size={28}
                      fill={(reviewHover || reviewRating) >= star ? '#FFB830' : '#2A2D3E'}
                      color={(reviewHover || reviewRating) >= star ? '#FFB830' : '#2A2D3E'}
                    />
                  </button>
                ))}
                {reviewRating > 0 && (
                  <span style={{ color: '#FFB830', fontSize: '13px', alignSelf: 'center', marginLeft: '4px', fontWeight: 600 }}>
                    {['', 'Poor', 'Fair', 'Good', 'Great', 'Amazing!'][reviewRating]}
                  </span>
                )}
              </div>

              {/* Text input */}
              <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                placeholder="Share your experience at this event..."
                rows={3}
                style={{
                  width: '100%',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px',
                  padding: '12px',
                  color: '#F0F0FF',
                  fontSize: '14px',
                  lineHeight: 1.55,
                  resize: 'none',
                  outline: 'none',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />

              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button
                  onClick={() => { setShowReviewForm(false); setReviewRating(0); setReviewText(''); }}
                  style={{
                    flex: 1,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    padding: '12px',
                    color: '#8B8FA8',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={submitReview}
                  disabled={!reviewRating || !reviewText.trim()}
                  style={{
                    flex: 2,
                    background: reviewRating && reviewText.trim()
                      ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)'
                      : 'rgba(123,47,190,0.2)',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '12px',
                    color: reviewRating && reviewText.trim() ? '#fff' : 'rgba(255,255,255,0.35)',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor: reviewRating && reviewText.trim() ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                  }}
                >
                  <Send size={14} />
                  Post Review
                </button>
              </div>
            </div>
          )}

          {/* Submitted confirmation */}
          {reviewSubmitted && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '12px', padding: '10px 14px' }}>
              <CheckCircle size={15} color="#10B981" />
              <span style={{ color: '#10B981', fontSize: '13px', fontWeight: 600 }}>Your review has been posted!</span>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {allReviews.length === 0 ? (
              <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '14px', padding: '24px 16px', textAlign: 'center' }}>
                <span style={{ fontSize: '24px', display: 'block', marginBottom: '8px' }}>⭐</span>
                <p style={{ color: '#8B8FA8', fontSize: '13px', fontWeight: 500 }}>No reviews yet</p>
                <p style={{ color: '#5C607C', fontSize: '11px', marginTop: '3px' }}>Be the first to write a review!</p>
              </div>
            ) : (
              allReviews.map((review) => (
                <div
                  key={review.id}
                  style={{
                    background: '#131629',
                    border: review.id.startsWith('user-') ? '1px solid rgba(168,85,247,0.2)' : '1px solid rgba(255,255,255,0.05)',
                    borderRadius: '14px',
                    padding: '14px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: review.avatar,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '11px',
                          color: '#fff',
                          fontWeight: 700,
                        }}
                      >
                        {review.initials}
                      </div>
                      <div>
                        <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>
                          {review.name}
                        </span>
                        {review.id.startsWith('user-') && (
                          <span style={{ color: '#A855F7', fontSize: '10px', fontWeight: 600, marginLeft: '6px' }}>You</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '2px' }}>
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          size={11}
                          fill={i < review.rating ? '#FFB830' : '#2A2D3E'}
                          color={i < review.rating ? '#FFB830' : '#2A2D3E'}
                        />
                      ))}
                    </div>
                  </div>
                  <p style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.55 }}>
                    {review.text}
                  </p>
                  <span style={{ color: '#8B8FA8', fontSize: '11px', display: 'block', marginTop: '6px' }}>
                    {review.date}
                  </span>
                </div>
              ))
            )}
          </div>
          
          {/* Related Events Section */}
          <div style={{ marginTop: '24px', marginBottom: '16px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '12px', fontFamily: 'Space Grotesk, sans-serif' }}>
              Related Events
            </p>
            {loadingRelated ? (
              <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', scrollbarWidth: 'none' }}>
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} style={{ width: '140px', height: '120px', background: '#131629', borderRadius: '16px', opacity: 0.6 }} />
                ))}
              </div>
            ) : relatedEvents.length === 0 ? (
              <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
                <span style={{ fontSize: '24px', display: 'block', marginBottom: '4px' }}>🎪</span>
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
                      background: '#131629',
                      border: '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '16px',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <img src={evt.image} alt="" style={{ width: '100%', height: '80px', objectFit: 'cover' }} />
                    <div style={{ padding: '8px' }}>
                      <p style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 700, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', height: '32px', lineHeight: 1.3, marginBottom: '4px' }}>
                        {evt.title}
                      </p>
                      <p style={{ color: '#8B8FA8', fontSize: '10px' }}>{evt.date}</p>
                      <p style={{ color: '#FFB830', fontSize: '11px', fontWeight: 700, marginTop: '2px' }}>
                        {evt.price === 0 ? 'Free' : `₦${evt.price.toLocaleString()}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
              background: '#131629',
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
          background: 'rgba(6,10,18,0.95)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '14px 16px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <div>
          <div style={{ color: '#8B8FA8', fontSize: '11px' }}>From</div>
          <div style={{ color: '#FFB830', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
            {formatPrice(lowestPrice)}
          </div>
        </div>
        <button
          onClick={isBooked ? undefined : onBook}
          disabled={isBooked || bookingLoading}
          style={{
            flex: 1,
            background: isBooked
              ? 'rgba(16,185,129,0.12)'
              : bookingLoading
              ? 'rgba(123,47,190,0.4)'
              : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: isBooked ? '1px solid rgba(16,185,129,0.3)' : 'none',
            borderRadius: '16px',
            padding: '15px',
            color: isBooked ? '#10B981' : '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: isBooked || bookingLoading ? 'not-allowed' : 'pointer',
            boxShadow: isBooked || bookingLoading ? 'none' : '0 6px 24px rgba(123,47,190,0.45), 0 0 0 1px rgba(168,85,247,0.4), 0 0 20px rgba(168,85,247,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          {bookingLoading ? (
            <>
              <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
              Booking...
            </>
          ) : isBooked ? (
            '✓ You are going'
          ) : (
            'Book / RSVP'
          )}
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
    </div>
  );
}

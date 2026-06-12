import { useState, useEffect } from 'react';
import { ArrowLeft, MapPin, UserPlus, UserCheck, Calendar, Star, Camera, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { UserProfile } from './types';
import { EVENTS, formatPrice } from './data';
import { insforge } from '../../lib/insforge';

const MOCK_HIGHLIGHTS = [
  { id: 'h1', label: 'Afrobeats Night', emoji: '🎵', gradient: 'linear-gradient(135deg, #7B2FBE, #EC4899)', date: 'Dec 2024' },
  { id: 'h2', label: 'Tech Summit', emoji: '💻', gradient: 'linear-gradient(135deg, #4F46E5, #06B6D4)', date: 'Nov 2024' },
  { id: 'h3', label: 'Food Festival', emoji: '🍜', gradient: 'linear-gradient(135deg, #F97316, #EAB308)', date: 'Oct 2024' },
  { id: 'h4', label: 'Comedy Show', emoji: '😂', gradient: 'linear-gradient(135deg, #10B981, #3B82F6)', date: 'Sep 2024' },
];

interface UserProfileScreenProps {
  user: UserProfile;
  isFollowing: boolean;
  onToggleFollow: () => void;
  onBack: () => void;
  onEventPress?: (event: import('./types').Event) => void;
}

const INTEREST_COLORS: Record<string, string> = {
  'Music': '#A855F7',
  'Technology': '#06B6D4',
  'Food & Drinks': '#F97316',
  'Comedy Shows': '#EAB308',
  'Arts & Culture': '#F59E0B',
  'Sports & Wellness': '#10B981',
  'Cinema': '#3B82F6',
  'Conferences': '#6366F1',
  'Family Events': '#EC4899',
  'Fundraisers': '#EF4444',
  'Spirituality': '#8B5CF6',
  'Adventures': '#22C55E',
};

export function UserProfileScreen({
  user,
  isFollowing,
  onToggleFollow,
  onBack,
  onEventPress,
}: UserProfileScreenProps) {
  const [activeHighlight, setActiveHighlight] = useState<typeof MOCK_HIGHLIGHTS[0] | null>(null);
  const [highlights] = useState(MOCK_HIGHLIGHTS);

  const [eventsCreated, setEventsCreated] = useState(0);
  const [followers, setFollowers] = useState(0);
  const [attendees, setAttendees] = useState(0);

  useEffect(() => {
    async function fetchStats() {
      if (!user?.id) return;
      try {
        // 1. Events created count
        const { count: eCount } = await insforge.database
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('organizer_id', user.id);
        setEventsCreated(eCount || 0);

        // 2. Followers count
        const { count: fCount } = await insforge.database
          .from('follows')
          .select('following_id', { count: 'exact', head: true })
          .eq('following_id', user.id);
        setFollowers(fCount || 0);

        // 3. Attendees count
        const { data: userEvents } = await insforge.database
          .from('events')
          .select('id')
          .eq('organizer_id', user.id);

        if (userEvents && userEvents.length > 0) {
          const eventIds = userEvents.map((e: any) => e.id);
          const { count: tCount } = await insforge.database
            .from('tickets')
            .select('id', { count: 'exact', head: true })
            .in('event_id', eventIds)
            .eq('status', 'active');
          setAttendees(tCount || 0);
        } else {
          setAttendees(0);
        }
      } catch (err) {
        console.error("Failed to fetch user profile stats:", err);
      }
    }
    fetchStats();
  }, [user.id, isFollowing]);

  const userEvents = EVENTS.filter((e) =>
    user.interests.some((i) =>
      e.category.toLowerCase().includes(i.toLowerCase()) ||
      i.toLowerCase().includes(e.category.toLowerCase())
    )
  ).slice(0, 3);

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
        position: 'relative',
      }}
    >
      {/* Cover + back button */}
      <div style={{ position: 'relative', height: '140px', flexShrink: 0 }}>
        <div
          style={{
            width: '100%',
            height: '100%',
            background: `linear-gradient(135deg, ${user.avatarColor}40 0%, rgba(79,70,229,0.25) 60%, #060A12 100%)`,
          }}
        />
        {/* Back */}
        <button
          onClick={onBack}
          style={{
            position: 'absolute',
            top: '20px',
            left: '16px',
            background: 'rgba(0,0,0,0.4)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#fff" />
        </button>
      </div>

      {/* Avatar + follow */}
      <div
        style={{
          padding: '0 16px',
          marginTop: '-36px',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: '14px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <div
          style={{
            width: '72px',
            height: '72px',
            borderRadius: '20px',
            background: user.avatarColor,
            border: '3px solid #060A12',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 6px 24px ${user.avatarColor}60`,
          }}
        >
          <span style={{ color: '#fff', fontSize: '26px', fontWeight: 700 }}>
            {user.avatarInitials}
          </span>
        </div>

        <button
          onClick={onToggleFollow}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '10px 20px',
            borderRadius: '24px',
            border: isFollowing ? '1px solid rgba(167,139,250,0.3)' : 'none',
            background: isFollowing
              ? 'rgba(167,139,250,0.1)'
              : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            cursor: 'pointer',
            boxShadow: isFollowing ? 'none' : '0 4px 16px rgba(123,47,190,0.4)',
          }}
        >
          {isFollowing ? (
            <UserCheck size={15} color="#A78BFA" />
          ) : (
            <UserPlus size={15} color="#fff" />
          )}
          <span
            style={{
              color: isFollowing ? '#A78BFA' : '#fff',
              fontSize: '14px',
              fontWeight: 700,
            }}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </span>
        </button>
      </div>

      {/* Name + username */}
      <div style={{ padding: '0 16px', marginBottom: '8px' }}>
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '20px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
            marginBottom: '2px',
          }}
        >
          {user.name}
        </h1>
        <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 500 }}>
          @{user.username}
        </span>
      </div>

      {/* Bio */}
      <p
        style={{
          color: '#C4C9E0',
          fontSize: '13px',
          lineHeight: 1.65,
          padding: '0 16px',
          marginBottom: '12px',
        }}
      >
        {user.bio}
      </p>

      {/* Location */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          padding: '0 16px',
          marginBottom: '16px',
        }}
      >
        <MapPin size={13} color="#8B8FA8" />
        <span style={{ color: '#8B8FA8', fontSize: '13px' }}>{user.city}, Nigeria</span>
      </div>

      {/* Stats row */}
      <div
        style={{
          display: 'flex',
          margin: '0 16px',
          background: '#131629',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '16px',
          padding: '14px 0',
          marginBottom: '16px',
        }}
      >
        {[
          { label: 'Events', value: String(eventsCreated) },
          { label: 'Followers', value: String(followers) },
          { label: 'Attendees', value: String(attendees) },
        ].map(({ label, value }, i, arr) => (
          <div
            key={label}
            style={{
              flex: 1,
              textAlign: 'center',
              borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.07)' : 'none',
            }}
          >
            <p
              style={{
                color: '#F0F0FF',
                fontSize: '18px',
                fontWeight: 800,
                fontFamily: 'Space Grotesk, sans-serif',
              }}
            >
              {value}
            </p>
            <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '2px' }}>{label}</p>
          </div>
        ))}
      </div>

      {/* Highlights */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', marginBottom: '10px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em' }}>HIGHLIGHTS</p>
          <span style={{ color: '#A855F7', fontSize: '11px', fontWeight: 600 }}>{highlights.length} memories</span>
        </div>
        <div
          style={{
            display: 'flex',
            gap: '12px',
            overflowX: 'auto',
            padding: '0 16px 4px',
            scrollbarWidth: 'none',
          }}
        >
          {/* Add highlight button */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <div
              style={{
                width: '62px',
                height: '62px',
                borderRadius: '50%',
                border: '2px dashed rgba(168,85,247,0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                background: 'rgba(168,85,247,0.06)',
              }}
            >
              <Camera size={20} color="#A855F7" />
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '10px', textAlign: 'center', width: '68px' }}>Add</span>
          </div>

          {highlights.map((h) => (
            <div
              key={h.id}
              onClick={() => setActiveHighlight(h)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0, cursor: 'pointer' }}
            >
              <div
                style={{
                  width: '62px',
                  height: '62px',
                  borderRadius: '50%',
                  background: h.gradient,
                  border: '2.5px solid rgba(168,85,247,0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '26px',
                  boxShadow: '0 4px 16px rgba(168,85,247,0.25)',
                }}
              >
                {h.emoji}
              </div>
              <span style={{ color: '#C4C9E0', fontSize: '10px', textAlign: 'center', width: '68px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Highlight viewer overlay */}
      {activeHighlight && (
        <div
          onClick={() => setActiveHighlight(null)}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.9)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Progress bar */}
          <div style={{ position: 'absolute', top: '16px', left: '16px', right: '16px', display: 'flex', gap: '4px' }}>
            {highlights.map((h) => (
              <div
                key={h.id}
                style={{
                  flex: 1,
                  height: '3px',
                  borderRadius: '2px',
                  background: h.id === activeHighlight.id ? '#fff' : 'rgba(255,255,255,0.3)',
                }}
              />
            ))}
          </div>

          {/* Close */}
          <button
            onClick={() => setActiveHighlight(null)}
            style={{
              position: 'absolute',
              top: '32px',
              right: '16px',
              background: 'rgba(255,255,255,0.12)',
              border: 'none',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <X size={18} color="#fff" />
          </button>

          {/* Highlight card */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '280px',
              height: '380px',
              borderRadius: '24px',
              background: activeHighlight.gradient,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}
          >
            <span style={{ fontSize: '72px' }}>{activeHighlight.emoji}</span>
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: '#fff', fontSize: '22px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
                {activeHighlight.label}
              </p>
              <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '13px', marginTop: '4px' }}>
                {activeHighlight.date} · {user.name}
              </p>
            </div>
          </div>

          {/* Nav arrows */}
          <div style={{ position: 'absolute', bottom: '40px', display: 'flex', gap: '16px' }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const idx = highlights.findIndex((h) => h.id === activeHighlight.id);
                if (idx > 0) setActiveHighlight(highlights[idx - 1]);
              }}
              disabled={highlights.findIndex((h) => h.id === activeHighlight.id) === 0}
              style={{
                background: 'rgba(255,255,255,0.15)',
                border: 'none',
                borderRadius: '50%',
                width: '44px',
                height: '44px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: highlights.findIndex((h) => h.id === activeHighlight.id) === 0 ? 0.3 : 1,
              }}
            >
              <ChevronLeft size={20} color="#fff" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const idx = highlights.findIndex((h) => h.id === activeHighlight.id);
                if (idx < highlights.length - 1) setActiveHighlight(highlights[idx + 1]);
              }}
              disabled={highlights.findIndex((h) => h.id === activeHighlight.id) === highlights.length - 1}
              style={{
                background: 'rgba(255,255,255,0.15)',
                border: 'none',
                borderRadius: '50%',
                width: '44px',
                height: '44px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: highlights.findIndex((h) => h.id === activeHighlight.id) === highlights.length - 1 ? 0.3 : 1,
              }}
            >
              <ChevronRight size={20} color="#fff" />
            </button>
          </div>
        </div>
      )}

      {/* Interests */}
      <div style={{ padding: '0 16px', marginBottom: '20px' }}>
        <p
          style={{
            color: '#8B8FA8',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.07em',
            marginBottom: '10px',
          }}
        >
          INTERESTS
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {user.interests.map((interest) => {
            const color = INTEREST_COLORS[interest] ?? '#A78BFA';
            return (
              <span
                key={interest}
                style={{
                  background: `${color}15`,
                  border: `1px solid ${color}30`,
                  borderRadius: '20px',
                  padding: '6px 14px',
                  color,
                  fontSize: '12px',
                  fontWeight: 600,
                }}
              >
                {interest}
              </span>
            );
          })}
        </div>
      </div>

      {/* Events they'd like */}
      {userEvents.length > 0 && (
        <div style={{ padding: '0 16px 32px' }}>
          <p
            style={{
              color: '#F0F0FF',
              fontSize: '16px',
              fontWeight: 700,
              marginBottom: '12px',
            }}
          >
            Events {user.name.split(' ')[0]} might attend
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {userEvents.map((event) => (
              <div
                key={event.id}
                onClick={() => onEventPress?.(event)}
                style={{
                  background: '#131629',
                  border: '1px solid rgba(255,255,255,0.05)',
                  borderRadius: '16px',
                  padding: '12px',
                  display: 'flex',
                  gap: '12px',
                  cursor: onEventPress ? 'pointer' : 'default',
                }}
              >
                <img
                  src={event.image}
                  alt={event.title}
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '12px',
                    objectFit: 'cover',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      color: '#A78BFA',
                      fontSize: '10px',
                      fontWeight: 600,
                      background: 'rgba(167,139,250,0.1)',
                      padding: '2px 6px',
                      borderRadius: '4px',
                    }}
                  >
                    {event.category}
                  </span>
                  <p
                    style={{
                      color: '#F0F0FF',
                      fontSize: '13px',
                      fontWeight: 600,
                      marginTop: '4px',
                      marginBottom: '2px',
                    }}
                    className="truncate"
                  >
                    {event.title}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                    <Calendar size={11} color="#8B8FA8" />
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.date}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
                    <Star size={11} fill="#FFB830" color="#FFB830" />
                    <span style={{ color: '#FFB830', fontSize: '11px', fontWeight: 600 }}>
                      {event.rating}
                    </span>
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>·</span>
                    <span style={{ color: '#FFB830', fontSize: '12px', fontWeight: 700 }}>
                      {formatPrice(event.price)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

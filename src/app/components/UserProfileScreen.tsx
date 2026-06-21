import { useState, useEffect } from 'react';
import { ArrowLeft, MapPin, UserPlus, UserCheck, BadgeCheck, Calendar, Star, Flag, MessageCircle } from 'lucide-react';
import { UserProfile } from './types';
import { formatPrice } from './data';
import { insforge } from '../../lib/insforge';
import { HighlightsStrip, HighlightsModal } from './HighlightsModal';
import { ReportModal } from './ReportModal';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface UserProfileScreenProps {
  user: UserProfile & { is_verified?: boolean };
  isFollowing: boolean;
  onToggleFollow: () => void;
  onBack: () => void;
  onEventPress?: (event: import('./types').Event) => void;
  currentUserId?: string;
  onMessage?: (userId: string) => void;
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
  currentUserId,
  onMessage,
}: UserProfileScreenProps) {
  const [highlightData, setHighlightData] = useState<{ items: any[]; startIndex: number } | null>(null);
  const [highlightRefresh, setHighlightRefresh] = useState(0);
  const [eventsCreated, setEventsCreated] = useState(0);
  const [followers, setFollowers] = useState(0);
  const [attendees, setAttendees] = useState(0);
  const [eventsAttended, setEventsAttended] = useState(0);
  const [reviews, setReviews] = useState<{ id: string; reviewer_id: string; rating: number; body: string; created_at: string; reviewer?: { full_name?: string; username?: string } }[]>([]);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewHover, setReviewHover] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [avgRating, setAvgRating] = useState(0);
  const isVerified = user.is_verified || user.id === ROOT_UID;
  const isOwnProfile = currentUserId === user.id;
  const [showReport, setShowReport] = useState(false);
  const [userEvents, setUserEvents] = useState<any[]>([]);

  useEffect(() => {
    setFollowers(0);
    setEventsCreated(0);
    setAttendees(0);
    setEventsAttended(0);
  }, [user.id]);

  useEffect(() => {
    if (!user?.id) return;
    insforge.database
      .from('events')
      .select('id, title, event_date, cover_url, category, price, status')
      .eq('organizer_id', user.id)
      .in('status', ['live', 'published'])
      .gt('event_date', new Date().toISOString())
      .order('event_date', { ascending: true })
      .limit(6)
      .then(({ data }) => setUserEvents(data || []));
  }, [user.id]);

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

        // 4. Events this user attended (distinct events from their tickets)
        const { data: attendedTickets } = await insforge.database
          .from('tickets')
          .select('event_id')
          .eq('user_id', user.id)
          .eq('status', 'active');
        const distinctEvents = new Set((attendedTickets || []).map((t: any) => t.event_id));
        setEventsAttended(distinctEvents.size);
      } catch (err) {
        console.error("Failed to fetch user profile stats:", err);
      }
    }
    fetchStats();
  }, [user.id]);

  useEffect(() => {
    if (!user?.id) return;
    insforge.database
      .from('organizer_reviews')
      .select('*, reviewer:reviewer_id(full_name, username)')
      .eq('organizer_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (data) {
          setReviews(data as any);
          const avg = data.length ? data.reduce((s: number, r: any) => s + r.rating, 0) / data.length : 0;
          setAvgRating(Math.round(avg * 10) / 10);
          if (currentUserId) setReviewSubmitted(data.some((r: any) => r.reviewer_id === currentUserId));
        }
      });
  }, [user.id, currentUserId]);

  const submitReview = async () => {
    if (!reviewRating || reviewText.trim().length < 10 || reviewSubmitting) return;
    setReviewSubmitting(true);
    try {
      await insforge.database.rpc('submit_organizer_review' as any, {
        p_organizer_id: user.id,
        p_rating: reviewRating,
        p_body: reviewText.trim(),
      });
      setReviewSubmitted(true);
      setReviewRating(0);
      setReviewText('');
    } catch (err) {
      console.error('Review submit failed:', err);
    } finally {
      setReviewSubmitting(false);
    }
  };

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
      <div style={{ position: 'relative', height: 'calc(140px + env(safe-area-inset-top))', flexShrink: 0 }}>
        {user.cover_url ? (
          <img
            src={user.cover_url}
            alt="cover"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              background: `linear-gradient(135deg, ${user.avatarColor}40 0%, rgba(79,70,229,0.25) 60%, #060A12 100%)`,
            }}
          />
        )}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(6,10,18,0.1) 0%, rgba(6,10,18,0.6) 100%)' }} />
        {/* Back */}
        <button
          onClick={onBack}
          style={{
            position: 'absolute',
            top: 'calc(20px + env(safe-area-inset-top))',
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
            background: user.avatar_url ? 'transparent' : user.avatarColor,
            border: '3px solid #060A12',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 6px 24px ${user.avatarColor}60`,
            overflow: 'hidden',
          }}
        >
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ color: '#fff', fontSize: '26px', fontWeight: 700 }}>
              {user.avatarInitials}
            </span>
          )}
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
        {!isOwnProfile && onMessage && currentUserId && (
          <button
            onClick={() => onMessage(user.id)}
            title="Send message"
            style={{
              background: 'rgba(167,139,250,0.1)',
              border: '1px solid rgba(167,139,250,0.25)',
              borderRadius: '50%',
              width: '38px',
              height: '38px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <MessageCircle size={16} color="#A78BFA" />
          </button>
        )}
        {!isOwnProfile && currentUserId && (
          <button
            onClick={() => setShowReport(true)}
            title="Report user"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '50%',
              width: '38px',
              height: '38px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Flag size={16} color="#8B8FA8" />
          </button>
        )}
      </div>

      {/* Name + username */}
      <div style={{ padding: '0 16px', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
          <h1
            style={{
              color: '#F0F0FF',
              fontSize: '20px',
              fontWeight: 800,
              fontFamily: 'Space Grotesk, sans-serif',
              margin: 0,
            }}
          >
            {user.name}
          </h1>
          {isVerified && (
            <BadgeCheck size={18} color="#3B82F6" title="Verified" style={{ filter: 'drop-shadow(0 0 6px rgba(59,130,246,0.6))' }} />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
          <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 500 }}>
            @{user.username}
          </span>
          {user.vc_badge && (() => {
            const badgeMap: Record<string, { label: string; gradient: string; color: string }> = {
              bronze: { label: '🥉 Bronze', gradient: 'linear-gradient(135deg,#CD7F32,#A0522D)', color: '#FFD9B3' },
              silver: { label: '🥈 Silver', gradient: 'linear-gradient(135deg,#9CA3AF,#6B7280)', color: '#E5E7EB' },
              gold: { label: '🥇 Gold', gradient: 'linear-gradient(135deg,#F59E0B,#D97706)', color: '#FEF3C7' },
              platinum: { label: '💎 Platinum', gradient: 'linear-gradient(135deg,#818CF8,#4F46E5)', color: '#E0E7FF' },
              elite: { label: '⚡ Elite', gradient: 'linear-gradient(135deg,#A855F7,#7C3AED)', color: '#F3E8FF' },
              legend: { label: '👑 Legend', gradient: 'linear-gradient(135deg,#EC4899,#7C3AED)', color: '#FFF' },
            };
            const b = badgeMap[user.vc_badge!.toLowerCase()];
            if (!b) return null;
            return (
              <span style={{ background: b.gradient, borderRadius: '20px', padding: '2px 10px', fontSize: '11px', fontWeight: 700, color: b.color, whiteSpace: 'nowrap' }}>
                {b.label}
              </span>
            );
          })()}
        </div>
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
          { label: 'Followers', value: String(followers + (isFollowing ? 1 : 0)) },
          { label: 'Attended', value: String(eventsAttended) },
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

      {/* Highlights (real DB-backed) */}
      <HighlightsStrip
        userId={user.id}
        isOwnProfile={isOwnProfile}
        onHighlightClick={(items, startIndex) => setHighlightData({ items, startIndex })}
        refreshTrigger={highlightRefresh}
      />

      {highlightData && (
        <HighlightsModal
          highlights={highlightData.items}
          startIndex={highlightData.startIndex}
          onClose={() => setHighlightData(null)}
        />
      )}

      {/* Interests section below */}

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
            Events by {user.name.split(' ')[0]}
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
                  src={event.cover_url || event.image || ''}
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
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.event_date ? new Date(event.event_date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : event.date}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
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

      {/* Organizer Reviews */}
      {(user.role === 'organizer' || user.role === 'organiser') && (
        <div style={{ margin: '0 16px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Reviews</span>
            {avgRating > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Star size={13} fill="#FFB830" color="#FFB830" />
                <span style={{ color: '#FFB830', fontSize: '13px', fontWeight: 700 }}>{avgRating}</span>
                <span style={{ color: '#8B8FA8', fontSize: '12px' }}>({reviews.length})</span>
              </div>
            )}
          </div>

          {!isOwnProfile && currentUserId && !reviewSubmitted && (
            <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', marginBottom: '12px' }}>
              <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>Leave a Review</p>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                {[1, 2, 3, 4, 5].map((s) => (
                  <button key={s} onClick={() => setReviewRating(s)} onMouseEnter={() => setReviewHover(s)} onMouseLeave={() => setReviewHover(0)}
                    style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer' }}>
                    <Star size={26} fill={(reviewHover || reviewRating) >= s ? '#FFB830' : '#2A2D3E'} color={(reviewHover || reviewRating) >= s ? '#FFB830' : '#2A2D3E'} />
                  </button>
                ))}
              </div>
              <textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)}
                placeholder="Share your experience (min 10 characters)..." rows={3}
                style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '10px', color: '#F0F0FF', fontSize: '13px', resize: 'none', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }} />
              <button onClick={submitReview} disabled={!reviewRating || reviewText.trim().length < 10 || reviewSubmitting}
                style={{ marginTop: '10px', width: '100%', background: reviewRating && reviewText.trim().length >= 10 ? 'linear-gradient(135deg,#7B2FBE 0%,#4F46E5 100%)' : 'rgba(123,47,190,0.2)', border: 'none', borderRadius: '12px', padding: '12px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
                {reviewSubmitting ? 'Posting...' : 'Post Review'}
              </button>
            </div>
          )}
          {reviewSubmitted && !isOwnProfile && (
            <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '12px', padding: '10px 14px', marginBottom: '12px', color: '#10B981', fontSize: '13px', fontWeight: 600 }}>
              ✓ Your review has been submitted
            </div>
          )}

          {reviews.length === 0 ? (
            <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '14px', padding: '20px', textAlign: 'center', color: '#8B8FA8', fontSize: '13px' }}>
              No reviews yet
            </div>
          ) : (
            reviews.map((r) => (
              <div key={r.id} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '14px', padding: '14px', marginBottom: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>
                    {(r.reviewer as any)?.full_name || (r.reviewer as any)?.username || 'Anonymous'}
                    {r.reviewer_id === currentUserId && <span style={{ color: '#A855F7', fontSize: '10px', marginLeft: '6px' }}>You</span>}
                  </span>
                  <div style={{ display: 'flex', gap: '2px' }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} size={11} fill={i < r.rating ? '#FFB830' : '#2A2D3E'} color={i < r.rating ? '#FFB830' : '#2A2D3E'} />
                    ))}
                  </div>
                </div>
                <p style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.5 }}>{r.body}</p>
                <span style={{ color: '#8B8FA8', fontSize: '11px', display: 'block', marginTop: '6px' }}>
                  {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
        </div>
      )}
      {showReport && currentUserId && (
        <ReportModal
          reporterId={currentUserId}
          targetType="user"
          targetId={user.id}
          targetName={user.name || user.username}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  );
}

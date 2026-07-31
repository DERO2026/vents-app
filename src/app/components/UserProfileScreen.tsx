import { useState, useEffect } from 'react';
import BadgeChip from './BadgeChip';
import { ArrowLeft, MapPin, BadgeCheck, Flag, MessageCircle, Share2, Ban } from 'lucide-react';
import { UserProfile } from './types';
import { insforge, getAuthToken } from '../../lib/insforge';
import { ReportModal } from './ReportModal';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface UserProfileScreenProps {
  user: UserProfile & { is_verified?: boolean };
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
  onBack,
  onEventPress,
  currentUserId,
  onMessage,
}: UserProfileScreenProps) {
  const [eventsCreated, setEventsCreated] = useState(0);
  const [attendees, setAttendees] = useState(0);
  const [eventsAttended, setEventsAttended] = useState(0);
  const isVerified = user.is_verified || user.id === ROOT_UID;
  const isOwnProfile = currentUserId === user.id;
  const [showReport, setShowReport] = useState(false);
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockLoading, setBlockLoading] = useState(false);
  const isOrganizerProfile = user.role === 'organizer' || (user.role as any) === 'organiser';

  useEffect(() => {
    if (!currentUserId || isOwnProfile || !user?.id) return;
    insforge.database
      .from('blocked_users')
      .select('id')
      .eq('blocker_id', currentUserId)
      .eq('blocked_id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsBlocked(!!data), () => {});
  }, [currentUserId, user.id, isOwnProfile]);

  const handleToggleBlock = async () => {
    if (!currentUserId || blockLoading) return;
    setBlockLoading(true);
    try {
      await getAuthToken();
      const { error } = isBlocked
        ? await insforge.database.rpc('unblock_user' as any, { p_blocked_id: user.id })
        : await insforge.database.rpc('block_user' as any, { p_blocked_id: user.id });
      if (error) throw error;
      setIsBlocked(!isBlocked);
    } catch (err: any) {
      console.error('Block/unblock failed:', err);
    } finally {
      setBlockLoading(false);
    }
  };

  useEffect(() => {
    setCoverLoadFailed(false);
  }, [user.cover_url]);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [user.avatar_url]);

  useEffect(() => {
    setEventsCreated(0);
    setAttendees(0);
    setEventsAttended(0);
  }, [user.id]);

  useEffect(() => {
    async function fetchStats() {
      if (!user?.id) return;
      try {
        // 1. Events created count
        const { count: eCount } = await insforge.database
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('organizer_id', user.id)
          .is('deleted_at', null);
        setEventsCreated(eCount || 0);

        // 2. Attendees count
        const { data: userEvents } = await insforge.database
          .from('events')
          .select('id')
          .eq('organizer_id', user.id)
          .is('deleted_at', null);

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
        position: 'relative',
      }}
    >
      {/* Cover + back button */}
      <div style={{ position: 'relative', height: 'calc(140px + env(safe-area-inset-top))', flexShrink: 0 }}>
        {user.cover_url && !coverLoadFailed ? (
          <img
            src={user.cover_url}
            alt="cover"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={() => setCoverLoadFailed(true)}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              background: `linear-gradient(135deg, ${user.avatarColor}40 0%, rgba(79,70,229,0.25) 60%, #020005 100%)`,
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
            background: (user.avatar_url && !avatarLoadFailed) ? 'transparent' : user.avatarColor,
            border: '3px solid #020005',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 6px 24px ${user.avatarColor}60`,
            overflow: 'hidden',
          }}
        >
          {user.avatar_url && !avatarLoadFailed ? (
            <img
              src={user.avatar_url}
              alt="Avatar"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={() => setAvatarLoadFailed(true)}
            />
          ) : (
            <span style={{ color: '#fff', fontSize: '26px', fontWeight: 700 }}>
              {user.avatarInitials}
            </span>
          )}
        </div>

        {/* Share button */}
        <button
          onClick={async () => {
            // Query-param form, not a /user/:id path — the app is a client-
            // rendered SPA with no router mounted for path-based routes, so
            // a /user/:id link only ever resolves to index.html with no
            // matching route and dead-ends at home. App.tsx already parses
            // ?event=/?user= off window.location.search on load.
            const shareUrl = `${window.location.origin}/?user=${user.id}`;
            const shareData = { title: `${user.username || user.name} on Vents`, url: shareUrl };
            try {
              if (navigator.share) {
                await navigator.share(shareData);
              } else {
                await navigator.clipboard.writeText(shareUrl);
                alert('Profile link copied!');
              }
            } catch { /* user cancelled */ }
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '10px 16px', borderRadius: '24px',
            border: '1px solid #7B2FF7', background: 'transparent', cursor: 'pointer',
          }}
        >
          <Share2 size={16} color="#7B2FF7" />
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
        {!isOwnProfile && currentUserId && isOrganizerProfile && (
          <button
            onClick={handleToggleBlock}
            disabled={blockLoading}
            title={isBlocked ? 'Unblock organizer' : 'Block organizer'}
            style={{
              background: isBlocked ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
              border: isBlocked ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(255,255,255,0.1)',
              borderRadius: '50%',
              width: '38px',
              height: '38px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: blockLoading ? 'wait' : 'pointer',
              opacity: blockLoading ? 0.6 : 1,
            }}
          >
            <Ban size={16} color={isBlocked ? '#EF4444' : '#8B8FA8'} />
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
            <span title="Verified" style={{ display: 'inline-flex' }}>
              <BadgeCheck size={18} color="#3B82F6" style={{ filter: 'drop-shadow(0 0 6px rgba(59,130,246,0.6))' }} />
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
          <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 500 }}>
            @{user.username}
          </span>
          <BadgeChip tier={user.vc_badge} />
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

      {/* Location — hidden entirely when unset rather than showing a fake/blank state */}
      {user.city && (
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
      )}

      {/* Stats row */}
      <div
        style={{
          display: 'flex',
          margin: '0 16px',
          background: '#090514',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '16px',
          padding: '14px 0',
          marginBottom: '16px',
        }}
      >
        {[
          { label: 'Events', value: String(eventsCreated) },
          { label: 'Attended', value: String(eventsAttended) },
          // Only meaningful for organizer profiles (count of ticket-buyers
          // across their events) -- hidden for standard/attendee profiles.
          ...(isOrganizerProfile ? [{ label: 'Attendees', value: String(attendees) }] : []),
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

      {/* Interests section below */}

      {/* Interests */}
      {user.interests?.length > 0 && (
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

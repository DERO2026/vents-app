import { useState, useEffect } from 'react';
import BadgeChip from './BadgeChip';
import { ArrowLeft, MapPin, BadgeCheck, Flag, MessageCircle, Share2, Ban } from 'lucide-react';
import { UserProfile } from './types';
import { supabase, getAuthToken } from '../../lib/supabase';
import { ReportModal } from './ReportModal';
import { shareLink } from '../../lib/shareLink';
import { Sentry } from '../../lib/sentry';
import { openExternalUrl } from '../../lib/externalLink';
import { SiInstagram, SiX, SiTiktok } from 'react-icons/si';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface UserProfileScreenProps {
  user: UserProfile;
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
  // Fixed pre-existing bug: this previously read user.is_verified (snake_
  // case), a field UserProfile never has -- every real caller
  // (mapDbUserToUserProfile in ExploreScreen.tsx) sets isVerified
  // (camelCase) instead, so the verified badge/label below could never
  // actually render for a real user except the hardcoded ROOT_UID.
  const isVerified = user.isVerified || user.id === ROOT_UID;
  const isOwnProfile = currentUserId === user.id;
  const [showReport, setShowReport] = useState(false);
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockLoading, setBlockLoading] = useState(false);
  const [copiedToast, setCopiedToast] = useState(false);
  // Local-only visual Follow/Following toggle -- see the Follow/Contact row
  // comment below for why this is intentionally not backed by any RPC.
  const [localFollowing, setLocalFollowing] = useState(false);
  const isOrganizerProfile = user.role === 'organizer' || (user.role as any) === 'organiser';
  // Real event list -- the "Public User/Organizer Profile" exports both
  // show an actual event list (Upcoming/Past tabs for a regular user,
  // "Upcoming events" for an organizer), which this screen never fetched
  // before (only aggregate counts). Organizer: events they host
  // (events.organizer_id). Attendee: events they hold an active ticket
  // for, split by date the same way MyTicketsScreen already does.
  const [profileEvents, setProfileEvents] = useState<{ id: string; title: string; date: string; venue: string; eventDate: string }[]>([]);
  const [eventsTab, setEventsTab] = useState<'upcoming' | 'past'>('upcoming');

  useEffect(() => {
    if (!currentUserId || isOwnProfile || !user?.id) return;
    supabase
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
        ? await supabase.rpc('unblock_user' as any, { p_blocked_id: user.id })
        : await supabase.rpc('block_user' as any, { p_blocked_id: user.id });
      if (error) throw error;
      setIsBlocked(!isBlocked);
    } catch (err: any) {
      console.error('Block/unblock failed:', err);
      Sentry.captureException(err);
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
        const { count: eCount } = await supabase
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('organizer_id', user.id)
          .is('deleted_at', null);
        setEventsCreated(eCount || 0);

        // 2. Attendees count
        const { data: userEvents } = await supabase
          .from('events')
          .select('id')
          .eq('organizer_id', user.id)
          .is('deleted_at', null);

        if (userEvents && userEvents.length > 0) {
          const eventIds = userEvents.map((e: any) => e.id);
          const { count: tCount } = await supabase
            .from('tickets')
            .select('id', { count: 'exact', head: true })
            .in('event_id', eventIds)
            .eq('status', 'active');
          setAttendees(tCount || 0);
        } else {
          setAttendees(0);
        }

        // 4. Events this user attended (distinct events from their tickets)
        const { data: attendedTickets } = await supabase
          .from('tickets')
          .select('event_id')
          .eq('user_id', user.id)
          .eq('status', 'active');
        const distinctEvents = new Set((attendedTickets || []).map((t: any) => t.event_id));
        setEventsAttended(distinctEvents.size);
      } catch (err) {
        console.error("Failed to fetch user profile stats:", err);
        Sentry.captureException(err);
      }
    }
    fetchStats();
  }, [user.id]);

  useEffect(() => {
    async function fetchEvents() {
      if (!user?.id) return;
      try {
        if (isOrganizerProfile) {
          const { data } = await supabase
            .from('events')
            .select('id, title, event_date, venue, location')
            .eq('organizer_id', user.id)
            .is('deleted_at', null)
            .gte('event_date', new Date().toISOString())
            .order('event_date', { ascending: true })
            .limit(10);
          setProfileEvents((data || []).map((e: any) => ({
            id: e.id, title: e.title, eventDate: e.event_date,
            date: e.event_date ? new Date(e.event_date).toLocaleDateString('en-NG', { weekday: 'short', month: 'short', day: 'numeric' }) : '',
            venue: e.venue || e.location || '',
          })));
        } else {
          const { data } = await supabase
            .from('tickets')
            .select('event_id, events(id, title, event_date, venue, location)')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .order('created_at', { ascending: false })
            .limit(20);
          const seen = new Set<string>();
          const rows: { id: string; title: string; date: string; venue: string; eventDate: string }[] = [];
          (data || []).forEach((t: any) => {
            const ev = t.events;
            if (!ev || seen.has(ev.id)) return;
            seen.add(ev.id);
            rows.push({
              id: ev.id, title: ev.title, eventDate: ev.event_date,
              date: ev.event_date ? new Date(ev.event_date).toLocaleDateString('en-NG', { weekday: 'short', month: 'short', day: 'numeric' }) : '',
              venue: ev.venue || ev.location || '',
            });
          });
          setProfileEvents(rows);
        }
      } catch (err) {
        console.error('Failed to fetch profile events:', err);
        Sentry.captureException(err);
      }
    }
    fetchEvents();
  }, [user.id, isOrganizerProfile]);

  const now = Date.now();
  const upcomingProfileEvents = profileEvents.filter((e) => !e.eventDate || new Date(e.eventDate).getTime() > now);
  const pastProfileEvents = profileEvents.filter((e) => e.eventDate && new Date(e.eventDate).getTime() <= now);
  const displayedProfileEvents = isOrganizerProfile ? upcomingProfileEvents : (eventsTab === 'upcoming' ? upcomingProfileEvents : pastProfileEvents);

  return (
    <div
      style={{
        background: '#08050f',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
        position: 'relative',
      }}
    >
      {/* Radial purple glow decoration, matching the export's ambient
          background treatment (both Public User and Organizer Profile
          exports use the same top-anchored radial glow, no cover photo). */}
      <div style={{ position: 'absolute', top: '-140px', left: '50%', transform: 'translateX(-50%)', width: '520px', height: '420px', background: 'radial-gradient(ellipse at center, rgba(168,85,247,0.32), transparent 65%)', filter: 'blur(10px)', pointerEvents: 'none' }} />

      {copiedToast && (
        <div style={{ position: 'fixed', left: '16px', right: '16px', bottom: 'calc(24px + env(safe-area-inset-bottom))', zIndex: 50, display: 'flex', justifyContent: 'center' }}>
          <div style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.35)', borderRadius: '12px', padding: '10px 16px', color: '#A78BFA', fontSize: '13px', fontWeight: 600 }}>
            Profile link copied!
          </div>
        </div>
      )}

      {/* Real cover photo, if the user has one -- the export has no cover
          photo concept at all (flat radial-glow background only), but
          dropping the feature would delete real, working functionality.
          Shown as a short backdrop band behind the header row rather than
          the old avatar-overlapping banner, so the avatar/name/bio below
          stay centered exactly like the export regardless of whether a
          cover photo is set. */}
      {user.cover_url && !coverLoadFailed && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '160px', overflow: 'hidden' }}>
          <img
            src={user.cover_url}
            alt="cover"
            style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35 }}
            onError={() => setCoverLoadFailed(true)}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(8,5,15,0.2) 0%, #08050f 100%)' }} />
        </div>
      )}

      {/* Header row -- back + real action icons (share/message/report/block),
          restyled to the export's circular glass-button treatment instead
          of overlapping the avatar the way the old cover-banner layout did. */}
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'calc(16px + env(safe-area-inset-top)) 20px 4px' }}>
        <button
          onClick={onBack}
          style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ArrowLeft size={16} color="#f6f4f9" />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={async () => {
              // Query-param form, not a /user/:id path — the app is a client-
              // rendered SPA with no router mounted for path-based routes, so
              // a /user/:id link only ever resolves to index.html with no
              // matching route and dead-ends at home. App.tsx already parses
              // ?event=/?user= off window.location.search on load.
              // Always the real public domain, never window.location.origin --
              // inside the native app that resolves to the WebView's own
              // internal origin (capacitor://localhost on iOS, https://localhost
              // on Android), meaningless to anyone the link is shared with.
              const shareUrl = `https://getvents.com/?user=${user.id}`;
              const result = await shareLink({ title: `${user.username || user.name} on Vents`, url: shareUrl });
              if (result === 'copied') {
                setCopiedToast(true);
                setTimeout(() => setCopiedToast(false), 2000);
              }
            }}
            title="Share profile"
            style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <Share2 size={15} color="#f6f4f9" />
          </button>
          {!isOwnProfile && currentUserId && (
            <button
              onClick={() => setShowReport(true)}
              title="Report user"
              style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <Flag size={15} color="#c3bdd1" />
            </button>
          )}
          {!isOwnProfile && currentUserId && isOrganizerProfile && (
            <button
              onClick={handleToggleBlock}
              disabled={blockLoading}
              title={isBlocked ? 'Unblock organizer' : 'Block organizer'}
              style={{ width: '36px', height: '36px', borderRadius: '50%', background: isBlocked ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)', border: isBlocked ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: blockLoading ? 'wait' : 'pointer', opacity: blockLoading ? 0.6 : 1 }}
            >
              <Ban size={15} color={isBlocked ? '#EF4444' : '#c3bdd1'} />
            </button>
          )}
        </div>
      </div>

      {/* Avatar -- centered, per both exports. Organizer: 92px rounded
          square with a verified-checkmark overlay when real is_verified is
          true. Attendee: 96px circle. Both keep the real avatar_url/
          avatarColor/avatarInitials data exactly as before. */}
      <div style={{ position: 'relative', padding: '16px 20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <div
            style={{
              width: isOrganizerProfile ? '92px' : '96px',
              height: isOrganizerProfile ? '92px' : '96px',
              borderRadius: isOrganizerProfile ? '22px' : '50%',
              background: (user.avatar_url && !avatarLoadFailed) ? 'transparent' : `linear-gradient(145deg, ${user.avatarColor}, #4c1d95)`,
              boxShadow: '0 0 0 3px rgba(168,85,247,0.3), 0 0 28px rgba(168,85,247,0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
              <span style={{ color: '#fff', fontSize: isOrganizerProfile ? '30px' : '34px', fontWeight: 800 }}>
                {user.avatarInitials}
              </span>
            )}
          </div>
          {isOrganizerProfile && isVerified && (
            <div style={{ position: 'absolute', bottom: '-6px', right: '-6px', width: '26px', height: '26px', borderRadius: '50%', background: '#a855f7', border: '2px solid #08050f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <BadgeCheck size={13} color="#fff" />
            </div>
          )}
        </div>

        <div style={{ marginTop: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <h1 style={{ color: '#f6f4f9', fontSize: isOrganizerProfile ? '21px' : '22px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', margin: 0 }}>
            {user.name}
          </h1>
          {!isOrganizerProfile && isVerified && (
            <span title="Verified" style={{ display: 'inline-flex' }}>
              <BadgeCheck size={18} color="#3B82F6" style={{ filter: 'drop-shadow(0 0 6px rgba(59,130,246,0.6))' }} />
            </span>
          )}
        </div>
        {isOrganizerProfile ? (
          isVerified && (
            <div style={{ fontSize: '12px', letterSpacing: '1px', color: '#c084fc', fontWeight: 700, marginTop: '4px' }}>
              VERIFIED ORGANIZER
            </div>
          )
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
            <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 500 }}>@{user.username}</span>
            <BadgeChip tier={user.vc_badge} />
          </div>
        )}
        {user.bio && (
          <p style={{ color: '#c3bdd1', fontSize: '13px', textAlign: 'center', marginTop: '10px', lineHeight: 1.5, padding: '0 20px' }}>
            {user.bio}
          </p>
        )}

        {/* Connected Accounts (handoff PD2) -- real per-user handles
            (users.instagram_handle/x_handle/tiktok_handle), only rendered
            when actually set rather than showing empty/placeholder icons. */}
        {(user.instagram_handle || user.x_handle || user.tiktok_handle) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
            {user.instagram_handle && (
              <button onClick={() => openExternalUrl(`https://instagram.com/${user.instagram_handle}`)} title={`@${user.instagram_handle} on Instagram`} style={{ width: '32px', height: '32px', borderRadius: '9px', background: 'linear-gradient(45deg, #F58529, #DD2A7B, #8134AF)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <SiInstagram size={14} color="#fff" />
              </button>
            )}
            {user.x_handle && (
              <button onClick={() => openExternalUrl(`https://x.com/${user.x_handle}`)} title={`@${user.x_handle} on X`} style={{ width: '32px', height: '32px', borderRadius: '9px', background: '#000', border: '1px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <SiX size={13} color="#fff" />
              </button>
            )}
            {user.tiktok_handle && (
              <button onClick={() => openExternalUrl(`https://www.tiktok.com/@${user.tiktok_handle}`)} title={`@${user.tiktok_handle} on TikTok`} style={{ width: '32px', height: '32px', borderRadius: '9px', background: '#000', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <SiTiktok size={13} color="#fff" />
              </button>
            )}
          </div>
        )}

        {/* Location — hidden entirely when unset rather than showing a fake/blank state */}
        {user.city && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '10px' }}>
            <MapPin size={13} color="#9a93a8" />
            <span style={{ color: '#9a93a8', fontSize: '13px' }}>{user.city}</span>
          </div>
        )}
      </div>

      {/* Stats row -- centered, matching both exports' 3-column card.
          Organizer export wants HOSTED / FOLLOWERS / RATING★, but VENTS has
          no follower or rating system at all (confirmed: no such column/
          table anywhere in the schema) -- rather than fabricate those two
          numbers, this uses the real metrics we do have: Hosted (real
          events count) and Attendees (real ticket count across their
          events). Attendee export wants EVENTS / FOLLOWERS / FOLLOWING --
          same reasoning, substituted with real Events-attended count. */}
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', margin: '20px 20px 0', background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '18px', padding: '16px 0' }}>
        {(isOrganizerProfile
          ? [
              { label: 'HOSTED', value: String(eventsCreated) },
              { label: 'ATTENDEES', value: String(attendees) },
            ]
          : [
              { label: 'EVENTS', value: String(eventsAttended) },
            ]
        ).map(({ label, value }, i, arr) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, textAlign: 'center', minWidth: '90px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#f6f4f9', fontFamily: 'Manrope, sans-serif' }}>{value}</div>
              <div style={{ fontSize: '11px', letterSpacing: '1px', color: '#9a93a8', marginTop: '3px' }}>{label}</div>
            </div>
            {i < arr.length - 1 && <div style={{ width: '1px', alignSelf: 'stretch', background: 'rgba(255,255,255,0.1)' }} />}
          </div>
        ))}
      </div>

      {/* Follow/Contact row. "Contact"/message opens the real existing
          conversation flow (onMessage). "Follow" has no real backend to
          back it -- there is no follows table or RPC anywhere in the
          schema -- so rather than fabricate a persisted social relationship,
          this is an honest LOCAL-ONLY visual toggle (matching the export's
          own reference implementation, which is also just local component
          state, not a real backend call) and is never presented as saved
          or synced anywhere. */}
      {!isOwnProfile && currentUserId && (
        <div style={{ position: 'relative', display: 'flex', gap: '10px', margin: '16px 20px 0' }}>
          <button
            onClick={() => setLocalFollowing((f) => !f)}
            style={{
              flex: 1, textAlign: 'center', padding: '13px 0', borderRadius: '14px', border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: '14px',
              background: localFollowing ? 'rgba(255,255,255,0.08)' : 'linear-gradient(135deg,#a855f7,#7c3aed)',
              boxShadow: localFollowing ? 'none' : '0 6px 20px rgba(168,85,247,0.35)',
              color: localFollowing ? '#f6f4f9' : '#fff',
            }}
          >
            {localFollowing ? 'Following' : 'Follow'}
          </button>
          {isOrganizerProfile ? (
            <button
              onClick={() => onMessage && onMessage(user.id)}
              style={{ flex: 1, textAlign: 'center', padding: '13px 0', borderRadius: '14px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', fontWeight: 700, fontSize: '14px', color: '#f6f4f9', cursor: onMessage ? 'pointer' : 'default' }}
            >
              Contact
            </button>
          ) : (
            onMessage && (
              <button
                onClick={() => onMessage(user.id)}
                title="Send message"
                style={{ width: '48px', borderRadius: '14px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
              >
                <MessageCircle size={16} color="#f6f4f9" />
              </button>
            )
          )}
        </div>
      )}

      {/* Interests */}
      {user.interests?.length > 0 && (
      <div style={{ padding: '0 20px', marginTop: '22px', marginBottom: '4px' }}>
        <p
          style={{
            color: '#9a93a8',
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

      {/* Events list -- real data (see profileEvents fetch above), matching
          the export's "Upcoming / Past Events" tabs (attendee profile) or
          "Upcoming events" list (organizer profile). Hidden entirely when
          there's nothing real to show, rather than a fabricated placeholder
          row. */}
      {!isOrganizerProfile && (
        <div style={{ display: 'flex', margin: '26px 20px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          {(['upcoming', 'past'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setEventsTab(tab)}
              style={{
                flex: 1, textAlign: 'center', padding: '0 0 12px', background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '13.5px', fontWeight: eventsTab === tab ? 700 : 600,
                color: eventsTab === tab ? '#f6f4f9' : '#8b8594',
                borderBottom: eventsTab === tab ? '2px solid #a855f7' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {tab === 'upcoming' ? 'Upcoming' : 'Past Events'}
            </button>
          ))}
        </div>
      )}
      {isOrganizerProfile && profileEvents.length > 0 && (
        <p style={{ color: '#9a93a8', fontSize: '13px', letterSpacing: '1.5px', fontWeight: 700, margin: '24px 20px 0' }}>
          UPCOMING EVENTS
        </p>
      )}
      {displayedProfileEvents.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', margin: '16px 20px 30px' }}>
          {displayedProfileEvents.map((ev) => (
            <button
              key={ev.id}
              onClick={() => onEventPress && onEventPress({ id: ev.id } as any)}
              style={{ display: 'flex', gap: '12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '12px', textAlign: 'left', cursor: onEventPress ? 'pointer' : 'default' }}
            >
              <div style={{ width: '52px', height: '52px', borderRadius: '10px', background: 'rgba(168,85,247,0.14)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#f6f4f9', fontSize: '14px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                <div style={{ color: '#9a93a8', fontSize: '12px', marginTop: '3px' }}>{ev.date}{ev.venue ? ` · ${ev.venue}` : ''}</div>
              </div>
            </button>
          ))}
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

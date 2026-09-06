import { useState, useEffect, useRef, useCallback } from 'react';
import BadgeChip from './BadgeChip';
import { Search, X, CheckCircle, MessageCircle, Check, ChevronRight, Plus, Users } from 'lucide-react';
import { UserProfile } from './types';
import { supabase } from '../../lib/supabase';
import { SkeletonCard } from './SkeletonCard';
import { escapePostgrestOrValue } from '../../lib/sanitize';
import { haptics } from '../../lib/haptics';
import { Sentry } from '../../lib/sentry';

interface ExploreScreenProps {
  onUserPress: (user: UserProfile) => void;
  currentUserId?: string;
  onOpenConversation?: (userId: string, userName: string, avatarUrl?: string, vcBadge?: string) => void;
  chatRefreshKey?: number;
  initialTab?: 'people' | 'chats';
  onTabChange?: (tab: 'people' | 'chats') => void;
}

export function mapDbUserToUserProfile(dbUser: any): UserProfile {
  const name = dbUser.full_name || (dbUser.email ? dbUser.email.split('@')[0] : null) || dbUser.username || 'Vents User';
  const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2) || 'U';
  const colors = ['#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444'];
  const charSum = (dbUser.username || dbUser.id || '').split('').reduce((sum: number, char: string) => sum + char.charCodeAt(0), 0);
  const avatarColor = colors[charSum % colors.length];

  return {
    id: dbUser.id,
    name,
    username: dbUser.username || (dbUser.email ? dbUser.email.split('@')[0] : null) || dbUser.id?.slice(0, 8) || 'user',
    avatarColor,
    avatarInitials: initials,
    city: dbUser.state || '',
    bio: dbUser.bio || 'Hello, I am using Vents!',
    eventsAttended: 0,
    interests: Array.isArray(dbUser.interests) ? dbUser.interests : [],
    avatar_url: dbUser.avatar_url,
    cover_url: dbUser.cover_url,
    role: dbUser.role,
    isOrganizer: dbUser.role === 'organizer',
    isVerified: dbUser.is_verified === true,
    vc_badge: dbUser.vc_badge || undefined,
  };
}

export function ExploreScreen({
  onUserPress,
  currentUserId,
  onOpenConversation,
  chatRefreshKey,
}: ExploreScreenProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [chatFilter, setChatFilter] = useState<'all' | 'unread' | 'organizers' | 'attendees'>('all');

  // Pull-to-refresh
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const pullStartY = useRef<number | null>(null);
  const handlePullTouchStart = (e: React.TouchEvent) => {
    pullStartY.current = e.touches[0].clientY;
  };
  const handlePullTouchEnd = (e: React.TouchEvent) => {
    if (pullStartY.current === null) return;
    const dy = e.changedTouches[0].clientY - pullStartY.current;
    pullStartY.current = null;
    if (dy > 400 && !pullRefreshing) {
      setPullRefreshing(true);
      setLocalRefreshKey(k => k + 1);
      setTimeout(() => setPullRefreshing(false), 800);
    }
  };

  // ── Conversations ────────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<any[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [requests, setRequests] = useState<any[]>([]);
  const [showRequests, setShowRequests] = useState(false);
  const [respondingId, setRespondingId] = useState<string | null>(null);

  const loadConversations = useCallback(() => {
    if (!currentUserId) return;
    setLoadingChats(true);
    Promise.all([
      supabase
        .from('direct_messages')
        .select('id, sender_id, recipient_id, body, created_at, read_at')
        .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('conversation_requests')
        .select('requester_id, recipient_id, status, created_at')
        .or(`requester_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`),
    ])
      .then(async ([{ data, error }, { data: reqData }]) => {
        if (error || !data) { setLoadingChats(false); return; }
        try {
          const reqRows = reqData || [];
          // Only 'accepted' (or no row at all — legacy threads from before
          // this feature shipped) belong in the main list; pending/declined
          // stay out of the way in Message Requests.
          const gatedPartnerIds = new Set(
            reqRows.filter((r: any) => r.status !== 'accepted')
              .map((r: any) => r.requester_id === currentUserId ? r.recipient_id : r.requester_id)
          );
          const pendingIncoming = reqRows.filter((r: any) => r.status === 'pending' && r.recipient_id === currentUserId);

          const seen = new Map<string, any>();
          const unreadCounts = new Map<string, number>();
          for (const msg of data) {
            const partnerId = msg.sender_id === currentUserId ? msg.recipient_id : msg.sender_id;
            if (gatedPartnerIds.has(partnerId)) continue;
            if (!seen.has(partnerId)) seen.set(partnerId, msg);
            if (msg.sender_id !== currentUserId && !msg.read_at) {
              unreadCounts.set(partnerId, (unreadCounts.get(partnerId) || 0) + 1);
            }
          }
          const partnerIds = [...new Set([...seen.keys(), ...pendingIncoming.map((r: any) => r.requester_id)])];
          if (partnerIds.length === 0) { setConversations([]); setRequests([]); return; }
          const { data: profiles } = await supabase
            .from('public_profiles')
            .select('id, full_name, username, avatar_url, vc_badge, role, last_active_at')
            .in('id', partnerIds);
          const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
          const isOnline = (id: string) => {
            const t = profileMap.get(id)?.last_active_at;
            return !!t && Date.now() - new Date(t).getTime() < 60_000;
          };
          setConversations([...seen.keys()].map(pid => ({
            partnerId: pid,
            lastMsg: seen.get(pid),
            profile: profileMap.get(pid) || null,
            unreadCount: unreadCounts.get(pid) || 0,
            online: isOnline(pid),
          })));
          setRequests(pendingIncoming.map((r: any) => ({
            requesterId: r.requester_id,
            profile: profileMap.get(r.requester_id) || null,
            createdAt: r.created_at,
          })));
        } catch (err) {
          console.error('Failed to build conversation list:', err);
          Sentry.captureException(err);
        } finally {
          setLoadingChats(false);
        }
      }, (err) => { console.error('Direct messages fetch error:', err); setLoadingChats(false); });
  }, [currentUserId]);

  useEffect(() => { loadConversations(); }, [loadConversations, chatRefreshKey, localRefreshKey]);

  async function respondToRequest(requesterId: string, action: 'accept' | 'decline') {
    setRespondingId(requesterId);
    haptics.light();
    try {
      const { error } = await supabase.rpc('respond_to_message_request', { p_requester_id: requesterId, p_action: action });
      if (error) throw error;
      setRequests(prev => prev.filter(r => r.requesterId !== requesterId));
      if (action === 'accept') loadConversations();
    } catch (err) {
      console.error('Failed to respond to message request:', err);
      Sentry.captureException(err);
    } finally {
      setRespondingId(null);
    }
  }

  // ── People search ────────────────────────────────────────────────────────────
  const [searchedUsers, setSearchedUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearchedUsers([]); return; }
    setLoadingUsers(true);
    const t = setTimeout(async () => {
      try {
        const like = escapePostgrestOrValue(`%${q.toLowerCase()}%`);
        const { data } = await supabase
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
          .or(`username.ilike.${like},full_name.ilike.${like}`)
          .limit(20);
        setSearchedUsers((data || []).map(mapDbUserToUserProfile));
      } catch { /* ignore */ } finally { setLoadingUsers(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // Account-relationship label, derived only from the profile's real `role`
  // column (never a manual/hardcoded per-row label). public_profiles does
  // not currently expose is_service_provider, so a "Vendor" label isn't
  // shown here yet -- adding it would require exposing that column on the
  // view, a backend change outside this pass's scope.
  const roleBadge = (role?: string): { label: string; color: string; bg: string } | null => {
    if (role === 'organizer' || role === 'organiser') return { label: 'Organizer', color: '#D8B4FE', bg: 'rgba(168,85,247,0.16)' };
    if (role === 'admin' || role === 'sub-admin') return { label: 'Admin', color: '#FCA5A5', bg: 'rgba(239,68,68,0.14)' };
    return null;
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };

  const isSearching = query.trim().length > 0;

  // Filtered conversations when searching
  const searchedConvos = isSearching
    ? conversations.filter(c => {
        const name = (c.profile?.full_name || c.profile?.username || '').toLowerCase();
        const msg = (c.lastMsg?.body || '').toLowerCase();
        const q = query.trim().toLowerCase();
        return name.includes(q) || msg.includes(q);
      })
    : conversations;

  // Real filter chips over the actual conversation list -- Unread checks
  // unreadCount, Organizers/Attendees check the partner's real
  // public_profiles.role. No "Vendors" chip: public_profiles doesn't
  // currently expose is_service_provider, so there's no real data to filter
  // on yet (adding one would either always be empty or require guessing).
  const filteredConvos = searchedConvos.filter((c) => {
    if (chatFilter === 'unread') return c.unreadCount > 0;
    if (chatFilter === 'organizers') return c.profile?.role === 'organizer' || c.profile?.role === 'organiser';
    if (chatFilter === 'attendees') return !c.profile?.role || (c.profile.role !== 'organizer' && c.profile.role !== 'organiser' && c.profile.role !== 'admin' && c.profile.role !== 'sub-admin');
    return true;
  });
  const unreadTotal = conversations.reduce((sum, c) => sum + (c.unreadCount > 0 ? 1 : 0), 0);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'radial-gradient(ellipse 600px 400px at 30% -5%, rgba(123,47,190,0.13) 0%, rgba(5,0,16,1) 45%, #020005 100%)', position: 'relative' }}
      onTouchStart={handlePullTouchStart}
      onTouchEnd={handlePullTouchEnd}
    >
      <style>{`input::placeholder { color: #94A3B8; }`}</style>
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
      {/* ── Header ── */}
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 16px 12px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ color: '#FFFFFF', fontSize: '24px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            Chats
          </h1>
          <p style={{ color: '#9CA0BC', fontSize: '12.5px', margin: '2px 0 0' }}>Messages, organizers, and more</p>
        </div>
        <button
          onClick={() => { haptics.light(); searchRef.current?.focus(); }}
          aria-label="Find people to chat with"
          style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #5B3FCB)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.3)', flexShrink: 0 }}
        >
          <Plus size={20} color="#fff" />
        </button>
      </div>

      {/* ── Search bar ── */}
      <div style={{ padding: '0 16px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '100px', height: '48px', padding: '0 14px', boxSizing: 'border-box' }}>
          <Search size={16} color="#9CA0BC" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search people and messages..."
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#FFFFFF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              <X size={15} color="#9CA0BC" />
            </button>
          )}
        </div>
      </div>

      {/* ── Filter chips ── real filters over the actual conversation list,
          not decoration -- see chatFilter above. Hidden while searching
          (search already narrows both people and messages). */}
      {!isSearching && (
        <div className="no-scrollbar" style={{ display: 'flex', gap: '8px', padding: '0 16px 12px', overflowX: 'auto', flexShrink: 0, scrollbarWidth: 'none' }}>
          {([
            { key: 'all' as const, label: 'All' },
            { key: 'unread' as const, label: 'Unread', count: unreadTotal },
            { key: 'organizers' as const, label: 'Organizers' },
            { key: 'attendees' as const, label: 'Attendees' },
          ]).map((f) => {
            const active = chatFilter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => { haptics.light(); setChatFilter(f.key); }}
                style={{
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px',
                  background: active ? 'linear-gradient(135deg, #7B2FBE, #5B3FCB)' : 'rgba(255,255,255,0.07)',
                  backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                  border: active ? '1px solid rgba(196,181,253,0.4)' : '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '999px', padding: '8px 14px', cursor: 'pointer',
                }}
              >
                <span style={{ color: active ? '#fff' : '#E4E4F0', fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' }}>{f.label}</span>
                {!!f.count && (
                  <span style={{ background: active ? 'rgba(255,255,255,0.25)' : '#A855F7', color: '#fff', fontSize: '10px', fontWeight: 800, borderRadius: '10px', padding: '1px 6px', minWidth: '16px', textAlign: 'center' }}>{f.count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Find people to chat with -- routes into the same real people
          search above, not a fake discovery feed. ── */}
      {!isSearching && (
        <div style={{ padding: '0 16px 14px', flexShrink: 0 }}>
          <button
            onClick={() => { haptics.light(); searchRef.current?.focus(); }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left',
              background: 'rgba(168,85,247,0.1)', backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)',
              border: '1px solid rgba(196,181,253,0.25)', borderRadius: '16px', padding: '14px', cursor: 'pointer',
            }}
          >
            <div style={{ width: '38px', height: '38px', borderRadius: '12px', background: 'rgba(168,85,247,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Users size={18} color="#D8B4FE" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Find people to chat with</p>
              <p style={{ margin: '2px 0 0', color: '#9CA0BC', fontSize: '12px' }}>Connect with organizers and attendees</p>
            </div>
            <ChevronRight size={16} color="#9CA0BC" style={{ flexShrink: 0 }} />
          </button>
        </div>
      )}

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', paddingBottom: 'calc(80px + env(safe-area-inset-bottom))' }}>

        {!currentUserId ? (
          <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '80px', fontSize: '14px' }}>Sign in to see your messages.</p>
        ) : (
          <>
            {/* ── People results (while searching) ── */}
            {isSearching && (
              <div style={{ padding: '0 16px 8px' }}>
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>PEOPLE</p>
                {loadingUsers ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Searching…</p>
                ) : searchedUsers.length === 0 ? (
                  <p style={{ color: '#8B8FA8', fontSize: '13px' }}>No people found</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {searchedUsers.map(u => {
                      const badge = roleBadge(u.role);
                      return (
                      <div
                        key={u.id}
                        onClick={() => onUserPress(u)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUserPress(u); } }}
                        role="button" tabIndex={0}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px', borderRadius: '16px', cursor: 'pointer', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                      >
                        <div style={{ width: '42px', height: '42px', borderRadius: '50%', background: u.avatar_url ? 'transparent' : u.avatarColor, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)', boxSizing: 'border-box' }}>
                          {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>{u.avatarInitials}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0, flexWrap: 'wrap' }}>
                            <span style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{u.name}</span>
                            {u.isVerified && <CheckCircle size={12} fill="#4F46E5" color="#fff" style={{ flexShrink: 0 }} />}
                            <span style={{ flexShrink: 0 }}><BadgeChip tier={u.vc_badge} /></span>
                            {badge && (
                              <span style={{ flexShrink: 0, background: badge.bg, color: badge.color, fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px' }}>{badge.label}</span>
                            )}
                          </div>
                          <span style={{ color: '#9CA0BC', fontSize: '12px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{u.username}</span>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
                {filteredConvos.length > 0 && (
                  <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '14px 0 10px' }}>MESSAGES</p>
                )}
              </div>
            )}

            {/* ── Message Requests ── */}
            {!isSearching && requests.length > 0 && (
              <div style={{ padding: '0 16px 12px' }}>
                <button
                  onClick={() => { haptics.light(); setShowRequests(true); }}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(168,85,247,0.1)', backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)', border: '1px solid rgba(196,181,253,0.25)', borderRadius: '14px', padding: '12px 14px', cursor: 'pointer' }}
                >
                  <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <MessageCircle size={15} color="#A78BFA" />
                  </div>
                  <span style={{ flex: 1, textAlign: 'left', color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>Message Requests</span>
                  <span style={{ background: '#A78BFA', color: '#fff', fontSize: '11px', fontWeight: 800, borderRadius: '10px', padding: '1px 7px' }}>{requests.length}</span>
                  <ChevronRight size={16} color="#8B8FA8" />
                </button>
              </div>
            )}

            {/* ── Conversations ── */}
            <div style={{ padding: '0 16px' }}>
              {!isSearching && (
                <p style={{ color: '#9CA0BC', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>RECENT</p>
              )}
              {loadingChats && conversations.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {[1, 2, 3].map(i => (
                    <SkeletonCard key={i} variant="message" />
                  ))}
                </div>
              ) : filteredConvos.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 32px', gap: '12px', textAlign: 'center' }}>
                  <div style={{ width: '64px', height: '64px', borderRadius: '20px', background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <MessageCircle size={28} color="#C4C9E0" />
                  </div>
                  <p style={{ color: '#E4E4F0', fontSize: '14px', fontWeight: 700, margin: 0 }}>
                    {isSearching ? 'No matching messages' : 'No conversations yet'}
                  </p>
                  <p style={{ color: '#9CA0BC', fontSize: '14px', margin: 0 }}>
                    {isSearching ? 'Try a different search term' : 'Message an organizer or attendee to start'}
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {filteredConvos.map(({ partnerId, lastMsg, profile, unreadCount, online }: any) => {
                    const name = profile?.full_name || profile?.username || 'User';
                    const avatarUrl = profile?.avatar_url;
                    const initial = name[0]?.toUpperCase() || 'U';
                    const isUnread = unreadCount > 0;
                    const badge = roleBadge(profile?.role);
                    return (
                      <div
                        key={partnerId}
                        onClick={() => onOpenConversation?.(partnerId, name, avatarUrl, profile?.vc_badge)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenConversation?.(partnerId, name, avatarUrl, profile?.vc_badge); } }}
                        role="button" tabIndex={0}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '16px', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                      >
                        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: avatarUrl ? 'transparent' : '#7B2FBE', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0, border: '1px solid rgba(255,255,255,0.1)', boxSizing: 'border-box', position: 'relative' }}>
                          {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '18px', fontWeight: 700 }}>{initial}</span>}
                          {online && <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '12px', height: '12px', borderRadius: '50%', background: '#10B981', border: '2px solid #0A0612' }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' }}>
                              <span style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{name}</span>
                              <span style={{ flexShrink: 0 }}><BadgeChip tier={profile?.vc_badge} /></span>
                              {badge && (
                                <span style={{ flexShrink: 0, background: badge.bg, color: badge.color, fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '999px' }}>{badge.label}</span>
                              )}
                            </div>
                            <span style={{ color: '#7C8199', fontSize: '11px', flexShrink: 0, marginLeft: '4px' }}>{timeAgo(lastMsg.created_at)}</span>
                          </div>
                          <span style={{ color: isUnread ? '#E4E4F0' : '#9CA0BC', fontSize: '13px', fontWeight: isUnread ? 600 : 400, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {lastMsg.sender_id === currentUserId ? 'You: ' : ''}{lastMsg.body}
                          </span>
                        </div>
                        {isUnread && (
                          <div style={{ minWidth: '18px', height: '18px', borderRadius: '50%', background: '#A855F7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: '0 4px', boxSizing: 'border-box' }}>
                            <span style={{ color: '#FFFFFF', fontSize: '10px', fontWeight: 700 }}>{unreadCount > 99 ? '99+' : unreadCount}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Message Requests overlay ── */}
      {showRequests && (
        <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse 600px 400px at 30% -5%, rgba(123,47,190,0.13) 0%, rgba(5,0,16,1) 45%, #020005 100%)', zIndex: 500, display: 'flex', flexDirection: 'column', padding: 'calc(16px + env(safe-area-inset-top)) 0 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0 16px 16px' }}>
            <button onClick={() => setShowRequests(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              <X size={22} color="#A78BFA" />
            </button>
            <h2 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>Message Requests</h2>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {requests.length === 0 ? (
              <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '60px', fontSize: '13px' }}>No pending requests.</p>
            ) : requests.map((r) => {
              const name = r.profile?.full_name || r.profile?.username || 'User';
              const avatarUrl = r.profile?.avatar_url;
              return (
                <div key={r.requesterId} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px' }}>
                  <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: avatarUrl ? 'transparent' : '#7B2FBE', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                    {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>{name[0]?.toUpperCase()}</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>{name}</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>wants to message you</p>
                  </div>
                  <button
                    onClick={() => respondToRequest(r.requesterId, 'decline')}
                    disabled={respondingId === r.requesterId}
                    style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                  >
                    <X size={15} color="#8B8FA8" />
                  </button>
                  <button
                    onClick={() => respondToRequest(r.requesterId, 'accept')}
                    disabled={respondingId === r.requesterId}
                    style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                  >
                    <Check size={15} color="#fff" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

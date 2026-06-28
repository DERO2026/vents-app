import { useState, useEffect, useRef } from 'react';
import BadgeChip from './BadgeChip';
import { Search, X, CheckCircle, MessageCircle } from 'lucide-react';
import { UserProfile } from './types';
import { insforge } from '../../lib/insforge';
import { SkeletonCard } from './SkeletonCard';

interface ExploreScreenProps {
  onUserPress: (user: UserProfile) => void;
  currentUserId?: string;
  following?: string[];
  onToggleFollow?: (userId: string) => void;
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
    city: dbUser.state || 'Lagos',
    bio: dbUser.bio || 'Hello, I am using Vents!',
    eventsAttended: 0,
    followers: 0,
    following: 0,
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
  following = [],
  onToggleFollow,
  onOpenConversation,
  chatRefreshKey,
}: ExploreScreenProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

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
    if (dy > 120 && !pullRefreshing) {
      setPullRefreshing(true);
      setLocalRefreshKey(k => k + 1);
      setTimeout(() => setPullRefreshing(false), 800);
    }
  };

  // ── Conversations ────────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<any[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);

  useEffect(() => {
    if (!currentUserId) return;
    setLoadingChats(true);
    insforge.database
      .from('direct_messages')
      .select('id, sender_id, recipient_id, body, created_at, read_at')
      .or(`sender_id.eq.${currentUserId},recipient_id.eq.${currentUserId}`)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(async ({ data, error }) => {
        if (error || !data) { setLoadingChats(false); return; }
        const seen = new Map<string, any>();
        const unreadCounts = new Map<string, number>();
        for (const msg of data) {
          const partnerId = msg.sender_id === currentUserId ? msg.recipient_id : msg.sender_id;
          if (!seen.has(partnerId)) seen.set(partnerId, msg);
          if (msg.sender_id !== currentUserId && !msg.read_at) {
            unreadCounts.set(partnerId, (unreadCounts.get(partnerId) || 0) + 1);
          }
        }
        const partnerIds = [...seen.keys()];
        if (partnerIds.length === 0) { setConversations([]); setLoadingChats(false); return; }
        const { data: profiles } = await insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, vc_badge')
          .in('id', partnerIds);
        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
        setConversations(partnerIds.map(pid => ({
          partnerId: pid,
          lastMsg: seen.get(pid),
          profile: profileMap.get(pid) || null,
          unreadCount: unreadCounts.get(pid) || 0,
        })));
        setLoadingChats(false);
      });
  }, [currentUserId, chatRefreshKey, localRefreshKey]);

  // ── People search ────────────────────────────────────────────────────────────
  const [searchedUsers, setSearchedUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearchedUsers([]); return; }
    setLoadingUsers(true);
    const t = setTimeout(async () => {
      try {
        const like = `%${q.toLowerCase()}%`;
        const { data } = await insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio')
          .or(`username.ilike.${like},full_name.ilike.${like}`)
          .limit(20);
        setSearchedUsers((data || []).map(mapDbUserToUserProfile));
      } catch { /* ignore */ } finally { setLoadingUsers(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

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
  const filteredConvos = isSearching
    ? conversations.filter(c => {
        const name = (c.profile?.full_name || c.profile?.username || '').toLowerCase();
        const msg = (c.lastMsg?.body || '').toLowerCase();
        const q = query.trim().toLowerCase();
        return name.includes(q) || msg.includes(q);
      })
    : conversations;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12', position: 'relative' }}
      onTouchStart={handlePullTouchStart}
      onTouchEnd={handlePullTouchEnd}
    >
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
        <h1 style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
          Messages
        </h1>
      </div>

      {/* ── Search bar ── */}
      <div style={{ padding: '0 16px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#131629', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '10px 14px' }}>
          <Search size={16} color="#8B8FA8" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search people and messages..."
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              <X size={15} color="#8B8FA8" />
            </button>
          )}
        </div>
      </div>

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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {searchedUsers.map(u => (
                      <div
                        key={u.id}
                        onClick={() => onUserPress(u)}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px', borderRadius: '14px', cursor: 'pointer', background: 'rgba(255,255,255,0.02)' }}
                      >
                        <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: u.avatar_url ? 'transparent' : u.avatarColor, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>{u.avatarInitials}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>{u.name}</span>
                            {u.isVerified && <CheckCircle size={12} fill="#4F46E5" color="#fff" />}
                            <BadgeChip tier={u.vc_badge} />
                          </div>
                          <span style={{ color: '#8B8FA8', fontSize: '12px' }}>@{u.username}</span>
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); onToggleFollow?.(u.id); }}
                          style={{
                            background: following.includes(u.id) ? 'rgba(167,139,250,0.12)' : 'linear-gradient(135deg,#7B2FBE,#4F46E5)',
                            border: following.includes(u.id) ? '1px solid rgba(167,139,250,0.3)' : 'none',
                            borderRadius: '20px', padding: '5px 12px',
                            color: following.includes(u.id) ? '#A78BFA' : '#fff',
                            fontSize: '12px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                          }}
                        >{following.includes(u.id) ? 'Subscribed' : 'Subscribe'}</button>
                      </div>
                    ))}
                  </div>
                )}
                {filteredConvos.length > 0 && (
                  <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', margin: '14px 0 10px' }}>MESSAGES</p>
                )}
              </div>
            )}

            {/* ── Conversations ── */}
            <div style={{ padding: '0 16px' }}>
              {!isSearching && (
                <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '10px' }}>CONVERSATIONS</p>
              )}
              {loadingChats && conversations.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {[1, 2, 3].map(i => (
                    <SkeletonCard key={i} variant="message" />
                  ))}
                </div>
              ) : filteredConvos.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 32px', gap: '12px', textAlign: 'center' }}>
                  <div style={{ width: '64px', height: '64px', borderRadius: '20px', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <MessageCircle size={28} color="#6B7280" />
                  </div>
                  <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, margin: 0 }}>
                    {isSearching ? 'No matching messages' : 'No conversations yet'}
                  </p>
                  <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0 }}>
                    {isSearching ? 'Try a different search term' : 'Message an organizer or attendee to start'}
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {filteredConvos.map(({ partnerId, lastMsg, profile, unreadCount }: any) => {
                    const name = profile?.full_name || profile?.username || 'User';
                    const avatarUrl = profile?.avatar_url;
                    const initial = name[0]?.toUpperCase() || 'U';
                    const isUnread = unreadCount > 0;
                    return (
                      <div
                        key={partnerId}
                        onClick={() => onOpenConversation?.(partnerId, name, avatarUrl, profile?.vc_badge)}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px', borderRadius: '14px', cursor: 'pointer', background: isUnread ? 'rgba(167,139,250,0.05)' : 'transparent' }}
                      >
                        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: avatarUrl ? 'transparent' : '#7B2FBE', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                          {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '18px', fontWeight: 700 }}>{initial}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                              <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: isUnread ? 700 : 500 }}>{name}</span>
                              <BadgeChip tier={profile?.vc_badge} />
                            </div>
                            <span style={{ color: '#8B8FA8', fontSize: '11px', flexShrink: 0, marginLeft: '4px' }}>{timeAgo(lastMsg.created_at)}</span>
                          </div>
                          <span style={{ color: isUnread ? '#C4C9E0' : '#8B8FA8', fontSize: '12px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {lastMsg.sender_id === currentUserId ? 'You: ' : ''}{lastMsg.body}
                          </span>
                        </div>
                        {isUnread && (
                          <div style={{ minWidth: '20px', height: '20px', borderRadius: '10px', background: '#A855F7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: '0 5px' }}>
                            <span style={{ color: '#fff', fontSize: '11px', fontWeight: 700 }}>{unreadCount > 99 ? '99+' : unreadCount}</span>
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
    </div>
  );
}

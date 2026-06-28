import { useState, useEffect } from 'react';
import { ArrowLeft, Search, Loader } from 'lucide-react';
import { insforge } from '../../lib/insforge';
import BadgeChip from './BadgeChip';
import { UserProfile } from './types';

interface FollowingListScreenProps {
  following: string[];
  onToggleFollow: (id: string) => void;
  onBack: () => void;
  currentUserId?: string;
  onUserPress?: (user: UserProfile) => void;
  initialFilter?: 'following' | 'followers' | 'attendees' | 'all';
}

interface SimpleUser {
  id: string;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
  vc_badge?: string | null;
}

export function FollowingListScreen({
  following,
  onToggleFollow,
  onBack,
  currentUserId,
  onUserPress,
  initialFilter,
}: FollowingListScreenProps) {
  const [query, setQuery] = useState('');
  // 'following' = Subscribed (people I follow), 'followers' = Subscribers (people who follow me)
  const [activeFilter, setActiveFilter] = useState<'following' | 'followers'>(
    initialFilter === 'followers' ? 'followers' : 'following'
  );
  const [subscribedUsers, setSubscribedUsers] = useState<SimpleUser[]>([]);
  const [subscriberUsers, setSubscriberUsers] = useState<SimpleUser[]>([]);
  const [loadingSubscribed, setLoadingSubscribed] = useState(false);
  const [loadingSubscribers, setLoadingSubscribers] = useState(false);

  // Fetch people current user subscribes to (following)
  useEffect(() => {
    if (!currentUserId) return;
    async function loadSubscribed() {
      setLoadingSubscribed(true);
      try {
        const { data: followRows } = await insforge.database
          .from('follows')
          .select('following_id')
          .eq('follower_id', currentUserId);

        if (!followRows || followRows.length === 0) {
          setSubscribedUsers([]);
          return;
        }
        const ids = followRows.map((r: any) => r.following_id);
        const { data: users } = await insforge.database
          .from('public_profiles')
          .select('id, username, full_name, avatar_url, vc_badge')
          .in('id', ids);
        setSubscribedUsers(users || []);
      } catch (err) {
        console.error('Failed to load subscribed users:', err);
      } finally {
        setLoadingSubscribed(false);
      }
    }
    loadSubscribed();
  }, [currentUserId, following]);

  // Fetch people who subscribe to current user (followers)
  useEffect(() => {
    if (!currentUserId) return;
    async function loadSubscribers() {
      setLoadingSubscribers(true);
      try {
        const { data: followRows } = await insforge.database
          .from('follows')
          .select('follower_id')
          .eq('following_id', currentUserId);

        if (!followRows || followRows.length === 0) {
          setSubscriberUsers([]);
          return;
        }
        const ids = followRows.map((r: any) => r.follower_id);
        const { data: users } = await insforge.database
          .from('public_profiles')
          .select('id, username, full_name, avatar_url, vc_badge')
          .in('id', ids);
        setSubscriberUsers(users || []);
      } catch (err) {
        console.error('Failed to load subscriber users:', err);
      } finally {
        setLoadingSubscribers(false);
      }
    }
    loadSubscribers();
  }, [currentUserId]);

  const handleUnsubscribe = async (userId: string) => {
    // Optimistic remove from subscribed list
    setSubscribedUsers(prev => prev.filter(u => u.id !== userId));
    onToggleFollow(userId);
  };

  const displayUsers = activeFilter === 'following' ? subscribedUsers : subscriberUsers;
  const isLoading = activeFilter === 'following' ? loadingSubscribed : loadingSubscribers;

  const filtered = query.trim()
    ? displayUsers.filter(u =>
        (u.full_name || '').toLowerCase().includes(query.toLowerCase()) ||
        (u.username || '').toLowerCase().includes(query.toLowerCase())
      )
    : displayUsers;

  const titleText = activeFilter === 'following' ? 'Subscribed' : 'Subscribers';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: '#060A12',
      }}>
        <button
          onClick={onBack}
          style={{
            background: '#131629', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%', width: '36px', height: '36px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            {titleText}
          </h1>
          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
            {activeFilter === 'following' ? 'People you subscribe to' : 'People who subscribe to you'}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '16px 20px 10px', display: 'flex', gap: '10px' }}>
        {([
          { id: 'following' as const, label: `Subscribed (${subscribedUsers.length})` },
          { id: 'followers' as const, label: `Subscribers (${subscriberUsers.length})` },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveFilter(tab.id)}
            style={{
              padding: '6px 16px', borderRadius: '20px', border: 'none',
              background: activeFilter === tab.id ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : '#131629',
              color: activeFilter === tab.id ? '#fff' : '#8B8FA8',
              fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
              boxShadow: activeFilter === tab.id ? '0 4px 12px rgba(123,47,190,0.3)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Search */}
      <div style={{ padding: '6px 20px 10px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', background: '#131629',
          borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)',
          padding: '10px 14px', gap: '10px',
        }}>
          <Search size={16} color="#8B8FA8" />
          <input
            type="text"
            placeholder="Search by name or username..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '13px' }}
          />
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 20px 40px', scrollbarWidth: 'none' }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '150px', color: '#8B8FA8' }}>
            <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
            <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8B8FA8' }}>
            <p style={{ fontSize: '14px', fontWeight: 600, margin: 0 }}>
              {activeFilter === 'following' ? "You haven't subscribed to anyone yet" : 'No subscribers yet'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filtered.map((user) => {
              const isAlreadyFollowing = following.includes(user.id);
              const displayName = user.full_name || user.username || 'Vents User';
              const initials = displayName.trim().split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
              return (
                <div
                  key={user.id}
                  onClick={() => onUserPress?.({ id: user.id, name: displayName, username: user.username || '', bio: '', city: '', avatarColor: '#7B2FF7', avatarInitials: initials, avatar_url: user.avatar_url || undefined, eventsCreated: 0, followers: 0, following: 0, attendees: 0, role: 'user' })}
                  style={{
                    display: 'flex', alignItems: 'center', background: '#131629',
                    border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px',
                    padding: '12px 14px', gap: '12px', cursor: 'pointer',
                  }}
                >
                  {/* Avatar */}
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '14px', overflow: 'hidden',
                    background: user.avatar_url ? 'none' : '#7B2FF7',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    {user.avatar_url
                      ? <img src={user.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ color: '#fff', fontSize: '15px', fontWeight: 800 }}>{initials}</span>
                    }
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, margin: 0 }}>
                        {displayName}
                      </p>
                      {user.vc_badge && <BadgeChip tier={user.vc_badge} />}
                    </div>
                    <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                      @{user.username || user.id?.slice(0, 8)}
                    </p>
                  </div>

                  {/* Action button */}
                  {activeFilter === 'following' ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleUnsubscribe(user.id); }}
                      style={{
                        padding: '6px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.12)',
                        background: 'transparent', color: '#C4C9E0', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >Unsubscribe</button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); onToggleFollow(user.id); }}
                      style={{
                        padding: '6px 14px', borderRadius: '10px', border: 'none',
                        background: isAlreadyFollowing ? 'rgba(167,139,250,0.12)' : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                        color: isAlreadyFollowing ? '#A78BFA' : '#fff',
                        fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                      }}
                    >{isAlreadyFollowing ? 'Subscribed' : 'Subscribe'}</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

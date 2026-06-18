import { useState, useEffect } from 'react';
import { ArrowLeft, Search, Check, MapPin, Loader } from 'lucide-react';
import { insforge } from '../../lib/insforge';
import { UserProfile } from './types';

interface FollowingListScreenProps {
  following: string[];
  onToggleFollow: (id: string) => void;
  onBack: () => void;
  currentUserId?: string;
  onUserPress?: (user: UserProfile) => void;
  initialFilter?: 'following' | 'followers' | 'attendees' | 'all';
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
  const [activeFilter, setActiveFilter] = useState<'following' | 'followers' | 'attendees' | 'all'>(initialFilter || 'following');
  const [dbUsers, setDbUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [followerIds, setFollowerIds] = useState<string[]>([]);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);

  useEffect(() => {
    async function loadUsers() {
      setLoadingUsers(true);
      try {
        const { data: usersData, error: usersError } = await insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, is_verified, state')
          .limit(100);
        if (usersError) throw usersError;

        if (usersData) {
          // Fetch follow counts and ticket counts centrally to avoid duplicate calls (N+1 queries)
          const { data: followsData } = await insforge.database
            .from('follows')
            .select('*');

          const { data: ticketsData } = await insforge.database
            .from('tickets')
            .select('user_id')
            .eq('status', 'active');

          const followerCountMap: Record<string, number> = {};
          const followingCountMap: Record<string, number> = {};
          const currentFollowers: string[] = [];
          if (followsData) {
            followsData.forEach((f: any) => {
              if (f.following_id === currentUserId) {
                currentFollowers.push(f.follower_id);
              }
              if (f.follower_id !== currentUserId) {
                followerCountMap[f.following_id] = (followerCountMap[f.following_id] || 0) + 1;
              }
              followingCountMap[f.follower_id] = (followingCountMap[f.follower_id] || 0) + 1;
            });
          }
          setFollowerIds(currentFollowers);

          // Fetch attendee IDs (users who booked current user's events)
          let currentAttendeeIds: string[] = [];
          if (currentUserId) {
            const { data: myEvents } = await insforge.database
              .from('events')
              .select('id')
              .eq('organizer_id', currentUserId);

            if (myEvents && myEvents.length > 0) {
              const eventIds = myEvents.map((e: any) => e.id);
              const { data: attendeeTickets } = await insforge.database
                .from('tickets')
                .select('user_id')
                .in('event_id', eventIds);
              if (attendeeTickets) {
                currentAttendeeIds = Array.from(new Set(attendeeTickets.map((t: any) => t.user_id)));
              }
            }
          }
          setAttendeeIds(currentAttendeeIds);

          const ticketsCountMap: Record<string, number> = {};
          if (ticketsData) {
            ticketsData.forEach((t: any) => {
              ticketsCountMap[t.user_id] = (ticketsCountMap[t.user_id] || 0) + 1;
            });
          }

          const mapped: UserProfile[] = usersData.map((u: any) => {
            const colors = ['#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444'];
            const charCodeSum = (u.id || '').split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
            const avatarColor = colors[charCodeSum % colors.length];
            const initials = (u.full_name || u.email || 'U').trim().split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
            
            return {
              id: u.id,
              name: u.full_name || u.username || 'Vents User',
              username: u.username || u.id?.slice(0, 8) || 'user',
              bio: u.bio || 'Hello! I am a VENTS member.',
              city: u.state || 'Lagos',
              avatarColor,
              avatarInitials: initials,
              avatar_url: u.avatar_url,
              eventsCreated: 0, // stub or calculated if needed
              followers: followerCountMap[u.id] || 0,
              following: followingCountMap[u.id] || 0,
              attendees: ticketsCountMap[u.id] || 0,
              role: u.role || 'user'
            };
          });

          setDbUsers(mapped);
        }
      } catch (err) {
        console.error("Failed to load users:", err);
      } finally {
        setLoadingUsers(false);
      }
    }
    loadUsers();
  }, [currentUserId, following]);

  const filteredUsers = dbUsers.filter((u) => {
    // Exclude current user
    if (u.id === currentUserId) return false;

    // Filter by tab
    if (activeFilter === 'following' && !following.includes(u.id)) {
      return false;
    }
    if (activeFilter === 'followers' && !followerIds.includes(u.id)) {
      return false;
    }
    if (activeFilter === 'attendees' && !attendeeIds.includes(u.id)) {
      return false;
    }

    // Search query matches name or username
    if (query.trim()) {
      const q = query.toLowerCase().trim();
      return u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
    }

    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#060A12' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          background: '#060A12',
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            {activeFilter === 'following' ? 'Following' : activeFilter === 'followers' ? 'Followers' : activeFilter === 'attendees' ? 'Attendees' : 'Discover'}
          </h1>
          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
            {activeFilter === 'following' ? 'Manage who you follow in Vents' : activeFilter === 'followers' ? 'Users who follow you' : activeFilter === 'attendees' ? 'Attendees of your events' : 'Discover new creators'}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '16px 20px 10px', display: 'flex', gap: '10px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {([
          { id: 'following', label: `Following (${following.length})` },
          { id: 'followers', label: `Followers (${followerIds.length})` },
          { id: 'attendees', label: `Attendees (${attendeeIds.length})` },
          { id: 'all', label: 'Discover' }
        ] as const).map((filter) => (
          <button
            key={filter.id}
            onClick={() => setActiveFilter(filter.id)}
            style={{
              padding: '6px 16px',
              borderRadius: '20px',
              border: 'none',
              background: activeFilter === filter.id ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : '#131629',
              color: activeFilter === filter.id ? '#fff' : '#8B8FA8',
              fontSize: '13px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              boxShadow: activeFilter === filter.id ? '0 4px 12px rgba(123,47,190,0.3)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Search Input */}
      <div style={{ padding: '10px 20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: '#131629',
            borderRadius: '14px',
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '10px 14px',
            gap: '10px',
          }}
        >
          <Search size={16} color="#8B8FA8" />
          <input
            type="text"
            placeholder="Search by name or username..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#F0F0FF',
              fontSize: '13px',
            }}
          />
        </div>
      </div>

      {/* List content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 40px', scrollbarWidth: 'none' }}>
        {loadingUsers ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '150px', color: '#8B8FA8' }}>
            <Loader size={20} className="animate-spin" />
            <span style={{ marginLeft: '10px', fontSize: '13px' }}>Loading people...</span>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#8B8FA8' }}>
            <p style={{ fontSize: '14px', fontWeight: 600, margin: 0 }}>No users found</p>
            <p style={{ fontSize: '12px', margin: '4px 0 0', opacity: 0.7 }}>
              {activeFilter === 'following' ? "You aren't following anyone yet." : activeFilter === 'followers' ? "You don't have any followers yet." : activeFilter === 'attendees' ? "No attendees registered for your events yet." : "No matching creators found."}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {filteredUsers.map((user) => {
              const isFollowing = following.includes(user.id);
              return (
                <div
                  key={user.id}
                  onClick={() => onUserPress?.(user)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    background: '#131629',
                    border: '1px solid rgba(255,255,255,0.05)',
                    borderRadius: '16px',
                    padding: '12px 14px',
                    gap: '12px',
                    cursor: onUserPress ? 'pointer' : 'default',
                  }}
                >
                  <div
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '14px',
                      overflow: 'hidden',
                      background: user.avatar_url ? 'none' : user.avatarColor,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {user.avatar_url ? (
                      <img src={user.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span style={{ color: '#fff', fontSize: '15px', fontWeight: 800 }}>
                        {user.avatarInitials}
                      </span>
                    )}
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, margin: 0 }}>
                        {user.name}
                      </p>
                      {user.role === 'organizer' && (
                        <Check size={12} color="#10B981" />
                      )}
                    </div>
                    <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                      @{user.username}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                      <MapPin size={10} color="#8B8FA8" />
                      <span style={{ color: '#8B8FA8', fontSize: '10px' }}>{user.city}</span>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFollow(user.id);
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: '10px',
                      border: 'none',
                      background: isFollowing ? 'rgba(255,255,255,0.04)' : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                      color: isFollowing ? '#C4C9E0' : '#fff',
                      fontSize: '11px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      boxShadow: isFollowing ? 'none' : '0 4px 10px rgba(123,47,190,0.25)',
                    }}
                  >
                    {isFollowing ? 'Following' : 'Follow'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

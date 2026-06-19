import { useState, useEffect } from 'react';
import { Search, X, MapPin, User, MessageCircle, CheckCircle } from 'lucide-react';
import { UserProfile } from './types';
import { insforge } from '../../lib/insforge';

interface ExploreScreenProps {
  onUserPress: (user: UserProfile) => void;
}

export function mapDbUserToUserProfile(dbUser: any): UserProfile {
  const name = dbUser.full_name || (dbUser.email ? dbUser.email.split('@')[0] : null) || dbUser.username || 'Vents User';
  const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2) || 'U';
  const colors = ['#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444'];
  const charSum = (dbUser.username || dbUser.id || '').split('').reduce((sum: number, char: string) => sum + char.charCodeAt(0), 0);
  const avatarColor = colors[charSum % colors.length];

  return {
    id: dbUser.id,
    name: name,
    username: dbUser.username || (dbUser.email ? dbUser.email.split('@')[0] : null) || dbUser.id?.slice(0, 8) || 'user',
    avatarColor: avatarColor,
    avatarInitials: initials,
    city: dbUser.state || 'Lagos',
    bio: dbUser.bio || 'Hello, I am using Vents!',
    eventsAttended: 0,
    followers: 0,
    following: 0,
    interests: dbUser.state ? [dbUser.state] : [],
    avatar_url: dbUser.avatar_url,
    cover_url: dbUser.cover_url,
    isOrganizer: dbUser.role === 'organizer',
    isVerified: dbUser.is_verified === true,
  };
}

export function ExploreScreen({
  onUserPress,
}: ExploreScreenProps) {
  const [exploreTab, setExploreTab] = useState<'people' | 'inbox'>('people');

  // User Search state
  const [userQuery, setUserQuery] = useState('');
  const [searchedUsers, setSearchedUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  useEffect(() => {
    if (exploreTab !== 'people') return;

    const searchUsers = async () => {
      setLoadingUsers(true);
      try {
        let queryBuilder = insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role');

        if (userQuery.trim()) {
          const q = `%${userQuery.trim().toLowerCase()}%`;
          queryBuilder = queryBuilder.or(`full_name.ilike.${q},username.ilike.${q}`);
        } else {
          queryBuilder = queryBuilder.limit(15);
        }

        const { data, error } = await queryBuilder;
        if (error) throw error;
        if (data) {
          setSearchedUsers(data.map(mapDbUserToUserProfile));
        }
      } catch (err) {
        console.error("Failed to search users:", err);
      } finally {
        setLoadingUsers(false);
      }
    };

    const debounceHandler = setTimeout(() => {
      searchUsers();
    }, 300);

    return () => clearTimeout(debounceHandler);
  }, [userQuery, exploreTab]);

  return (
    <div className="flex flex-col h-full" style={{ background: '#060A12' }}>
      {/* Header */}
      <div className="px-4 pb-3" style={{ paddingTop: 'calc(20px + env(safe-area-inset-top))', flexShrink: 0 }}>
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          Explore
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Discover events and creators in Nigeria</p>
      </div>

      {/* Segment Selector */}
      <div style={{ padding: '0 16px 12px', display: 'flex', gap: '8px', flexShrink: 0 }}>
        {(['people', 'inbox'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setExploreTab(tab)}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: '12px',
              border: 'none',
              background: exploreTab === tab ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : '#131629',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 700,
              fontFamily: 'Space Grotesk, sans-serif',
              cursor: 'pointer',
              boxShadow: exploreTab === tab ? '0 4px 12px rgba(123,47,190,0.2)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            {tab === 'people' ? '👥 People' : '💬 Inbox'}
          </button>
        ))}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(96px + env(safe-area-inset-bottom))' }}>
        {exploreTab === 'people' ? (
          /* ── People Tab: search attendees & organizers ── */
          <div>
            {/* User Search Bar */}
            <div className="px-4 mb-4">
              <div
                className="flex items-center gap-3 px-4"
                style={{
                  height: '48px',
                  background: '#131629',
                  borderRadius: '14px',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <Search size={18} color="#8B8FA8" />
                <input
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                  placeholder="Search users by name or @username..."
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: '#F0F0FF',
                    fontSize: '14px',
                  }}
                />
                {userQuery && (
                  <button onClick={() => setUserQuery('')}>
                    <X size={16} color="#8B8FA8" />
                  </button>
                )}
              </div>
            </div>

            {/* User Results List */}
            {loadingUsers ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '40px', color: '#8B8FA8', fontSize: '14px' }}>
                Searching users...
              </div>
            ) : searchedUsers.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px', gap: '8px' }}>
                <User size={36} color="#2A2D3E" />
                <p style={{ color: '#8B8FA8', fontSize: '14px' }}>No users found</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 16px' }}>
                {searchedUsers.map((user) => (
                  <div
                    key={user.id}
                    onClick={() => onUserPress(user)}
                    style={{
                      background: '#131629',
                      border: '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '16px',
                      padding: '12px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '12px',
                        background: user.avatar_url ? 'none' : user.avatarColor,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}
                    >
                      {user.avatar_url ? (
                        <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
                          {user.avatarInitials}
                        </span>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }} className="truncate">
                          {user.name}
                        </span>
                        {user.isVerified && (
                          <CheckCircle size={13} fill="#4F46E5" color="#fff" />
                        )}
                        {user.isOrganizer && (
                          <span style={{ background: 'rgba(167,139,250,0.15)', color: '#A78BFA', fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', textTransform: 'uppercase' }}>
                            CREATOR
                          </span>
                        )}
                      </div>
                      <span style={{ color: '#8B8FA8', fontSize: '11px', display: 'block' }} className="truncate">
                        @{user.username}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255,255,255,0.03)', padding: '5px 10px', borderRadius: '10px' }}>
                      <MapPin size={10} color="#8B8FA8" />
                      <span style={{ color: '#8B8FA8', fontSize: '10px', fontWeight: 500 }}>
                        {user.city}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* ── Inbox Tab: coming-soon state ── */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 32px', gap: '16px', textAlign: 'center' }}>
            <div style={{ width: '72px', height: '72px', borderRadius: '24px', background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MessageCircle size={32} color="#A855F7" />
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
              Messaging is coming soon
            </p>
            <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, margin: 0 }}>
              Direct messaging between attendees and creators is on the way. Stay tuned.
            </p>
          </div>
        )}
      </div>

    </div>
  );
}

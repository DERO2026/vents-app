import { useState, useEffect } from 'react';
import { Search, X, MapPin, Calendar, UserPlus, UserCheck, Users } from 'lucide-react';
import { Event, UserProfile } from './types';
import { CATEGORIES, formatPrice } from './data';
import { insforge } from '../../lib/insforge';

interface ExploreScreenProps {
  onEventPress: (event: Event) => void;
  savedEvents: string[];
  onToggleSave: (id: string) => void;
  following: string[];
  onToggleFollow: (userId: string) => void;
  onUserPress?: (user: UserProfile) => void;
}

const CITIES = [
  'All Cities',
  'Lagos',
  'Abuja',
  'Port Harcourt',
  'Kano',
  'Ibadan',
  'Enugu',
  'Benin City',
  'Kaduna',
  'Owerri',
  'Calabar',
  'Warri',
  'Uyo',
  'Abeokuta',
  'Jos',
  'Ilorin',
];

function UserCard({
  user,
  isFollowing,
  onToggleFollow,
  onPress,
}: {
  user: UserProfile;
  isFollowing: boolean;
  onToggleFollow: () => void;
  onPress?: () => void;
}) {
  return (
    <div
      onClick={onPress}
      style={{
        background: '#131629',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.05)',
        overflow: 'hidden',
        cursor: onPress ? 'pointer' : 'default',
      }}
    >
      {/* Cover gradient */}
      <div
        style={{
          height: '52px',
          background: `linear-gradient(135deg, ${user.avatarColor}30 0%, rgba(79,70,229,0.2) 100%)`,
        }}
      />

      <div className="px-4 pb-4">
        {/* Avatar */}
        <div className="flex items-end justify-between" style={{ marginTop: '-24px', marginBottom: '8px' }}>
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{
              background: user.avatarColor,
              border: '3px solid #131629',
              boxShadow: `0 4px 16px ${user.avatarColor}50`,
            }}
          >
            <span style={{ color: '#fff', fontSize: '18px', fontWeight: 700 }}>{user.avatarInitials}</span>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFollow(); }}
            className="flex items-center gap-1.5 px-3 py-1.5"
            style={{
              background: isFollowing
                ? 'rgba(167,139,250,0.1)'
                : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
              borderRadius: '20px',
              border: isFollowing ? '1px solid rgba(167,139,250,0.3)' : 'none',
              transition: 'all 0.2s',
              boxShadow: isFollowing ? 'none' : '0 4px 12px rgba(123,47,190,0.35)',
            }}
          >
            {isFollowing ? (
              <UserCheck size={14} color="#A78BFA" />
            ) : (
              <UserPlus size={14} color="#fff" />
            )}
            <span
              style={{
                fontSize: '12px',
                fontWeight: 700,
                color: isFollowing ? '#A78BFA' : '#fff',
              }}
            >
              {isFollowing ? 'Following' : 'Follow'}
            </span>
          </button>
        </div>

        {/* Info */}
        <div className="mb-2">
          <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{user.name}</h3>
          <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 500 }}>@{user.username}</span>
        </div>

        <p style={{ color: '#A8AEC8', fontSize: '12px', lineHeight: 1.5, marginBottom: '12px' }}>
          {user.bio}
        </p>

        {/* City */}
        <div className="flex items-center gap-1 mb-3">
          <MapPin size={11} color="#8B8FA8" />
          <span style={{ color: '#8B8FA8', fontSize: '12px' }}>{user.city}, Nigeria</span>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 pb-1">
          <div className="text-center">
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{user.followers.toLocaleString()}</p>
            <p style={{ color: '#8B8FA8', fontSize: '10px' }}>Followers</p>
          </div>
          <div style={{ width: '1px', height: '28px', background: 'rgba(255,255,255,0.08)' }} />
          <div className="text-center">
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{user.following.toLocaleString()}</p>
            <p style={{ color: '#8B8FA8', fontSize: '10px' }}>Following</p>
          </div>
          <div style={{ width: '1px', height: '28px', background: 'rgba(255,255,255,0.08)' }} />
          <div className="text-center">
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{user.eventsAttended}</p>
            <p style={{ color: '#8B8FA8', fontSize: '10px' }}>Events</p>
          </div>
        </div>

        {/* Interests */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {user.interests.map((interest) => (
            <span
              key={interest}
              style={{
                fontSize: '10px',
                color: '#A78BFA',
                background: 'rgba(167,139,250,0.1)',
                padding: '2px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(167,139,250,0.15)',
                fontWeight: 500,
              }}
            >
              {interest}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function PeopleTab({
  following,
  onToggleFollow,
  onUserPress,
}: {
  following: string[];
  onToggleFollow: (id: string) => void;
  onUserPress?: (user: UserProfile) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'following'>('all');
  const [dbUsers, setDbUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  useEffect(() => {
    async function loadUsers() {
      try {
        const { data, error } = await insforge.database
          .from('users')
          .select('*')
          .limit(100);
        if (error) throw error;
        if (data) {
          const mapped: UserProfile[] = data.map((u: any) => {
            const colors = ['#EC4899', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444'];
            const charCodeSum = (u.id || '').split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
            const avatarColor = colors[charCodeSum % colors.length];
            const initials = (u.full_name || u.email || 'U').trim().split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
            
            return {
              id: u.id,
              name: u.full_name || u.email.split('@')[0],
              username: u.username || u.email.split('@')[0],
              bio: u.bio || 'Hello! I am a VENTS member.',
              city: u.state || 'Lagos',
              avatarColor,
              avatarInitials: initials,
              followers: 0,
              following: 0,
              eventsAttended: 0,
              interests: ['Music', 'Comedy Shows']
            };
          });
          setDbUsers(mapped);
        }
      } catch (err) {
        console.error("Failed to load users for Explore screen:", err);
      } finally {
        setLoadingUsers(false);
      }
    }
    loadUsers();
  }, []);

  const filtered = dbUsers.filter((u) => {
    const matchQuery =
      !query ||
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.username.toLowerCase().includes(query.toLowerCase()) ||
      u.city.toLowerCase().includes(query.toLowerCase()) ||
      u.interests.some((i) => i.toLowerCase().includes(query.toLowerCase()));
    const matchFilter = activeFilter === 'all' || following.includes(u.id);
    return matchQuery && matchFilter;
  });

  return (
    <div>
      {/* Search */}
      <div className="px-4 mb-3">
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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, city, interest..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#F0F0FF',
              fontSize: '14px',
            }}
          />
          {query && (
            <button onClick={() => setQuery('')}>
              <X size={16} color="#8B8FA8" />
            </button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 px-4 mb-4">
        {(['all', 'following'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className="flex items-center gap-1.5 px-4 py-2"
            style={{
              background: activeFilter === f ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : '#131629',
              borderRadius: '20px',
              border: activeFilter === f ? 'none' : '1px solid rgba(255,255,255,0.08)',
              boxShadow: activeFilter === f ? '0 4px 12px rgba(123,47,190,0.3)' : 'none',
              transition: 'all 0.2s',
            }}
          >
            <span style={{ color: activeFilter === f ? '#fff' : '#8B8FA8', fontSize: '13px', fontWeight: 600 }}>
              {f === 'all' ? 'All People' : `Following (${following.length})`}
            </span>
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="flex items-center justify-between px-4 mb-3">
        <span style={{ color: '#8B8FA8', fontSize: '13px' }}>
          {filtered.length} {filtered.length === 1 ? 'person' : 'people'} found
        </span>
      </div>

      {loadingUsers ? (
        <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px' }}>Loading people...</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-12 px-4">
          <Users size={48} color="#2A2D3E" strokeWidth={1.5} />
          <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '12px' }}>
            {activeFilter === 'following' ? 'Not following anyone yet' : 'No people found'}
          </p>
          <p style={{ color: '#6B7280', fontSize: '13px', textAlign: 'center', marginTop: '4px' }}>
            {activeFilter === 'following' ? 'Find and follow event-goers below' : 'Try a different search'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4">
          {filtered.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              isFollowing={following.includes(user.id)}
              onToggleFollow={() => onToggleFollow(user.id)}
              onPress={onUserPress ? () => onUserPress(user) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventsTab({
  dbEvents,
  onEventPress,
  savedEvents,
  onToggleSave,
}: {
  dbEvents: Event[];
  onEventPress: (e: Event) => void;
  savedEvents: string[];
  onToggleSave: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [activeCity, setActiveCity] = useState('All Cities');

  const filtered = dbEvents.filter((e) => {
    const matchQuery =
      !query ||
      e.title.toLowerCase().includes(query.toLowerCase()) ||
      e.category.toLowerCase().includes(query.toLowerCase()) ||
      e.city.toLowerCase().includes(query.toLowerCase()) ||
      e.venue.toLowerCase().includes(query.toLowerCase());
    const matchCategory =
      activeCategory === 'all' ||
      e.category.toLowerCase().includes(activeCategory) ||
      (CATEGORIES.find((c) => c.id === activeCategory)?.label || '')
        .toLowerCase()
        .includes(e.category.toLowerCase());
    const matchCity = activeCity === 'All Cities' || e.city === activeCity;
    return matchQuery && matchCategory && matchCity;
  });

  return (
    <div>
      {/* Search */}
      <div className="px-4 mb-3">
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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search events, venues, cities..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#F0F0FF',
              fontSize: '14px',
            }}
          />
          {query && (
            <button onClick={() => setQuery('')}>
              <X size={16} color="#8B8FA8" />
            </button>
          )}
        </div>
      </div>

      {/* Cities */}
      <div className="flex gap-2 px-4 mb-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {CITIES.map((city) => {
          const isActive = activeCity === city;
          return (
            <button
              key={city}
              onClick={() => setActiveCity(city)}
              className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5"
              style={{
                background: isActive ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : '#131629',
                borderRadius: '20px',
                border: isActive ? 'none' : '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {city !== 'All Cities' && <MapPin size={11} color={isActive ? '#fff' : '#8B8FA8'} />}
              <span style={{ fontSize: '12px', color: isActive ? '#fff' : '#8B8FA8', fontWeight: 500 }}>
                {city}
              </span>
            </button>
          );
        })}
      </div>

      {/* Categories */}
      <div className="flex gap-2 px-4 mb-3 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {CATEGORIES.map((cat) => {
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5"
              style={{
                background: isActive ? 'rgba(167,139,250,0.15)' : '#131629',
                borderRadius: '20px',
                border: isActive ? '1px solid rgba(167,139,250,0.5)' : '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <span style={{ fontSize: '14px' }}>{cat.icon}</span>
              <span style={{ fontSize: '12px', color: isActive ? '#A78BFA' : '#8B8FA8', fontWeight: 500 }}>
                {cat.label.split(' ')[0]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="px-4 mb-3">
        <span style={{ color: '#8B8FA8', fontSize: '13px' }}>
          {filtered.length} event{filtered.length !== 1 ? 's' : ''} found
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center py-12 px-4">
          <Search size={48} color="#2A2D3E" strokeWidth={1.5} />
          <p style={{ color: '#8B8FA8', fontSize: '16px', fontWeight: 600, marginTop: '12px' }}>No events found</p>
          <p style={{ color: '#6B7280', fontSize: '13px' }}>Try a different search or category</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4">
          {filtered.map((event) => {
            const isSaved = savedEvents.includes(event.id);
            return (
              <div
                key={event.id}
                onClick={() => onEventPress(event)}
                className="overflow-hidden cursor-pointer active:opacity-90"
                style={{ background: '#131629', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}
              >
                <div className="relative" style={{ height: '150px' }}>
                  <img src={event.image} alt={event.title} className="w-full h-full object-cover" />
                  <div
                    className="absolute inset-0"
                    style={{ background: 'linear-gradient(to bottom, transparent 40%, rgba(19,22,41,0.9) 100%)' }}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleSave(event.id); }}
                    className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill={isSaved ? '#A78BFA' : 'none'} stroke={isSaved ? '#A78BFA' : '#fff'} strokeWidth="2">
                      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                  <div className="absolute bottom-2 left-3">
                    <span style={{ fontSize: '10px', color: '#fff', background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', padding: '3px 8px', borderRadius: '6px', fontWeight: 600 }}>
                      {event.category}
                    </span>
                  </div>
                </div>
                <div className="p-3">
                  <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }} className="mb-1">{event.title}</h3>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <Calendar size={11} color="#8B8FA8" />
                      <span style={{ color: '#8B8FA8', fontSize: '12px' }}>{event.date}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <MapPin size={11} color="#8B8FA8" />
                      <span style={{ color: '#8B8FA8', fontSize: '12px' }}>{event.city}</span>
                    </div>
                    <span style={{ color: '#FFB830', fontSize: '13px', fontWeight: 700, marginLeft: 'auto' }}>
                      {formatPrice(event.price)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExploreScreen({ dbEvents, onEventPress, savedEvents, onToggleSave, following, onToggleFollow, onUserPress }: ExploreScreenProps & { dbEvents: Event[] }) {
  const [activeTab, setActiveTab] = useState<'events' | 'people'>('events');

  return (
    <div className="flex flex-col h-full" style={{ background: '#060A12' }}>
      {/* Header */}
      <div className="px-4 pt-5 pb-3">
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
          Explore
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Discover events and people in Nigeria</p>
      </div>

      {/* Tab switcher */}
      <div className="px-4 mb-4">
        <div
          className="flex p-1"
          style={{ background: '#131629', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {(['events', 'people'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="flex-1 flex items-center justify-center gap-2 py-2.5"
              style={{
                background: activeTab === tab ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : 'transparent',
                borderRadius: '11px',
                transition: 'all 0.25s ease',
                boxShadow: activeTab === tab ? '0 4px 12px rgba(123,47,190,0.35)' : 'none',
              }}
            >
              {tab === 'people' ? (
                <Users size={15} color={activeTab === tab ? '#fff' : '#8B8FA8'} />
              ) : (
                <Calendar size={15} color={activeTab === tab ? '#fff' : '#8B8FA8'} />
              )}
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: activeTab === tab ? '#fff' : '#8B8FA8',
                }}
              >
                {tab === 'events' ? 'Events' : 'People'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable tab content */}
      <div className="flex-1 overflow-y-auto pb-24" style={{ scrollbarWidth: 'none' }}>
        {activeTab === 'events' ? (
          <EventsTab
            dbEvents={dbEvents}
            onEventPress={onEventPress}
            savedEvents={savedEvents}
            onToggleSave={onToggleSave}
          />
        ) : (
          <PeopleTab following={following} onToggleFollow={onToggleFollow} onUserPress={onUserPress} />
        )}
      </div>
    </div>
  );
}

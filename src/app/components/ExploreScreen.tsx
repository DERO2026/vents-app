import { useState, useEffect, useMemo, useRef } from 'react';
import BadgeChip from './BadgeChip';
import { Search, X, CheckCircle, Music, Palette, Briefcase, Landmark, MapPin, Sparkles } from 'lucide-react';
import { UserProfile, Event } from './types';
import { insforge } from '../../lib/insforge';
import { formatPrice } from './data';

interface ExploreScreenProps {
  onUserPress: (user: UserProfile) => void;
  currentUserId?: string;
  following?: string[];
  onToggleFollow?: (userId: string) => void;
  events: Event[];
  onEventPress: (event: Event) => void;
  onMoodSelect: (category: string) => void;
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

// Decorative navigation shortcuts only — each maps to the closest real category
// in Home's existing filter system. Not a database field.
const MOODS: { id: string; label: string; category: string; icon: React.ElementType; gradient: string }[] = [
  { id: 'turn-up',   label: 'Turn Up',     category: 'Nightlife',      icon: Music,    gradient: 'linear-gradient(135deg, #7B2FBE, #4F46E5)' },
  { id: 'chill',     label: 'Chill Vibes', category: 'Arts & Culture', icon: Palette,  gradient: 'linear-gradient(135deg, #4F46E5, #7B2FBE)' },
  { id: 'network',   label: 'Network',     category: 'Conferences',   icon: Briefcase, gradient: 'linear-gradient(135deg, #7B2FBE, #4F46E5)' },
  { id: 'culture',   label: 'Culture',     category: 'Arts & Culture', icon: Landmark, gradient: 'linear-gradient(135deg, #4F46E5, #7B2FBE)' },
];

export function ExploreScreen({
  onUserPress,
  currentUserId,
  following = [],
  onToggleFollow,
  events,
  onEventPress,
  onMoodSelect,
}: ExploreScreenProps) {
  const [activeTab, setActiveTab] = useState<'discover' | 'people'>('discover');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // ── People search (reuses the same search logic previously built for Messages/Explore) ──
  const [searchedUsers, setSearchedUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  useEffect(() => {
    if (activeTab !== 'people') return;
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
  }, [query, activeTab]);

  // ── Discover: event search (client-side, real data already loaded) ──
  const isSearching = query.trim().length > 0;
  const searchedEvents = useMemo(() => {
    if (activeTab !== 'discover' || !isSearching) return [];
    const q = query.trim().toLowerCase();
    return events.filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      e.venue.toLowerCase().includes(q)
    ).slice(0, 20);
  }, [events, query, activeTab, isSearching]);

  // ── Trending venues: group real events by venue, order by count ──
  const trendingVenues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      const venue = (e.venue || '').trim();
      if (!venue) continue;
      counts.set(venue, (counts.get(venue) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([venue, count]) => ({ venue, count }));
  }, [events]);

  // ── Vents Pick: most recent featured event ──
  const ventsPick = useMemo(() => {
    const featured = events.filter(e => e.isFeatured);
    if (featured.length === 0) return null;
    return [...featured].sort((a, b) =>
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    )[0];
  }, [events]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#020005', position: 'relative' }}>
      <style>{`input::placeholder { color: #94A3B8; }`}</style>

      {/* ── Header ── */}
      <div style={{ padding: 'calc(20px + env(safe-area-inset-top)) 16px 12px', flexShrink: 0 }}>
        <h1 style={{ color: '#FFFFFF', fontSize: '24px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', margin: '0 0 12px' }}>
          Explore
        </h1>

        {/* Search bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '100px', height: '48px', padding: '0 14px', boxSizing: 'border-box' }}>
          <Search size={16} color="#94A3B8" />
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search people or events..."
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#FFFFFF', fontSize: '14px', fontFamily: 'Inter, sans-serif' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
              <X size={15} color="#94A3B8" />
            </button>
          )}
        </div>

        {/* Discover / People toggle */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
          {(['discover', 'people'] as const).map(tab => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  flex: 1,
                  background: isActive ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#090514',
                  border: isActive ? 'none' : '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '100px',
                  padding: '10px',
                  color: '#FFFFFF',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {tab === 'discover' ? 'Discover' : 'People'}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '4px 16px calc(80px + env(safe-area-inset-bottom))' }}>

        {activeTab === 'people' ? (
          !currentUserId ? (
            <p style={{ color: '#94A3B8', textAlign: 'center', marginTop: '80px', fontSize: '14px' }}>Sign in to find people.</p>
          ) : !isSearching ? (
            <p style={{ color: '#94A3B8', textAlign: 'center', marginTop: '80px', fontSize: '14px' }}>Search for people to follow.</p>
          ) : loadingUsers ? (
            <p style={{ color: '#94A3B8', fontSize: '13px', marginTop: '20px' }}>Searching…</p>
          ) : searchedUsers.length === 0 ? (
            <p style={{ color: '#94A3B8', fontSize: '13px', marginTop: '20px' }}>No people found</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '8px' }}>
              {searchedUsers.map(u => (
                <div
                  key={u.id}
                  onClick={() => onUserPress(u)}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px', borderRadius: '16px', cursor: 'pointer', background: '#090514' }}
                >
                  <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: u.avatar_url ? 'transparent' : u.avatarColor, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.07)', boxSizing: 'border-box' }}>
                    {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#fff', fontSize: '14px', fontWeight: 700 }}>{u.avatarInitials}</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ color: '#FFFFFF', fontSize: '15px', fontWeight: 600 }}>{u.name}</span>
                      {u.isVerified && <CheckCircle size={12} fill="#4F46E5" color="#fff" />}
                      <BadgeChip tier={u.vc_badge} />
                    </div>
                    <span style={{ color: '#94A3B8', fontSize: '12px' }}>@{u.username}</span>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); onToggleFollow?.(u.id); }}
                    style={{
                      background: following.includes(u.id) ? 'transparent' : 'linear-gradient(135deg,#7B2FBE,#4F46E5)',
                      border: following.includes(u.id) ? '1px solid rgba(255,255,255,0.15)' : 'none',
                      borderRadius: '100px', padding: '5px 12px',
                      color: following.includes(u.id) ? '#94A3B8' : '#FFFFFF',
                      fontSize: '12px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                    }}
                  >{following.includes(u.id) ? 'Subscribed' : 'Subscribe'}</button>
                </div>
              ))}
            </div>
          )
        ) : isSearching ? (
          /* ── Discover: search results ── */
          searchedEvents.length === 0 ? (
            <p style={{ color: '#94A3B8', fontSize: '13px', marginTop: '20px' }}>No events found</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
              {searchedEvents.map(e => (
                <div
                  key={e.id}
                  onClick={() => onEventPress(e)}
                  style={{ display: 'flex', gap: '12px', alignItems: 'center', background: '#090514', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '10px', cursor: 'pointer' }}
                >
                  <img src={e.image} alt="" style={{ width: '56px', height: '56px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 700, margin: '0 0 2px' }} className="truncate">{e.title}</p>
                    <p style={{ color: '#94A3B8', fontSize: '12px', margin: 0 }} className="truncate">{e.category} · {e.venue}</p>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          /* ── Discover: default sections ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', marginTop: '8px' }}>

            {/* Events by mood */}
            <div>
              <p style={{ color: '#94A3B8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '12px' }}>EVENTS BY MOOD</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                {MOODS.map(mood => {
                  const Icon = mood.icon;
                  return (
                    <button
                      key={mood.id}
                      onClick={() => onMoodSelect(mood.category)}
                      style={{
                        background: '#090514',
                        border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: '20px',
                        padding: '18px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: '10px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ width: '38px', height: '38px', borderRadius: '12px', background: mood.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon size={18} color="#FFFFFF" />
                      </div>
                      <span style={{ color: '#FFFFFF', fontSize: '14px', fontWeight: 700 }}>{mood.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Trending venues */}
            <div>
              <p style={{ color: '#94A3B8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '12px' }}>TRENDING VENUES</p>
              {trendingVenues.length === 0 ? (
                <p style={{ color: '#94A3B8', fontSize: '13px' }}>No venue data yet</p>
              ) : (
                <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
                  {trendingVenues.map(v => (
                    <div
                      key={v.venue}
                      style={{
                        background: '#090514',
                        border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: '16px',
                        padding: '16px',
                        minWidth: '150px',
                        flexShrink: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      <div style={{ width: '32px', height: '32px', borderRadius: '10px', background: 'rgba(123,47,190,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <MapPin size={16} color="#7B2FBE" />
                      </div>
                      <span style={{ color: '#FFFFFF', fontSize: '13px', fontWeight: 700 }} className="truncate">{v.venue}</span>
                      <span style={{ color: '#94A3B8', fontSize: '11px' }}>{v.count} event{v.count !== 1 ? 's' : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Vents Picks */}
            <div>
              <p style={{ color: '#94A3B8', fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', marginBottom: '12px' }}>VENTS PICKS</p>
              {!ventsPick ? (
                <p style={{ color: '#94A3B8', fontSize: '13px' }}>No featured events yet</p>
              ) : (
                <div
                  onClick={() => onEventPress(ventsPick)}
                  style={{
                    position: 'relative',
                    borderRadius: '20px',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    height: '160px',
                  }}
                >
                  <img src={ventsPick.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
                  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(2,0,5,0.95), rgba(2,0,5,0.1))' }} />
                  <div style={{ position: 'absolute', top: '12px', left: '12px', display: 'flex', alignItems: 'center', gap: '6px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', borderRadius: '100px', padding: '4px 10px' }}>
                    <Sparkles size={12} color="#FFFFFF" />
                    <span style={{ color: '#FFFFFF', fontSize: '10px', fontWeight: 700 }}>FEATURED</span>
                  </div>
                  <div style={{ position: 'absolute', bottom: '14px', left: '14px', right: '14px' }}>
                    <p style={{ color: '#FFFFFF', fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }} className="truncate">{ventsPick.title}</p>
                    <p style={{ color: '#E5E7EB', fontSize: '12px', margin: 0 }}>{ventsPick.venue} · {formatPrice(ventsPick.price)}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { HighlightsStrip, HighlightsModal } from './HighlightsModal';
import {
  Settings,
  Bell,
  Heart,
  Ticket,
  ChevronRight,
  Star,
  LogOut,
  Shield,
  HelpCircle,
  MapPin,
  Users,
  BadgeCheck,
  Gift,
  Camera,
  Receipt,
  Wallet,
} from 'lucide-react';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import { insforge } from '../../lib/insforge';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface ProfileScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string; avatar_url?: string; cover_url?: string; hasBeenOrganizer?: boolean; vc_badge?: string } | null;
  onSignOut: () => void;
  tickets: PurchasedTicket[];
  savedCount: number;
  followingCount: number;
  onViewTicket: (ticket: PurchasedTicket) => void;
  onNavigate: (screen: string) => void;
  onNavigateToFollowingFilter?: (filter: 'following' | 'followers' | 'attendees' | 'all') => void;
  setActiveView: (view: 'attendee' | 'organizer') => void;
  onBecomeOrganizer?: () => void;
  userRole?: 'attendee' | 'organizer';
  unreadNotificationsCount?: number;
}

export function ProfileScreen({
  currentUser,
  onSignOut,
  tickets,
  savedCount,
  followingCount,
  onViewTicket,
  onNavigate,
  onNavigateToFollowingFilter,
  setActiveView,
  onBecomeOrganizer,
  userRole,
  unreadNotificationsCount = 0,
}: ProfileScreenProps) {
  const [eventsCreated, setEventsCreated] = useState(0);
  const [followers, setFollowers] = useState(0);
  const [attendees, setAttendees] = useState(0);
  const [highlightData, setHighlightData] = useState<{ groups: any[]; startGroupIndex: number } | null>(null);
  const [highlightRefresh, setHighlightRefresh] = useState(0);

  useEffect(() => {
    async function fetchStats() {
      if (!currentUser?.id) return;
      try {
        // 1. Events created count
        const { count: eCount } = await insforge.database
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('organizer_id', currentUser.id);
        setEventsCreated(eCount || 0);

        // 2. Followers count (follows where following_id = currentUser.id)
        const { count: fCount } = await insforge.database
          .from('follows')
          .select('following_id', { count: 'exact', head: true })
          .eq('following_id', currentUser.id);
        setFollowers(fCount || 0);

        // 3. Attendees count (sum of active tickets sold for their created events)
        const { data: userEvents } = await insforge.database
          .from('events')
          .select('id')
          .eq('organizer_id', currentUser.id);

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
      } catch (err) {
        console.error("Failed to fetch profile stats:", err);
      }
    }
    fetchStats();
  }, [currentUser?.id]);
  if (!currentUser) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading profile...
      </div>
    );
  }

  const menuItems = [
    {
      icon: Bell,
      label: 'Notifications',
      sublabel: 'Manage alerts',
      color: '#F59E0B',
      screen: 'notifications',
      badge: unreadNotificationsCount > 0 ? unreadNotificationsCount : undefined,
    },
    {
      icon: Heart,
      label: 'Saved Events',
      sublabel: `${savedCount} saved`,
      color: '#EC4899',
      screen: 'saved',
    },
    { icon: Receipt, label: 'Transactions', sublabel: 'Last 90 days', color: '#06B6D4', screen: 'transactions' },
    {
      icon: Gift,
      label: 'Vents Cents',
      sublabel: 'Earn Vents Cents',
      color: '#FFB830',
      screen: 'referral',
    },
    {
      icon: Settings,
      label: 'Settings',
      sublabel: 'Account & preferences',
      color: '#22C55E',
      screen: 'settings',
    },
    {
      icon: Shield,
      label: 'Privacy & Security',
      sublabel: 'Privacy policy & data rights',
      color: '#3B82F6',
      screen: 'privacy-policy',
    },
    {
      icon: HelpCircle,
      label: 'Help & Support',
      sublabel: 'FAQs and contact',
      color: '#8B8FA8',
      screen: 'help-support',
    },
  ];

  const initial = (currentUser?.full_name || currentUser?.email || 'A').trim().charAt(0).toUpperCase();
  const displayName = currentUser?.full_name || currentUser?.email || 'Guest User';
  const isOrganizer = currentUser?.role === 'organizer' || currentUser?.role === 'organiser';
  const isAdmin = currentUser?.role === 'admin' || currentUser?.id === ROOT_UID;
  const isVerified = (currentUser as any)?.is_verified === true || currentUser?.id === ROOT_UID;
  const roleLabel = isOrganizer ? 'Organizer' : isAdmin ? 'Admin' : 'Attendee';
  
  const filteredMenuItems = menuItems.filter(item => {
    if (isOrganizer) {
      return item.screen !== 'my-tickets' && item.screen !== 'saved';
    }
    return true;
  });

  const badgeGradient = isOrganizer
    ? 'linear-gradient(135deg, #C084FC, #7C3AED)'
    : isAdmin
    ? 'linear-gradient(135deg, #F87171, #EF4444)'
    : 'linear-gradient(135deg, #FFB830, #F59E0B)';

  const badgeTextColor = isAdmin ? '#fff' : '#000';
  const starColor = isAdmin ? '#fff' : '#000';

  return (
    <div className="flex flex-col h-full" style={{ background: '#060A12' }}>
      {/* Header */}
      <div 
        className="flex items-center justify-between px-4 pb-3"
        style={{ paddingTop: 'calc(20px + env(safe-area-inset-top))' }}
      >
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '20px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
          }}
        >
          Profile
        </h1>
        <div />
      </div>

      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(96px + env(safe-area-inset-bottom))' }}>
        {/* Profile card */}
        <div className="px-4 mb-4">
          <div
            className="p-5"
            style={{
              background: 'linear-gradient(135deg, #1A0D2E 0%, #0D1429 100%)',
              borderRadius: '20px',
              border: '1px solid rgba(123,47,190,0.25)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {!currentUser?.cover_url && (
              <div
                style={{
                  position: 'absolute',
                  top: '-40px',
                  right: '-40px',
                  width: '160px',
                  height: '160px',
                  background: 'radial-gradient(circle, rgba(123,47,190,0.25) 0%, transparent 70%)',
                  borderRadius: '50%',
                  pointerEvents: 'none',
                }}
              />
            )}

            {currentUser?.cover_url && (
              <div style={{ margin: '-20px -20px 16px', borderRadius: '20px 20px 0 0', overflow: 'hidden', height: '100px', position: 'relative' }}>
                <img src={currentUser.cover_url} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(6,10,18,0) 50%, rgba(26,13,46,0.85) 100%)' }} />
              </div>
            )}

            <div className="flex items-center gap-4 mb-4">
              <button
                onClick={() => onNavigate('settings')}
                style={{ position: 'relative', padding: 0, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                aria-label="Change profile photo"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center overflow-hidden"
                  style={{
                    background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                    boxShadow: '0 8px 24px rgba(123,47,190,0.4)',
                  }}
                >
                  {currentUser?.avatar_url ? (
                    <img src={currentUser.avatar_url} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ color: '#fff', fontSize: '26px', fontWeight: 700 }}>{initial}</span>
                  )}
                </div>
                <div style={{
                  position: 'absolute', bottom: -4, right: -4,
                  background: '#7B2FBE', borderRadius: '50%', width: '22px', height: '22px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '2px solid #060A12',
                }}>
                  <Camera size={11} color="#fff" />
                </div>
              </button>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <h2
                    style={{
                      color: '#F0F0FF',
                      fontSize: '17px',
                      fontWeight: 700,
                      fontFamily: 'Space Grotesk, sans-serif',
                      margin: 0,
                    }}
                  >
                    {displayName}
                  </h2>
                  {isVerified && (
                    <BadgeCheck size={16} color="#3B82F6" title="Verified" style={{ filter: 'drop-shadow(0 0 6px rgba(59,130,246,0.6))' }} />
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin size={12} color="#8B8FA8" />
                  <span style={{ color: '#8B8FA8', fontSize: '12px' }}>{currentUser?.state || 'Lagos'}, Nigeria</span>
                </div>
                <div className="flex items-center gap-1 mt-1" style={{ flexWrap: 'wrap', gap: '6px' }}>
                  <div
                    style={{
                      background: badgeGradient,
                      borderRadius: '5px',
                      padding: '2px 7px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '3px',
                    }}
                  >
                    <Star size={10} color={starColor} fill={starColor} />
                    <span style={{ color: badgeTextColor, fontSize: '10px', fontWeight: 700 }}>
                      {roleLabel}
                    </span>
                  </div>
                  {currentUser?.vc_badge && (() => {
                    const badgeMap: Record<string, { label: string; background?: string; gradient?: string; color: string; border?: string }> = {
                      bronze: { label: 'BRONZE', background: '#CD7F32', color: '#fff' },
                      silver: { label: 'SILVER', background: '#A8A9AD', color: '#fff' },
                      gold: { label: 'GOLD', background: '#FFD700', color: '#1a1a2e' },
                      platinum: { label: 'PLATINUM', background: '#E5E4E2', color: '#1a1a2e' },
                      elite: { label: 'ELITE', background: '#1a1a2e', color: '#fff', border: '1px solid rgba(255,255,255,0.15)' },
                      legend: { label: 'LEGEND', gradient: 'linear-gradient(135deg,#7B2FF7,#F107A3)', color: '#fff' },
                    };
                    const b = badgeMap[currentUser.vc_badge!.toLowerCase()];
                    if (!b) return null;
                    return (
                      <span style={{ background: b.gradient || b.background, borderRadius: '20px', padding: '6px 12px', fontSize: '11px', fontWeight: 700, color: b.color, letterSpacing: '0.08em', border: b.border || 'none' }}>
                        {b.label}
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Stats tab bar — role-specific */}
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
              {(isAdmin ? [
                { label: 'Events', value: eventsCreated, onClick: () => onNavigate('manage-events') },
                { label: 'Saved', value: savedCount, onClick: () => onNavigate('saved') },
                { label: 'Followers', value: followers, onClick: () => onNavigateToFollowingFilter?.('followers') },
                { label: 'Following', value: followingCount, onClick: () => onNavigateToFollowingFilter?.('following') },
              ] : isOrganizer ? [
                { label: 'Followers', value: followers, onClick: () => onNavigateToFollowingFilter?.('followers') },
                { label: 'Following', value: followingCount, onClick: () => onNavigateToFollowingFilter?.('following') },
                { label: 'Events Organized', value: eventsCreated, onClick: () => onNavigate('manage-events') },
                { label: 'Saved Events', value: savedCount, onClick: () => onNavigate('saved') },
              ] : [
                { label: 'Followers', value: followers, onClick: () => onNavigateToFollowingFilter?.('followers') },
                { label: 'Following', value: followingCount, onClick: () => onNavigateToFollowingFilter?.('following') },
                { label: 'Attended Events', value: tickets.length, onClick: () => onNavigate('my-tickets') },
                { label: 'Saved Events', value: savedCount, onClick: () => onNavigate('saved') },
              ]).map((stat) => (
                <div
                  key={stat.label}
                  onClick={stat.onClick}
                  style={{
                    flex: '1 0 0',
                    minWidth: '72px',
                    textAlign: 'center',
                    padding: '10px 6px',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '12px',
                    cursor: 'pointer',
                  }}
                >
                  <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
                    {stat.value}
                  </p>
                  <p style={{ color: '#8B8FA8', fontSize: '10px', marginTop: '2px', margin: 0 }}>
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>

            {/* Organizer/admin: switching is now via the Create tab FAB or the banner */}
          </div>
        </div>

        {/* Highlights strip — own profile */}
        {currentUser?.id && (
          <div style={{ marginBottom: '4px' }}>
            <HighlightsStrip
              userId={currentUser.id}
              isOwnProfile={true}
              onHighlightClick={(groups, startGroupIndex) => setHighlightData({ groups, startGroupIndex })}
              refreshTrigger={highlightRefresh}
            />
          </div>
        )}
        {highlightData && (
          <HighlightsModal
            groups={highlightData.groups}
            startGroupIndex={highlightData.startGroupIndex}
            onClose={() => { setHighlightData(null); setHighlightRefresh(r => r + 1); }}
          />
        )}

        {/* Recent ticket */}
        {tickets.length > 0 && (
          <div className="px-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h2 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Latest Ticket</h2>
              <button
                onClick={() => onNavigate('my-tickets')}
                style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}
              >
                See all
              </button>
            </div>
            <button
              onClick={() => onViewTicket(tickets[tickets.length - 1])}
              className="w-full flex items-center gap-3 p-3 text-left"
              style={{
                background: '#131629',
                borderRadius: '14px',
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <img
                src={tickets[tickets.length - 1].event.image}
                alt=""
                className="object-cover flex-shrink-0"
                style={{ width: '54px', height: '54px', borderRadius: '10px' }}
              />
              <div className="flex-1 min-w-0">
                <p
                  style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}
                  className="truncate"
                >
                  {tickets[tickets.length - 1].event.title}
                </p>
                <p style={{ color: '#8B8FA8', fontSize: '11px' }}>
                  {tickets[tickets.length - 1].event.date}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    style={{
                      fontSize: '10px',
                      color: '#22C55E',
                      background: 'rgba(34,197,94,0.12)',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      fontWeight: 600,
                    }}
                  >
                    Confirmed
                  </span>
                  <span style={{ color: '#FFB830', fontSize: '11px', fontWeight: 600 }}>
                    {formatPrice(tickets[tickets.length - 1].totalAmount)}
                  </span>
                </div>
              </div>
              <ChevronRight size={16} color="#8B8FA8" />
            </button>
          </div>
        )}

        {/* Menu items */}
        <div className="px-4 mb-4">
          <div
            style={{
              background: '#131629',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.05)',
              overflow: 'hidden',
            }}
          >
            {filteredMenuItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => item.screen && onNavigate(item.screen)}
                  className="w-full flex items-center gap-3 p-4 text-left"
                  style={{
                    borderBottom:
                      index < filteredMenuItems.length - 1
                        ? '1px solid rgba(255,255,255,0.04)'
                        : 'none',
                    cursor: item.screen ? 'pointer' : 'default',
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: `${item.color}15` }}
                  >
                    <Icon size={17} color={item.color} />
                  </div>
                  <div className="flex-1">
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>
                      {item.label}
                    </p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>{item.sublabel}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.badge && (
                      <div
                        style={{
                          background: '#EF4444',
                          borderRadius: '50%',
                          width: '18px',
                          height: '18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>
                          {item.badge}
                        </span>
                      </div>
                    )}
                    <ChevronRight size={15} color="#8B8FA8" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Organizer Wallet */}
        {(isOrganizer || isAdmin) && (
          <div className="px-4 mb-3">
            <button
              onClick={() => onNavigate('wallet')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: 'linear-gradient(135deg, rgba(79,70,229,0.15), rgba(168,85,247,0.1))',
                borderRadius: '14px',
                border: '1px solid rgba(168,85,247,0.3)',
                cursor: 'pointer',
              }}
            >
              <Wallet size={16} color="#A855F7" />
              <span style={{ color: '#A855F7', fontSize: '14px', fontWeight: 700 }}>My Wallet</span>
            </button>
          </div>
        )}

        {/* Admin Dashboard (ROOT_UID only) */}
        {isAdmin && (
          <div className="px-4 mb-3">
            <button
              onClick={() => onNavigate('admin-dashboard')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(185,28,28,0.1))',
                borderRadius: '14px',
                border: '1px solid rgba(239,68,68,0.35)',
                cursor: 'pointer',
                boxShadow: '0 0 18px rgba(239,68,68,0.18)',
              }}
            >
              <Shield size={16} color="#EF4444" />
              <span style={{ color: '#EF4444', fontSize: '14px', fontWeight: 700, letterSpacing: '0.02em' }}>
                Admin Dashboard
              </span>
            </button>
          </div>
        )}

        {/* Sign out */}
        <div className="px-4 mb-5">
          <button
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 p-4"
            style={{
              background: 'rgba(239,68,68,0.07)',
              borderRadius: '14px',
              border: '1px solid rgba(239,68,68,0.14)',
              cursor: 'pointer',
            }}
          >
            <LogOut size={16} color="#EF4444" />
            <span style={{ color: '#EF4444', fontSize: '14px', fontWeight: 600 }}>Sign Out</span>
          </button>
        </div>

        <p style={{ textAlign: 'center', color: '#555C7A', fontSize: '11px', marginTop: '8px', paddingBottom: '4px' }}>
          VENTS v1.1.0 | © VENTS LTD
        </p>
      </div>
    </div>
  );
}

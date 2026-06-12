import { useState, useEffect } from 'react';
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
  LayoutDashboard,
} from 'lucide-react';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import { insforge } from '../../lib/insforge';

interface ProfileScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onSignOut: () => void;
  tickets: PurchasedTicket[];
  savedCount: number;
  followingCount: number;
  onViewTicket: (ticket: PurchasedTicket) => void;
  onNavigate: (screen: string) => void;
}

export function ProfileScreen({
  currentUser,
  onSignOut,
  tickets,
  savedCount,
  followingCount,
  onViewTicket,
  onNavigate,
}: ProfileScreenProps) {
  const [eventsCreated, setEventsCreated] = useState(0);
  const [followers, setFollowers] = useState(0);
  const [attendees, setAttendees] = useState(0);

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
  }, [currentUser]);
  if (!currentUser) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading profile...
      </div>
    );
  }

  const menuItems = [
    {
      icon: Ticket,
      label: 'My Events',
      sublabel: `${tickets.length} event${tickets.length !== 1 ? 's' : ''}`,
      color: '#A78BFA',
      screen: 'my-tickets',
    },
    {
      icon: Bell,
      label: 'Notifications',
      sublabel: 'Manage alerts',
      color: '#F59E0B',
      screen: 'notifications',
      badge: 2,
    },
    {
      icon: Heart,
      label: 'Saved Events',
      sublabel: `${savedCount} saved`,
      color: '#EC4899',
      screen: 'saved',
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
      sublabel: 'Account safety',
      color: '#3B82F6',
      screen: null,
    },
    {
      icon: HelpCircle,
      label: 'Help & Support',
      sublabel: 'FAQs and contact',
      color: '#8B8FA8',
      screen: null,
    },
  ];

  const initial = (currentUser?.full_name || currentUser?.email || 'A').trim().charAt(0).toUpperCase();
  const displayName = currentUser?.full_name || currentUser?.email || 'Guest User';
  const isOrganizer = currentUser?.role === 'organizer';
  const isAdmin = currentUser?.role === 'admin';
  const roleLabel = isOrganizer ? 'Organizer' : isAdmin ? 'Admin' : 'Attendee';
  
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
      <div className="flex items-center justify-between px-4 pb-3 pt-5">
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('notifications')}
            className="w-9 h-9 rounded-full flex items-center justify-center relative"
            style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <Bell size={16} color="#C4C9E0" />
            <div
              style={{
                position: 'absolute',
                top: '7px',
                right: '7px',
                width: '8px',
                height: '8px',
                background: '#EF4444',
                borderRadius: '50%',
                border: '1.5px solid #060A12',
              }}
            />
          </button>
          <button
            onClick={() => onNavigate('settings')}
            className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <Settings size={16} color="#C4C9E0" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24" style={{ scrollbarWidth: 'none' }}>
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

            <div className="flex items-center gap-4 mb-4">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                  boxShadow: '0 8px 24px rgba(123,47,190,0.4)',
                }}
              >
                <span style={{ color: '#fff', fontSize: '26px', fontWeight: 700 }}>{initial}</span>
              </div>
              <div>
                <h2
                  style={{
                    color: '#F0F0FF',
                    fontSize: '17px',
                    fontWeight: 700,
                    fontFamily: 'Space Grotesk, sans-serif',
                  }}
                >
                  {displayName}
                </h2>
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin size={12} color="#8B8FA8" />
                  <span style={{ color: '#8B8FA8', fontSize: '12px' }}>{currentUser?.state || 'Lagos'}, Nigeria</span>
                </div>
                <div className="flex items-center gap-1 mt-1">
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
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Events', value: String(eventsCreated) },
                { label: 'Followers', value: String(followers) },
                { label: 'Attendees', value: String(attendees) },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="text-center p-3"
                  style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}
                >
                  <p
                    style={{
                      color: '#F0F0FF',
                      fontSize: '20px',
                      fontWeight: 800,
                      fontFamily: 'Space Grotesk, sans-serif',
                    }}
                  >
                    {stat.value}
                  </p>
                  <p style={{ color: '#8B8FA8', fontSize: '10px', marginTop: '1px' }}>
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Organizer mode CTA */}
        <div className="px-4 mb-4">
          <button
            onClick={() => onNavigate('org-dashboard')}
            style={{
              width: '100%',
              background: 'linear-gradient(135deg, rgba(124,58,237,0.15), rgba(79,70,229,0.1))',
              border: '1px solid rgba(124,58,237,0.3)',
              borderRadius: '16px',
              padding: '14px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '12px',
                background: 'rgba(124,58,237,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <LayoutDashboard size={20} color="#A855F7" />
            </div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>Organizer Mode</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                Create & manage your events
              </p>
            </div>
            <ChevronRight size={16} color="#A855F7" />
          </button>
        </div>

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
            {menuItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => item.screen && onNavigate(item.screen)}
                  className="w-full flex items-center gap-3 p-4 text-left"
                  style={{
                    borderBottom:
                      index < menuItems.length - 1
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

        <p style={{ color: '#6B7280', fontSize: '11px', textAlign: 'center' }} className="pb-2">
          VENTS v2.1.0 · Made with ❤️ in Lagos, Nigeria
        </p>
      </div>
    </div>
  );
}

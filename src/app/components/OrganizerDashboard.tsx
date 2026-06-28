import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  DollarSign,
  Users,
  Ticket,
  Inbox,
  Sparkles,
  ScanLine,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import { insforge } from '../../lib/insforge';
import { formatPrice } from './data';

interface OrganizerDashboardProps {
  currentUser?: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack?: () => void;
  onNavigate?: (screen: string) => void;
  setActiveView: (view: 'attendee' | 'organizer') => void;
  onScanTickets?: (eventId: string) => void;
  onEventPress?: (event: any) => void;
  onManageEvents?: () => void;
}

export function OrganizerDashboard({
  currentUser = null,
  onBack = () => {},
  onNavigate = () => {},
  setActiveView = () => {},
  onScanTickets,
  onEventPress,
  onManageEvents,
}: OrganizerDashboardProps) {
  const [activeTab, setActiveTab] = useState<'live' | 'drafts' | 'past'>('live');
  const [loading, setLoading] = useState(true);
  const [revenue, setRevenue] = useState(0);
  const [ticketsSold, setTicketsSold] = useState(0);
  const [followers, setFollowers] = useState(0);
  const [orgEvents, setOrgEvents] = useState<any[]>([]);
  const [chartData, setChartData] = useState<{ name: string; sold: number; goal: number }[]>([]);

  useEffect(() => {
    async function loadDashboardData() {
      if (!currentUser?.id) return;
      setLoading(true);
      try {
        // 1. Fetch events created by the organizer — organizers always see their own events
        //    regardless of hidden_by_admin (that flag only hides from public feeds)
        const { data: eventsData, error: eventsError } = await insforge.database
          .from('events')
          .select('*')
          .eq('organizer_id', currentUser.id)
          .order('created_at', { ascending: false });

        if (eventsError) throw eventsError;

        if (eventsData) {
          setOrgEvents(eventsData);

          // 2. Fetch followers count (rows where following_id = currentUser.id)
          const { count: followersCount, error: followsError } = await insforge.database
            .from('follows')
            .select('id', { count: 'exact', head: true })
            .eq('following_id', currentUser.id);

          if (!followsError && followersCount !== null) {
            setFollowers(followersCount);
          }

          // 3. Real revenue = SUM(amount) and tickets sold = COUNT where payment_status='paid'
          if (eventsData.length > 0) {
            const eventIds = eventsData.map((e: any) => e.id);
            const { data: ticketsData, error: ticketsError } = await insforge.database
              .from('tickets')
              .select('id, event_id, quantity, amount, payment_status')
              .in('event_id', eventIds)
              .eq('payment_status', 'paid');

            if (!ticketsError && ticketsData) {
              let totalTickets = 0;
              let totalRev = 0;
              const soldByEvent: Record<string, number> = {};
              ticketsData.forEach((ticket: any) => {
                totalTickets += Number(ticket.quantity) || 1;
                totalRev += Number(ticket.amount) || 0;
                soldByEvent[ticket.event_id] = (soldByEvent[ticket.event_id] || 0) + (Number(ticket.quantity) || 1);
              });
              setTicketsSold(totalTickets);
              setRevenue(totalRev);

              // Chart data: top 5 events by tickets sold
              const chart = eventsData
                .slice(0, 5)
                .map((e: any) => ({
                  name: (e.title as string).length > 12 ? (e.title as string).slice(0, 12) + '…' : e.title,
                  sold: soldByEvent[e.id] || 0,
                  goal: Number(e.ticket_goal) || 500,
                }))
                .sort((a: any, b: any) => b.sold - a.sold);
              setChartData(chart);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load organizer dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }
    loadDashboardData();
  }, [currentUser]);

  if (loading) {
    return (
      <div
        style={{
          background: '#060A12',
          width: '100%',
          height: '100%',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Inter, sans-serif',
          color: '#8B8FA8',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              border: '3px solid rgba(123, 47, 190, 0.1)',
              borderTop: '3px solid #7B2FBE',
              borderRadius: '50%',
              animation: 'dashSpinner 0.8s linear infinite',
            }}
          />
          <style>{`
            @keyframes dashSpinner {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          `}</style>
          <span style={{ fontSize: '14px', letterSpacing: '0.05em', color: '#C4C9E0' }}>
            Loading Creator Hub...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, sans-serif',
        color: '#F0F0FF',
        overflowY: 'auto',
      }}
    >
      {/* Top Navigation (The Sinc Switch) */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'calc(20px + env(safe-area-inset-top)) 20px 20px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
          background: 'rgba(6, 10, 18, 0.85)',
          backdropFilter: 'blur(12px)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '50%',
                width: '40px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
              }}
            >
              <ArrowLeft size={18} color="#C4C9E0" />
            </button>
          )}
          <div>
            <h1
              style={{
                color: '#F0F0FF',
                fontSize: '20px',
                fontWeight: 800,
                fontFamily: 'Space Grotesk, sans-serif',
                margin: 0,
                letterSpacing: '-0.02em',
              }}
            >
              Creator Studio
            </h1>
            <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0', fontWeight: 500 }}>
              {currentUser?.full_name || currentUser?.email?.split('@')[0] || 'Organizer'}
            </p>
          </div>
        </div>

      </header>

      {/* Main Content Area */}
      <main
        style={{
          flex: 1,
          padding: '24px 20px 110px',
          maxWidth: '800px',
          width: '100%',
          boxSizing: 'border-box',
          margin: '0 auto',
        }}
      >
        {/* Style block for responsive grid and other dynamic adjustments */}
        <style>{`
          .metrics-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 28px;
          }
          @media (max-width: 600px) {
            .metrics-grid {
              grid-template-columns: 1fr;
              gap: 16px;
            }
          }
        `}</style>

        {/* Metrics Hero Section */}
        <div className="metrics-grid">
          {/* Card 1: Total Revenue */}
          <div
            style={{
              background: '#131629',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '16px',
              padding: '20px 16px',
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              transition: 'transform 0.2s ease, border-color 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.borderColor = 'rgba(123, 47, 190, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
            }}
          >
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'rgba(16, 185, 129, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '14px',
              }}
            >
              <DollarSign size={18} color="#10B981" />
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>
              Total Revenue
            </span>
            <span style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif' }}>
              {formatPrice(revenue)}
            </span>
          </div>

          {/* Card 2: Tickets Sold */}
          <div
            style={{
              background: '#131629',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '16px',
              padding: '20px 16px',
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              transition: 'transform 0.2s ease, border-color 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.borderColor = 'rgba(79, 70, 229, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
            }}
          >
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'rgba(79, 70, 229, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '14px',
              }}
            >
              <Ticket size={18} color="#4F46E5" />
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>
              Tickets Sold
            </span>
            <span style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif' }}>
              {ticketsSold}
            </span>
          </div>

          {/* Card 3: Followers */}
          <div
            style={{
              background: '#131629',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: '16px',
              padding: '20px 16px',
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              transition: 'transform 0.2s ease, border-color 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
            }}
          >
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'rgba(168, 85, 247, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '14px',
              }}
            >
              <Users size={18} color="#A855F7" />
            </div>
            <span style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>
              Followers
            </span>
            <span style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif' }}>
              {followers}
            </span>
          </div>
        </div>

        {/* ── Tickets Sold vs Goal Chart ──────────────────────────────────── */}
        {chartData.length > 0 && (
          <div style={{ background: '#131629', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.06)', padding: '20px', marginBottom: '28px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>Tickets Sold vs Goal</h3>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                  {ticketsSold} sold across {orgEvents.length} event{orgEvents.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#A78BFA' }} />
                  <span style={{ color: '#8B8FA8', fontSize: '10px' }}>Sold</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'rgba(167,139,250,0.2)', border: '1px solid rgba(167,139,250,0.3)' }} />
                  <span style={{ color: '#8B8FA8', fontSize: '10px' }}>Goal</span>
                </div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData} barGap={4} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" tick={{ fill: '#8B8FA8', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#8B8FA8', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: '#0F1322', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', fontSize: '12px' }}
                  labelStyle={{ color: '#F0F0FF', fontWeight: 700, marginBottom: '4px' }}
                  itemStyle={{ color: '#A78BFA' }}
                />
                <Bar dataKey="goal" fill="rgba(167,139,250,0.15)" radius={[4, 4, 0, 0]} name="Goal" />
                <Bar dataKey="sold" radius={[4, 4, 0, 0]} name="Sold">
                  {chartData.map((entry, idx) => (
                    <Cell
                      key={idx}
                      fill={entry.sold >= entry.goal
                        ? '#10B981'  // green = hit goal
                        : entry.sold > 0 ? '#A78BFA' : 'rgba(167,139,250,0.3)'  // purple or empty
                      }
                    />
                  ))}
                  <LabelList dataKey="sold" position="top" style={{ fill: '#A78BFA', fontSize: 10, fontWeight: 700 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Action buttons row */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
          <button
            onClick={() => onManageEvents?.()}
            style={{
              flex: 1,
              background: 'transparent',
              border: '1px solid #7B2FF7',
              borderRadius: '12px',
              padding: '10px 20px',
              color: '#7B2FF7',
              fontFamily: 'Space Grotesk, sans-serif',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Edit All Events
          </button>
        </div>

        {/* Primary Action (Create Event) */}
        <button
          onClick={() => onNavigate?.('create-event')}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '16px',
            padding: '16px 24px',
            color: '#FFFFFF',
            fontFamily: 'Space Grotesk, sans-serif',
            fontSize: '16px',
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 8px 30px rgba(123, 47, 190, 0.3)',
            marginBottom: '36px',
            transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 12px 35px rgba(123, 47, 190, 0.45)';
            e.currentTarget.style.opacity = '0.95';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 8px 30px rgba(123, 47, 190, 0.3)';
            e.currentTarget.style.opacity = '1';
          }}
        >
          + Create New Event
        </button>

        {/* Event Management Tabs */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            marginBottom: '28px',
            gap: '24px',
          }}
        >
          {(['live', 'drafts', 'past'] as const).map((tab) => {
            const label = tab === 'live' ? 'Live Events' : tab === 'drafts' ? 'Drafts' : 'Past Events';
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 4px 16px',
                  color: isActive ? '#FFFFFF' : '#8B8FA8',
                  fontFamily: 'Space Grotesk, sans-serif',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'color 0.2s ease',
                }}
              >
                {label}
                {isActive && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: '2px',
                      background: 'linear-gradient(90deg, #7B2FBE 0%, #4F46E5 100%)',
                      borderRadius: '2px',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {(() => {
          // Resolve event status — treat null/undefined as 'live' for backward compat
          const getStatus = (e: any): string => e.status ?? 'live';

          // Compare against start-of-today so same-day events still show as live/upcoming
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);

          const displayEvents = activeTab === 'live'
            ? orgEvents.filter(e => getStatus(e) === 'live' && new Date(e.event_date) >= todayStart)
            : activeTab === 'drafts'
            ? orgEvents.filter(e => getStatus(e) === 'draft')
            : orgEvents.filter(e => getStatus(e) !== 'draft' && new Date(e.event_date) < todayStart);


          if (displayEvents.length > 0) {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {displayEvents.map((event) => {
                  const dateStr = event.event_date ? new Date(event.event_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                  return (
                    <div
                      key={event.id}
                      onClick={() => onEventPress?.(event)}
                      style={{
                        background: '#131629',
                        border: '1px solid rgba(255,255,255,0.06)',
                        borderRadius: '16px',
                        padding: '16px',
                        display: 'flex',
                        gap: '16px',
                        alignItems: 'center',
                        cursor: onEventPress ? 'pointer' : 'default',
                      }}
                    >
                      <img
                        src={event.image_url || 'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?w=800'}
                        alt=""
                        style={{ width: '64px', height: '64px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                          <span style={{
                            fontSize: '9px',
                            background: getStatus(event) === 'live' ? 'rgba(16, 185, 129, 0.12)' : getStatus(event) === 'draft' ? 'rgba(245, 158, 11, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                            color: getStatus(event) === 'live' ? '#10B981' : getStatus(event) === 'draft' ? '#F59E0B' : '#EF4444',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontWeight: 700,
                            textTransform: 'uppercase' as const
                          }}>
                            {getStatus(event)}
                          </span>
                          <span style={{ color: '#8B8FA8', fontSize: '10px' }}>{event.category}</span>
                        </div>
                        <h4 style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: '0 0 4px 0' }} className="truncate">
                          {event.title}
                        </h4>
                        <p style={{ color: '#8B8FA8', fontSize: '11px', margin: 0 }} className="truncate">
                          {dateStr} • {event.location || 'Lagos, Nigeria'}
                        </p>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                        <span style={{ color: '#FFB830', fontSize: '13px', fontWeight: 700, display: 'block' }}>
                          {formatPrice(Number(event.price || 0))}
                        </span>
                        {activeTab === 'live' && (
                          <button
                            onClick={() => onScanTickets?.(event.id)}
                            style={{
                              background: '#7B2FF7',
                              border: 'none',
                              borderRadius: '12px',
                              padding: '10px 20px',
                              color: '#fff',
                              fontSize: '13px',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <ScanLine size={16} />
                            Scan Tickets
                          </button>
                        )}
                        {activeTab === 'drafts' && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              await insforge.database
                                .from('events')
                                .update({ status: 'live' })
                                .eq('id', event.id);
                              setOrgEvents(prev => prev.map(ev => ev.id === event.id ? { ...ev, status: 'live' } : ev));
                            }}
                            style={{
                              background: 'rgba(16,185,129,0.12)',
                              border: '1px solid rgba(16,185,129,0.3)',
                              borderRadius: '8px',
                              padding: '5px 10px',
                              color: '#10B981',
                              fontSize: '10px',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            ✓ Publish
                          </button>
                        )}
                      </div>

                    </div>
                  );
                })}
              </div>
            );
          }

          if (activeTab === 'live') {
            return (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '64px 20px',
                  background: '#131629',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: '20px',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    width: '72px',
                    height: '72px',
                    borderRadius: '50%',
                    background: 'rgba(123, 47, 190, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '20px',
                    border: '1px solid rgba(123, 47, 190, 0.15)',
                  }}
                >
                  <Inbox size={28} color="#A855F7" />
                </div>
                <h3
                  style={{
                    color: '#F0F0FF',
                    fontFamily: 'Space Grotesk, sans-serif',
                    fontSize: '16px',
                    fontWeight: 700,
                    margin: '0 0 8px 0',
                    lineHeight: '1.4',
                  }}
                >
                  No live events yet. Tap Create New Event to start hosting.
                </h3>
                <p
                  style={{
                    color: '#8B8FA8',
                    fontSize: '13px',
                    margin: 0,
                    lineHeight: '1.5',
                    maxWidth: '280px',
                  }}
                >
                  Publish your first event and start selling tickets globally.
                </p>
              </div>
            );
          }

          if (activeTab === 'drafts') {
            return (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '64px 20px',
                  background: '#131629',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: '20px',
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    width: '72px',
                    height: '72px',
                    borderRadius: '50%',
                    background: 'rgba(255, 255, 255, 0.03)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                  }}
                >
                  <Inbox size={28} color="#8B8FA8" />
                </div>
                <h3
                  style={{
                    color: '#F0F0FF',
                    fontFamily: 'Space Grotesk, sans-serif',
                    fontSize: '16px',
                    fontWeight: 700,
                    margin: '0 0 8px 0',
                    lineHeight: '1.4',
                  }}
                >
                  No draft events
                </h3>
                <p
                  style={{
                    color: '#8B8FA8',
                    fontSize: '13px',
                    margin: 0,
                    lineHeight: '1.5',
                    maxWidth: '280px',
                  }}
                >
                  Any in-progress event set ups will appear here.
                </p>
              </div>
            );
          }

          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '64px 20px',
                background: '#131629',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '20px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '72px',
                  height: '72px',
                  borderRadius: '50%',
                  background: 'rgba(255, 255, 255, 0.03)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '20px',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                <Inbox size={28} color="#8B8FA8" />
              </div>
              <h3
                style={{
                  color: '#F0F0FF',
                  fontFamily: 'Space Grotesk, sans-serif',
                  fontSize: '16px',
                  fontWeight: 700,
                  margin: '0 0 8px 0',
                  lineHeight: '1.4',
                }}
              >
                No past events
              </h3>
              <p
                style={{
                  color: '#8B8FA8',
                  fontSize: '13px',
                  margin: 0,
                  lineHeight: '1.5',
                  maxWidth: '280px',
                }}
              >
                Completed events will be listed here for record-keeping.
              </p>
            </div>
          );
        })()}
      </main>
    </div>
  );
}

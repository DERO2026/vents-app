import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  TrendingUp,
  Users,
  DollarSign,
  Calendar,
  Plus,
  BarChart3,
  List,
  ChevronRight,
} from 'lucide-react';
import { formatPrice } from './data';
import { insforge } from '../../lib/insforge';

interface OrganizerDashboardProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
  onNavigate: (screen: string) => void;
}



function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div
      style={{
        background: '#131629',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '16px',
        padding: '14px',
        flex: 1,
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '10px',
          background: `${color}18`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '10px',
        }}
      >
        <Icon size={18} color={color} />
      </div>
      <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
        {value}
      </p>
      <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '2px' }}>{label}</p>
      {sub && (
        <p style={{ color: '#10B981', fontSize: '11px', marginTop: '3px', fontWeight: 600 }}>{sub}</p>
      )}
    </div>
  );
}

function RevenueChart({ data }: { data: { day: string; revenue: number }[] }) {
  const W = 320, H = 120, PL = 4, PR = 4, PT = 8, PB = 20;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;
  const maxVal = Math.max(...data.map((d) => d.revenue));
  const minVal = Math.min(...data.map((d) => d.revenue));
  const range = maxVal - minVal || 1;

  const pts = data.map((d, i) => ({
    x: PL + (i / (data.length - 1)) * innerW,
    y: PT + innerH - ((d.revenue - minVal) / range) * innerH,
    d,
  }));

  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath = `M${pts[0].x},${pts[0].y} ${pts.slice(1).map((p) => `L${p.x},${p.y}`).join(' ')} L${pts[pts.length - 1].x},${PT + innerH} L${pts[0].x},${PT + innerH} Z`;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A855F7" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#A855F7" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 0.33, 0.66, 1].map((t, i) => (
        <line key={i} x1={PL} y1={PT + innerH * (1 - t)} x2={W - PR} y2={PT + innerH * (1 - t)} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
      ))}
      {/* Area fill */}
      <path d={areaPath} fill="url(#chartGrad)" />
      {/* Line */}
      <polyline points={polyline} fill="none" stroke="#A855F7" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* Dots */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.5" fill="#A855F7" stroke="#131629" strokeWidth="1.5" />
      ))}
      {/* X-axis labels */}
      {pts.map((p, i) => (
        <text key={i} x={p.x} y={H - 4} textAnchor="middle" fill="#8B8FA8" fontSize="10">{p.d.day}</text>
      ))}
    </svg>
  );
}

export function OrganizerDashboard({ currentUser, onBack, onNavigate }: OrganizerDashboardProps) {
  if (!currentUser) {
    return (
      <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading dashboard...
      </div>
    );
  }

  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalTickets: 0,
    activeEventsCount: 0,
    averageRating: 4.8,
    dailyRevenue: [] as { day: string; revenue: number }[],
    myEvents: [] as any[]
  });

  useEffect(() => {
    async function loadDashboardData() {
      if (!currentUser?.id) return;
      try {
        const { data: myEvents, error: eventsError } = await insforge.database
          .from('events')
          .select('*')
          .eq('organizer_id', currentUser.id)
          .order('created_at', { ascending: false });

        if (eventsError) throw eventsError;

        if (!myEvents || myEvents.length === 0) {
          setStats({
            totalRevenue: 0,
            totalTickets: 0,
            activeEventsCount: 0,
            averageRating: 4.8,
            dailyRevenue: [
              { day: 'Mon', revenue: 0 },
              { day: 'Tue', revenue: 0 },
              { day: 'Wed', revenue: 0 },
              { day: 'Thu', revenue: 0 },
              { day: 'Fri', revenue: 0 },
              { day: 'Sat', revenue: 0 },
              { day: 'Sun', revenue: 0 }
            ],
            myEvents: []
          });
          setLoading(false);
          return;
        }

        const eventIds = myEvents.map((e: any) => e.id);
        const eventPriceMap = myEvents.reduce((acc: any, e: any) => {
          acc[e.id] = Number(e.price || 0);
          return acc;
        }, {});

        const { data: tickets, error: ticketsError } = await insforge.database
          .from('tickets')
          .select('*')
          .in('event_id', eventIds)
          .eq('status', 'active');

        if (ticketsError) throw ticketsError;

        let totalRev = 0;
        let totalQty = 0;
        const bookingsCountMap: Record<string, number> = {};
        const dailyRevenueMap: Record<string, number> = {
          'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0, 'Sat': 0, 'Sun': 0
        };

        if (tickets) {
          tickets.forEach((t: any) => {
            const qty = t.quantity || 1;
            const price = eventPriceMap[t.event_id] || 0;
            const rev = price * qty;
            totalRev += rev;
            totalQty += qty;
            bookingsCountMap[t.event_id] = (bookingsCountMap[t.event_id] || 0) + qty;

            const date = new Date(t.created_at);
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const dayName = days[date.getDay()];
            if (dailyRevenueMap[dayName] !== undefined) {
              dailyRevenueMap[dayName] += rev;
            }
          });
        }

        const dailyRevenue = Object.keys(dailyRevenueMap).map(day => ({
          day,
          revenue: dailyRevenueMap[day]
        }));
        const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        dailyRevenue.sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));

        const mappedEvents = myEvents.slice(0, 3).map((e: any) => {
          const dt = new Date(e.event_date);
          const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const sold = bookingsCountMap[e.id] || 0;
          return {
            id: e.id,
            title: e.title,
            image: e.image_url || 'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?w=800',
            price: Number(e.price || 0),
            date: dateStr,
            attendees: sold,
            capacity: 1000,
            revenue: sold * Number(e.price || 0)
          };
        });

        setStats({
          totalRevenue: totalRev,
          totalTickets: totalQty,
          activeEventsCount: myEvents.length,
          averageRating: 4.8,
          dailyRevenue,
          myEvents: mappedEvents
        });

      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }

    loadDashboardData();
  }, [currentUser]);

  return (
    <div
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 16px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
            <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>
              Organizer Dashboard
            </h1>
            <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
              {currentUser?.full_name || currentUser?.username || 'Organizer'}
            </p>
          </div>
        </div>
        <button
          onClick={() => onNavigate('create-event')}
          style={{
            background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
            border: 'none',
            borderRadius: '12px',
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
          }}
        >
          <Plus size={14} color="#fff" />
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>New Event</span>
        </button>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 16px 32px',
          scrollbarWidth: 'none',
        }}
      >
        {loading ? (
          <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px' }}>Loading stats...</div>
        ) : (
          <>
            {/* Stats grid */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
              <StatCard
                icon={DollarSign}
                label="Total Revenue"
                value={`₦${stats.totalRevenue.toLocaleString()}`}
                sub="Dynamic total"
                color="#10B981"
              />
              <StatCard
                icon={Users}
                label="Tickets Sold"
                value={stats.totalTickets.toLocaleString()}
                sub="Sold tickets"
                color="#A855F7"
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
              <StatCard
                icon={Calendar}
                label="Active Events"
                value={String(stats.activeEventsCount)}
                color="#3B82F6"
              />
              <StatCard
                icon={TrendingUp}
                label="Avg Rating"
                value={`${stats.averageRating} ⭐`}
                sub="Excellent"
                color="#F59E0B"
              />
            </div>
          </>
        )}

        {!loading && (
          <div
            style={{
              background: '#131629',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: '18px',
              padding: '16px',
              marginBottom: '20px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Revenue</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>This week</p>
              </div>
              <span
                style={{
                  background: 'rgba(16,185,129,0.1)',
                  color: '#10B981',
                  fontSize: '12px',
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: '8px',
                }}
              >
                Dynamic
              </span>
            </div>
            <RevenueChart data={stats.dailyRevenue} />
          </div>
        )}

        {/* Quick actions */}
        <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '10px' }}>
          QUICK ACTIONS
        </p>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          {[
            { icon: Plus, label: 'Create Event', screen: 'create-event', color: '#A855F7' },
            { icon: List, label: 'Manage', screen: 'manage-events', color: '#3B82F6' },
            { icon: BarChart3, label: 'Analytics', screen: 'sales-analytics', color: '#10B981' },
            { icon: TrendingUp, label: 'Promote', screen: 'promote-event', color: '#FFB830' },
          ].map(({ icon: Icon, label, screen, color }) => (
            <button
              key={label}
              onClick={() => onNavigate(screen)}
              style={{
                flex: 1,
                background: '#131629',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '14px',
                padding: '12px 8px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '7px',
                cursor: 'pointer',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: `${color}15`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={17} color={color} />
              </div>
              <span style={{ color: '#C4C9E0', fontSize: '10px', fontWeight: 500, textAlign: 'center', lineHeight: 1.3 }}>
                {label}
              </span>
            </button>
          ))}
        </div>

        {/* Recent events */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>My Events</p>
          <button
            onClick={() => onNavigate('manage-events')}
            style={{ background: 'none', border: 'none', color: '#A78BFA', fontSize: '13px', cursor: 'pointer' }}
          >
            See all
          </button>
        </div>
        {!loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {stats.myEvents.length === 0 ? (
              <div style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '24px', textAlign: 'center' }}>
                <p style={{ color: '#8B8FA8', fontSize: '13px' }}>No events created yet</p>
              </div>
            ) : (
              stats.myEvents.map((event) => {
                const pct = event.capacity > 0 ? Math.round((event.attendees / event.capacity) * 100) : 0;
                return (
                  <div
                    key={event.id}
                    style={{
                      background: '#131629',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '16px',
                      padding: '12px',
                      display: 'flex',
                      gap: '12px',
                      cursor: 'pointer',
                    }}
                    onClick={() => onNavigate('manage-events')}
                  >
                    <img
                      src={event.image}
                      alt=""
                      style={{ width: '56px', height: '56px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                        <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, flex: 1, marginRight: '8px' }} className="truncate">
                          {event.title}
                        </p>
                        <span
                          style={{
                            background: 'rgba(16,185,129,0.12)',
                            color: '#10B981',
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 7px',
                            borderRadius: '5px',
                            flexShrink: 0,
                          }}
                        >
                          On Sale
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
                          {event.attendees.toLocaleString()} sold
                        </span>
                        <span style={{ color: '#FFB830', fontSize: '12px', fontWeight: 700 }}>
                          {formatPrice(Math.round(event.revenue))}
                        </span>
                      </div>
                    </div>
                    <ChevronRight size={15} color="#8B8FA8" style={{ alignSelf: 'center', flexShrink: 0 }} />
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

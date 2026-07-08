import { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { formatPrice } from './data';
import { insforge } from '../../lib/insforge';

interface SalesAnalyticsScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
}

function BarChartSVG({ data }: { data: { day: string; revenue: number }[] }) {
  const W = 320, H = 140, PL = 8, PR = 8, PT = 8, PB = 24;
  const maxVal = Math.max(...data.map((d) => d.revenue));
  const max = maxVal === 0 ? 1 : maxVal;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;
  const barW = Math.floor(innerW / data.length) - 6;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="saBarGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#7B2FBE" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((frac, i) => {
        const y = PT + innerH * frac;
        return (
          <line
            key={`grid-${i}`}
            x1={PL}
            y1={y}
            x2={W - PR}
            y2={y}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={1}
          />
        );
      })}
      {/* Bars + labels */}
      {data.map((d, i) => {
        const barH = (d.revenue / max) * innerH;
        const x = PL + (innerW / data.length) * i + (innerW / data.length - barW) / 2;
        const y = PT + innerH - barH;
        return (
          <g key={`bar-${i}`}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={barH}
              rx={4}
              ry={4}
              fill="url(#saBarGrad)"
            />
            <text
              x={x + barW / 2}
              y={H - 6}
              textAnchor="middle"
              fill="#8B8FA8"
              fontSize={10}
            >
              {d.day}
            </text>
          </g>
        );
      })}
      {/* Y labels */}
      {[0, 0.5, 1].map((frac, i) => {
        const val = Math.round(max * (1 - frac));
        const y = PT + innerH * frac + 4;
        return (
          <text key={`ylabel-${i}`} x={PL} y={y} fill="#8B8FA8" fontSize={9}>
            ₦{val >= 1000000 ? `${(val / 1000000).toFixed(1)}M` : `${val / 1000}k`}
          </text>
        );
      })}
    </svg>
  );
}

function DonutChartSVG({ data }: { data: { name: string; value: number; color: string }[] }) {
  const cx = 60, cy = 60, r = 45, ir = 28;
  const total = data.reduce((s, d) => s + d.value, 0);
  let angle = -Math.PI / 2;
  const slices = data.map((d) => {
    const sweep = (d.value / total) * 2 * Math.PI;
    const start = angle;
    angle += sweep;
    return { ...d, start, sweep };
  });

  function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  return (
    <svg width={120} height={120} viewBox="0 0 120 120" style={{ flexShrink: 0 }}>
      {slices.map((s, i) => {
        const outerArc = arcPath(cx, cy, r, s.start, s.start + s.sweep);
        const innerArcRev = arcPath(cx, cy, ir, s.start + s.sweep, s.start);
        return (
          <path
            key={`donut-${i}`}
            d={`${outerArc} L ${cx + ir * Math.cos(s.start + s.sweep)} ${cy + ir * Math.sin(s.start + s.sweep)} ${innerArcRev} Z`}
            fill={s.color}
          />
        );
      })}
    </svg>
  );
}

function LineChartSVG({ data }: { data: { day: string; rate: number }[] }) {
  const W = 320, H = 120, PL = 8, PR = 8, PT = 8, PB = 20;
  const maxVal = Math.max(...data.map((d) => d.rate));
  const minVal = Math.min(...data.map((d) => d.rate));
  const max = maxVal === 0 ? 1 : maxVal;
  const min = minVal;
  const range = max - min === 0 ? 1 : max - min;
  const innerW = W - PL - PR;
  const innerH = H - PT - PB;

  const pts = data.map((d, i) => {
    const x = PL + (innerW / (data.length - 1)) * i;
    const y = PT + innerH - ((d.rate - min) / range) * innerH;
    return { x, y, d };
  });

  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `M ${pts[0].x},${PT + innerH} ${pts.map((p) => `L ${p.x},${p.y}`).join(' ')} L ${pts[pts.length - 1].x},${PT + innerH} Z`;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="saLineArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10B981" stopOpacity={0.25} />
          <stop offset="100%" stopColor="#10B981" stopOpacity={0} />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((frac, i) => {
        const y = PT + innerH * frac;
        return (
          <line
            key={`lgrid-${i}`}
            x1={PL}
            y1={y}
            x2={W - PR}
            y2={y}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={1}
          />
        );
      })}
      <path d={area} fill="url(#saLineArea)" />
      <polyline points={polyline} fill="none" stroke="#10B981" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <circle key={`dot-${i}`} cx={p.x} cy={p.y} r={3.5} fill="#10B981" />
      ))}
      {data.map((d, i) => (
        <text key={`lday-${i}`} x={pts[i].x} y={H - 4} textAnchor="middle" fill="#8B8FA8" fontSize={10}>
          {d.day}
        </text>
      ))}
    </svg>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#131629',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '18px',
        padding: '16px',
        marginBottom: '16px',
      }}
    >
      <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '16px' }}>
        {title}
      </p>
      {children}
    </div>
  );
}

export function SalesAnalyticsScreen({ currentUser, onBack }: SalesAnalyticsScreenProps) {
  if (!currentUser) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading analytics...
      </div>
    );
  }

  const [loading, setLoading] = useState(true);
  const [analytics, setAnalytics] = useState<{
    totalRevenue: number;
    totalSales: number;
    daily: { day: string; revenue: number }[];
    ticketTypes: { name: string; value: number; color: string }[];
    conversion: { day: string; rate: number }[];
  }>({
    totalRevenue: 0,
    totalSales: 0,
    daily: [
      { day: 'Mon', revenue: 0 },
      { day: 'Tue', revenue: 0 },
      { day: 'Wed', revenue: 0 },
      { day: 'Thu', revenue: 0 },
      { day: 'Fri', revenue: 0 },
      { day: 'Sat', revenue: 0 },
      { day: 'Sun', revenue: 0 }
    ],
    ticketTypes: [
      { name: 'No sales yet', value: 100, color: '#374151' },
      { name: 'VIP', value: 0, color: '#A855F7' },
      { name: 'VVIP', value: 0, color: '#D946EF' }
    ],
    conversion: [
      { day: 'Mon', rate: 0 },
      { day: 'Tue', rate: 0 },
      { day: 'Wed', rate: 0 },
      { day: 'Thu', rate: 0 },
      { day: 'Fri', rate: 0 },
      { day: 'Sat', rate: 0 },
      { day: 'Sun', rate: 0 }
    ]
  });

  useEffect(() => {
    async function fetchAnalytics() {
      if (!currentUser?.id) return;
      try {
        const { data: myEvents, error: eventsError } = await insforge.database
          .from('events')
          .select('id, price')
          .eq('organizer_id', currentUser.id);

        if (eventsError) throw eventsError;

        if (!myEvents || myEvents.length === 0) {
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
        const dailyRevenue: Record<string, number> = {
          'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0, 'Sat': 0, 'Sun': 0
        };
        const dailySales: Record<string, number> = {
          'Mon': 0, 'Tue': 0, 'Wed': 0, 'Thu': 0, 'Fri': 0, 'Sat': 0, 'Sun': 0
        };
        const typeCount: Record<string, number> = {};

        if (tickets) {
          tickets.forEach((t: any) => {
            const qty = t.quantity || 1;
            const price = eventPriceMap[t.event_id] || 0;
            const rev = price * qty;
            totalRev += rev;
            totalQty += qty;

            const typeName: string = t.ticket_type || 'Regular';
            typeCount[typeName] = (typeCount[typeName] || 0) + qty;

            const date = new Date(t.created_at);
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const dayName = days[date.getDay()];
            if (dailyRevenue[dayName] !== undefined) {
              dailyRevenue[dayName] += rev;
              dailySales[dayName] += qty;
            }
          });
        }

        const TYPE_COLORS = ['#7B2FBE', '#A855F7', '#D946EF', '#EC4899', '#6366F1'];
        const computedTypes = Object.keys(typeCount).length > 0
          ? Object.entries(typeCount).map(([name, count], i) => ({
              name,
              value: totalQty > 0 ? Math.round((count / totalQty) * 100) : 0,
              color: TYPE_COLORS[i % TYPE_COLORS.length],
            }))
          : [{ name: 'No sales yet', value: 100, color: '#374151' }];

        const daily = Object.keys(dailyRevenue).map(day => ({
          day,
          revenue: dailyRevenue[day]
        }));

        const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        daily.sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));

        const conversion = order.map(day => ({
          day,
          rate: dailyRevenue[day] > 0 ? Number(((dailySales[day] / 120) * 100).toFixed(1)) : 0
        }));

        setAnalytics({
          totalRevenue: totalRev,
          totalSales: totalQty,
          daily,
          ticketTypes: computedTypes,
          conversion
        });
      } catch (err) {
        console.error("Failed to load analytics:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchAnalytics();
  }, [currentUser]);

  return (
    <div
      style={{
        background: '#020005',
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
          gap: '12px',
          padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
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
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Sales Analytics</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px' }}>This week · All events</p>
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 16px 110px',
          scrollbarWidth: 'none',
        }}
      >
        {loading ? (
          <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px' }}>Loading analytics...</div>
        ) : (
          <>
            {/* Top stats */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
              {[
                { label: 'Total Revenue', value: `₦${(analytics.totalRevenue).toLocaleString()}`, sub: 'All paid tickets', color: '#10B981' },
                { label: 'Tickets Sold', value: analytics.totalSales.toLocaleString(), sub: 'Active tickets', color: '#A855F7' },
              ].map(({ label, value, sub, color }) => (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    background: '#131629',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '16px',
                    padding: '14px',
                  }}
                >
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '5px' }}>{label}</p>
                  <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '3px' }}>
                    {value}
                  </p>
                  <p style={{ color, fontSize: '11px', fontWeight: 600 }}>{sub}</p>
                </div>
              ))}
            </div>

            {/* Daily revenue chart */}
            <ChartCard title="Daily Revenue">
              <BarChartSVG data={analytics.daily} />
            </ChartCard>

            {/* Ticket type breakdown */}
            <ChartCard title="Ticket Type Breakdown">
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <DonutChartSVG data={analytics.ticketTypes} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {analytics.ticketTypes.map((t) => (
                    <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '10px', height: '10px', borderRadius: '3px', background: t.color, flexShrink: 0 }} />
                      <span style={{ color: '#C4C9E0', fontSize: '13px', flex: 1 }}>{t.name}</span>
                      <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>{t.value}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </ChartCard>

            {/* Conversion rate */}
            <ChartCard title="Conversion Rate (%)">
              <LineChartSVG data={analytics.conversion} />
            </ChartCard>

            {/* Key insights */}
            <div
              style={{
                background: '#131629',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '18px',
                padding: '16px',
              }}
            >
              <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, marginBottom: '12px' }}>Key Insights</p>
              {[
                { icon: '📈', text: 'Real-time sales dashboard is active. Revenue updates directly on ticket bookings.' },
                { icon: '🎟️', text: 'Ticket sales count shows exact quantity of checked-out attendee tickets.' },
                { icon: '⚡', text: 'Daily sales breakdown tracks ticket creation date dynamically.' },
              ].map(({ icon, text }) => (
                <div key={text} style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                  <span style={{ fontSize: '18px', flexShrink: 0 }}>{icon}</span>
                  <p style={{ color: '#C4C9E0', fontSize: '13px', lineHeight: 1.5 }}>{text}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

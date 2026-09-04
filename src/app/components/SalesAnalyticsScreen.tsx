import { useState, useEffect } from 'react';
import { ArrowLeft, Ticket, Wallet, Receipt, Users, TrendingUp } from 'lucide-react';
import { formatPrice } from './data';
import { supabase } from '../../lib/supabase';
import { Sentry } from '../../lib/sentry';

interface SalesAnalyticsScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
  // When set, scopes every figure on this screen to just this one event
  // (e.g. opened from an event card's "Analytics" action) instead of the
  // organizer's full portfolio.
  eventId?: string;
  eventTitle?: string;
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
        background: '#090514',
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

export function SalesAnalyticsScreen({ currentUser, onBack, eventId, eventTitle }: SalesAnalyticsScreenProps) {
  // Per-event mode gets a purpose-built overview/sales/attendance layout
  // (Stage 11) built on the new get_event_analytics RPC. Portfolio mode
  // (no eventId — the organizer's whole account) is untouched below.
  if (eventId) {
    return <EventAnalyticsScreen currentUser={currentUser} onBack={onBack} eventId={eventId} eventTitle={eventTitle} />;
  }
  return <PortfolioAnalyticsScreen currentUser={currentUser} onBack={onBack} />;
}

function PortfolioAnalyticsScreen({ currentUser, onBack }: { currentUser: SalesAnalyticsScreenProps['currentUser']; onBack: () => void }) {
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
      if (!currentUser?.id) {
        setLoading(false);
        return;
      }
      try {
        const { data: myEvents, error: eventsError } = await supabase
          .from('events')
          .select('id, ticket_goal')
          .eq('organizer_id', currentUser.id)
          .is('deleted_at', null);

        if (eventsError) throw eventsError;

        if (!myEvents || myEvents.length === 0) {
          setLoading(false);
          return;
        }
        const eventIds = myEvents.map((e: any) => e.id);
        const totalCapacity = myEvents.reduce((sum: number, e: any) => sum + (e.ticket_goal || 0), 0);

        // Matches the canonical "sold" definition used everywhere else
        // (get_event_ticket_stats, see Data Consistency migration):
        // status='active' AND payment_status='paid'. This screen still
        // needs the raw per-ticket rows for the daily/ticket-type
        // breakdown below, so it can't just call the aggregate RPC, but it
        // must apply the same filter or "Total Revenue"/"Tickets Sold"
        // here would silently include pending/unpaid checkouts that
        // OrganizerDashboard and AdminDashboard correctly exclude.
        const { data: tickets, error: ticketsError } = await supabase
          .from('tickets')
          .select('*')
          .in('event_id', eventIds)
          .eq('status', 'active')
          .eq('payment_status', 'paid');

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
            // Use the ticket's own stored amount (the real price actually
            // paid — accounts for the specific ticket type and any promo
            // discount applied at purchase time) rather than a flat
            // event.price lookup, which silently ignored ticket-type pricing
            // and promo discounts. Matches get_event_ticket_stats' convention
            // of not re-multiplying by quantity (rows from purchase_ticket
            // are always qty=1 with amount already being that ticket's price).
            const rev = Number(t.amount) || 0;
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

        // Previously divided by a hardcoded 120 regardless of the event's
        // actual capacity, so "Conversion Rate" was fabricated for any
        // event whose ticket_goal wasn't ~120. Uses the real capacity
        // (summed ticket_goal across the organizer's events) as the
        // denominator; renders 0 rather than a division-by-zero/fake rate
        // when no capacity is set anywhere in scope.
        const conversion = order.map(day => ({
          day,
          rate: dailyRevenue[day] > 0 && totalCapacity > 0
            ? Number(((dailySales[day] / totalCapacity) * 100).toFixed(1))
            : 0
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
        Sentry.captureException(err);
      } finally {
        setLoading(false);
      }
    }

    fetchAnalytics();
  }, [currentUser]);

  if (!currentUser) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8FA8', fontFamily: 'Inter, sans-serif' }}>
        Loading analytics...
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, sans-serif',
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
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={18} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif' }}>Sales Analytics</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '260px' }}>
            This week · All events
          </p>
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
                    background: '#090514',
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
                background: '#090514',
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

// ─── Per-event analytics (Stage 11) ────────────────────────────────────────

interface EventAnalyticsData {
  eventTitle: string;
  currency: string;
  overview: {
    soldCount: number;
    soldQuantity: number;
    ticketGoal: number;
    remaining: number | null;
    grossKobo: number;
    buyerFeeKobo: number;
    organizerEarnedKobo: number;
    pendingCount: number;
    cancelledCount: number;
    refundedCount: number;
  };
  byTicketType: { name: string; soldCount: number; revenueKobo: number; remaining: number | null }[];
  salesTrend: { date: string; count: number; revenueKobo: number }[];
  attendance: { checkedInCount: number; soldQuantity: number; attendancePct: number | null };
  checkinTrend: { date: string; count: number }[];
}

function fmtKobo(kobo: number): string {
  return formatPrice(kobo / 100);
}

function fmtTrendDate(iso: string): string {
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-NG', { month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function StatTile({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div style={{ flex: '1 1 140px', background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px' }}>
      <p style={{ color: '#8B8FA8', fontSize: '11px', marginBottom: '5px' }}>{label}</p>
      <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: sub ? '3px' : 0 }}>{value}</p>
      {sub && <p style={{ color: subColor || '#8B8FA8', fontSize: '11px', fontWeight: 600 }}>{sub}</p>}
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '20px 0 10px' }}>
      {icon}
      <p style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', margin: 0 }}>{title}</p>
    </div>
  );
}

// Small, calm horizontal bars for a date-bucketed trend — deliberately not
// another SVG chart library; this screen already has enough visual weight
// from the portfolio mode's three chart types, and the ask here was to keep
// per-event analytics clean and easy to scan.
function TrendBars({ data, valueKey, color, formatValue }: {
  data: { date: string; [k: string]: any }[];
  valueKey: string;
  color: string;
  formatValue: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {data.map((d) => {
        const v = Number(d[valueKey]) || 0;
        const pct = Math.max(2, Math.round((v / max) * 100));
        return (
          <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ color: '#8B8FA8', fontSize: '11px', width: '52px', flexShrink: 0 }}>{fmtTrendDate(d.date)}</span>
            <div style={{ flex: 1, background: 'rgba(255,255,255,0.04)', borderRadius: '100px', height: '8px', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '100px' }} />
            </div>
            <span style={{ color: '#F0F0FF', fontSize: '11px', fontWeight: 700, width: '64px', textAlign: 'right', flexShrink: 0 }}>{formatValue(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

function EventAnalyticsScreen({ currentUser, onBack, eventId, eventTitle }: { currentUser: SalesAnalyticsScreenProps['currentUser']; onBack: () => void; eventId: string; eventTitle?: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<EventAnalyticsData | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (!currentUser?.id) { setLoading(false); return; }
      setLoading(true);
      setError('');
      try {
        const { data: res, error: err } = await supabase.rpc('get_event_analytics', { p_event_id: eventId });
        if (err) throw new Error(err.message);
        if (alive) setData(res as EventAnalyticsData);
      } catch (e: any) {
        console.error('Failed to load event analytics:', e);
        Sentry.captureException(e);
        if (alive) setError(e?.message || 'Could not load analytics for this event.');
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [currentUser?.id, eventId]);

  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px' }}>
        <button
          onClick={onBack}
          style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <ArrowLeft size={18} color="#C4C9E0" />
        </button>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>Event Analytics</h1>
          <p style={{ color: '#8B8FA8', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '260px', margin: 0 }}>
            {data?.eventTitle || eventTitle || 'This event'}
          </p>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 110px', scrollbarWidth: 'none' }}>
        {loading ? (
          <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px' }}>Loading analytics…</div>
        ) : error ? (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '16px', padding: '16px', textAlign: 'center', marginTop: '20px' }}>
            <p style={{ color: '#F87171', fontSize: '13px', margin: 0 }}>{error}</p>
          </div>
        ) : !data ? (
          <div style={{ color: '#8B8FA8', textAlign: 'center', padding: '40px' }}>No analytics available.</div>
        ) : (
          <>
            {/* 1. OVERVIEW */}
            <SectionHeader icon={<Wallet size={13} color="#A855F7" />} title="Overview" />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '4px' }}>
              <StatTile label="Tickets Sold" value={data.overview.soldQuantity.toLocaleString()} sub={data.overview.pendingCount > 0 ? `${data.overview.pendingCount} pending payment` : undefined} subColor="#F59E0B" />
              {data.overview.remaining !== null && (
                <StatTile label="Tickets Remaining" value={data.overview.remaining.toLocaleString()} sub={`of ${data.overview.ticketGoal.toLocaleString()} capacity`} />
              )}
              <StatTile label="Gross Ticket Sales" value={fmtKobo(data.overview.grossKobo)} sub="paid tickets only" subColor="#10B981" />
              <StatTile label="Organizer Amount Earned" value={fmtKobo(data.overview.organizerEarnedKobo)} sub="credited to your wallet" subColor="#10B981" />
              <StatTile
                label="VENTS Service Fee"
                value={fmtKobo(data.overview.buyerFeeKobo)}
                sub="paid by buyers, not deducted"
              />
            </div>
            {(data.overview.cancelledCount > 0 || data.overview.refundedCount > 0) && (
              <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '10px 2px 0' }}>
                {data.overview.cancelledCount > 0 && `${data.overview.cancelledCount} cancelled`}
                {data.overview.cancelledCount > 0 && data.overview.refundedCount > 0 && ' · '}
                {data.overview.refundedCount > 0 && `${data.overview.refundedCount} refunded`}
                {' — excluded from the figures above.'}
              </p>
            )}

            {/* 2. SALES */}
            <SectionHeader icon={<Ticket size={13} color="#A855F7" />} title="Sales" />
            {data.byTicketType.length === 0 ? (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
                <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0 }}>No ticket sales yet.</p>
              </div>
            ) : (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px', marginBottom: '14px' }}>
                <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>By Ticket Type</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {data.byTicketType.map((t) => (
                    <div key={t.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</p>
                        <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                          {t.soldCount} sold{t.remaining !== null ? ` · ${t.remaining} left` : ''}
                        </p>
                      </div>
                      <span style={{ color: '#10B981', fontSize: '13px', fontWeight: 700, flexShrink: 0 }}>{fmtKobo(t.revenueKobo)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.salesTrend.length === 0 ? (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '20px', textAlign: 'center', marginBottom: '4px' }}>
                <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0 }}>Sales trend will appear here once tickets start selling.</p>
              </div>
            ) : (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px', marginBottom: '4px' }}>
                <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, marginBottom: '12px' }}>Sales by Date</p>
                <TrendBars data={data.salesTrend} valueKey="count" color="#A855F7" formatValue={(v) => `${v} sold`} />
              </div>
            )}

            {/* 3. ATTENDANCE */}
            <SectionHeader icon={<Users size={13} color="#A855F7" />} title="Attendance" />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
              <StatTile label="Total Checked In" value={data.attendance.checkedInCount.toLocaleString()} />
              <StatTile
                label="Attendance %"
                value={data.attendance.attendancePct !== null ? `${data.attendance.attendancePct}%` : '—'}
                sub={data.attendance.attendancePct === null ? 'No sales yet' : `of ${data.attendance.soldQuantity.toLocaleString()} sold`}
              />
            </div>

            {data.checkinTrend.length === 0 ? (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '20px', textAlign: 'center' }}>
                <p style={{ color: '#8B8FA8', fontSize: '13px', margin: 0 }}>No check-ins recorded yet.</p>
              </div>
            ) : (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                  <TrendingUp size={13} color="#10B981" />
                  <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, margin: 0 }}>Check-ins by Date</p>
                </div>
                <TrendBars data={data.checkinTrend} valueKey="count" color="#10B981" formatValue={(v) => `${v} in`} />
              </div>
            )}

            <p style={{ color: '#555C7A', fontSize: '10.5px', textAlign: 'center', margin: '18px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
              <Receipt size={11} /> All figures in NGN — paid, active tickets only.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

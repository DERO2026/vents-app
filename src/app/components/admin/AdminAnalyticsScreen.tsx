// Analytics — ported from the legacy AdminDashboardScreen.tsx 'stats' tab
// as part of its full retirement. Subscribes to the same 'admin:stats'
// realtime channel so numbers stay live without a manual refresh.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';

interface Stats { users: number; events: number; tickets: number; vc: number; revenue: number; newThisWeek: number; newThisMonth: number; }

export function AdminAnalyticsScreen() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(() => {
    setLoading(true);
    Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('events').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid'),
      supabase.from('vc_transactions').select('amount').eq('type', 'earn').eq('status', 'active'),
      supabase.from('tickets').select('amount').eq('payment_status', 'paid'),
      supabase.rpc('admin_get_new_user_stats' as any),
    ]).then(([uRes, eRes, tRes, vcRes, revRes, newUserRes]) => {
      const vcTotal = (vcRes.data || []).reduce((s: number, r: any) => s + Number(r.amount), 0);
      const revenue = (revRes.data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const newUserRow = (newUserRes.data || [])[0] || {};
      setStats({
        users: uRes.count ?? 0, events: eRes.count ?? 0, tickets: tRes.count ?? 0, vc: vcTotal, revenue,
        newThisWeek: newUserRow.new_this_week ?? 0, newThisMonth: newUserRow.new_this_month ?? 0,
      });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase.channel('admin:stats', { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'admin_stats_changed' }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadStats, 300);
    });
    channel.subscribe();
    return () => { if (debounceTimer) clearTimeout(debounceTimer); supabase.removeChannel(channel); };
  }, [loadStats]);

  return (
    <div data-testid="admin-analytics" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {loading && !stats ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 32 }}>Loading stats…</div>
      ) : stats ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Total Users', value: stats.users.toLocaleString(), color: adminTheme.blue },
              { label: 'Total Events', value: stats.events.toLocaleString(), color: adminTheme.accentFrom },
              { label: 'Paid Tickets', value: stats.tickets.toLocaleString(), color: adminTheme.green },
              { label: 'Active VC', value: stats.vc.toLocaleString(), color: adminTheme.amber },
              { label: 'Total Revenue', value: '₦' + stats.revenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }), color: '#34D399' },
              { label: 'New Users This Week', value: stats.newThisWeek.toLocaleString(), color: '#60A5FA' },
              { label: 'New Users This Month', value: stats.newThisMonth.toLocaleString(), color: '#818CF8' },
            ].map((c) => (
              <div key={c.label} style={{ background: adminTheme.panelAlt, border: `1px solid ${c.color}25`, borderRadius: 14, padding: 16 }}>
                <div style={{ color: adminTheme.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>{c.label}</div>
                <div style={{ color: c.color, fontSize: 22, fontWeight: 800 }}>{c.value}</div>
              </div>
            ))}
          </div>
          <p style={{ color: adminTheme.textFainter, fontSize: 11, textAlign: 'center', marginTop: 8 }}>Live — updates automatically as transactions, payouts, and signups happen.</p>
        </>
      ) : (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 32 }}>No data.</div>
      )}
    </div>
  );
}

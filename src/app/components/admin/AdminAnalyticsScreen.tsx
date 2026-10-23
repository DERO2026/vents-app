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
  const [error, setError] = useState<string | null>(null);

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
      // A failed query here previously fell through to the catch below,
      // which only cleared `loading` and left `stats` untouched -- on a
      // refresh triggered by the admin:stats broadcast, that meant a
      // transient failure silently kept showing the LAST successful
      // numbers forever, with nothing telling the admin the refresh had
      // actually stopped working. Any one of the six queries erroring
      // (RLS, network) is now surfaced instead of swallowed.
      const firstError = [uRes.error, eRes.error, tRes.error, vcRes.error, revRes.error, newUserRes.error].find(Boolean);
      if (firstError) { setError((firstError as any)?.message || 'Failed to load analytics.'); setLoading(false); return; }
      setError(null);
      const vcTotal = (vcRes.data || []).reduce((s: number, r: any) => s + Number(r.amount), 0);
      const revenue = (revRes.data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const newUserRow = (newUserRes.data || [])[0] || {};
      setStats({
        users: uRes.count ?? 0, events: eRes.count ?? 0, tickets: tRes.count ?? 0, vc: vcTotal, revenue,
        newThisWeek: newUserRow.new_this_week ?? 0, newThisMonth: newUserRow.new_this_month ?? 0,
      });
      setLoading(false);
    }).catch((e: any) => { setError(e?.message || 'Failed to load analytics.'); setLoading(false); });
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
      {error && (
        <div style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.25)', borderRadius: 12, padding: '14px 16px', color: adminTheme.red, fontSize: 12.5 }}>
          Could not refresh analytics: {error}{stats ? ' — showing the last successful numbers.' : ''}
        </div>
      )}
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

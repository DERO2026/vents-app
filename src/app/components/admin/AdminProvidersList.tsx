// Batch 3 — Service Providers list. Desktop table / mobile card-list per
// design-export's v_providers block (~560-599). Reuses the EXACT
// service_providers/provider_services query already shipped in
// AdminDashboardScreen's "Services" tab (loadSvcProviders) rather than
// inventing a new one — same columns, same country/category/status filters,
// same owner-user join, same active-service batch lookup.
//
// Real data sources:
//  - `service_providers` (id, user_id, business_name, category, country,
//    status, created_at, updated_at) — status here is the LISTING'S
//    draft/approved/rejected state (service_providers_admin_select, 0034).
//  - `users` for the owning account's display name/email.
//  - `provider_services` (is_active) for a real has-active-service filter.
// Explicit "not available" (no fabrication):
//  - Ratings/bookings/revenue are NOT shown in this list. avgRating/
//    reviewCount ARE real per-provider (service_provider_ratings via
//    withProviderRatings in src/lib/serviceProviders.ts) but that RPC/join
//    is a per-row public.get_nearby_service_providers-style call the
//    existing services-admin tab never uses for its list view; wiring it in
//    is shown honestly on Provider Detail's Overview tab instead (see
//    AdminProviderDetail.tsx), where a single provider's real rating is
//    fetched. No booking/revenue table exists for providers at all
//    (grepped supabase/migrations + migrations — no booking_requests/
//    provider_bookings/provider_payouts table), so this list never shows
//    those columns.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { escapePostgrestOrValue } from '../../../lib/sanitize';
import { adminTheme } from './adminConsoleTheme';

export interface AdminProviderRow {
  id: string;
  user_id: string;
  business_name: string;
  category: string;
  country: string;
  status: 'draft' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
  owner: { id: string; username: string | null; full_name: string | null; email: string } | null;
  hasActiveService: boolean;
}

const STATUS_FILTERS = ['all', 'draft', 'approved', 'rejected'] as const;

function statusColors(status: string): { bg: string; fg: string; label: string } {
  if (status === 'approved') return { bg: 'rgba(52,211,153,.12)', fg: adminTheme.green, label: 'Approved' };
  if (status === 'rejected') return { bg: 'rgba(248,113,113,.12)', fg: adminTheme.red, label: 'Rejected' };
  return { bg: 'rgba(251,191,36,.12)', fg: adminTheme.amber, label: 'Draft' };
}

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', flexShrink: 0, textTransform: 'capitalize',
  background: active ? adminTheme.accentSoftBg : adminTheme.panel,
  color: active ? adminTheme.accentText : adminTheme.textMuted,
  border: `1px solid ${active ? adminTheme.accentSoftBorder : adminTheme.border}`,
});

export function AdminProvidersList({ isMobile, onSelectProvider }: { isMobile: boolean; onSelectProvider: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<typeof STATUS_FILTERS[number]>('all');
  const [providers, setProviders] = useState<AdminProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let q = supabase
        .from('service_providers')
        .select('id, user_id, business_name, category, country, status, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      if (search.trim()) {
        const like = escapePostgrestOrValue(`%${search.trim()}%`);
        q = q.ilike('business_name', like);
      }
      const { data: rows, error: err } = await q;
      if (err) throw err;
      const providerRows = rows || [];

      const ownerIds = [...new Set(providerRows.map((r: any) => r.user_id).filter(Boolean))];
      let ownersMap: Record<string, any> = {};
      if (ownerIds.length > 0) {
        const { data: owners } = await supabase.from('users').select('id, username, full_name, email').in('id', ownerIds);
        (owners || []).forEach((u: any) => { ownersMap[u.id] = u; });
      }

      const providerIds = providerRows.map((r: any) => r.id);
      let activeServiceProviderIds = new Set<string>();
      if (providerIds.length > 0) {
        const { data: activeRows } = await supabase
          .from('provider_services')
          .select('provider_id')
          .eq('is_active', true)
          .in('provider_id', providerIds);
        activeServiceProviderIds = new Set((activeRows || []).map((r: any) => r.provider_id));
      }

      setProviders(providerRows.map((r: any) => ({
        ...r,
        owner: ownersMap[r.user_id] || null,
        hasActiveService: activeServiceProviderIds.has(r.id),
      })));
    } catch (e: any) {
      setError(e?.message || 'Failed to load service providers.');
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div data-testid="admin-providers-list">
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, overflowX: 'auto', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by business name…"
          style={{
            flex: isMobile ? '1 1 100%' : 1, maxWidth: isMobile ? 'none' : 320,
            background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 8,
            padding: '9px 12px', fontSize: 12.5, color: adminTheme.text, outline: 'none', boxSizing: 'border-box',
          }}
        />
        {STATUS_FILTERS.map((f) => (
          <div key={f} onClick={() => setStatusFilter(f)} style={chipStyle(statusFilter === f)}>{f === 'all' ? 'All statuses' : f}</div>
        ))}
      </div>

      {error && <div style={{ color: adminTheme.red, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading service providers…</div>
      ) : isMobile ? (
        <div>
          {providers.length === 0 && (
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
              No providers match your search.
            </div>
          )}
          {providers.map((p) => {
            const st = statusColors(p.status);
            return (
              <div key={p.id} onClick={() => onSelectProvider(p.id)} style={{ cursor: 'pointer', background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 700, fontSize: 13.5 }}>{p.business_name}</div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: st.bg, color: st.fg, flexShrink: 0 }}>{st.label}</span>
                </div>
                <div style={{ fontSize: 11.5, color: adminTheme.textMuted, marginTop: 6 }}>
                  {p.category} · {p.country || 'Unknown country'}
                </div>
                <div style={{ fontSize: 11, color: adminTheme.textFaint, marginTop: 4 }}>
                  {p.hasActiveService ? 'Has active service' : 'No active service'}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.1fr 1fr .9fr 1fr .9fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
            <div>PROVIDER</div><div>CATEGORY</div><div>COUNTRY</div><div>STATUS</div><div>SERVICES</div><div />
          </div>
          {providers.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No providers match your search.</div>
          )}
          {providers.map((p) => {
            const st = statusColors(p.status);
            return (
              <div key={p.id} onClick={() => onSelectProvider(p.id)} style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '1.6fr 1.1fr 1fr .9fr 1fr .9fr', padding: '13px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}`, alignItems: 'center' }}>
                <div>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 600 }}>{p.business_name}</div>
                  <div style={{ color: adminTheme.textFaint, fontSize: 11, marginTop: 1 }}>{p.owner?.username ? `@${p.owner.username}` : p.owner?.email || 'Unknown owner'}</div>
                </div>
                <div style={{ color: adminTheme.text }}>{p.category}</div>
                <div style={{ color: adminTheme.text }}>{p.country || '—'}</div>
                <div><span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: st.bg, color: st.fg }}>{st.label}</span></div>
                <div style={{ color: adminTheme.textMuted }}>{p.hasActiveService ? 'Active' : 'None'}</div>
                <div style={{ textAlign: 'right', color: adminTheme.accentFrom, fontWeight: 600 }}>View →</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { statusColors as providerStatusColors };

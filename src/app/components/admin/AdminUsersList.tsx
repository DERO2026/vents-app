// Batch 2 — Users list. Desktop table / mobile card-list per
// design-export/"VENTS Admin Console.dc.html" (v_users block, lines
// ~169-217): search bar + role/status filter chips, table with
// USER/ROLE/COUNTRY-CITY/STATUS/VERIFICATION/LAST ACTIVE columns on desktop,
// a stacked card per user on mobile. Backed by the same `users` table query
// AdminDashboardScreen's Users tab already runs (loadUsers) — role/status
// filters are real column filters (server-side), not client-only slicing.
//
// RECONCILED against the multi-role architecture fix
// (0121_organizer_capability_independent_of_role.sql): `role` now
// represents staff tier only (user/sub-admin/admin). Organizer and Service
// Provider are independent capability booleans (is_organizer,
// is_service_provider) that can coexist with each other and with any staff
// tier -- so "ROLE" is no longer a single mutually-exclusive filter/column.
// The staff-tier filter chips (All/User/Sub-Admin/Admin) and the capability
// filter chips (Organizer/Service Provider, independently toggleable) are
// now separate, and the table/card shows both a staff-tier label and
// however many capability badges actually apply.
//
// Pagination note: the underlying query has no .range()/.limit() today (see
// AdminDashboardScreen.tsx loadUsers) — this list keeps that same
// unbounded-fetch behavior rather than inventing pagination the backend
// doesn't support elsewhere in the app.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { escapePostgrestOrValue } from '../../../lib/sanitize';
import { adminTheme } from './adminConsoleTheme';

export interface AdminUserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  is_organizer: boolean;
  is_service_provider: boolean;
  username: string | null;
  state: string | null;
  status: string;
  is_verified: boolean;
  created_at: string;
  banned_until: string | null;
}

const STAFF_FILTERS = ['all', 'user', 'sub-admin', 'admin'] as const;
const CAPABILITY_FILTERS = ['organizer', 'service_provider'] as const;
const STATUS_FILTERS = ['all', 'active', 'suspended', 'deleted'] as const;

export function staffLabel(role: string): string {
  return role === 'admin' ? 'Admin' : role === 'sub-admin' ? 'Sub-Admin' : 'User';
}

function statusColors(status: string): { bg: string; fg: string; label: string } {
  if (status === 'active') return { bg: 'rgba(52,211,153,.12)', fg: adminTheme.green, label: 'Active' };
  if (status === 'suspended') return { bg: 'rgba(251,191,36,.12)', fg: adminTheme.amber, label: 'Suspended' };
  if (status === 'deleted') return { bg: 'rgba(248,113,113,.12)', fg: adminTheme.red, label: 'Deleted' };
  return { bg: adminTheme.borderChip, fg: adminTheme.textMuted, label: status };
}

function verifColors(verified: boolean) {
  return verified
    ? { bg: 'rgba(96,165,250,.12)', fg: adminTheme.blue, label: 'Verified' }
    : { bg: adminTheme.borderChip, fg: adminTheme.textFaint, label: 'Unverified' };
}

function initials(name: string | null, email: string) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function CapabilityBadges({ isOrganizer, isServiceProvider }: { isOrganizer: boolean; isServiceProvider: boolean }) {
  if (!isOrganizer && !isServiceProvider) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {isOrganizer && (
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 6, background: 'rgba(163,92,255,.16)', color: adminTheme.accentText }}>Organizer</span>
      )}
      {isServiceProvider && (
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 6, background: 'rgba(96,165,250,.14)', color: adminTheme.blue }}>Service Provider</span>
      )}
    </span>
  );
}

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
  background: active ? adminTheme.accentSoftBg : adminTheme.panel,
  color: active ? adminTheme.accentText : adminTheme.textMuted,
  border: `1px solid ${active ? adminTheme.accentSoftBorder : adminTheme.border}`,
});

export function AdminUsersList({ isMobile, onSelectUser }: { isMobile: boolean; onSelectUser: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [staffFilter, setStaffFilter] = useState<typeof STAFF_FILTERS[number]>('all');
  // Independent, multi-select capability filters -- an admin can filter for
  // Organizer, Service Provider, or both at once, since a real account can
  // hold both capabilities at the same time.
  const [capabilityFilters, setCapabilityFilters] = useState<Set<typeof CAPABILITY_FILTERS[number]>>(new Set());
  const [statusFilter, setStatusFilter] = useState<typeof STATUS_FILTERS[number]>('all');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const toggleCapability = (f: typeof CAPABILITY_FILTERS[number]) => {
    setCapabilityFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let q = supabase
        .from('users')
        .select('id, email, full_name, role, is_organizer, is_service_provider, username, state, status, is_verified, created_at, banned_until')
        .order('created_at', { ascending: false });

      if (statusFilter === 'all') q = q.neq('status', 'deleted');
      else q = q.eq('status', statusFilter);

      if (staffFilter !== 'all') q = q.eq('role', staffFilter);
      if (capabilityFilters.has('organizer')) q = q.eq('is_organizer', true);
      if (capabilityFilters.has('service_provider')) q = q.eq('is_service_provider', true);

      if (search.trim()) {
        const like = escapePostgrestOrValue(`%${search.trim().toLowerCase()}%`);
        q = q.or(`full_name.ilike.${like},username.ilike.${like},email.ilike.${like}`);
      }

      const { data, error: err } = await q;
      if (err) throw err;
      setUsers(data || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, [search, staffFilter, capabilityFilters, statusFilter]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce search keystrokes
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div data-testid="admin-users-list">
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, overflowX: 'auto', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, phone…"
          style={{
            flex: isMobile ? '1 1 100%' : 1, maxWidth: isMobile ? 'none' : 320,
            background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 8,
            padding: '9px 12px', fontSize: 12.5, color: adminTheme.text, outline: 'none', boxSizing: 'border-box',
          }}
        />
        {STAFF_FILTERS.map((f) => (
          <div key={f} onClick={() => setStaffFilter(f)} style={chipStyle(staffFilter === f)}>{f === 'all' ? 'All access' : staffLabel(f)}</div>
        ))}
        {CAPABILITY_FILTERS.map((f) => (
          <div key={f} onClick={() => toggleCapability(f)} style={chipStyle(capabilityFilters.has(f))}>
            {f === 'organizer' ? 'Organizer' : 'Service Provider'}
          </div>
        ))}
        {STATUS_FILTERS.map((f) => (
          <div key={f} onClick={() => setStatusFilter(f)} style={chipStyle(statusFilter === f)}>{f === 'all' ? 'All statuses' : f}</div>
        ))}
      </div>

      {error && <div style={{ color: adminTheme.red, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading users…</div>
      ) : isMobile ? (
        <div>
          {users.length === 0 && (
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
              No users match your search.
            </div>
          )}
          {users.map((u) => {
            const st = statusColors(u.status);
            return (
              <div key={u.id} onClick={() => onSelectUser(u.id)} style={{ cursor: 'pointer', background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <div style={{ color: adminTheme.textStrong, fontWeight: 700, fontSize: 13.5 }}>{u.full_name || 'No name'}</div>
                    <div style={{ color: adminTheme.textFaint, fontSize: 11.5, marginTop: 2 }}>{u.email}</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: st.bg, color: st.fg, flexShrink: 0 }}>{st.label}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11.5, color: adminTheme.textMuted, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>{staffLabel(u.role)}</span><span>·</span><span>{u.state || 'Unknown'}</span><span>·</span>
                  <span>{new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</span>
                </div>
                <div style={{ marginTop: 8 }}>
                  <CapabilityBadges isOrganizer={u.is_organizer} isServiceProvider={u.is_service_provider} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr .8fr 1.1fr .8fr .8fr .9fr 1fr .8fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
            <div>USER</div><div>ACCESS</div><div>CAPABILITIES</div><div>STATE</div><div>STATUS</div><div>VERIFICATION</div><div>JOINED</div><div />
          </div>
          {users.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No users match your search.</div>
          )}
          {users.map((u) => {
            const st = statusColors(u.status);
            const vf = verifColors(u.is_verified);
            return (
              <div key={u.id} onClick={() => onSelectUser(u.id)} style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '1.5fr .8fr 1.1fr .8fr .8fr .9fr 1fr .8fr', padding: '13px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}`, alignItems: 'center' }}>
                <div>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 600 }}>{u.full_name || 'No name'}</div>
                  <div style={{ color: adminTheme.textFaint, fontSize: 11, marginTop: 1 }}>{u.email}</div>
                </div>
                <div style={{ color: adminTheme.text }}>{staffLabel(u.role)}</div>
                <div><CapabilityBadges isOrganizer={u.is_organizer} isServiceProvider={u.is_service_provider} /></div>
                <div style={{ color: adminTheme.text }}>{u.state || '—'}</div>
                <div><span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: st.bg, color: st.fg }}>{st.label}</span></div>
                <div><span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: vf.bg, color: vf.fg }}>{vf.label}</span></div>
                <div style={{ color: adminTheme.textMuted }}>{new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>
                <div style={{ textAlign: 'right', color: adminTheme.accentFrom, fontWeight: 600 }}>View →</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { initials, statusColors, verifColors };

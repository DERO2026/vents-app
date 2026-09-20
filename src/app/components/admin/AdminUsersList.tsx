// Batch 2 — Users list. Desktop table / mobile card-list per
// design-export/"VENTS Admin Console.dc.html" (v_users block, lines
// ~169-217): search bar + role/status filter chips, table with
// USER/ROLE/COUNTRY-CITY/STATUS/VERIFICATION/LAST ACTIVE columns on desktop,
// a stacked card per user on mobile. Backed by the same `users` table query
// AdminDashboardScreen's Users tab already runs (loadUsers) — role/status
// filters are real column filters (server-side), not client-only slicing.
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
  username: string | null;
  state: string | null;
  status: string;
  is_verified: boolean;
  created_at: string;
  banned_until: string | null;
}

const ROLE_FILTERS = ['all', 'attendee', 'organizer', 'sub-admin', 'admin'] as const;
const STATUS_FILTERS = ['all', 'active', 'suspended', 'deleted'] as const;

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

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
  background: active ? adminTheme.accentSoftBg : adminTheme.panel,
  color: active ? adminTheme.accentText : adminTheme.textMuted,
  border: `1px solid ${active ? adminTheme.accentSoftBorder : adminTheme.border}`,
});

export function AdminUsersList({ isMobile, onSelectUser }: { isMobile: boolean; onSelectUser: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<typeof ROLE_FILTERS[number]>('all');
  const [statusFilter, setStatusFilter] = useState<typeof STATUS_FILTERS[number]>('all');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let q = supabase
        .from('users')
        .select('id, email, full_name, role, username, state, status, is_verified, created_at, banned_until')
        .order('created_at', { ascending: false });

      if (statusFilter === 'all') q = q.neq('status', 'deleted');
      else q = q.eq('status', statusFilter);

      if (roleFilter !== 'all') q = q.eq('role', roleFilter);

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
  }, [search, roleFilter, statusFilter]);

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
        {ROLE_FILTERS.map((f) => (
          <div key={f} onClick={() => setRoleFilter(f)} style={chipStyle(roleFilter === f)}>{f === 'all' ? 'All roles' : f}</div>
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
                <div style={{ display: 'flex', gap: 10, marginTop: 10, fontSize: 11.5, color: adminTheme.textMuted, flexWrap: 'wrap' }}>
                  <span>{u.role}</span><span>·</span><span>{u.state || 'Unknown'}</span><span>·</span>
                  <span>{new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr .9fr .9fr 1fr .9fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
            <div>USER</div><div>ROLE</div><div>STATE</div><div>STATUS</div><div>VERIFICATION</div><div>JOINED</div><div />
          </div>
          {users.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No users match your search.</div>
          )}
          {users.map((u) => {
            const st = statusColors(u.status);
            const vf = verifColors(u.is_verified);
            return (
              <div key={u.id} onClick={() => onSelectUser(u.id)} style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr .9fr .9fr 1fr .9fr', padding: '13px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}`, alignItems: 'center' }}>
                <div>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 600 }}>{u.full_name || 'No name'}</div>
                  <div style={{ color: adminTheme.textFaint, fontSize: 11, marginTop: 1 }}>{u.email}</div>
                </div>
                <div style={{ color: adminTheme.text }}>{u.role}</div>
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

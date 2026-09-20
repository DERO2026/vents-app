// Batch 3 — Organizers list. Per the brief, built from EXISTING users
// (role='organizer') + events + organizer_verification_requests — no new
// organizer backend or table is invented. Desktop table / mobile card-list
// per design-export's v_organizers block (~451-489).
//
// Real data sources:
//  - `users` filtered to role='organizer' (same table/columns Batch 2's
//    Users list already reads) for name/state/is_verified/created_at.
//  - `events` for a real per-organizer event count — a single grouped-count
//    query (id, organizer_id) over the page's organizer ids, counted
//    client-side, is.deleted_at null — the exact same table+FK Batch 2's
//    Events list already filters by organizer_id, just aggregated here
//    instead of listed.
//  - `organizer_verification_requests` (latest row per organizer, via
//    admin_list_organizer_verifications RPC already shipped in
//    AdminDashboardScreen's Verify tab) for a real CAC verification status,
//    separate from users.is_verified (the trust badge) which is also shown.
// No fabricated attendee/revenue counts — those are not queried anywhere in
// this list.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { escapePostgrestOrValue } from '../../../lib/sanitize';
import { adminTheme } from './adminConsoleTheme';

export interface AdminOrganizerRow {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string;
  state: string | null;
  is_verified: boolean;
  created_at: string;
  eventCount: number;
  cacStatus: string | null; // from organizer_verification_requests, or null if none filed
}

const VERIF_FILTERS = ['all', 'verified', 'unverified', 'cac-pending'] as const;

function verifChip(o: AdminOrganizerRow): { bg: string; fg: string; label: string } {
  if (o.cacStatus === 'pending') return { bg: 'rgba(251,191,36,.12)', fg: adminTheme.amber, label: 'CAC Pending' };
  if (o.is_verified) return { bg: 'rgba(96,165,250,.12)', fg: adminTheme.blue, label: 'Verified' };
  return { bg: adminTheme.borderChip, fg: adminTheme.textFaint, label: 'Unverified' };
}

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 11.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
  background: active ? adminTheme.accentSoftBg : adminTheme.panel,
  color: active ? adminTheme.accentText : adminTheme.textMuted,
  border: `1px solid ${active ? adminTheme.accentSoftBorder : adminTheme.border}`,
});

export function AdminOrganizersList({ isMobile, onSelectOrganizer }: { isMobile: boolean; onSelectOrganizer: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [verifFilter, setVerifFilter] = useState<typeof VERIF_FILTERS[number]>('all');
  const [organizers, setOrganizers] = useState<AdminOrganizerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let q = supabase
        .from('users')
        .select('id, full_name, username, email, state, is_verified, created_at')
        .eq('role', 'organizer')
        .order('created_at', { ascending: false })
        .limit(200);
      if (search.trim()) {
        const like = escapePostgrestOrValue(`%${search.trim().toLowerCase()}%`);
        q = q.or(`full_name.ilike.${like},username.ilike.${like},email.ilike.${like}`);
      }
      const { data: rows, error: err } = await q;
      if (err) throw err;
      const orgRows = rows || [];
      const ids = orgRows.map((r: any) => r.id);

      let eventCounts: Record<string, number> = {};
      if (ids.length > 0) {
        const { data: evRows } = await supabase.from('events').select('organizer_id').is('deleted_at', null).in('organizer_id', ids);
        (evRows || []).forEach((e: any) => { eventCounts[e.organizer_id] = (eventCounts[e.organizer_id] || 0) + 1; });
      }

      // admin_list_organizer_verifications (SECURITY DEFINER, admin-gated,
      // already shipped for the Verify tab) — pull enough rows to cover this
      // page's organizers and keep only each one's latest request.
      let cacByUser: Record<string, string> = {};
      try {
        const { data: cacRows } = await supabase.rpc('admin_list_organizer_verifications' as any, {
          p_status: 'all', p_search: null, p_limit: 200, p_offset: 0,
        });
        (cacRows || []).forEach((r: any) => {
          if (!cacByUser[r.user_id] || new Date(r.created_at) > new Date(cacByUser[r.user_id + '__at'] || 0)) {
            cacByUser[r.user_id] = r.status;
            cacByUser[r.user_id + '__at'] = r.created_at;
          }
        });
      } catch { /* verification status is a display enhancement, never blocks the list */ }

      let merged: AdminOrganizerRow[] = orgRows.map((r: any) => ({
        ...r,
        eventCount: eventCounts[r.id] || 0,
        cacStatus: cacByUser[r.id] || null,
      }));

      if (verifFilter === 'verified') merged = merged.filter((o) => o.is_verified);
      else if (verifFilter === 'unverified') merged = merged.filter((o) => !o.is_verified);
      else if (verifFilter === 'cac-pending') merged = merged.filter((o) => o.cacStatus === 'pending');

      setOrganizers(merged);
    } catch (e: any) {
      setError(e?.message || 'Failed to load organizers.');
      setOrganizers([]);
    } finally { setLoading(false); }
  }, [search, verifFilter]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div data-testid="admin-organizers-list">
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, overflowX: 'auto', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by organizer name or email…"
          style={{
            flex: isMobile ? '1 1 100%' : 1, maxWidth: isMobile ? 'none' : 320,
            background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 8,
            padding: '9px 12px', fontSize: 12.5, color: adminTheme.text, outline: 'none', boxSizing: 'border-box',
          }}
        />
        {VERIF_FILTERS.map((f) => (
          <div key={f} onClick={() => setVerifFilter(f)} style={chipStyle(verifFilter === f)}>{f === 'all' ? 'All' : f.replace('-', ' ')}</div>
        ))}
      </div>

      {error && <div style={{ color: adminTheme.red, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading organizers…</div>
      ) : isMobile ? (
        <div>
          {organizers.length === 0 && (
            <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
              No organizers match your search.
            </div>
          )}
          {organizers.map((o) => {
            const vc = verifChip(o);
            return (
              <div key={o.id} onClick={() => onSelectOrganizer(o.id)} style={{ cursor: 'pointer', background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 700, fontSize: 13.5 }}>{o.full_name || o.username || 'No name'}</div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: vc.bg, color: vc.fg, flexShrink: 0 }}>{vc.label}</span>
                </div>
                <div style={{ fontSize: 11.5, color: adminTheme.textMuted, marginTop: 6 }}>{o.state || 'Unknown state'} · {o.eventCount} events</div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr .9fr 1fr 1fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
            <div>ORGANIZER</div><div>STATE</div><div>EVENTS</div><div>VERIFICATION</div><div />
          </div>
          {organizers.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No organizers match your search.</div>
          )}
          {organizers.map((o) => {
            const vc = verifChip(o);
            return (
              <div key={o.id} onClick={() => onSelectOrganizer(o.id)} style={{ cursor: 'pointer', display: 'grid', gridTemplateColumns: '1.6fr 1fr .9fr 1fr 1fr', padding: '13px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}`, alignItems: 'center' }}>
                <div>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 600 }}>{o.full_name || o.username || 'No name'}</div>
                  <div style={{ color: adminTheme.textFaint, fontSize: 11, marginTop: 1 }}>{o.email}</div>
                </div>
                <div style={{ color: adminTheme.text }}>{o.state || '—'}</div>
                <div style={{ color: adminTheme.text }}>{o.eventCount}</div>
                <div><span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: vc.bg, color: vc.fg }}>{vc.label}</span></div>
                <div style={{ textAlign: 'right', color: adminTheme.accentFrom, fontWeight: 600 }}>View →</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { verifChip as organizerVerifChip };

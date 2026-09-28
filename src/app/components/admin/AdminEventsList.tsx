// Batch 2 — Events list. Desktop table / mobile card-list per
// design-export's v_events block (~328-364). Reuses the exact query
// AdminDashboardScreen's loadEvents already runs (same table, same
// organizer join, same 50-row limit) and the same admin RPCs for actions.
import React, { useState, useEffect, useCallback } from 'react';
import { BadgeCheck } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { isSuperAdmin as permIsSuperAdmin, type PermissionUser } from '../../../lib/permissions';
import { hideEvent, reinstateEvent, restoreDeletedEvent, toggleEventFeatured } from './adminUserEventActions';

interface AdminEventRow {
  id: string; title: string | null; organizer_id: string | null; hidden_by_admin: boolean;
  hidden_at: string | null; created_at: string; event_date: string | null; deleted_at: string | null;
  is_featured: boolean; featured_until: string | null; image_url: string | null;
  'users!events_organizer_id_fkey'?: { username: string | null; full_name: string | null; is_verified: boolean } | null;
}

function statusChip(ev: AdminEventRow): { bg: string; fg: string; label: string } {
  if (ev.deleted_at) return { bg: 'rgba(248,113,113,.12)', fg: adminTheme.red, label: 'Deleted' };
  if (ev.hidden_by_admin) return { bg: 'rgba(251,191,36,.12)', fg: adminTheme.amber, label: 'Hidden' };
  return { bg: 'rgba(52,211,153,.12)', fg: adminTheme.green, label: 'Visible' };
}

const FILTERS = ['active', 'hidden', 'deleted', 'featured'] as const;

export function AdminEventsList({ isMobile, currentUser, onSelectEvent }: {
  isMobile: boolean; currentUser: PermissionUser | null | undefined; onSelectEvent: (id: string) => void;
}) {
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const [filter, setFilter] = useState<typeof FILTERS[number]>('active');
  const [events, setEvents] = useState<AdminEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let q = supabase
        .from('events')
        .select('id, title, organizer_id, hidden_by_admin, hidden_at, created_at, event_date, deleted_at, is_featured, featured_until, image_url, users!events_organizer_id_fkey(username, full_name, is_verified)')
        .order('created_at', { ascending: false })
        .limit(50);
      if (filter === 'deleted') q = q.not('deleted_at', 'is', null);
      else {
        q = q.is('deleted_at', null);
        if (filter === 'hidden') q = q.eq('hidden_by_admin', true);
        if (filter === 'featured') q = q.eq('is_featured', true);
      }
      const { data, error: err } = await q;
      if (err) throw err;
      setEvents((data as any) || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load events.');
    } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const doAction = async (id: string, label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusyId(id);
    const res = await fn();
    flash(res.ok, res.message);
    if (res.ok) await load();
    setBusyId(null);
  };

  return (
    <div data-testid="admin-events-list">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {FILTERS.map((f) => (
          <div key={f} onClick={() => setFilter(f)} style={{
            fontSize: 11.5, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', flexShrink: 0, textTransform: 'capitalize',
            background: filter === f ? adminTheme.accentSoftBg : adminTheme.panel,
            color: filter === f ? adminTheme.accentText : adminTheme.textMuted,
            border: `1px solid ${filter === f ? adminTheme.accentSoftBorder : adminTheme.border}`,
          }}>{f}</div>
        ))}
      </div>
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}
      {error && <div style={{ color: adminTheme.red, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading events…</div>
      ) : isMobile ? (
        <div>
          {events.length === 0 && <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No events found.</div>}
          {events.map((ev) => {
            const organizer = ev['users!events_organizer_id_fkey'];
            const sc = statusChip(ev);
            return (
              <div key={ev.id} onClick={() => onSelectEvent(ev.id)} style={{ cursor: 'pointer', background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ color: adminTheme.textStrong, fontWeight: 700, fontSize: 13.5 }}>{ev.title || '(Untitled)'}</div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: sc.bg, color: sc.fg, flexShrink: 0 }}>{sc.label}</span>
                </div>
                <div style={{ fontSize: 11.5, color: adminTheme.textMuted, marginTop: 6 }}>
                  {organizer?.username ? `@${organizer.username}` : organizer?.full_name || 'Unknown organizer'}
                  {ev.event_date && ` · ${new Date(ev.event_date).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`}
                </div>
                {ev.is_featured && <div style={{ fontSize: 11, color: adminTheme.amber, marginTop: 4 }}>★ Featured</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 1.2fr 1fr .9fr 1.4fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
            <div>EVENT</div><div>ORGANIZER</div><div>DATE</div><div>STATUS</div><div>ACTIONS</div>
          </div>
          {events.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No events found.</div>}
          {events.map((ev) => {
            const organizer = ev['users!events_organizer_id_fkey'];
            const sc = statusChip(ev);
            const isBusy = busyId === ev.id;
            const label = ev.title || ev.id;
            return (
              <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '1.8fr 1.2fr 1fr .9fr 1.4fr', padding: '13px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}`, alignItems: 'center' }}>
                <div onClick={() => onSelectEvent(ev.id)} style={{ cursor: 'pointer', color: adminTheme.textStrong, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {ev.title || '(Untitled)'} {ev.is_featured && <span title="Featured" style={{ color: adminTheme.amber }}>★</span>}
                </div>
                <div style={{ color: adminTheme.text, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {organizer?.username ? `@${organizer.username}` : organizer?.full_name || 'Unknown'}
                  {organizer?.is_verified && <BadgeCheck size={12} color={adminTheme.blue} />}
                </div>
                <div style={{ color: adminTheme.textMuted }}>{ev.event_date ? new Date(ev.event_date).toLocaleDateString('en-NG', { dateStyle: 'medium' }) : '—'}</div>
                <div><span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: sc.bg, color: sc.fg }}>{sc.label}</span></div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {!ev.deleted_at && (
                    <button disabled={isBusy} onClick={() => doAction(ev.id, label, () => toggleEventFeatured(isSuperAdmin, ev.id, label, !!ev.is_featured))}
                      style={{ fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 8, background: ev.is_featured ? 'rgba(251,191,36,.12)' : adminTheme.borderChip, border: `1px solid ${ev.is_featured ? 'rgba(251,191,36,.35)' : adminTheme.border}`, color: ev.is_featured ? adminTheme.amber : adminTheme.textMuted, cursor: isBusy ? 'not-allowed' : 'pointer' }}>
                      {ev.is_featured ? '★ Featured' : '☆ Feature'}
                    </button>
                  )}
                  {ev.deleted_at ? (
                    <button disabled={isBusy} onClick={() => doAction(ev.id, label, () => restoreDeletedEvent(isSuperAdmin, ev.id, label))}
                      style={{ fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 8, background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, cursor: isBusy ? 'not-allowed' : 'pointer' }}>Restore</button>
                  ) : (
                    <button disabled={isBusy} onClick={() => doAction(ev.id, label, () => ev.hidden_by_admin ? reinstateEvent(isSuperAdmin, ev.id, label) : hideEvent(isSuperAdmin, ev.id, label))}
                      style={{ fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 8, background: ev.hidden_by_admin ? 'rgba(52,211,153,.1)' : 'rgba(248,113,113,.1)', border: `1px solid ${ev.hidden_by_admin ? 'rgba(52,211,153,.3)' : 'rgba(248,113,113,.3)'}`, color: ev.hidden_by_admin ? adminTheme.green : adminTheme.red, cursor: isBusy ? 'not-allowed' : 'pointer' }}>
                      {ev.hidden_by_admin ? 'Reinstate' : 'Hide'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

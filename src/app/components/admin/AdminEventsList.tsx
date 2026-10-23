// Batch 2 — Events list. Desktop table / mobile card-list per
// design-export's v_events block (~328-364). Reuses the exact query
// AdminDashboardScreen's loadEvents already runs (same table, same
// organizer join, same 50-row limit) and the same admin RPCs for actions.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BadgeCheck, X } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { isSuperAdmin as permIsSuperAdmin, type PermissionUser } from '../../../lib/permissions';
import { hideEvent, reinstateEvent, restoreDeletedEvent, toggleEventFeatured, toggleEventTrending, isMissingTrendingSchemaError } from './adminUserEventActions';

interface AdminEventRow {
  id: string; title: string | null; organizer_id: string | null; hidden_by_admin: boolean;
  hidden_at: string | null; created_at: string; event_date: string | null; deleted_at: string | null;
  is_featured: boolean; featured_until: string | null; admin_trending: boolean; image_url: string | null;
  'users!events_organizer_id_fkey'?: { username: string | null; full_name: string | null; is_verified: boolean } | null;
}

function statusChip(ev: AdminEventRow): { bg: string; fg: string; label: string } {
  if (ev.deleted_at) return { bg: 'rgba(248,113,113,.12)', fg: adminTheme.red, label: 'Deleted' };
  if (ev.hidden_by_admin) return { bg: 'rgba(251,191,36,.12)', fg: adminTheme.amber, label: 'Hidden' };
  return { bg: 'rgba(52,211,153,.12)', fg: adminTheme.green, label: 'Visible' };
}

const FILTERS = ['active', 'hidden', 'deleted', 'featured', 'trending'] as const;

// Escapes PostgREST ilike wildcards (%, _) and the comma/backslash that
// would otherwise break out of the pattern or the .or()/.ilike() filter
// syntax, so a title containing any of these characters is matched
// literally instead of as a pattern -- same precaution any admin free-text
// search into a LIKE-family filter needs.
function escapeIlike(term: string): string {
  return term.replace(/[\\%_,]/g, (c) => `\\${c}`);
}

const SEARCH_DEBOUNCE_MS = 300;

export function AdminEventsList({ isMobile, currentUser, onSelectEvent }: {
  isMobile: boolean; currentUser: PermissionUser | null | undefined; onSelectEvent: (id: string) => void;
}) {
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const [filter, setFilter] = useState<typeof FILTERS[number]>('active');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [events, setEvents] = useState<AdminEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Set once this screen actually observes PostgREST reject admin_trending
  // -- never assumed up front -- so the Trending filter tab/column hide
  // themselves automatically the moment migration 0182 lands, with no
  // follow-up deploy needed.
  const [trendingColumnMissing, setTrendingColumnMissing] = useState(false);

  // Debounce: only the trailing value after SEARCH_DEBOUNCE_MS of no typing
  // becomes a real server query, so fast typing doesn't fire a request per
  // keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Stale-response guard: each load() call gets its own ticket; if a newer
  // call started (filter/search changed again) before this one resolves,
  // its result is dropped instead of overwriting the newer, still-loading
  // or already-applied state.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true); setError(null);
    try {
      // admin_trending (migration 0182_admin_manual_trending_control.sql)
      // has not reached production yet -- apply_migration has timed out on
      // it seven times (see this repo's own debug history). Selecting a
      // column PostgREST doesn't know about fails the WHOLE query, not just
      // the Trending feature, so this screen must be resilient to that
      // column's absence rather than assume the reviewed migration file
      // reflects the live schema. buildQuery(includeTrending) builds the
      // identical query either way; only the trending-specific pieces are
      // conditional, so there's exactly one place this falls back.
      const buildQuery = (includeTrending: boolean) => {
        const cols = includeTrending
          ? 'id, title, organizer_id, hidden_by_admin, hidden_at, created_at, event_date, deleted_at, is_featured, featured_until, admin_trending, image_url, users!events_organizer_id_fkey(username, full_name, is_verified)'
          : 'id, title, organizer_id, hidden_by_admin, hidden_at, created_at, event_date, deleted_at, is_featured, featured_until, image_url, users!events_organizer_id_fkey(username, full_name, is_verified)';
        let query = supabase.from('events').select(cols).order('created_at', { ascending: false }).limit(50);
        if (filter === 'deleted') query = query.not('deleted_at', 'is', null);
        else {
          query = query.is('deleted_at', null);
          if (filter === 'hidden') query = query.eq('hidden_by_admin', true);
          if (filter === 'featured') query = query.eq('is_featured', true);
          if (filter === 'trending' && includeTrending) query = query.eq('admin_trending', true);
        }
        const term = search.trim();
        if (term) query = query.ilike('title', `%${escapeIlike(term)}%`);
        return query;
      };

      let { data, error: err } = await buildQuery(true);
      if (err && isMissingTrendingSchemaError(err)) {
        setTrendingColumnMissing(true);
        // The 'trending' filter tab has no meaning without the column --
        // fall back to the default tab rather than return an empty,
        // confusing list.
        if (filter === 'trending') { setFilter('active'); return; }
        ({ data, error: err } = await buildQuery(false));
        if (data) data = (data as any[]).map((row) => ({ ...row, admin_trending: false }));
      }
      if (requestId !== requestIdRef.current) return; // a newer request superseded this one
      if (err) throw err;
      setEvents((data as any) || []);
    } catch (e: any) {
      if (requestId !== requestIdRef.current) return;
      setError(e?.message || 'Failed to load events.');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => { load(); }, [load]);

  const clearSearch = () => { setSearchInput(''); setSearch(''); };

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const doAction = async (id: string, label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusyId(id);
    const res = await fn();
    flash(res.ok, res.message);
    if (res.ok) await load();
    setBusyId(null);
  };

  const noResultsLabel = search.trim() ? `No events found for "${search.trim()}".` : 'No events found.';

  return (
    <div data-testid="admin-events-list">
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          aria-label="Search events by title"
          placeholder="Search events by title…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '9px 34px 9px 12px',
            borderRadius: 8, border: `1px solid ${adminTheme.border}`, background: adminTheme.panel,
            color: adminTheme.text, outline: 'none',
          }}
        />
        {searchInput && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={clearSearch}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 4,
              display: 'flex', color: adminTheme.textFaint,
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {FILTERS.filter((f) => f !== 'trending' || !trendingColumnMissing).map((f) => (
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
      {trendingColumnMissing && (
        <div style={{ fontSize: 11.5, color: adminTheme.textMuted, marginBottom: 12 }}>
          Trending controls are pending a database migration and aren't available yet.
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading events…</div>
      ) : isMobile ? (
        <div>
          {events.length === 0 && <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>{noResultsLabel}</div>}
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
                {ev.admin_trending && <div style={{ fontSize: 11, color: adminTheme.red, marginTop: 4 }}>🔥 Trending</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 1.2fr 1fr .9fr 1.4fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
            <div>EVENT</div><div>ORGANIZER</div><div>DATE</div><div>STATUS</div><div>ACTIONS</div>
          </div>
          {events.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>{noResultsLabel}</div>}
          {events.map((ev) => {
            const organizer = ev['users!events_organizer_id_fkey'];
            const sc = statusChip(ev);
            const isBusy = busyId === ev.id;
            const label = ev.title || ev.id;
            return (
              <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '1.8fr 1.2fr 1fr .9fr 1.4fr', padding: '13px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}`, alignItems: 'center' }}>
                <div onClick={() => onSelectEvent(ev.id)} style={{ cursor: 'pointer', color: adminTheme.textStrong, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {ev.title || '(Untitled)'} {ev.is_featured && <span title="Featured" style={{ color: adminTheme.amber }}>★</span>} {ev.admin_trending && <span title="Trending" style={{ color: adminTheme.red }}>🔥</span>}
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
                  {!ev.deleted_at && (
                    <button disabled={isBusy || trendingColumnMissing} title={trendingColumnMissing ? 'Pending database migration (0182) — not available yet' : undefined}
                      onClick={() => doAction(ev.id, label, () => toggleEventTrending(isSuperAdmin, ev.id, label, !!ev.admin_trending))}
                      style={{ fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 8, background: ev.admin_trending ? 'rgba(248,113,113,.12)' : adminTheme.borderChip, border: `1px solid ${ev.admin_trending ? 'rgba(248,113,113,.35)' : adminTheme.border}`, color: ev.admin_trending ? adminTheme.red : adminTheme.textMuted, cursor: (isBusy || trendingColumnMissing) ? 'not-allowed' : 'pointer', opacity: trendingColumnMissing ? 0.5 : 1 }}>
                      {ev.admin_trending ? '🔥 Trending' : '📈 Trend'}
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

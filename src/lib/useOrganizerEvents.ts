import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { OrganizerEventOverview, OrganizerEventDisplayStatus } from '../app/components/types';

// ─── Organizer Hub → "My Created Events" real-time data layer ────────────────
// Backs the production Organizer Hub dashboard. Single-call aggregate RPC
// (get_organizer_events_overview) instead of a raw `events.select('*')` with
// zero ticket/revenue data, subscribed to the per-organizer `organizer-
// events:<id>` realtime channel so ticket sales / check-ins / event edits
// refresh the dashboard live with no manual pull-to-refresh required.

export type OrganizerEventSort = 'newest' | 'oldest';

function toDisplayStatus(row: any): OrganizerEventDisplayStatus {
  if (row.status === 'draft') return 'draft';
  // Coming Soon (0224): public but not on sale -- never shown as 'live',
  // so live-only actions (Promote, Scan, Make Live) are not offered.
  if (row.status === 'coming_soon') return row.is_ended ? 'ended' : 'coming_soon';
  if (row.is_ended) return 'ended';
  if (row.is_sold_out) return 'sold_out';
  return 'live';
}

function mapRow(row: any): OrganizerEventOverview {
  return {
    id: row.id,
    title: row.title || '',
    description: row.description ?? null,
    location: row.location ?? null,
    eventDate: row.event_date ?? null,
    price: Number(row.price) || 0,
    ticketGoal: Number(row.ticket_goal) || 0,
    ticketTypes: Array.isArray(row.ticket_types) ? row.ticket_types : [],
    status: row.status === 'draft' ? 'draft' : row.status === 'coming_soon' ? 'coming_soon' : 'live',
    salesOpenAt: row.sales_open_at ?? null,
    saleAlertCount: Number(row.sale_alert_count) || 0,
    is18Plus: !!row.is_18_plus,
    createdAt: row.created_at,
    soldCount: Number(row.sold_count) || 0,
    soldQuantity: Number(row.sold_quantity) || 0,
    pendingCount: Number(row.pending_count) || 0,
    cancelledCount: Number(row.cancelled_count) || 0,
    refundedCount: Number(row.refunded_count) || 0,
    revenueKobo: Number(row.revenue_kobo) || 0,
    checkedInCount: Number(row.checked_in_count) || 0,
    isEnded: !!row.is_ended,
    isSoldOut: !!row.is_sold_out,
    displayStatus: toDisplayStatus(row),
  };
}

async function loadSaleSchedule(ids: string[]): Promise<Map<string, { sales_open_at: string | null; sale_alert_count: number }>> {
  const out = new Map<string, { sales_open_at: string | null; sale_alert_count: number }>();
  if (ids.length === 0) return out;
  try {
    const [{ data: times, error: tErr }, { data: counts }] = await Promise.all([
      supabase.from('events').select('id, sales_open_at').in('id', ids).not('sales_open_at', 'is', null),
      supabase.rpc('get_my_event_sale_alert_counts' as any, {}),
    ]);
    if (tErr) return out;
    const countById = new Map<string, number>((Array.isArray(counts) ? counts : []).map((c: any) => [c.event_id, Number(c.subscribers) || 0]));
    for (const t of times ?? []) out.set((t as any).id, { sales_open_at: (t as any).sales_open_at, sale_alert_count: countById.get((t as any).id) ?? 0 });
  } catch { /* pre-0224 database: no schedules */ }
  return out;
}

export function useOrganizerEvents(organizerId: string | undefined) {
  const [events, setEvents] = useState<OrganizerEventOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<OrganizerEventSort>('newest');
  const [live, setLive] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!organizerId) { setEvents([]); setLoading(false); return; }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc('get_organizer_events_overview' as any, {});
      if (err) throw err;
      if (!mountedRef.current) return;
      const rows: any[] = Array.isArray(data) ? data : [];
      // 0224 extras, fetched alongside the unchanged overview RPC: each
      // event's planned sales opening and its Notify-me count (a number,
      // never who). A database without 0224 simply has neither.
      const scheduled = await loadSaleSchedule(rows.map((r) => r.id));
      if (!mountedRef.current) return;
      setEvents(rows.map((r) => mapRow({ ...r, ...(scheduled.get(r.id) ?? {}) })));
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.message || 'Could not load your events. Pull to refresh to try again.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [organizerId]);

  useEffect(() => { refresh(false); }, [refresh]);

  // ── Realtime: refetch on any ticket/check-in/event change for this organizer ──
  // Server-side triggers (0004_functions.sql) broadcast 'event_changed' /
  // 'tickets_changed' on the 'organizer-events:<id>' topic — same
  // realtime.send() + supabase.channel() broadcast convention as
  // NotificationsScreen.tsx's 'user:<id>' channel.
  useEffect(() => {
    if (!organizerId) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => refresh(true), 350);
    };

    const channel = supabase.channel(`organizer-events:${organizerId}`, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'tickets_changed' }, bump);
    channel.on('broadcast', { event: 'event_changed' }, bump);
    channel.subscribe((status) => setLive(status === 'SUBSCRIBED'));

    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
      setLive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizerId]);

  const sorted = [...events].sort((a, b) => {
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    return sort === 'newest' ? bt - at : at - bt;
  });

  return { events: sorted, loading, error, sort, setSort, live, refresh };
}

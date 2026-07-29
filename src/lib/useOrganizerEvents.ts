import { useCallback, useEffect, useRef, useState } from 'react';
import { insforge } from './insforge';
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
    status: row.status === 'draft' ? 'draft' : 'live',
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
      const { data, error: err } = await insforge.database.rpc('get_organizer_events_overview' as any, {});
      if (err) throw err;
      if (!mountedRef.current) return;
      setEvents(Array.isArray(data) ? data.map(mapRow) : []);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.message || 'Could not load your events. Pull to refresh to try again.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [organizerId]);

  useEffect(() => { refresh(false); }, [refresh]);

  // ── Realtime: refetch on any ticket/check-in/event change for this organizer ──
  useEffect(() => {
    if (!organizerId) return;
    const channel = `organizer-events:${organizerId}`;
    let subscribed = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => refresh(true), 350);
    };

    insforge.realtime.connect()
      .then(() => insforge.realtime.subscribe(channel))
      .then(() => { subscribed = true; setLive(true); })
      .catch(() => setLive(false));

    insforge.realtime.on('tickets_changed', bump);
    insforge.realtime.on('event_changed', bump);

    return () => {
      if (debounce) clearTimeout(debounce);
      insforge.realtime.off?.('tickets_changed', bump);
      insforge.realtime.off?.('event_changed', bump);
      if (subscribed) insforge.realtime.unsubscribe(channel);
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

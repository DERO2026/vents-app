// Coming Soon events (migration 0224): public, discoverable events whose
// ticket sales have not opened yet, plus the "Notify me" subscriptions.
//
// The server is the authority: a Coming Soon event (status 'coming_soon')
// is refused by every purchase function, opens only through
// open_event_sales at/after sales_open_at, and notifies each subscriber
// exactly once. These helpers only render that state and call those RPCs.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { REGION } from './regionConfig';
import { hasEventEnded } from './eventLifecycle';

// VENTS runs on Nigeria time (REGION.timezoneOffset = +01:00, no DST). Event
// times are entered and shown in it; the database stores UTC instants.
export const COMING_SOON_TIME_ZONE = 'Africa/Lagos';

export function isComingSoon(event: { status?: string | null } | null | undefined): boolean {
  return event?.status === 'coming_soon';
}

/** True once the planned sales time has passed (the server may not have opened it yet). */
export function isSalesDue(salesOpenAt: string | null | undefined, now: Date = new Date()): boolean {
  return !!salesOpenAt && new Date(salesOpenAt).getTime() <= now.getTime();
}

/** "Sat 6 Dec, 10:00 AM" in Nigeria time. */
export function formatSalesOpen(salesOpenAt: string | null | undefined): string {
  if (!salesOpenAt) return '';
  const d = new Date(salesOpenAt);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: COMING_SOON_TIME_ZONE });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: COMING_SOON_TIME_ZONE });
  return `${day}, ${time}`;
}

/** Local Nigeria date ('YYYY-MM-DD') + time ('HH:MM') -> UTC ISO instant. */
export function salesOpenAtFromLocal(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00${REGION.timezoneOffset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** UTC ISO instant -> { date, time } in Nigeria time, for the edit form. */
export function salesOpenAtToLocal(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: COMING_SOON_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Mirrors the server's rules (events_sales_schedule_guard / events_sales_open_before_start). */
export function validateSalesOpen(salesOpenAtIso: string | null, eventStartIso: string | null, now: Date = new Date()): string | null {
  if (!salesOpenAtIso) return 'Please choose when ticket sales open.';
  const t = new Date(salesOpenAtIso).getTime();
  if (t <= now.getTime()) return 'Ticket sales must open at a time in the future.';
  if (eventStartIso && t > new Date(eventStartIso).getTime()) return 'Ticket sales must open before the event starts.';
  return null;
}

/**
 * Ask the server to open a Coming Soon event whose time has passed. Anyone
 * may call it; it never opens early. Returns true when the event is now on
 * sale (opened by this call or already open).
 */
export async function openEventSalesIfDue(eventId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('open_event_sales', { p_event_id: eventId });
    if (error) return false;
    const res = data as { opened?: boolean; reason?: string } | null;
    return !!res && (res.opened === true || res.reason === 'already_open');
  } catch {
    return false;
  }
}

// ── Notify me: one shared store so Home and Event Details always agree ──
type AlertState = { userId: string | null; ids: Set<string>; pending: Set<string> };
let alertState: AlertState = { userId: null, ids: new Set(), pending: new Set() };
const listeners = new Set<() => void>();
const emit = () => { alertState = { ...alertState }; listeners.forEach((l) => l()); };
const subscribeStore = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const readStore = () => alertState;

/** Loads the signed-in user's own subscriptions (RLS: own rows only). */
export async function loadSaleAlerts(userId: string | null | undefined): Promise<void> {
  if (!userId) { alertState = { userId: null, ids: new Set(), pending: new Set() }; emit(); return; }
  const { data, error } = await supabase.from('event_sale_alerts').select('event_id').eq('user_id', userId);
  if (error) return; // database without 0224, or offline: show the default (not subscribed)
  alertState = { userId, ids: new Set((data ?? []).map((r: any) => r.event_id as string)), pending: new Set() };
  emit();
}

export function useSaleAlerts(userId: string | null | undefined) {
  const state = useSyncExternalStore(subscribeStore, readStore, readStore);
  useEffect(() => {
    if ((userId ?? null) !== alertState.userId) void loadSaleAlerts(userId ?? null);
  }, [userId]);

  const toggle = useCallback(async (eventId: string): Promise<{ ok: boolean; error?: string }> => {
    if (!userId) return { ok: false, error: 'Sign in to get notified when tickets go on sale.' };
    if (alertState.pending.has(eventId)) return { ok: false };
    const wasOn = alertState.ids.has(eventId);
    alertState.pending.add(eventId);
    // Optimistic; reverted on error.
    if (wasOn) alertState.ids.delete(eventId); else alertState.ids.add(eventId);
    emit();
    try {
      const { error } = await supabase.rpc(wasOn ? 'unsubscribe_event_sale_alert' : 'subscribe_event_sale_alert', { p_event_id: eventId });
      if (error) throw error;
      return { ok: true };
    } catch (err: any) {
      if (wasOn) alertState.ids.add(eventId); else alertState.ids.delete(eventId);
      return { ok: false, error: err?.message || 'Could not update your notification.' };
    } finally {
      alertState.pending.delete(eventId);
      emit();
    }
  }, [userId]);

  return {
    isSubscribed: (eventId: string) => state.ids.has(eventId),
    isPending: (eventId: string) => state.pending.has(eventId),
    toggle,
  };
}

/** Test hook: reset the shared store between tests. */
export function __resetSaleAlertsForTests() { alertState = { userId: null, ids: new Set(), pending: new Set() }; emit(); }

// ── Homepage data ──
export interface ComingSoonQuery {
  country: string;
  blockedOrganizerIds: Set<string>;
  isMinor: boolean;
}

/**
 * Coming Soon events for the homepage: public (not hidden/deleted/archived),
 * not ended, in the viewer's country, age- and block-filtered like the main
 * feed, nearest sales opening first. Any whose time has already passed are
 * opened (lazily) and left out -- they move to the normal on-sale sections.
 */
export function useComingSoonEvents<T extends { id: string; salesOpenAt?: string | null }>(
  q: ComingSoonQuery,
  mapRow: (row: any) => T,
) {
  const [events, setEvents] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const blockedKey = [...q.blockedOrganizerIds].sort().join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let query = supabase
          .from('events')
          .select('*, users!events_organizer_id_fkey(username, full_name, vc_badge)')
          .eq('status', 'coming_soon')
          .eq('hidden_by_admin', false)
          .is('deleted_at', null)
          .is('archived_at', null)
          .eq('country', q.country);
        if (q.isMinor) query = query.eq('is_18_plus', false);
        if (blockedKey) query = query.not('organizer_id', 'in', `(${blockedKey})`);
        const { data, error } = await query.order('sales_open_at', { ascending: true }).limit(20);
        if (cancelled) return;
        if (error || !Array.isArray(data)) { setEvents([]); return; }
        const now = new Date();
        const upcoming = data.filter((e: any) => !hasEventEnded({ event_date: e.event_date, end_date: e.end_date }, now));
        const due = upcoming.filter((e: any) => isSalesDue(e.sales_open_at, now));
        due.forEach((e: any) => { void openEventSalesIfDue(e.id); });
        setEvents(upcoming.filter((e: any) => !isSalesDue(e.sales_open_at, now)).map((e: any) => mapRow({
          ...e,
          organizer_name: e.users?.username || e.users?.full_name || null,
          organizer_vc_badge: e.users?.vc_badge || null,
        })));
      } catch {
        if (!cancelled) setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.country, q.isMinor, blockedKey]);

  return { events, loading };
}

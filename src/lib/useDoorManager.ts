import { useCallback, useEffect, useRef, useState } from 'react';
import { insforge } from './insforge';

// ─── Door Manager real-time data layer ───────────────────────────────────────
// Backs the Organizer Door Manager dashboard. Subscribes to the per-event
// `door:<eventId>` realtime channel (registered in the door-manager migration)
// and, on every check-in / ticket broadcast, debounces a refetch of the live
// stats + activity feed so every open organizer device stays in sync with no
// manual refresh. All reads go through the gated, single-query RPCs
// (get_door_stats / get_recent_checkins / get_event_attendees) so there's no
// N+1 and the server enforces organizer/admin authorization.

export interface DoorStats {
  total: number;
  checked_in: number;
  remaining: number;
  attendance_pct: number;
  duplicate_attempts: number;
  invalid_attempts: number;
}

export interface FeedItem {
  checkin_id: string;
  ticket_id: string;
  holder_name: string | null;
  ticket_type: string | null;
  checked_in_at: string;
  gate_name: string | null;
  is_manual_override: boolean;
  scanned_by: string | null;
  scanner_name: string | null;
}

export interface Attendee {
  ticket_id: string;
  holder_name: string | null;
  holder_email: string | null;
  buyer_phone: string | null;
  ticket_type: string | null;
  status: string;
  payment_status: string | null;
  amount: number | null;
  checked_in: boolean;
  checked_in_at: string | null;
  is_manual_override: boolean;
  gate_name: string | null;
  purchased_at: string;
  order_ref: string | null;
  user_id: string | null;
  buyer_name: string | null;
  avatar_url: string | null;
  scanner_name: string | null;
  device_id: string | null;
}

export type DoorFilter =
  | 'all' | 'checked_in' | 'pending' | 'vip' | 'regular' | 'refunded' | 'cancelled';

export type ScanResult = 'valid' | 'duplicate' | 'invalid' | 'wrong_event' | 'refunded' | 'cancelled';

export interface ScanLogItem {
  id: string;
  ticket_id: string | null;
  holder_name: string | null;
  ticket_type: string | null;
  scanned_by: string | null;
  scanner_name: string | null;
  result: ScanResult;
  reason: string | null;
  message: string | null;
  device_id: string | null;
  gate_name: string | null;
  is_manual_override: boolean;
  created_at: string;
}

export interface ManualCheckInResult {
  ok: boolean;
  reason?: string;
  message?: string;
  holder_name?: string;
  ticket_type?: string;
  checked_in_at?: string;
  is_manual_override?: boolean;
  stats?: DoorStats;
}

const PAGE_SIZE = 40;
const SCAN_LOG_PAGE_SIZE = 40;
const EMPTY_STATS: DoorStats = { total: 0, checked_in: 0, remaining: 0, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 };

// A stable, per-install device id so the ledger can attribute check-ins to a
// physical scanning device (multi-gate audit). Not PII; purely local.
function getDeviceId(): string {
  try {
    let id = localStorage.getItem('vents_door_device_id');
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem('vents_door_device_id', id);
    }
    return id;
  } catch {
    return 'dev-unknown';
  }
}

export function useDoorManager(eventId: string | undefined, actorId: string | undefined) {
  const [stats, setStats] = useState<DoorStats>(EMPTY_STATS);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DoorFilter>('all');
  const [gateName, setGateName] = useState<string>('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [live, setLive] = useState(false);

  const [scanLog, setScanLog] = useState<ScanLogItem[]>([]);
  const [scanLogFilter, setScanLogFilter] = useState<ScanResult | 'all'>('all');
  const [loadingScanLog, setLoadingScanLog] = useState(false);
  const [loadingMoreScanLog, setLoadingMoreScanLog] = useState(false);
  const [hasMoreScanLog, setHasMoreScanLog] = useState(true);

  const offsetRef = useRef(0);
  const scanLogOffsetRef = useRef(0);
  const reqIdRef = useRef(0); // guards against out-of-order search/filter responses
  const scanLogReqIdRef = useRef(0);

  // ── Stats + activity feed ──────────────────────────────────────────────────
  const refreshStats = useCallback(async () => {
    if (!eventId) return;
    const [{ data: s }, { data: f }] = await Promise.all([
      insforge.database.rpc('get_door_stats' as any, { p_event_id: eventId }),
      insforge.database.rpc('get_recent_checkins' as any, { p_event_id: eventId, p_limit: 25 }),
    ]);
    if (s) setStats(s as DoorStats);
    if (Array.isArray(f)) setFeed(f as FeedItem[]);
  }, [eventId]);

  // ── Guest list (paginated, searched, filtered — single-query server side) ───
  const loadList = useCallback(async (reset: boolean) => {
    if (!eventId) return;
    const myReq = ++reqIdRef.current;
    if (reset) { offsetRef.current = 0; setLoadingList(true); }
    else setLoadingMore(true);

    const { data, error } = await insforge.database.rpc('get_event_attendees' as any, {
      p_event_id: eventId,
      p_search: search || null,
      p_filter: filter,
      p_limit: PAGE_SIZE,
      p_offset: reset ? 0 : offsetRef.current,
    });

    if (myReq !== reqIdRef.current) return; // a newer search/filter superseded us
    const rows = (!error && Array.isArray(data) ? data : []) as Attendee[];
    setAttendees((prev) => (reset ? rows : [...prev, ...rows]));
    setHasMore(rows.length === PAGE_SIZE);
    offsetRef.current = (reset ? 0 : offsetRef.current) + rows.length;
    setLoadingList(false);
    setLoadingMore(false);
  }, [eventId, search, filter]);

  const loadMore = useCallback(() => {
    if (!loadingList && !loadingMore && hasMore) loadList(false);
  }, [loadingList, loadingMore, hasMore, loadList]);

  // Initial + whenever search/filter change (debounce handled by caller via search state).
  useEffect(() => {
    if (!eventId) return;
    const t = setTimeout(() => loadList(true), 250);
    return () => clearTimeout(t);
  }, [eventId, search, filter, loadList]);

  useEffect(() => { refreshStats(); }, [refreshStats]);

  // ── Full scan history (every attempt — valid, duplicate, invalid, wrong
  // event, refunded, cancelled) — searchable/filterable audit trail, separate
  // from the "Live Activity" feed which only shows successful admissions.
  const loadScanLog = useCallback(async (reset: boolean) => {
    if (!eventId) return;
    const myReq = ++scanLogReqIdRef.current;
    if (reset) { scanLogOffsetRef.current = 0; setLoadingScanLog(true); }
    else setLoadingMoreScanLog(true);

    const { data, error } = await insforge.database.rpc('get_scan_log' as any, {
      p_event_id: eventId,
      p_result: scanLogFilter === 'all' ? null : scanLogFilter,
      p_limit: SCAN_LOG_PAGE_SIZE,
      p_offset: reset ? 0 : scanLogOffsetRef.current,
    });

    if (myReq !== scanLogReqIdRef.current) return;
    const rows = (!error && Array.isArray(data) ? data : []) as ScanLogItem[];
    setScanLog((prev) => (reset ? rows : [...prev, ...rows]));
    setHasMoreScanLog(rows.length === SCAN_LOG_PAGE_SIZE);
    scanLogOffsetRef.current = (reset ? 0 : scanLogOffsetRef.current) + rows.length;
    setLoadingScanLog(false);
    setLoadingMoreScanLog(false);
  }, [eventId, scanLogFilter]);

  const loadMoreScanLog = useCallback(() => {
    if (!loadingScanLog && !loadingMoreScanLog && hasMoreScanLog) loadScanLog(false);
  }, [loadingScanLog, loadingMoreScanLog, hasMoreScanLog, loadScanLog]);

  useEffect(() => {
    if (!eventId) return;
    const t = setTimeout(() => loadScanLog(true), 250);
    return () => clearTimeout(t);
  }, [eventId, scanLogFilter, loadScanLog]);

  // ── Realtime subscription: refetch stats/feed on every door broadcast ───────
  useEffect(() => {
    if (!eventId) return;
    const channel = `door:${eventId}`;
    let subscribed = false;
    let torn = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { refreshStats(); loadList(true); loadScanLog(true); }, 300);
    };

    insforge.realtime.connect()
      .then(() => insforge.realtime.subscribe(channel))
      .then(() => {
        if (torn) { insforge.realtime.unsubscribe(channel); return; }
        subscribed = true; setLive(true);
      })
      .catch(() => setLive(false));

    insforge.realtime.on('checkin', bump);
    insforge.realtime.on('ticket', bump);
    insforge.realtime.on('scan_attempt', bump);

    return () => {
      torn = true;
      if (debounce) clearTimeout(debounce);
      insforge.realtime.off?.('checkin', bump);
      insforge.realtime.off?.('ticket', bump);
      insforge.realtime.off?.('scan_attempt', bump);
      if (subscribed) insforge.realtime.unsubscribe(channel);
      setLive(false);
    };
    // loadList/refreshStats/loadScanLog are stable per (eventId, search, filter,
    // scanLogFilter); we only want to (re)subscribe when the event changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // ── Manual check-in (dead-phone override) ───────────────────────────────────
  const manualCheckIn = useCallback(async (ticketId: string): Promise<ManualCheckInResult> => {
    if (!actorId) return { ok: false, message: 'Not signed in.' };
    try {
      const { data, error } = await insforge.database.rpc('manual_check_in' as any, {
        p_ticket_id: ticketId,
        p_actor_id: actorId,
        p_device_id: getDeviceId(),
        p_gate_name: gateName.trim() || null,
      });
      if (error) throw error;
      const res = data as ManualCheckInResult;
      if (res?.stats) setStats(res.stats);
      // Optimistically reflect locally; the realtime broadcast will also refetch.
      refreshStats();
      loadList(true);
      return res;
    } catch (err: any) {
      const msg = String(err?.message || '');
      return {
        ok: false,
        message: msg.includes('scanning_disabled')
          ? 'Scanning is temporarily paused platform-wide.'
          : (msg || 'Could not check in. Try again.'),
      };
    }
  }, [actorId, gateName, refreshStats, loadList]);

  return {
    stats, feed, attendees,
    search, setSearch, filter, setFilter, gateName, setGateName,
    loadingList, loadingMore, hasMore, live,
    loadMore, refresh: refreshStats, manualCheckIn,
    scanLog, scanLogFilter, setScanLogFilter,
    loadingScanLog, loadingMoreScanLog, hasMoreScanLog, loadMoreScanLog,
  };
}

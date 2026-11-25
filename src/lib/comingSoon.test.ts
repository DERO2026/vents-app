import { describe, it, expect, vi, beforeEach } from 'vitest';

// Coming Soon helpers (0224): Nigeria-time formatting/parsing, the same
// sales-time rules the server enforces, and the shared Notify-me store
// (optimistic, reverted on error, never double-submits).

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { rpc, from } }));

import {
  formatSalesOpen, isComingSoon, isSalesDue, salesOpenAtFromLocal, salesOpenAtToLocal, validateSalesOpen,
  openEventSalesIfDue, loadSaleAlerts, useSaleAlerts, __resetSaleAlertsForTests,
} from './comingSoon';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';

beforeEach(() => { rpc.mockReset(); from.mockReset(); __resetSaleAlertsForTests(); });

describe('time zones (Nigeria, +01:00)', () => {
  it('a Lagos local date/time becomes the right UTC instant', () => {
    expect(salesOpenAtFromLocal('2026-12-05', '10:00')).toBe('2026-12-05T09:00:00.000Z');
    expect(salesOpenAtFromLocal('2026-12-31', '23:30')).toBe('2026-12-31T22:30:00.000Z');
  });
  it('round-trips back to the same Lagos date/time for the edit form (across midnight UTC)', () => {
    expect(salesOpenAtToLocal('2026-12-05T09:00:00.000Z')).toEqual({ date: '2026-12-05', time: '10:00' });
    expect(salesOpenAtToLocal('2026-12-31T23:30:00.000Z')).toEqual({ date: '2027-01-01', time: '00:30' });
  });
  it('formats the opening in Lagos time regardless of the device time zone', () => {
    expect(formatSalesOpen('2026-12-05T09:00:00.000Z')).toBe('Sat 5 Dec, 10:00 AM');
    expect(formatSalesOpen(null)).toBe('');
  });
  it('rejects malformed input', () => {
    expect(salesOpenAtFromLocal('05/12/2026', '10:00')).toBeNull();
    expect(salesOpenAtFromLocal('2026-12-05', '')).toBeNull();
  });
});

describe('rules mirrored from the server', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  it('requires a time, in the future, no later than the event start', () => {
    expect(validateSalesOpen(null, '2026-12-20T18:00:00Z', now)).toMatch(/choose when/);
    expect(validateSalesOpen('2026-11-25T11:59:00Z', '2026-12-20T18:00:00Z', now)).toMatch(/future/);
    expect(validateSalesOpen('2026-12-21T09:00:00Z', '2026-12-20T18:00:00Z', now)).toMatch(/before the event starts/);
    expect(validateSalesOpen('2026-12-01T09:00:00Z', '2026-12-20T18:00:00Z', now)).toBeNull();
  });
  it('isSalesDue only once the instant has passed', () => {
    expect(isSalesDue('2026-11-25T12:00:01Z', now)).toBe(false);
    expect(isSalesDue('2026-11-25T12:00:00Z', now)).toBe(true);
    expect(isSalesDue(null, now)).toBe(false);
  });
  it('isComingSoon reads the event status', () => {
    expect(isComingSoon({ status: 'coming_soon' })).toBe(true);
    expect(isComingSoon({ status: 'live' })).toBe(false);
    expect(isComingSoon(undefined)).toBe(false);
  });
});

describe('openEventSalesIfDue', () => {
  it('true when the server opened it or it was already open; false when not due or on error', async () => {
    rpc.mockResolvedValueOnce({ data: { opened: true, notified: 3 }, error: null });
    expect(await openEventSalesIfDue('e1')).toBe(true);
    rpc.mockResolvedValueOnce({ data: { opened: false, reason: 'already_open' }, error: null });
    expect(await openEventSalesIfDue('e1')).toBe(true);
    rpc.mockResolvedValueOnce({ data: { opened: false, reason: 'not_due' }, error: null });
    expect(await openEventSalesIfDue('e1')).toBe(false);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await openEventSalesIfDue('e1')).toBe(false);
    expect(rpc).toHaveBeenCalledWith('open_event_sales', { p_event_id: 'e1' });
  });
});

describe('Notify me store', () => {
  const ownRows = (ids: string[]) => {
    const q: any = { select: () => q, eq: () => Promise.resolve({ data: ids.map((event_id) => ({ event_id })), error: null }) };
    from.mockImplementation(() => q);
  };
  function mountHook(userId: string | null) {
    const out: { current: ReturnType<typeof useSaleAlerts> | null } = { current: null };
    const Probe = () => { out.current = useSaleAlerts(userId); return null; };
    const el = document.createElement('div'); const root = createRoot(el);
    act(() => { root.render(createElement(Probe)); });
    return { out, unmount: () => act(() => root.unmount()) };
  }
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it('loads only the signed-in user\'s own subscriptions (state survives returning to the app)', async () => {
    ownRows(['e1']);
    await loadSaleAlerts('u1');
    const { out, unmount } = mountHook('u1');
    expect(out.current!.isSubscribed('e1')).toBe(true);
    expect(out.current!.isSubscribed('e2')).toBe(false);
    unmount();
  });

  it('subscribe then unsubscribe call the RPCs with the event id', async () => {
    ownRows([]);
    const { out, unmount } = mountHook('u1'); await flush();
    rpc.mockResolvedValue({ data: { subscribed: true }, error: null });
    await act(async () => { await out.current!.toggle('e1'); });
    expect(rpc).toHaveBeenLastCalledWith('subscribe_event_sale_alert', { p_event_id: 'e1' });
    expect(out.current!.isSubscribed('e1')).toBe(true);
    await act(async () => { await out.current!.toggle('e1'); });
    expect(rpc).toHaveBeenLastCalledWith('unsubscribe_event_sale_alert', { p_event_id: 'e1' });
    expect(out.current!.isSubscribed('e1')).toBe(false);
    unmount();
  });

  it('reverts the optimistic state and returns the server error', async () => {
    ownRows([]);
    const { out, unmount } = mountHook('u1'); await flush();
    rpc.mockResolvedValue({ data: null, error: { message: 'Tickets are already on sale for this event' } });
    let res: any;
    await act(async () => { res = await out.current!.toggle('e1'); });
    expect(res).toEqual({ ok: false, error: 'Tickets are already on sale for this event' });
    expect(out.current!.isSubscribed('e1')).toBe(false);
    unmount();
  });

  it('a second tap while the first is in flight sends nothing (no duplicate request)', async () => {
    ownRows([]);
    const { out, unmount } = mountHook('u1'); await flush();
    let resolve!: (v: any) => void;
    rpc.mockReturnValue(new Promise((r) => { resolve = r; }));
    let p1!: Promise<any>;
    act(() => { p1 = out.current!.toggle('e1'); });
    expect(out.current!.isPending('e1')).toBe(true);
    await act(async () => { await out.current!.toggle('e1'); });
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ data: { subscribed: true }, error: null }); await p1; });
    unmount();
  });

  it('signed out: asks to sign in and calls nothing', async () => {
    const { out, unmount } = mountHook(null); await flush();
    let res: any;
    await act(async () => { res = await out.current!.toggle('e1'); });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Sign in/);
    expect(rpc).not.toHaveBeenCalled();
    unmount();
  });
});

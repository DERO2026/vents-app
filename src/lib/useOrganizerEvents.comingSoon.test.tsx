import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// useOrganizerEvents (0224): a coming_soon row is never shown as 'live'
// (which would offer Promote / Make Live), and each event's planned sales
// opening and Notify-me count are merged in. On a database without 0224
// the extra calls fail and the hook behaves exactly as before.

const overview = [
  { id: 'cs1', title: 'Afrobeats Live', status: 'coming_soon', is_ended: false, is_sold_out: false, created_at: '2026-11-02T00:00:00Z' },
  { id: 'l1', title: 'Live Show', status: 'live', is_ended: false, is_sold_out: false, created_at: '2026-11-01T00:00:00Z' },
  { id: 'cs-old', title: 'Never opened', status: 'coming_soon', is_ended: true, is_sold_out: false, created_at: '2026-10-01T00:00:00Z' },
];
let without0224 = false;
const rpc = vi.fn(async (fn: string, _args?: any) => {
  if (fn === 'get_organizer_events_overview') return { data: overview, error: null };
  if (fn === 'get_my_event_sale_alert_counts') return without0224 ? { data: null, error: { code: 'PGRST202', message: 'not found' } } : { data: [{ event_id: 'cs1', subscribers: 42, notified: 0 }], error: null };
  return { data: null, error: null };
});
const from = vi.fn(() => {
  const q: any = { select: () => q, in: () => q, not: () => Promise.resolve(without0224 ? { data: null, error: { code: '42703', message: 'column events.sales_open_at does not exist' } } : { data: [{ id: 'cs1', sales_open_at: '2026-12-05T09:00:00.000Z' }, { id: 'cs-old', sales_open_at: '2026-10-05T09:00:00.000Z' }], error: null }) };
  return q;
});
vi.mock('./supabase', () => ({ supabase: { rpc: (fn: string, a: any) => rpc(fn, a), from: () => from(), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {} } }));

import { useOrganizerEvents } from './useOrganizerEvents';

let root: Root; let el: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); el.remove(); without0224 = false; });
async function load() {
  const out: { events: any[] } = { events: [] };
  const Probe = () => { out.events = useOrganizerEvents('org-1').events; return null; };
  el = document.createElement('div'); root = createRoot(el);
  await act(async () => { root.render(<Probe />); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return out.events;
}

describe('useOrganizerEvents with Coming Soon', () => {
  it('maps coming_soon to its own status and merges the schedule and Notify-me count', async () => {
    const events = await load();
    const cs = events.find((e) => e.id === 'cs1');
    expect(cs).toMatchObject({ status: 'coming_soon', displayStatus: 'coming_soon', salesOpenAt: '2026-12-05T09:00:00.000Z', saleAlertCount: 42 });
    expect(events.find((e) => e.id === 'l1')).toMatchObject({ status: 'live', displayStatus: 'live', salesOpenAt: null, saleAlertCount: 0 });
  });

  it('an ended Coming Soon event displays as Ended', async () => {
    const events = await load();
    expect(events.find((e) => e.id === 'cs-old')!.displayStatus).toBe('ended');
  });

  it('without 0224 the list still loads, with no schedules', async () => {
    without0224 = true;
    const events = await load();
    expect(events).toHaveLength(3);
    expect(events.find((e) => e.id === 'l1')).toMatchObject({ status: 'live', salesOpenAt: null });
  });
});

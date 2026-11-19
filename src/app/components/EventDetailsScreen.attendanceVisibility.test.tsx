import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Event attendance visibility (0221) on the public Event Details screen. The
// mocked RPC answers the way the real get_event_ticket_stats does after 0221:
// a hidden event's row is withheld from the public and returned to its
// organizer/admins. The screen reads events.show_attendance_count itself.

let statsRows: any[] = [];
let settingRow: any = null;
const rpc = vi.fn(async (fn: string, a: any) => {
  if (fn === 'get_event_ticket_stats') return { data: statsRows, error: null };
  if (fn === 'ticket_fee_quote') {
    const face = Math.round(a.p_unit_price * 100); const fee = Math.round(face * 15 / 1000);
    return { data: { fee_model: 'v3_15_35', quantity: a.p_quantity, unit_face_kobo: face, face_kobo: face * a.p_quantity, service_fee_kobo: fee * a.p_quantity, discount_kobo: 0, total_kobo: (face + fee) * a.p_quantity }, error: null };
  }
  return { data: null, error: null };
});
const fromCalls: string[] = [];
function chain(table: string): any {
  const ops: string[] = [];
  const handler: ProxyHandler<any> = {
    get(_t, prop: string) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        const isSetting = table === 'events' && ops.includes('maybeSingle');
        const p = Promise.resolve(isSetting ? { data: settingRow, error: null } : { data: null, error: null, count: 0 });
        return (p as any)[prop].bind(p);
      }
      return (...args: any[]) => { ops.push(prop); if (prop === 'select') fromCalls.push(`${table}:${args[0]}`); return new Proxy(() => {}, handler); };
    },
  };
  return new Proxy(() => {}, handler);
}
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, a: any) => rpc(fn, a),
    from: (table: string) => chain(table),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
    storage: { from: () => chain('storage') },
  },
}));
vi.mock('./EventMap', () => ({ EventMap: () => null }));

import { EventDetailsScreen } from './EventDetailsScreen';
import { __clearQuoteCache } from '../../lib/ticketQuote';

const EVENT: any = {
  id: 'e1', title: 'TIG Paint & Play', organizer: 'Org', organizer_id: 'org-1', image: '', images: [], date: 'Sat, 20 Dec',
  time: '2:00 PM', location: 'Lagos, Nigeria', category: 'Sports', attendees: 0, capacity: 300, description: 'x',
  event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
  ticketTypes: [{ id: 't1', name: 'Regular', price: 5000, available: 300 }],
};

let container: HTMLDivElement; let root: Root;
async function render(event: any, viewer: { id?: string; role?: string } = {}) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => {
    root.render(<EventDetailsScreen event={event} onBack={() => {}} onGetTickets={() => {}} isSaved={false} onToggleSave={() => {}}
      currentUserId={viewer.id} currentUserRole={viewer.role} />);
  });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const bottomButton = () => container.querySelector('.edt-bottom-bar button')?.textContent ?? '';
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockClear(); __clearQuoteCache(); statsRows = []; settingRow = null; fromCalls.length = 0; });

describe('Event Details: attendance count shown (ON)', () => {
  it('shows the count in the header and the capacity bar', async () => {
    statsRows = [{ event_id: 'e1', sold_count: 120 }]; settingRow = { show_attendance_count: true };
    await render({ ...EVENT, showAttendanceCount: true });
    expect(byId('event-attendance-header')?.textContent).toBe('120 attending');
    expect(byId('event-attendance-capacity')?.textContent).toBe('120 attending');
    expect(container.textContent).toContain('40% filled');
    expect(byId('event-capacity-only')).toBeNull();
  });
});

describe('Event Details: attendance count hidden (OFF), public viewer', () => {
  it('shows no count, no fill %, no bar -- only the capacity -- and the event is still purchasable', async () => {
    statsRows = []; settingRow = { show_attendance_count: false };   // the server withholds the row
    await render({ ...EVENT, showAttendanceCount: false });
    expect(byId('event-attendance-header')).toBeNull();
    expect(byId('event-attendance-capacity')).toBeNull();
    expect(container.textContent).not.toMatch(/attending/);
    expect(container.textContent).not.toMatch(/% filled/);
    expect(byId('event-capacity-only')?.textContent).toBe('300 total capacity');
    expect(container.textContent).toContain('TIG Paint & Play');
    expect(bottomButton()).toMatch(/^Pay ₦/);
  });

  it('reads the setting from the database even when the event came from a feed row without it', async () => {
    statsRows = []; settingRow = { show_attendance_count: false };
    await render({ ...EVENT });   // no showAttendanceCount (e.g. a search result)
    expect(fromCalls).toContain('events:show_attendance_count');
    expect(byId('event-attendance-header')).toBeNull();
    expect(container.textContent).not.toMatch(/attending/);
  });

  it('a signed-in stranger sees the same as the public', async () => {
    statsRows = []; settingRow = { show_attendance_count: false };
    await render({ ...EVENT, showAttendanceCount: false }, { id: 'someone-else', role: 'user' });
    expect(container.textContent).not.toMatch(/attending/);
  });
});

describe('Event Details: attendance count hidden (OFF), organizer and admin', () => {
  it('the organizer still sees the count, labelled as hidden from the public', async () => {
    statsRows = [{ event_id: 'e1', sold_count: 120 }]; settingRow = { show_attendance_count: false };
    await render({ ...EVENT, showAttendanceCount: false }, { id: 'org-1', role: 'user' });
    expect(byId('event-attendance-header')?.textContent).toBe('120 attending · hidden from the public');
    expect(container.textContent).toContain('40% filled');
  });

  it('an admin still sees the count, labelled', async () => {
    statsRows = [{ event_id: 'e1', sold_count: 120 }]; settingRow = { show_attendance_count: false };
    await render({ ...EVENT, showAttendanceCount: false }, { id: 'admin-1', role: 'admin' });
    expect(byId('event-attendance-header')?.textContent).toBe('120 attending · hidden from the public');
  });
});

describe('Event Details: turning the count back ON', () => {
  it('restores the public count from the server, with no new sale needed', async () => {
    statsRows = [{ event_id: 'e1', sold_count: 120 }]; settingRow = { show_attendance_count: true };
    await render({ ...EVENT, showAttendanceCount: false });   // stale feed row still says hidden
    expect(byId('event-attendance-header')?.textContent).toBe('120 attending');
  });
});

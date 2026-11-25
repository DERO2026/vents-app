import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Organizer side of Coming Soon (0224): a distinct status, the planned
// opening and the Notify-me COUNT on the card, "Open ticket sales" only once
// the time has come (through open_event_sales), a hidden scheduled event
// returns to Coming Soon rather than going straight on sale, and live-only
// actions (Promote) are not offered. Existing live/draft behaviour unchanged.

const base = { soldCount: 0, soldQuantity: 0, ticketGoal: 100, revenueKobo: 0, checkedInCount: 0, price: 10000, location: 'Lagos', eventDate: '2026-12-20T19:00:00Z', isEnded: false, isSoldOut: false, ticketTypes: [], createdAt: '2026-11-01T00:00:00Z' };
const future = new Date(Date.now() + 3 * 86400000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();
const cs = { ...base, id: 'cs1', title: 'Afrobeats Live', status: 'coming_soon', displayStatus: 'coming_soon', salesOpenAt: future, saleAlertCount: 42 };
const due = { ...base, id: 'cs2', title: 'Due Show', status: 'coming_soon', displayStatus: 'coming_soon', salesOpenAt: past, saleAlertCount: 1 };
const hidden = { ...base, id: 'cs3', title: 'Hidden Scheduled', status: 'draft', displayStatus: 'draft', salesOpenAt: future, saleAlertCount: 0 };
const plainDraft = { ...base, id: 'd1', title: 'Plain Draft', status: 'draft', displayStatus: 'draft', salesOpenAt: null };
const live = { ...base, id: 'l1', title: 'Live Show', status: 'live', displayStatus: 'live', salesOpenAt: null };
let eventsList: any[] = [];
const refresh = vi.fn();
vi.mock('../../lib/useOrganizerEvents', () => ({
  useOrganizerEvents: () => ({ events: eventsList, loading: false, error: null, sort: 'newest', setSort: () => {}, live: true, refresh }),
}));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
const rpc = vi.hoisted(() => vi.fn());
const updates: any[] = [];
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc,
    from: () => ({ update: (row: any) => ({ eq: (_c: string, id: string) => { updates.push({ id, row }); return Promise.resolve({ error: null }); } }) }),
  },
  getAuthToken: async () => 't',
}));

import { ManageEventsScreen } from './ManageEventsScreen';

let container: HTMLDivElement; let root: Root;
const flush = () => new Promise((r) => setTimeout(r, 0));
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const card = (title: string) => [...container.querySelectorAll('.vents-manage-card')].find((c) => c.textContent?.includes(title)) as HTMLElement;
const byText = (t: string, scope: ParentNode = container) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await flush(); }); };
async function render() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => {
    root.render(<ManageEventsScreen onBack={() => {}} currentUser={{ id: 'org-1' } as any} onOpenEdit={() => {}} onCreateEvent={() => {}} onViewAttendees={() => {}} onViewAnalytics={() => {}} onOpenDoorManager={() => {}} onOpenScanner={() => {}} onPromoteEvent={() => {}} />);
    await flush();
  });
}
const optionLabels = async (title: string) => {
  await click(card(title).querySelector('button[aria-label="Event options"]'));
  return [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
};

beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: [], error: null }); refresh.mockReset(); updates.length = 0; eventsList = [cs, due, hidden, plainDraft, live]; });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Manage Events: Coming Soon card', () => {
  it('shows a Coming Soon status, the planned opening and the Notify-me count (a number only)', async () => {
    await render();
    expect(card('Afrobeats Live').textContent).toContain('Coming Soon');
    expect(q('coming-soon-status-cs1')!.textContent).toMatch(/Tickets on sale /);
    expect(q('sale-alert-count-cs1')!.textContent).toBe('🔔 42 want to be notified');
    expect(q('sale-alert-count-cs2')!.textContent).toBe('🔔 1 wants to be notified');
  });

  it('before the planned time there is no Open ticket sales action', async () => {
    await render();
    expect(byText('Open ticket sales', card('Afrobeats Live'))).toBeUndefined();
    const labels = await optionLabels('Afrobeats Live');
    expect(labels).not.toContain('Open Ticket Sales');
    expect(labels).toContain('Hide as Draft');
    expect(labels).toContain('Edit');
  });

  it('Promote is not offered for a Coming Soon event (Featured/Trending stay under their own rules)', async () => {
    await render();
    expect(byText('Promote Event', card('Afrobeats Live'))).toBeUndefined();
    const labels = await optionLabels('Afrobeats Live');
    expect(labels).not.toContain('Promote');
  });

  it('once due, Open ticket sales calls open_event_sales and reports who was notified', async () => {
    rpc.mockImplementation(async (fn: string) => (fn === 'open_event_sales' ? { data: { opened: true, notified: 3 }, error: null } : { data: [], error: null }));
    await render();
    await click(byText('Open ticket sales', card('Due Show')));
    expect(rpc).toHaveBeenCalledWith('open_event_sales', { p_event_id: 'cs2' });
    expect(card('Due Show').textContent).toContain('Ticket sales are open · 3 people notified');
    expect(refresh).toHaveBeenCalled();
    expect(updates).toHaveLength(0); // never a direct status write
  });

  it('a server refusal (e.g. hidden by VENTS) is shown, not swallowed', async () => {
    rpc.mockImplementation(async (fn: string) => (fn === 'open_event_sales' ? { data: { opened: false, reason: 'hidden_by_admin' }, error: null } : { data: [], error: null }));
    await render();
    await click(byText('Open ticket sales', card('Due Show')));
    expect(card('Due Show').textContent).toContain('hidden by VENTS');
  });

  it('Hide as Draft on a Coming Soon event sets status draft', async () => {
    await render();
    await optionLabels('Afrobeats Live');
    await click(byText('Hide as Draft'));
    expect(updates).toEqual([{ id: 'cs1', row: { status: 'draft' } }]);
  });

  it('a hidden scheduled event offers "Publish as Coming Soon" (never straight on sale)', async () => {
    await render();
    const labels = await optionLabels('Hidden Scheduled');
    expect(labels).toContain('Publish as Coming Soon');
    expect(labels).not.toContain('Make Live');
    await click(byText('Publish as Coming Soon'));
    expect(updates).toEqual([{ id: 'cs3', row: { status: 'coming_soon' } }]);
  });
});

describe('Manage Events: existing behaviour unchanged', () => {
  it('a plain draft still offers Make Live and sets status live', async () => {
    await render();
    const labels = await optionLabels('Plain Draft');
    expect(labels).toContain('Make Live');
    await click(byText('Make Live'));
    expect(updates).toEqual([{ id: 'd1', row: { status: 'live' } }]);
  });

  it('a live event keeps Promote and shows no Coming Soon panel', async () => {
    await render();
    expect(byText('Promote Event', card('Live Show'))).toBeDefined();
    expect(q('coming-soon-status-l1')).toBeNull();
  });
});

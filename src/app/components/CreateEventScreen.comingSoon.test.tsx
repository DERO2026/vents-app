import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Coming Soon (0224) in Create / Edit Event, driven through the real wizard
// (every step's validation) with the payload sent to supabase.from('events')
// captured: the Ticket sales choice, Nigeria-time -> UTC conversion, the same
// rules the server enforces, and edits that never change status or clear a
// schedule. "Open now" (the default) is the unchanged existing behaviour.

const writes: { table: string; op: 'insert' | 'update'; row: any; filter: any[] }[] = [];
let eventRow: any = null;
let failFirstWriteWithMissingColumn = false;

function chain(table: string): any {
  const ops: any[][] = [];
  const result = () => {
    const write = ops.find((o) => o[0] === 'insert' || o[0] === 'update');
    if (write) {
      const row = write[0] === 'insert' ? write[1][0] : write[1];
      if (failFirstWriteWithMissingColumn && 'show_attendance_count' in row) {
        failFirstWriteWithMissingColumn = false;
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'show_attendance_count' column of 'events' in the schema cache" } };
      }
      writes.push({ table, op: write[0], row, filter: ops.filter((o) => o[0] === 'eq') });
      return { data: write[0] === 'insert' ? [{ id: 'new-event' }] : null, error: null };
    }
    if (table === 'events' && ops.some((o) => o[0] === 'single' || o[0] === 'maybeSingle')) return { data: eventRow, error: eventRow ? null : { message: 'not found' } };
    return { data: [], error: null, count: 0 };
  };
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        const p = Promise.resolve(result());
        return (p as any)[prop].bind(p);
      }
      return (...args: any[]) => { ops.push([prop, ...args]); return proxy; };
    },
  });
  return proxy;
}

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => chain(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
  },
}));
vi.mock('../../lib/permissions', () => ({ hasCapability: () => true }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {}, captureMessage: () => {} } }));
vi.mock('canvas-confetti', () => ({ default: () => {} }));

import { CreateEventScreen } from './CreateEventScreen';

const CURRENT_USER = { id: 'org-1', email: 'org@vents.test', full_name: 'Org User', role: 'organizer', isOrganizer: true, country: 'NG' };
const future = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
const ROW = {
  id: 'event-1', organizer_id: 'org-1', title: 'Paint & Play Day', description: 'A full afternoon of games, music and food for everyone.',
  image_url: 'https://example.test/flyer.jpg', gallery_urls: [], location: 'Play Park, Lagos, Ikeja', location_type: 'in_person',
  country: 'NG', event_date: `${future}T14:00:00+01:00`, start_time: '14:00', end_time: '20:00', categories: ['Sports'], category: 'Sports',
  ticket_goal: 200, status: 'live', is_18_plus: false, show_phone: false, contact_phone: null, payout_account_id: null,
  ticket_types: [{ id: 't_0', name: 'Regular', price: 5000, quantity: 200, description: 'Entry' }],
};

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  if (!(Element.prototype as any).scrollTo) (Element.prototype as any).scrollTo = () => {};
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  writes.length = 0; failFirstWriteWithMissingColumn = false;
});
afterEach(() => { act(() => root.unmount()); container.remove(); eventRow = null; });

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="attendance-visibility-toggle"]');
const mainButton = () => Array.from(container.querySelectorAll('button')).find((b) => /^(Next: |Save Changes|Publish Event|Publish as Coming Soon)/.test(b.textContent || ''))!;
const errorText = () => container.textContent || '';
async function click(el: Element | null | undefined) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }

async function openEdit(row: any) {
  eventRow = row;
  await act(async () => { root.render(<CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} editEventId="event-1" onUpdated={() => {}} />); });
  for (let i = 0; i < 4; i++) await flush();
}
async function goToSettingsStep() {
  for (let i = 0; i < 4 && !toggle(); i++) await click(mainButton());
  expect(toggle(), `could not reach the Settings step: ${errorText().slice(0, 200)}`).toBeTruthy();
}
async function saveFromSettings() {
  await click(mainButton());                 // Settings -> Review
  expect(mainButton().textContent).toBe('Save Changes');
  await click(mainButton());                 // Save Changes
  for (let i = 0; i < 3; i++) await flush();
}
const lastEventUpdate = () => writes.filter((w) => w.table === 'events' && w.op === 'update').pop();

// Set a controlled input the way a user does (React tracks the native value setter).
function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) {
  expect(el, 'input not found').toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el!.dispatchEvent(new Event('input', { bubbles: true }));
}
const byPlaceholder = (p: string) => container.querySelector<HTMLInputElement>(`[placeholder="${p}"]`);
const buttonWithText = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === text);


const salesMode = (m: 'now' | 'coming_soon') => container.querySelector<HTMLButtonElement>(`[data-testid="sales-mode-${m}"]`);
const salesDate = () => container.querySelector<HTMLInputElement>('[data-testid="sales-open-date"]');
const salesTime = () => container.querySelector<HTMLInputElement>('[data-testid="sales-open-time"]');
const inserts = () => writes.filter((w) => w.table === 'events' && w.op === 'insert');
const salesDay = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];   // before the event (30 days out)

async function createToReview() {
  await act(async () => { root.render(<CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />); });
  await flush();
  await act(async () => { typeInto(byPlaceholder('e.g. Afrobeats Night 2026'), 'Afrobeats Live'); });
  await click(buttonWithText('Music') || Array.from(container.querySelectorAll('button')).find((b) => /Music/.test(b.textContent || '')));
  await click(mainButton());
  await click(mainButton());
  const [startDate] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  const [startTime] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="time"]'));
  await act(async () => { typeInto(startDate, future); typeInto(startTime, '20:00'); });
  await click(Array.from(container.querySelectorAll('button')).find((b) => /Online/.test(b.textContent || '') && !/Hybrid/.test(b.textContent || '')));
  await act(async () => { typeInto(byPlaceholder('https://discord.gg/...'), 'https://discord.gg/vents-test'); typeInto(byPlaceholder('500'), '200'); });
  await click(mainButton());
  await act(async () => {
    typeInto(byPlaceholder('e.g. VIP, VVIP, Standard'), 'Regular');
    typeInto(byPlaceholder('5000'), '5000');
    typeInto(byPlaceholder('200'), '200');
    typeInto(byPlaceholder('e.g. General admission / VIP table access'), 'Entry');
  });
  await click(mainButton());   // Tickets -> Settings
  await click(mainButton());   // Settings -> Review
  expect(container.querySelector('[data-testid="ticket-sales-mode"]'), errorText().slice(0, 200)).toBeTruthy();
}

describe('Create Event: Ticket sales', () => {
  it('defaults to Open now: the existing publish label and no sales time in the payload', async () => {
    await createToReview();
    expect(salesMode('now')!.getAttribute('aria-checked')).toBe('true');
    expect(salesDate()).toBeNull();
    expect(mainButton().textContent).toBe('Publish Event');
    await click(buttonWithText('Save as Draft'));
    for (let i = 0; i < 3; i++) await flush();
    const row = inserts().pop()!.row;
    expect(row.status).toBe('draft');
    expect(row).not.toHaveProperty('sales_open_at');
  });

  it('Coming Soon: Nigeria-time opening is sent as the right UTC instant; label says Publish as Coming Soon', async () => {
    await createToReview();
    await click(salesMode('coming_soon'));
    await act(async () => { typeInto(salesDate(), salesDay); typeInto(salesTime(), '10:00'); });
    await flush();
    expect(mainButton().textContent).toBe('Publish as Coming Soon');
    expect(container.textContent).toMatch(/Coming Soon · on sale /);
    await click(buttonWithText('Save as Draft'));
    for (let i = 0; i < 3; i++) await flush();
    const row = inserts().pop()!.row;
    expect(row.status).toBe('draft');   // a draft keeps the schedule for later; publishing sends 'coming_soon'
    expect(row.sales_open_at).toBe(new Date(`${salesDay}T10:00:00+01:00`).toISOString());
    expect(row.title).toBe('Afrobeats Live');
  });

  it('Coming Soon without a time, or with one in the past, is refused before anything is written', async () => {
    await createToReview();
    await click(salesMode('coming_soon'));
    await click(buttonWithText('Save as Draft'));
    expect(errorText()).toContain('Please choose when ticket sales open.');
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    await act(async () => { typeInto(salesDate(), yesterday); typeInto(salesTime(), '10:00'); });
    await click(buttonWithText('Save as Draft'));
    expect(errorText()).toContain('Ticket sales must open at a time in the future.');
    expect(inserts()).toHaveLength(0);
  });

  it('a sales time after the event starts is refused', async () => {
    await createToReview();
    await click(salesMode('coming_soon'));
    const after = new Date(Date.now() + 40 * 86400000).toISOString().split('T')[0];
    await act(async () => { typeInto(salesDate(), after); typeInto(salesTime(), '10:00'); });
    await click(buttonWithText('Save as Draft'));
    expect(errorText()).toContain('Ticket sales must open before the event starts.');
    expect(inserts()).toHaveLength(0);
  });
});

describe('Edit Event: Coming Soon', () => {
  const COMING = { ...ROW, status: 'coming_soon', sales_open_at: `${salesDay}T09:00:00.000Z` };
  async function toReview(row: any) {
    await openEdit(row);
    for (let i = 0; i < 6 && !/^Save Changes/.test(mainButton().textContent || ''); i++) await click(mainButton());
    expect(mainButton().textContent, errorText().slice(0, 200)).toBe('Save Changes');
  }

  it('loads the planned opening in Nigeria time; the schedule cannot be switched back to Open now', async () => {
    await toReview(COMING);
    expect(salesDate()!.value).toBe(salesDay);
    expect(salesTime()!.value).toBe('10:00');
    expect(salesMode('now')).toBeNull();
  });

  it('editing other details does not touch status or the schedule', async () => {
    await toReview(COMING);
    await click(mainButton());
    for (let i = 0; i < 3; i++) await flush();
    const row = lastEventUpdate()!.row;
    expect(row).not.toHaveProperty('status');
    expect(row).not.toHaveProperty('sales_open_at');
    expect(row.title).toBe('Paint & Play Day');
  });

  it('moving the opening to another future time sends only that change', async () => {
    await toReview(COMING);
    await act(async () => { typeInto(salesTime(), '18:30'); });
    await click(mainButton());
    for (let i = 0; i < 3; i++) await flush();
    const row = lastEventUpdate()!.row;
    expect(row.sales_open_at).toBe(new Date(`${salesDay}T18:30:00+01:00`).toISOString());
    expect(row).not.toHaveProperty('status');
  });

  it('moving it into the past is refused before saving', async () => {
    await toReview(COMING);
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    await act(async () => { typeInto(salesDate(), yesterday); });
    await click(mainButton());
    expect(errorText()).toContain('Ticket sales must open at a time in the future.');
    expect(lastEventUpdate()).toBeUndefined();
  });

  it('a live (on sale) event shows no Ticket sales section', async () => {
    await toReview({ ...ROW, status: 'live' });
    expect(container.querySelector('[data-testid="ticket-sales-mode"]')).toBeNull();
  });
});

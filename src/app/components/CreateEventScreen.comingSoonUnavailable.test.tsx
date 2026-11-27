import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// P0 2026-11-27 regression: production lacks migration 0224, so PostgREST
// rejects events.sales_open_at ("Could not find the 'sales_open_at' column of
// 'events' in the schema cache", PGRST204). The Preview step showed that raw
// error under a green "Ready to publish!" and kept offering "Publish as Coming
// Soon". Driven through the real wizard against a mock that answers as
// production does.

const writes: { table: string; op: 'insert' | 'update'; row: any; filter: any[] }[] = [];
let eventRow: any = null;
let failFirstWriteWithMissingColumn = false;
// Production shape (0224 not applied): the column is unknown to PostgREST.
let probeMissing = false;     // select('sales_open_at') -> PGRST204
let writeMissing = false;     // any write carrying sales_open_at -> PGRST204
const MISSING_COL = { code: 'PGRST204', message: "Could not find the 'sales_open_at' column of 'events' in the schema cache" };
let rejectedWrites = 0;

function chain(table: string): any {
  const ops: any[][] = [];
  const result = () => {
    const write = ops.find((o) => o[0] === 'insert' || o[0] === 'update');
    if (write) {
      const row = write[0] === 'insert' ? write[1][0] : write[1];
      if (writeMissing && 'sales_open_at' in row) { rejectedWrites++; return { data: null, error: MISSING_COL }; }
      if (failFirstWriteWithMissingColumn && 'show_attendance_count' in row) {
        failFirstWriteWithMissingColumn = false;
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'show_attendance_count' column of 'events' in the schema cache" } };
      }
      writes.push({ table, op: write[0], row, filter: ops.filter((o) => o[0] === 'eq') });
      return { data: write[0] === 'insert' ? [{ id: 'new-event' }] : null, error: null };
    }
    if (probeMissing && table === 'events' && ops.some((o) => o[0] === 'select' && /sales_open_at/.test(String(o[1])))) return { data: null, error: MISSING_COL };
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
// Publishing (not drafts) needs a flyer: stand in for the cropper and the
// upload so the real publish path, flyer gate included, runs.
vi.mock('./ImageCropperModal', () => ({ ImageCropperModal: ({ onCropComplete }: any) => <button data-testid="crop-done" onClick={() => onCropComplete(new Blob(['x'], { type: 'image/jpeg' }))}>crop</button> }));
vi.mock('../../lib/mediaPipeline', () => ({ uploadImage: async () => ({ url: 'https://example.test/flyer.jpg', storageKey: 'events/flier.jpg' }) }));
vi.mock('../../lib/pickImage', () => ({ pickImage: async () => null }));
const confetti = vi.fn();
vi.mock('canvas-confetti', () => ({ default: (...a: any[]) => confetti(...a) }));

import { CreateEventScreen } from './CreateEventScreen';
import { resetComingSoonSupportCache, COMING_SOON_UNAVAILABLE } from '../../lib/comingSoonSupport';

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
  if (!(URL as any).createObjectURL) (URL as any).createObjectURL = () => 'blob:test';
  if (!(URL as any).revokeObjectURL) (URL as any).revokeObjectURL = () => {};
  if (!(Element.prototype as any).scrollTo) (Element.prototype as any).scrollTo = () => {};
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  writes.length = 0; failFirstWriteWithMissingColumn = false;
  probeMissing = false; writeMissing = false; rejectedWrites = 0; confetti.mockReset(); resetComingSoonSupportCache();
});
afterEach(() => { act(() => root.unmount()); container.remove(); eventRow = null; });

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mainButton = () => Array.from(container.querySelectorAll('button')).find((b) => /^(Next: |Save Changes|Publish Event|Publish as Coming Soon)/.test(b.textContent || ''))!;
const errorText = () => container.textContent || '';
async function click(el: Element | null | undefined) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }

const salesMode = (m: 'now' | 'coming_soon') => container.querySelector<HTMLButtonElement>(`[data-testid="sales-mode-${m}"]`);
const salesDate = () => container.querySelector<HTMLInputElement>('[data-testid="sales-open-date"]');
const salesTime = () => container.querySelector<HTMLInputElement>('[data-testid="sales-open-time"]');
const readiness = () => container.querySelector<HTMLElement>('[data-testid="publish-readiness"]');
const inserts = () => writes.filter((w) => w.table === 'events' && w.op === 'insert');
const salesDay = new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];

function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) {
  expect(el, 'input not found').toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el!.dispatchEvent(new Event('input', { bubbles: true }));
}
const byPlaceholder = (p: string) => container.querySelector<HTMLInputElement>(`[placeholder="${p}"]`);
const buttonWithText = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === text);

async function uploadFlyer() {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, 'flyer input not found').toBeTruthy();
  const file = new File(['x'], 'flyer.jpg', { type: 'image/jpeg' });
  await act(async () => { Object.defineProperty(input!, 'files', { value: [file], configurable: true }); input!.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
  await click(container.querySelector('[data-testid="crop-done"]'));
  for (let i = 0; i < 3; i++) await flush();
}
async function createToReview() {
  await act(async () => { root.render(<CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />); });
  await flush();
  await act(async () => { typeInto(byPlaceholder('e.g. Afrobeats Night 2026'), 'Afrobeats Live'); });
  await click(buttonWithText('Music') || Array.from(container.querySelectorAll('button')).find((b) => /Music/.test(b.textContent || '')));
  await click(mainButton());
  await uploadFlyer();
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
  for (let i = 0; i < 3; i++) await flush();   // Coming Soon support probe
  expect(container.querySelector('[data-testid="ticket-sales-mode"]'), errorText().slice(0, 200)).toBeTruthy();
}
async function chooseComingSoon() {
  await click(salesMode('coming_soon'));
  await act(async () => { typeInto(salesDate(), salesDay); typeInto(salesTime(), '10:00'); });
  await flush();
}
async function publish() { await click(mainButton()); for (let i = 0; i < 4; i++) await flush(); }

describe('Publishing when the database lacks 0224 (production today)', () => {
  it('normal "Open now" publish: no sales_open_at in the payload, status live, succeeds', async () => {
    probeMissing = true; writeMissing = true;
    await createToReview();
    expect(mainButton().textContent).toBe('Publish Event');
    await publish();
    const row = inserts().pop()!.row;
    expect(row.status).toBe('live');
    expect(row).not.toHaveProperty('sales_open_at');
    expect(rejectedWrites).toBe(0);
    expect(errorText()).not.toMatch(/schema cache|sales_open_at/);
  });

  it('the probe detects the missing column: Coming Soon is not offered and the organiser is told why', async () => {
    probeMissing = true;
    await createToReview();
    expect(salesMode('now')).toBeTruthy();
    expect(salesMode('coming_soon')).toBeNull();
    expect(container.querySelector('[data-testid="coming-soon-unavailable"]')).toBeTruthy();
    expect(mainButton().textContent).toBe('Publish Event');
    expect(readiness()!.getAttribute('data-state')).toBe('ready');
  });

  it('THE BUG: Coming Soon publish rejected for the missing column -> "Not published", friendly message, no success, option withdrawn', async () => {
    writeMissing = true;   // probe inconclusive/passes (e.g. stale), the write is what fails
    await createToReview();
    await chooseComingSoon();
    expect(mainButton().textContent).toBe('Publish as Coming Soon');
    await publish();
    expect(rejectedWrites).toBe(1);
    expect(inserts()).toHaveLength(0);            // nothing was created
    expect(confetti).not.toHaveBeenCalled();
    const banner = readiness()!;
    expect(banner.getAttribute('data-state')).toBe('failed');
    expect(banner.textContent).toContain('Not published');
    expect(errorText()).not.toContain('Ready to publish!');
    expect(errorText()).toContain(COMING_SOON_UNAVAILABLE);
    expect(errorText()).not.toMatch(/schema cache/);
    expect(salesMode('coming_soon')).toBeNull();  // not offered again this session
    expect(mainButton().textContent).toBe('Publish Event');
  });

  it('after the rejection, publishing with "Open now" works and sends no sales time', async () => {
    writeMissing = true;
    await createToReview();
    await chooseComingSoon();
    await publish();
    await publish();
    const row = inserts().pop()!.row;
    expect(row.status).toBe('live');
    expect(row).not.toHaveProperty('sales_open_at');
  });
});

describe('Publishing when the database has 0224', () => {
  it('Coming Soon publish sends status coming_soon and the scheduled sales time', async () => {
    await createToReview();
    await chooseComingSoon();
    await publish();
    const row = inserts().pop()!.row;
    expect(row.status).toBe('coming_soon');
    expect(row.sales_open_at).toBe(new Date(`${salesDay}T10:00:00+01:00`).toISOString());
    expect(readiness()?.getAttribute('data-state') ?? 'ready').not.toBe('failed');
  });

  it('a non-schema failure still says "Not published" with its own message, never "Ready to publish!"', async () => {
    failFirstWriteWithMissingColumn = false;
    await createToReview();
    // make the next insert fail with an ordinary error
    const orig = writes.push.bind(writes);
    (writes as any).push = () => { throw new Error('boom'); };
    try { await publish(); } finally { (writes as any).push = orig; }
    expect(readiness()!.getAttribute('data-state')).toBe('failed');
    expect(errorText()).not.toContain('Ready to publish!');
  });
});

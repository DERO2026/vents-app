import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Event attendance visibility (0221) in Create / Edit Event: the setting
// renders as an accessible switch, loads the saved value, is persisted on save
// and is never reset by saving other edits. The edit flow is driven through
// the real wizard (every step's validation) up to "Save Changes", and the
// payload the screen sends to supabase.from('events').update() is captured.

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
import { AttendanceVisibilityToggle } from './AttendanceVisibilityToggle';

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
const mainButton = () => Array.from(container.querySelectorAll('button')).find((b) => /^(Next: |Save Changes|Publish Event)/.test(b.textContent || ''))!;
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

describe('AttendanceVisibilityToggle', () => {
  it('renders the label, the description and an accessible switch reflecting the value', async () => {
    const onChange = vi.fn();
    await act(async () => { root.render(<AttendanceVisibilityToggle checked onChange={onChange} />); });
    const sw = toggle()!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-label')).toBe('Show attendance count publicly');
    expect(container.textContent).toContain('Choose whether people can see how many attendees your event has.');
    expect(container.querySelector('[data-testid="attendance-visibility-hidden-note"]')).toBeNull();
    await click(sw);
    expect(onChange).toHaveBeenCalledWith(false);
  });
  it('when OFF, says the event stays visible and on sale', async () => {
    await act(async () => { root.render(<AttendanceVisibilityToggle checked={false} onChange={() => {}} />); });
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[data-testid="attendance-visibility-hidden-note"]')!.textContent).toMatch(/stays visible and on sale/);
  });
});

// Set a controlled input the way a user does (React tracks the native value setter).
function typeInto(el: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) {
  expect(el, 'input not found').toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el!.dispatchEvent(new Event('input', { bubbles: true }));
}
const byPlaceholder = (p: string) => container.querySelector<HTMLInputElement>(`[placeholder="${p}"]`);
const buttonWithText = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === text);

describe('Create Event', () => {
  it('shows the switch ON by default on the Settings step, and saves the organizer\'s choice', async () => {
    await act(async () => { root.render(<CreateEventScreen currentUser={CURRENT_USER} onBack={() => {}} onCreated={() => {}} />); });
    await flush();
    // 1. Basics
    await act(async () => { typeInto(byPlaceholder('e.g. Afrobeats Night 2026'), 'Paint & Play Day'); });
    await click(buttonWithText('Music') || Array.from(container.querySelectorAll('button')).find((b) => /Music/.test(b.textContent || '')));
    await click(mainButton());
    // 2. Media (validated only at publish)
    await click(mainButton());
    // 3. When & where: an online event (no venue/state/city pickers needed)
    const [startDate] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    const [startTime] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="time"]'));
    await act(async () => { typeInto(startDate, future); typeInto(startTime, '14:00'); });
    await click(Array.from(container.querySelectorAll('button')).find((b) => /Online/.test(b.textContent || '') && !/Hybrid/.test(b.textContent || '')));
    await act(async () => { typeInto(byPlaceholder('https://discord.gg/...'), 'https://discord.gg/vents-test'); typeInto(byPlaceholder('500'), '200'); });
    await click(mainButton());
    // 4. Tickets
    await act(async () => {
      typeInto(byPlaceholder('e.g. VIP, VVIP, Standard'), 'Regular');
      typeInto(byPlaceholder('5000'), '5000');
      typeInto(byPlaceholder('200'), '200');
      typeInto(byPlaceholder('e.g. General admission / VIP table access'), 'Entry');
    });
    await click(mainButton());
    // 5. Settings: the switch is there, ON by default
    expect(toggle(), `could not reach the Settings step: ${errorText().slice(0, 200)}`).toBeTruthy();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('Show attendance count publicly');
    await click(toggle());
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    await click(mainButton());
    // 6. Review, then save as a draft (the publish path additionally needs a flyer upload)
    expect(container.textContent).toContain('Hidden from the public');
    await click(buttonWithText('Save as Draft'));
    for (let i = 0; i < 3; i++) await flush();
    const insert = writes.filter((w) => w.table === 'events' && w.op === 'insert').pop();
    expect(insert, errorText().slice(0, 300)).toBeTruthy();
    expect(insert!.row.show_attendance_count).toBe(false);
    expect(insert!.row.title).toBe('Paint & Play Day');
    expect(insert!.row.organizer_id).toBe('org-1');
  });
});

describe('Edit Event', () => {
  it('loads a saved OFF setting and keeps it when other details are edited and saved', async () => {
    await openEdit({ ...ROW, show_attendance_count: false });
    await goToSettingsStep();
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    await saveFromSettings();
    const w = lastEventUpdate();
    expect(w, errorText().slice(0, 300)).toBeTruthy();
    expect(w!.row.show_attendance_count).toBe(false);
    expect(w!.row.title).toBe('Paint & Play Day');
    expect(w!.filter).toContainEqual(['eq', 'id', 'event-1']);
  });

  it('loads a saved ON setting; turning it OFF is saved without touching status, tiers or capacity', async () => {
    await openEdit({ ...ROW, show_attendance_count: true });
    await goToSettingsStep();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
    await click(toggle());
    expect(toggle()!.getAttribute('aria-checked')).toBe('false');
    await saveFromSettings();
    const row = lastEventUpdate()!.row;
    expect(row.show_attendance_count).toBe(false);
    expect(row).not.toHaveProperty('status');            // the edit never unpublishes
    expect(row.ticket_goal).toBe(200);
    // D2a (0229): the tier also carries its identity key -- for a tier saved
    // before 0229, its own loaded name -- so a later rename keeps its sales.
    expect(row.ticket_types).toEqual([{ id: 't_0', key: 'Regular', name: 'Regular', price: 5000, quantity: 200, description: 'Entry' }]);
  });

  it('turning it back ON is saved', async () => {
    await openEdit({ ...ROW, show_attendance_count: false });
    await goToSettingsStep();
    await click(toggle());
    await saveFromSettings();
    expect(lastEventUpdate()!.row.show_attendance_count).toBe(true);
  });

  it('a row from before 0221 (no column) loads as ON', async () => {
    const { ...legacy } = ROW;
    await openEdit(legacy);
    await goToSettingsStep();
    expect(toggle()!.getAttribute('aria-checked')).toBe('true');
  });

  it('the review step shows the choice', async () => {
    await openEdit({ ...ROW, show_attendance_count: false });
    await goToSettingsStep();
    await click(mainButton());
    expect(container.textContent).toContain('Attendance Count');
    expect(container.textContent).toContain('Hidden from the public');
  });

  it('before 0221 is applied, a default (ON) save still succeeds without the column', async () => {
    failFirstWriteWithMissingColumn = true;
    await openEdit({ ...ROW });
    await goToSettingsStep();
    await saveFromSettings();
    const row = lastEventUpdate()!.row;
    expect(row).not.toHaveProperty('show_attendance_count');
    expect(row.title).toBe('Paint & Play Day');
  });

  it('before 0221 is applied, a request to HIDE the count is never silently dropped', async () => {
    failFirstWriteWithMissingColumn = true;
    await openEdit({ ...ROW });
    await goToSettingsStep();
    await click(toggle());
    await saveFromSettings();
    expect(lastEventUpdate()).toBeUndefined();
    expect(container.textContent).toContain("Hiding the attendance count isn't available yet");
  });
});

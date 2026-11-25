import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Announcements in the notification centre (one feed, not a second system):
// an Announcements tab (server-filtered: type 'announcement', or 'broadcast'
// sent with the 📢 icon -- admin approval notices are 'broadcast' with ✅/❌),
// an unread badge on that tab, a full-text reader that marks the row read,
// a push tap opening the right announcement, and every other notification
// keeping its existing tap-to-route behaviour.
// supabase is an in-memory fake that applies the same filters the screen
// sends, so the assertions check what the server would actually return.

type Row = { id: string; user_id: string; type: string; title: string; body: string; read: boolean; icon: string; created_at: string; push_data: any };
let rows: Row[] = [];
const updates: { filters: any[]; patch: any }[] = [];
const deletes: { filters: any[] }[] = [];

function makeQuery(table: string) {
  const filters: [string, string, any][] = [];
  // PostgREST or=() as the screen sends it: comma-separated eq conditions and
  // and(...) groups. Evaluated, not string-matched, so a wrong filter fails.
  const orGroups: string[][][] = [];
  const parseOr = (expr: string) => {
    const parts: string[] = []; let depth = 0; let cur = '';
    for (const ch of expr) { if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; } if (ch === '(') depth++; if (ch === ')') depth--; cur += ch; }
    parts.push(cur);
    return parts.map((p) => (p.startsWith('and(') ? p.slice(4, -1).split(',') : [p]));
  };
  const condOk = (r: any, c: string) => { const [col, op, ...v] = c.split('.'); if (op !== 'eq') throw new Error('fake supports eq only: ' + c); return String(r[col]) === v.join('.'); };
  let mode: 'select' | 'update' | 'delete' = 'select';
  let patch: any = null;
  let head = false;
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const apply = () => rows.filter((r) => filters.every(([op, col, v]) => (op === 'eq' ? (r as any)[col] === v : (v as any[]).includes((r as any)[col])))
    && orGroups.every((groups) => groups.some((g) => g.every((c) => condOk(r, c)))));
  const run = () => {
    if (table !== 'notifications') return { data: [], error: null };
    const matched = apply();
    if (mode === 'update') { matched.forEach((r) => Object.assign(r, patch)); updates.push({ filters: [...filters], patch }); return { data: null, error: null }; }
    if (mode === 'delete') { rows = rows.filter((r) => !matched.includes(r)); deletes.push({ filters: [...filters] }); return { data: null, error: null }; }
    const sorted = [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (head) return { data: null, count: sorted.length, error: null };
    const sliced = range ? sorted.slice(range[0], range[1] + 1) : limit != null ? sorted.slice(0, limit) : sorted;
    return { data: sliced.map((r) => ({ ...r })), error: null };
  };
  const q: any = {
    select: (_c?: string, opts?: any) => { if (opts?.head) head = true; return q; },
    update: (p: any) => { mode = 'update'; patch = p; return q; },
    delete: () => { mode = 'delete'; return q; },
    eq: (c: string, v: any) => { filters.push(['eq', c, v]); return q; },
    in: (c: string, v: any[]) => { filters.push(['in', c, v]); return q; },
    or: (expr: string) => { orGroups.push(parseOr(expr)); return q; },
    order: () => q,
    limit: (n: number) => { limit = n; return q; },
    range: (a: number, b: number) => { range = [a, b]; return q; },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}

vi.mock('../../lib/supabase', () => ({ supabase: { from: (t: string) => makeQuery(t) } }));
let rtHandler: (() => void) | null = null;
vi.mock('../../lib/userRealtime', () => ({ onUserRealtime: (_u: any, _e: any, h: () => void) => { rtHandler = h; return () => {}; } }));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { notificationOpened: () => {} } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

import { NotificationsScreen } from './NotificationsScreen';

const ME = 'user-1';
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();
const LONG = 'Line one of a long announcement.\nLine two continues with details.\n\nFinal paragraph.';

function seed() {
  rows = [
    { id: 'n-ann', user_id: ME, type: 'announcement', title: 'Organizer payouts update', body: LONG, read: false, icon: '📢', created_at: iso(5), push_data: { type: 'announcement', announcementId: 'a-1' } },
    { id: 'n-bc', user_id: ME, type: 'broadcast', title: 'Hello everyone', body: 'General notice', read: false, icon: '📢', created_at: iso(10), push_data: null },
    { id: 'n-sale', user_id: ME, type: 'sale', title: 'New ticket sale', body: 'Someone bought a ticket', read: false, icon: '🎟', created_at: iso(1), push_data: { eventId: 'e-1', screen: 'sales-analytics' } },
    { id: 'n-msg', user_id: ME, type: 'message', title: 'New message', body: 'Hi', read: true, icon: '💬', created_at: iso(20), push_data: { userId: 'u-2', screen: 'chat' } },
    { id: 'n-other', user_id: 'someone-else', type: 'announcement', title: 'Not mine', body: 'x', read: false, icon: '📢', created_at: iso(2), push_data: null },
    // Admin maker-checker notice: type 'broadcast' but NOT an announcement (0004/0186).
    { id: 'n-adm', user_id: ME, type: 'broadcast', title: 'Your request has been approved', body: 'Your request (Feature event) was approved and executed.', read: false, icon: '✅', created_at: iso(15), push_data: null },
  ];
}

let container: HTMLDivElement; let root: Root;
const route = vi.fn(); const refreshUnread = vi.fn(); const focusConsumed = vi.fn();

beforeEach(() => { seed(); updates.length = 0; deletes.length = 0; route.mockReset(); refreshUnread.mockReset(); focusConsumed.mockReset(); container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
async function mount(props: Record<string, any> = {}) {
  root = createRoot(container);
  act(() => { root.render(<NotificationsScreen onBack={() => {}} currentUser={{ id: ME }} onRefreshUnread={refreshUnread} onRouteNotification={route} onFocusConsumed={focusConsumed} {...props} />); });
  await flush();
}
const titles = () => Array.from(container.querySelectorAll('[data-testid="notification-row"]')).map((r) => r.querySelector('span')?.textContent);
const tab = (name: string) => Array.from(container.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.includes(name)) as HTMLButtonElement;
const row = (title: string) => Array.from(container.querySelectorAll('[data-testid="notification-row"]')).find((r) => r.textContent?.includes(title)) as HTMLElement;
const reader = () => container.querySelector('[data-testid="announcement-reader"]') as HTMLElement | null;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await flush(); };

describe('Notification centre: Announcements', () => {
  it('All tab still shows every notification of mine, newest first (existing behaviour)', async () => {
    await mount();
    expect(tab('All').getAttribute('aria-selected')).toBe('true');
    expect(titles()).toEqual(['New ticket sale', 'Organizer payouts update', 'Hello everyone', 'Your request has been approved', 'New message']);
  });

  it('Announcements tab shows only announcements (role announcements + 📢 broadcasts), fetched with a server-side filter', async () => {
    await mount();
    await click(tab('Announcements'));
    expect(tab('Announcements').getAttribute('aria-selected')).toBe('true');
    expect(titles()).toEqual(['Organizer payouts update', 'Hello everyone']);
  });

  it('the Announcements tab shows its own unread count', async () => {
    await mount();
    expect(container.querySelector('[data-testid="announcements-unread"]')?.textContent).toBe('2');
  });

  it('opening an announcement shows the full title, date and untruncated body, and marks it read', async () => {
    await mount();
    await click(row('Organizer payouts update'));
    const r = reader()!;
    expect(r).toBeTruthy();
    expect(r.querySelector('h2')?.textContent).toBe('Organizer payouts update');
    expect(r.querySelector('time')?.getAttribute('dateTime')).toBe(rows.find((x) => x.id === 'n-ann')!.created_at);
    expect(r.textContent).toContain('Final paragraph.');
    expect(rows.find((x) => x.id === 'n-ann')!.read).toBe(true);
    expect(refreshUnread).toHaveBeenCalled(); // App's bell badge is refreshed
    expect(route).not.toHaveBeenCalled(); // announcements open the reader, not another screen
    expect(container.querySelector('[data-testid="announcements-unread"]')?.textContent).toBe('1');
  });

  it('the reader closes with its close button and with Escape', async () => {
    await mount();
    await click(row('Hello everyone'));
    await click(reader()!.querySelector('[aria-label="Close announcement"]')!);
    expect(reader()).toBeNull();
    await click(row('Hello everyone'));
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(reader()).toBeNull();
  });

  it('non-announcement notifications keep routing exactly as before (no reader)', async () => {
    await mount();
    await click(row('New ticket sale'));
    expect(reader()).toBeNull();
    expect(route).toHaveBeenCalledWith({ eventId: 'e-1', screen: 'sales-analytics' });
    expect(rows.find((x) => x.id === 'n-sale')!.read).toBe(true);
  });

  it('Mark all read on the Announcements tab only marks announcements', async () => {
    await mount();
    await click(tab('Announcements'));
    await click(container.querySelector('[aria-label="Mark all announcements read"]')!);
    expect(rows.find((x) => x.id === 'n-ann')!.read).toBe(true);
    expect(rows.find((x) => x.id === 'n-bc')!.read).toBe(true);
    expect(rows.find((x) => x.id === 'n-adm')!.read).toBe(false); // admin notice is not an announcement
    expect(rows.find((x) => x.id === 'n-sale')!.read).toBe(false);
    expect(rows.find((x) => x.id === 'n-other')!.read).toBe(false);
  });

  it('Mark all read on the All tab still marks everything of mine (existing behaviour)', async () => {
    await mount();
    await click(container.querySelector('[aria-label="Mark all read"]')!);
    expect(rows.filter((x) => x.user_id === ME).every((x) => x.read)).toBe(true);
    expect(rows.find((x) => x.id === 'n-other')!.read).toBe(false);
  });

  it('Clear all on the Announcements tab removes announcements only', async () => {
    await mount();
    await click(tab('Announcements'));
    await click(container.querySelector('[aria-label="Clear all"]')!);
    // ConfirmDialog renders into a portal on document.body.
    expect(document.body.textContent).toContain('Clear all announcements?');
    await click(Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Clear All')!);
    expect(rows.map((r) => r.id).sort()).toEqual(['n-adm', 'n-msg', 'n-other', 'n-sale']);
  });

  it('an announcement push opens the Announcements tab with that announcement in the reader', async () => {
    await mount({ focusAnnouncementId: 'a-1' });
    expect(tab('Announcements').getAttribute('aria-selected')).toBe('true');
    expect(reader()?.querySelector('h2')?.textContent).toBe('Organizer payouts update');
    expect(rows.find((x) => x.id === 'n-ann')!.read).toBe(true);
    expect(focusConsumed).toHaveBeenCalledTimes(1);
  });

  it('a push for an announcement no longer in the feed just shows the Announcements tab', async () => {
    await mount({ focusAnnouncementId: 'deleted-one' });
    expect(tab('Announcements').getAttribute('aria-selected')).toBe('true');
    expect(reader()).toBeNull();
    expect(focusConsumed).toHaveBeenCalledTimes(1);
  });

  it('empty Announcements tab explains what will appear there', async () => {
    rows = rows.filter((r) => r.type !== 'announcement' && r.type !== 'broadcast');
    await mount();
    await click(tab('Announcements'));
    expect(container.textContent).toContain('No announcements yet');
    expect(container.querySelector('[data-testid="announcements-unread"]')).toBeNull();
  });

  // ── release audit M1: admin approval notices are not announcements ──
  it('admin approval/rejection notices stay in All, are not listed or counted as announcements, and keep their old tap behaviour', async () => {
    await mount();
    expect(titles()).toContain('Your request has been approved');
    expect(container.querySelector('[data-testid="announcements-unread"]')?.textContent).toBe('2');
    await click(row('Your request has been approved'));
    expect(reader()).toBeNull(); // no announcement reader
    expect(route).not.toHaveBeenCalled(); // no push_data -> no navigation, exactly as before
    expect(rows.find((x) => x.id === 'n-adm')!.read).toBe(true); // still marked read on tap
    await click(tab('Announcements'));
    expect(titles()).not.toContain('Your request has been approved');
  });

  // ── release audit H1: live updates respect the selected tab ──
  it('a live ordinary notification does not appear in the Announcements tab; a live announcement does', async () => {
    await mount();
    await click(tab('Announcements'));
    rows.push({ id: 'n-live-sale', user_id: ME, type: 'sale', title: 'Live sale', body: 'x', read: false, icon: '🎟', created_at: iso(0), push_data: null });
    await act(async () => { rtHandler!(); }); await flush();
    expect(titles()).toEqual(['Organizer payouts update', 'Hello everyone']);
    expect(tab('Announcements').getAttribute('aria-selected')).toBe('true');
    rows.push({ id: 'n-live-ann', user_id: ME, type: 'broadcast', title: 'Live announcement', body: 'y', read: false, icon: '📢', created_at: iso(0), push_data: { type: 'announcement', announcementId: 'a-9', screen: 'notifications' } });
    await act(async () => { rtHandler!(); }); await flush();
    expect(titles()).toEqual(['Live announcement', 'Organizer payouts update', 'Hello everyone']);
    expect(container.querySelector('[data-testid="announcements-unread"]')?.textContent).toBe('3');
  });

  it('after switching back to All, live updates show every notification again', async () => {
    await mount({ focusAnnouncementId: 'gone' }); // starts on Announcements
    await click(tab('All'));
    rows.push({ id: 'n-live-sale', user_id: ME, type: 'sale', title: 'Live sale', body: 'x', read: false, icon: '🎟', created_at: iso(0), push_data: null });
    await act(async () => { rtHandler!(); }); await flush();
    expect(titles()[0]).toBe('Live sale');
    expect(titles()).toContain('New ticket sale');
  });

  // ── release audit M4: overall unread vs announcement-only unread ──
  it('header shows unread across ALL notifications; the Announcements chip shows announcements only', async () => {
    await mount();
    // mine unread: n-ann, n-bc, n-sale, n-adm = 4; announcements unread: n-ann, n-bc = 2
    expect(container.querySelector('[data-testid="notifications-unread-total"]')?.textContent).toBe('4 unread');
    expect(container.querySelector('[data-testid="announcements-unread"]')?.getAttribute('aria-label')).toBe('2 unread announcements');
    await click(tab('Announcements'));
    expect(container.querySelector('[data-testid="notifications-unread-total"]')?.textContent).toBe('4 unread'); // same meaning on both tabs
    await click(row('Hello everyone'));
    await click(reader()!.querySelector('[aria-label="Close announcement"]')!);
    expect(container.querySelector('[data-testid="notifications-unread-total"]')?.textContent).toBe('3 unread');
    expect(container.querySelector('[data-testid="announcements-unread"]')?.textContent).toBe('1');
  });

  it('header total counts unread rows beyond the first loaded page (server count, not loaded rows)', async () => {
    for (let i = 0; i < 60; i++) rows.push({ id: `bulk-${i}`, user_id: ME, type: 'social', title: `Bulk ${i}`, body: 'b', read: false, icon: '👋', created_at: iso(100 + i), push_data: null });
    await mount();
    expect(container.querySelectorAll('[data-testid="notification-row"]').length).toBe(50);
    expect(container.querySelector('[data-testid="notifications-unread-total"]')?.textContent).toBe('64 unread');
  });

  it('when every announcement is read, the Announcements tab hides its Mark-all button but the header still shows other unread', async () => {
    rows.forEach((r) => { if (r.id === 'n-ann' || r.id === 'n-bc') r.read = true; });
    await mount();
    await click(tab('Announcements'));
    expect(container.querySelector('[aria-label="Mark all announcements read"]')).toBeNull();
    expect(container.querySelector('[data-testid="announcements-unread"]')).toBeNull();
    expect(container.querySelector('[data-testid="notifications-unread-total"]')?.textContent).toBe('2 unread');
  });
});

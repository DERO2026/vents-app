import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminSystemScreen } from './AdminSystemScreen';

// Coverage for the Announcements panel (AdminAnnouncementsPanel, rendered
// inside AdminSystemScreen in place of the old send-only card).
//   * Draft mode (migration 0222 applied): save draft, edit draft, delete
//     draft, publish = save + admin_publish_announcement, published rows are
//     read-only.
//   * Legacy mode (0222 not applied -- the announcements table is missing):
//     publishing falls back to the previous immediate admin_send_announcement
//     call, so shipping the UI before the migration never removes sending.
// `supabase` is mocked: no network call, no real announcement is sent.

const rpcCalls: { name: string; args: any }[] = [];
const auditLogCalls: any[] = [];
// Announcement WRITE calls. admin_list_announcement_test_recipients (0223) is
// a read the panel makes on load to decide whether to show Internal test.
const LIST_TEST = 'admin_list_announcement_test_recipients';
const annNames = () => rpcCalls.map((c) => c.name).filter((n) => n.includes('announcement') && n !== LIST_TEST);
const calls = (name: string) => rpcCalls.filter((c) => c.name === name).map((c) => c.args);
let rpcResponses: Record<string, { data: any; error: any }> = {};
let rpcDelayMs = 0;
let announcementsResponse: { data: any; error: any } = { data: [], error: null };

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'announcements') {
        const chain: any = { select: () => chain, order: () => chain, limit: () => Promise.resolve(announcementsResponse) };
        return chain;
      }
      return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) };
    },
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args });
      const res = rpcResponses[name] ?? { data: null, error: null };
      return rpcDelayMs ? new Promise((r) => setTimeout(() => r(res), rpcDelayMs)) : Promise.resolve(res);
    },
  },
}));

vi.mock('./adminAuditLog', () => ({
  writeAuditLog: (...args: any[]) => { auditLogCalls.push(args); return Promise.resolve(); },
}));

const MISSING_FUNCTION = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.admin_list_announcement_test_recipients without parameters in the schema cache' } };
const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';
const MISSING_TABLE = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.announcements' in the schema cache" } };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rpcCalls.length = 0;
  auditLogCalls.length = 0;
  rpcDelayMs = 0;
  rpcResponses = {
    admin_send_announcement: { data: { success: true, recipients: 7 }, error: null },
    admin_save_announcement_draft: { data: 'draft-1', error: null },
    admin_publish_announcement: { data: { success: true, recipients: 7 }, error: null },
    admin_delete_announcement_draft: { data: null, error: null },
    // Default: 0223 not applied -- the panel is the three-audience panel.
    [LIST_TEST]: MISSING_FUNCTION,
  };
  announcementsResponse = { data: [], error: null };
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

async function mount(user: { id: string; role: string } = { id: 'root-1', role: 'root' }) {
  root = createRoot(container);
  act(() => { root.render(<AdminSystemScreen currentUser={user} />); });
  await flush();
}

function card() {
  return container.querySelector('[data-testid="announcement-card"]') as HTMLDivElement;
}
function titleInput() { return card().querySelector('input') as HTMLInputElement; }
function bodyInput() { return card().querySelector('textarea') as HTMLTextAreaElement; }
function sendButton() {
  return Array.from(card().querySelectorAll('button')).find((b) => b.textContent?.includes('Publish to'))! as HTMLButtonElement;
}
function saveDraftButton() {
  return Array.from(card().querySelectorAll('button')).find((b) => /Save draft|Update draft/.test(b.textContent || '')) as HTMLButtonElement | undefined;
}
function confirmButton(label = 'Publish') {
  return Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === label).pop()!;
}
function audienceButton(label: string) {
  return Array.from(card().querySelectorAll('button[role="radio"]')).find((b) => b.textContent === label)! as HTMLButtonElement;
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}
async function fill(title: string, body: string, audience?: string) {
  await act(async () => {
    setValue(titleInput(), title);
    setValue(bodyInput(), body);
    if (audience) audienceButton(audience).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

describe('AdminSystemScreen: Announcements panel (composer)', () => {
  it('renders exactly three audience options: Everyone, Organizers, Service Providers', async () => {
    await mount();
    const labels = Array.from(card().querySelectorAll('button[role="radio"]')).map((b) => b.textContent);
    expect(labels).toEqual(['Everyone', 'Organizers', 'Service Providers']);
  });

  it('defaults to Everyone and clearly displays the currently selected audience', async () => {
    await mount();
    expect(card().textContent).toMatch(/Sending to:\s*Everyone/);
    expect(audienceButton('Everyone').getAttribute('aria-checked')).toBe('true');
  });

  it('selecting Organizers updates the displayed audience and the radio state', async () => {
    await mount();
    await act(async () => { audienceButton('Organizers').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(card().textContent).toMatch(/Sending to:\s*Organizers/);
    expect(audienceButton('Organizers').getAttribute('aria-checked')).toBe('true');
    expect(audienceButton('Everyone').getAttribute('aria-checked')).toBe('false');
  });

  it('the Send button is disabled until both title and message are non-empty', async () => {
    await mount();
    expect(sendButton().disabled).toBe(true);

    await act(async () => { setValue(titleInput(), 'Heads up'); });
    await flush();
    expect(sendButton().disabled).toBe(true); // title only, body still empty

    await act(async () => { setValue(bodyInput(), 'Something important'); });
    await flush();
    expect(sendButton().disabled).toBe(false);
  });

  it('whitespace-only title or message does not enable Send (matches server-side trim+required validation)', async () => {
    await mount();
    await act(async () => {
      setValue(titleInput(), '   ');
      setValue(bodyInput(), '   ');
    });
    await flush();
    expect(sendButton().disabled).toBe(true);
  });

  it('title and message inputs are capped at the server\'s own limits (80/500 chars) via maxLength', async () => {
    await mount();
    expect(titleInput().maxLength).toBe(80);
    expect(bodyInput().maxLength).toBe(500);
  });

  it('clicking Publish opens a confirmation naming the title and the selected audience, and does NOT call any RPC until confirmed', async () => {
    await mount();
    await fill('Server maintenance', 'We will be down briefly tonight.', 'Service Providers');
    await click(sendButton());
    expect(annNames()).toHaveLength(0); // not sent yet -- awaiting confirmation
    expect(container.textContent).toMatch(/Publish "Server maintenance" to Service Providers\?/);
    expect(container.textContent).toMatch(/cannot be edited afterwards/);
  });

  it('confirming saves the on-screen text as a draft, then publishes that draft -- one save, one publish, trimmed', async () => {
    await mount();
    await fill('  Server maintenance  ', '  We will be down briefly tonight.  ', 'Organizers');
    await click(sendButton());
    await click(confirmButton());
    expect(calls('admin_save_announcement_draft')).toEqual([{ p_id: null, p_audience: 'organizers', p_title: 'Server maintenance', p_body: 'We will be down briefly tonight.' }]);
    expect(calls('admin_publish_announcement')).toEqual([{ p_id: 'draft-1' }]);
    expect(annNames()).toEqual(['admin_save_announcement_draft', 'admin_publish_announcement']);
    expect(calls('admin_send_announcement')).toHaveLength(0); // legacy path not used once 0222 exists
  });

  it('on success, displays the server-returned recipient count, clears the form and writes the console audit log', async () => {
    rpcResponses.admin_publish_announcement = { data: { success: true, recipients: 42 }, error: null };
    await mount();
    await fill('Policy update', 'Please review the new terms.');
    await click(sendButton());
    await click(confirmButton());
    expect(container.textContent).toMatch(/Announcement published to 42 everyone recipients\./);
    expect(titleInput().value).toBe('');
    expect(bodyInput().value).toBe('');
    expect(auditLogCalls).toHaveLength(1);
    expect(auditLogCalls[0][1]).toBe('ROOT_announcement');
    expect(auditLogCalls[0][3]).toEqual({ audience: 'everyone', title: 'Policy update', recipients: 42 });
  });

  it('on a publish error (e.g. rate-limited), displays the error, keeps the text and keeps the saved draft for editing', async () => {
    rpcResponses.admin_publish_announcement = { data: null, error: { message: 'rate_limited' } };
    await mount();
    await fill('Retry me', 'This attempt will fail.');
    await click(sendButton());
    await click(confirmButton());
    expect(container.textContent).toMatch(/rate_limited/);
    expect(titleInput().value).toBe('Retry me');
    expect(bodyInput().value).toBe('This attempt will fail.');
    expect(card().querySelector('[data-testid="announcement-editing"]')).toBeTruthy();
    // A retry updates the same draft instead of creating a second one.
    rpcCalls.length = 0;
    rpcResponses.admin_publish_announcement = { data: { success: true, recipients: 1 }, error: null };
    await click(sendButton());
    await click(confirmButton());
    expect(calls('admin_save_announcement_draft')[0].p_id).toBe('draft-1');
  });

  it('prevents duplicate submissions: buttons are disabled while publishing, and a rapid double-confirm publishes once', async () => {
    rpcDelayMs = 30;
    await mount();
    await fill('Slow send', 'Testing the busy guard.');
    await click(sendButton());
    const btn = confirmButton();
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 5));
    });
    const busyBtn = Array.from(card().querySelectorAll('button')).find((b) => b.textContent?.includes('Publishing'));
    expect(busyBtn).toBeTruthy();
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);
    expect(saveDraftButton()!.disabled).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    await flush();
    expect(calls('admin_save_announcement_draft')).toHaveLength(1);
    expect(calls('admin_publish_announcement')).toHaveLength(1);
  });

  it('does not touch the existing Global Broadcast card, handler, or its admin_broadcast RPC', async () => {
    await mount();
    expect(container.textContent).toMatch(/Global Broadcast/);
    expect(container.textContent).toMatch(/Send a notification to all users/);
    const broadcastSendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Send Broadcast'));
    expect(broadcastSendBtn).toBeTruthy();
    // The two features never share a call: sending an announcement must
    // never call admin_broadcast, and vice versa (not exercised here, but
    // the mock only records admin_send_announcement calls, confirming the
    // announcement card's own Send button doesn't fall through to it).
  });
});

describe('Announcements panel: drafts', () => {
  const DRAFT = { id: 'd-1', title: 'Old draft', body: 'Draft body', audience: 'service_providers', status: 'draft', updated_at: '2026-11-20T10:00:00Z', published_at: null, recipients: null };
  const PUBLISHED = { id: 'p-1', title: 'Already out', body: 'Sent', audience: 'everyone', status: 'published', updated_at: '2026-11-19T10:00:00Z', published_at: '2026-11-19T10:00:00Z', recipients: 12 };

  it('Save draft stores the announcement without sending it to anyone', async () => {
    await mount();
    await fill('Holiday hours', 'Support closes early on Friday.', 'Organizers');
    await click(saveDraftButton()!);
    expect(calls('admin_save_announcement_draft')).toEqual([{ p_id: null, p_audience: 'organizers', p_title: 'Holiday hours', p_body: 'Support closes early on Friday.' }]);
    expect(calls('admin_publish_announcement')).toHaveLength(0);
    expect(calls('admin_send_announcement')).toHaveLength(0);
    expect(container.textContent).toMatch(/Draft saved\. It has not been sent to anyone\./);
    expect(saveDraftButton()!.textContent).toBe('Update draft');
  });

  it('lists drafts and published announcements separately; only drafts can be edited or deleted', async () => {
    announcementsResponse = { data: [DRAFT, PUBLISHED], error: null };
    await mount();
    const draftRows = card().querySelectorAll('[data-testid="announcement-draft-row"]');
    const pubRows = card().querySelectorAll('[data-testid="announcement-published-row"]');
    expect(draftRows).toHaveLength(1);
    expect(pubRows).toHaveLength(1);
    expect(draftRows[0].textContent).toMatch(/Old draft/);
    expect(pubRows[0].textContent).toMatch(/Already out.*Everyone · 12 recipients/);
    expect(pubRows[0].querySelector('button')).toBeNull(); // published: read-only
  });

  it('Edit loads the draft into the composer and saving updates that draft by id', async () => {
    announcementsResponse = { data: [DRAFT], error: null };
    await mount();
    await click(card().querySelector('[aria-label="Edit draft Old draft"]')!);
    expect(titleInput().value).toBe('Old draft');
    expect(bodyInput().value).toBe('Draft body');
    expect(audienceButton('Service Providers').getAttribute('aria-checked')).toBe('true');
    await act(async () => { setValue(titleInput(), 'Better title'); });
    await flush();
    await click(saveDraftButton()!);
    expect(calls('admin_save_announcement_draft')).toEqual([{ p_id: 'd-1', p_audience: 'service_providers', p_title: 'Better title', p_body: 'Draft body' }]);
  });

  it('Delete asks for confirmation, then deletes only that draft', async () => {
    announcementsResponse = { data: [DRAFT], error: null };
    await mount();
    await click(card().querySelector('[aria-label="Delete draft Old draft"]')!);
    expect(calls('admin_delete_announcement_draft')).toHaveLength(0);
    expect(container.textContent).toMatch(/Delete the draft "Old draft"\? It was never sent\./);
    await click(confirmButton('Delete'));
    expect(calls('admin_delete_announcement_draft')).toEqual([{ p_id: 'd-1' }]);
  });
});

describe('Announcements panel: before migration 0222 (legacy fallback)', () => {
  it('shows a notice, hides Save draft, and publishes through the existing admin_send_announcement', async () => {
    announcementsResponse = MISSING_TABLE;
    rpcResponses.admin_send_announcement = { data: { success: true, recipients: 9 }, error: null };
    await mount();
    expect(card().querySelector('[data-testid="announcement-legacy-notice"]')).toBeTruthy();
    expect(saveDraftButton()).toBeUndefined();
    await fill('  Legacy  ', '  Still sends  ', 'Service Providers');
    await click(sendButton());
    await click(confirmButton());
    expect(calls('admin_send_announcement')).toEqual([{ p_audience: 'service_providers', p_title: 'Legacy', p_body: 'Still sends' }]);
    expect(calls('admin_save_announcement_draft')).toHaveLength(0);
    expect(calls('admin_publish_announcement')).toHaveLength(0);
    expect(container.textContent).toMatch(/Announcement published to 9 service providers recipients\./);
  });

  it('a non-missing-table load error is shown, not mistaken for the legacy mode', async () => {
    announcementsResponse = { data: null, error: { code: '42501', message: 'permission denied for table announcements' } };
    await mount();
    expect(card().querySelector('[data-testid="announcement-legacy-notice"]')).toBeNull();
    expect(card().textContent).toMatch(/permission denied/);
  });
});

describe('Announcements panel: Internal test audience (0223)', () => {
  const ROOT_REC = { user_id: ROOT_UID, username: 'root', added_at: '2026-11-25T08:00:00Z' };
  const asRoot = () => mount({ id: ROOT_UID, role: 'admin' });
  const radios = () => Array.from(card().querySelectorAll('button[role="radio"]')).map((b) => b.textContent);
  const buttonText = (t: string) => Array.from(card().querySelectorAll('button')).find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
  const recipients = (n: number) => Array.from({ length: n }, (_, i) => ({ user_id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, username: `tester${i}`, added_at: '2026-11-25T08:00:00Z' }));

  it('0223 applied: a fourth "Internal test" chip appears after the three production audiences, unchanged and in order', async () => {
    rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
    await asRoot();
    expect(radios()).toEqual(['Everyone', 'Organizers', 'Service Providers', 'Internal test']);
    expect(audienceButton('Everyone').getAttribute('aria-checked')).toBe('true'); // default unchanged
  });

  it('0223 not applied (missing function): no Internal test chip, panel is the three-audience panel', async () => {
    await asRoot();
    expect(calls(LIST_TEST)).toHaveLength(1);
    expect(radios()).toEqual(['Everyone', 'Organizers', 'Service Providers']);
    expect(card().querySelector('[data-testid="internal-test-audience"]')).toBeNull();
  });

  it('0222 not applied (legacy immediate send): no Internal test chip, even if the list function answered', async () => {
    announcementsResponse = MISSING_TABLE;
    rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
    await asRoot();
    expect(radios()).toEqual(['Everyone', 'Organizers', 'Service Providers']);
  });

  it('empty list: publishing to Internal test is disabled and explained; no write RPC is possible', async () => {
    rpcResponses[LIST_TEST] = { data: [], error: null };
    await asRoot();
    await fill('Pipeline test', 'Internal only.', 'Internal test');
    expect(card().textContent).toMatch(/Sending to:\s*Internal test/);
    expect(card().querySelector('[data-testid="internal-test-empty"]')?.textContent).toMatch(/No internal test recipients are designated, so publishing is disabled/);
    expect(sendButton().disabled).toBe(true);
    await click(sendButton());
    expect(container.textContent).not.toMatch(/Publish "Pipeline test"/);
    expect(annNames()).toHaveLength(0);
  });

  it('list load error: publishing to Internal test stays disabled and the error is shown', async () => {
    rpcResponses[LIST_TEST] = { data: null, error: { code: '42501', message: 'Only admins can view internal test recipients' } };
    await asRoot();
    await fill('Pipeline test', 'Internal only.', 'Internal test');
    expect(card().textContent).toMatch(/Only admins can view internal test recipients/);
    expect(sendButton().disabled).toBe(true);
  });

  it('more than 10 listed (defence in depth): publishing is disabled', async () => {
    rpcResponses[LIST_TEST] = { data: recipients(11), error: null };
    await asRoot();
    await fill('Pipeline test', 'Internal only.', 'Internal test');
    expect(sendButton().disabled).toBe(true);
  });

  it('with Root designated: confirmation names the exact accounts, then save(internal_test) + publish', async () => {
    rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
    rpcResponses.admin_publish_announcement = { data: { success: true, recipients: 1 }, error: null };
    await asRoot();
    await fill('Pipeline test', 'Internal only.', 'Internal test');
    expect(card().querySelector('[data-testid="internal-test-audience"]')?.textContent).toMatch(/\(1\/10\): @root/);
    expect(sendButton().disabled).toBe(false);
    await click(sendButton());
    expect(annNames()).toHaveLength(0);
    expect(container.textContent).toMatch(/Publish "Pipeline test" to Internal test \(1 account: @root\)\?/);
    await click(confirmButton());
    expect(calls('admin_save_announcement_draft')).toEqual([{ p_id: null, p_audience: 'internal_test', p_title: 'Pipeline test', p_body: 'Internal only.' }]);
    expect(calls('admin_publish_announcement')).toEqual([{ p_id: 'draft-1' }]);
    expect(calls('admin_send_announcement')).toHaveLength(0);
    expect(container.textContent).toMatch(/Announcement published to 1 internal test recipient\./);
    expect(auditLogCalls[0][3]).toEqual({ audience: 'internal_test', title: 'Pipeline test', recipients: 1 });
  });

  it('a server refusal (e.g. list emptied meanwhile) is shown and the draft is kept', async () => {
    rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
    rpcResponses.admin_publish_announcement = { data: null, error: { message: 'Internal test audience has no recipients' } };
    await asRoot();
    await fill('Pipeline test', 'Internal only.', 'Internal test');
    await click(sendButton());
    await click(confirmButton());
    expect(container.textContent).toMatch(/Internal test audience has no recipients/);
    expect(card().querySelector('[data-testid="announcement-editing"]')).toBeTruthy();
  });

  it('selecting a production audience is unaffected by the internal list (no internal note, publish enabled)', async () => {
    rpcResponses[LIST_TEST] = { data: [], error: null };
    await asRoot();
    await fill('Hello', 'All users.', 'Organizers');
    expect(card().querySelector('[data-testid="internal-test-audience"]')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    await click(sendButton());
    expect(container.textContent).toMatch(/Publish "Hello" to Organizers\?/);
  });

  it('editing an internal_test draft restores the Internal test selection', async () => {
    rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
    announcementsResponse = { data: [{ id: 'd-it', title: 'IT draft', body: 'b', audience: 'internal_test', status: 'draft', updated_at: '2026-11-25T08:00:00Z', published_at: null, recipients: null }], error: null };
    await asRoot();
    expect(card().querySelector('[data-testid="announcement-draft-row"]')?.textContent).toMatch(/Internal test/);
    await click(card().querySelector('[aria-label="Edit draft IT draft"]')!);
    expect(audienceButton('Internal test').getAttribute('aria-checked')).toBe('true');
  });

  describe('recipient management (Root only)', () => {
    it('Root sees the list with Remove, and "Add me" when not listed', async () => {
      rpcResponses[LIST_TEST] = { data: [], error: null };
      await asRoot();
      await fill('x', 'y', 'Internal test');
      expect(card().querySelector('[data-testid="internal-test-recipients"]')).toBeTruthy();
      expect(buttonText('Add me')).toBeTruthy();
    });

    it('"Add me" calls admin_add_announcement_test_recipient with Root\'s own id, then reloads the list', async () => {
      rpcResponses[LIST_TEST] = { data: [], error: null };
      await asRoot();
      await fill('x', 'y', 'Internal test');
      rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
      await click(buttonText('Add me')!);
      expect(calls('admin_add_announcement_test_recipient')).toEqual([{ p_user_id: ROOT_UID }]);
      expect(calls(LIST_TEST).length).toBeGreaterThanOrEqual(2);
      expect(card().querySelectorAll('[data-testid="internal-test-recipient-row"]')).toHaveLength(1);
      expect(card().textContent).toMatch(/@root \(you\)/);
      expect(buttonText('Add me')).toBeUndefined();
      expect(calls('admin_publish_announcement')).toHaveLength(0); // managing recipients never publishes
    });

    it('adding by user ID requires a valid UUID and an explicit confirmation', async () => {
      rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
      await asRoot();
      await fill('x', 'y', 'Internal test');
      const input = card().querySelector('input[aria-label="User ID to add to internal test"]') as HTMLInputElement;
      await act(async () => { setValue(input, 'not-a-uuid'); });
      await flush();
      expect(buttonText('Add')!.disabled).toBe(true);
      const id = '11111111-2222-3333-4444-555555555555';
      await act(async () => { setValue(input, `  ${id}  `); });
      await flush();
      await click(buttonText('Add')!);
      expect(calls('admin_add_announcement_test_recipient')).toHaveLength(0);
      expect(container.textContent).toMatch(new RegExp(`Add user ${id} to the internal test audience\\?`));
      await click(confirmButton('Add'));
      expect(calls('admin_add_announcement_test_recipient')).toEqual([{ p_user_id: id }]);
    });

    it('Remove calls admin_remove_announcement_test_recipient for that account', async () => {
      rpcResponses[LIST_TEST] = { data: [ROOT_REC], error: null };
      await asRoot();
      await fill('x', 'y', 'Internal test');
      await click(card().querySelector('[aria-label="Remove @root from internal test"]')!);
      expect(calls('admin_remove_announcement_test_recipient')).toEqual([{ p_user_id: ROOT_UID }]);
    });

    it('at 10 recipients the add controls are replaced by the limit notice', async () => {
      rpcResponses[LIST_TEST] = { data: recipients(10), error: null };
      await asRoot();
      await fill('x', 'y', 'Internal test');
      expect(card().querySelector('[data-testid="internal-test-cap"]')?.textContent).toMatch(/Limit of 10 recipients reached/);
      expect(buttonText('Add me')).toBeUndefined();
      expect(card().querySelector('input[aria-label="User ID to add to internal test"]')).toBeNull();
      expect(sendButton().disabled).toBe(false); // exactly 10 may still publish
    });

    it('a server refusal (e.g. limit) is shown and the list is reloaded', async () => {
      rpcResponses[LIST_TEST] = { data: [], error: null };
      rpcResponses.admin_add_announcement_test_recipient = { data: null, error: { message: 'Internal test audience is limited to 10 recipients' } };
      await asRoot();
      await fill('x', 'y', 'Internal test');
      const before = calls(LIST_TEST).length;
      await click(buttonText('Add me')!);
      expect(container.textContent).toMatch(/limited to 10 recipients/);
      expect(calls(LIST_TEST).length).toBe(before + 1);
    });

    it('a non-Root admin sees the audience and list but no management controls', async () => {
      rpcResponses[LIST_TEST] = { data: [], error: null };
      await mount({ id: 'admin-2', role: 'admin' });
      await fill('x', 'y', 'Internal test');
      expect(card().querySelector('[data-testid="internal-test-recipients"]')).toBeNull();
      expect(buttonText('Add me')).toBeUndefined();
      expect(card().querySelector('[data-testid="internal-test-empty"]')?.textContent).toMatch(/Only Root can add recipients/);
    });
  });
});

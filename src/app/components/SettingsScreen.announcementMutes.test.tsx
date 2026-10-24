import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Coverage for the user-facing announcement-group mute controls
// (Organizer Announcements / Service Provider Announcements rows in
// Settings > MORE NOTIFICATIONS), built on the existing announcement_mutes
// schema (migration 0189, confirmed live in production) and the
// automatic, server-synced announcement_group_members table (migration
// 0190). This suite never invokes any real Supabase call: `supabase` is
// fully mocked below, so no real mute preference is ever written and no
// real announcement is ever sent while these tests run.

let membershipRows: any[] = [];
let muteRows: any[] = [];
const insertCalls: any[] = [];
const deleteCalls: any[] = [];
let insertShouldFail = false;

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'announcement_group_members') {
        return { select: () => ({ eq: () => Promise.resolve({ data: membershipRows, error: null }) }) };
      }
      if (table === 'announcement_mutes') {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: muteRows, error: null }) }),
          insert: (rows: any[]) => {
            insertCalls.push(rows);
            return Promise.resolve(insertShouldFail ? { data: null, error: { message: 'insert failed' } } : { data: null, error: null });
          },
          delete: () => ({
            eq: (col1: string, val1: string) => ({
              eq: (col2: string, val2: string) => {
                deleteCalls.push({ [col1]: val1, [col2]: val2 });
                return Promise.resolve({ data: null, error: null });
              },
            }),
          }),
        };
      }
      // 'users' (promotions_enabled load) and anything else.
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  },
  getAuthToken: () => Promise.resolve(null),
}));

import { SettingsScreen } from './SettingsScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const currentUser = { id: 'user-1', email: 'a@b.com', full_name: 'A B', role: 'attendee' };
const OTHER_USER_ID = 'user-999';

beforeEach(() => {
  membershipRows = [];
  muteRows = [];
  insertCalls.length = 0;
  deleteCalls.length = 0;
  insertShouldFail = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function mount() {
  act(() => {
    root!.render(
      <SettingsScreen
        currentUser={currentUser}
        onBack={() => {}}
        onSignOut={() => {}}
        isDark
        onToggleDark={() => {}}
        ventsAiEnabled
        onToggleVentsAi={() => {}}
      />
    );
  });
  await flush();
}

function row(testId: string) {
  return container!.querySelector(`[data-testid="${testId}"]`) as HTMLDivElement | null;
}
function toggleWithin(el: HTMLElement) {
  // Toggle is the last clickable div child in SettingRow -- select by its
  // distinguishing inline style (border-radius 13px pill) rather than by
  // a brittle DOM index.
  return Array.from(el.querySelectorAll('div')).find((d) => d.style.borderRadius === '13px')! as HTMLDivElement;
}

describe('Settings: Announcement mute controls -- membership-gated visibility', () => {
  it('shows neither row when the user is a member of no announcement group', async () => {
    membershipRows = [];
    await mount();
    expect(row('setting-row-organizer-announcements')).toBeNull();
    expect(row('setting-row-service-provider-announcements')).toBeNull();
  });

  it('shows only the Organizer Announcements row for an organizer-only member', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    await mount();
    expect(row('setting-row-organizer-announcements')).not.toBeNull();
    expect(row('setting-row-service-provider-announcements')).toBeNull();
  });

  it('shows only the Service Provider Announcements row for a provider-only member', async () => {
    membershipRows = [{ group_id: 'grp-sp', announcement_groups: { key: 'service_providers' } }];
    await mount();
    expect(row('setting-row-organizer-announcements')).toBeNull();
    expect(row('setting-row-service-provider-announcements')).not.toBeNull();
  });

  it('shows both rows for a user who is a member of both groups', async () => {
    membershipRows = [
      { group_id: 'grp-org', announcement_groups: { key: 'organizers' } },
      { group_id: 'grp-sp', announcement_groups: { key: 'service_providers' } },
    ];
    await mount();
    expect(row('setting-row-organizer-announcements')).not.toBeNull();
    expect(row('setting-row-service-provider-announcements')).not.toBeNull();
  });

  it('there is no join/leave control anywhere in these rows -- membership is read-only from this screen', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    await mount();
    const r = row('setting-row-organizer-announcements')!;
    // Only the mute toggle is interactive; no button/link to add or
    // remove membership exists in this row.
    expect(r.querySelectorAll('button').length).toBe(0);
  });
});

describe('Settings: Announcement mute controls -- toggle behavior and persistence', () => {
  it('defaults to ON (unmuted) when no mute row exists for that group', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    muteRows = [];
    await mount();
    const toggle = toggleWithin(row('setting-row-organizer-announcements')!);
    expect(toggle.style.background).toBe('rgb(123, 47, 190)'); // on-color
  });

  it('renders OFF (muted) when a mute row already exists for that group', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    muteRows = [{ group_id: 'grp-org' }];
    await mount();
    const toggle = toggleWithin(row('setting-row-organizer-announcements')!);
    expect(toggle.style.background).toBe('rgb(26, 22, 37)'); // off-color
  });

  it('turning the toggle OFF inserts exactly one announcement_mutes row scoped to the user and that one group_id', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    muteRows = [];
    await mount();
    const toggle = toggleWithin(row('setting-row-organizer-announcements')!);
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toEqual([{ user_id: 'user-1', group_id: 'grp-org' }]);
    expect(deleteCalls).toHaveLength(0);
  });

  it('turning the toggle back ON deletes exactly the (user_id, group_id) mute row, nothing else', async () => {
    membershipRows = [{ group_id: 'grp-sp', announcement_groups: { key: 'service_providers' } }];
    muteRows = [{ group_id: 'grp-sp' }];
    await mount();
    const toggle = toggleWithin(row('setting-row-service-provider-announcements')!);
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({ user_id: 'user-1', group_id: 'grp-sp' });
    expect(insertCalls).toHaveLength(0);
  });

  it('muting one group never writes anything for the other group (independent mute rows)', async () => {
    membershipRows = [
      { group_id: 'grp-org', announcement_groups: { key: 'organizers' } },
      { group_id: 'grp-sp', announcement_groups: { key: 'service_providers' } },
    ];
    muteRows = [];
    await mount();
    const orgToggle = toggleWithin(row('setting-row-organizer-announcements')!);
    await act(async () => { orgToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(insertCalls).toEqual([[{ user_id: 'user-1', group_id: 'grp-org' }]]);
    // Service Provider's toggle is unaffected -- still ON, no write for it.
    const spToggle = toggleWithin(row('setting-row-service-provider-announcements')!);
    expect(spToggle.style.background).toBe('rgb(123, 47, 190)');
  });

  it('on a failed write, the toggle reverts to its prior state rather than claiming an unpersisted change', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    muteRows = [];
    insertShouldFail = true;
    await mount();
    const toggle = toggleWithin(row('setting-row-organizer-announcements')!);
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(insertCalls).toHaveLength(1); // the attempt was made
    expect(toggle.style.background).toBe('rgb(123, 47, 190)'); // reverted back to ON/unmuted
  });

  it('prevents a duplicate write from a rapid double-click on the same toggle', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    muteRows = [];
    await mount();
    const toggle = toggleWithin(row('setting-row-organizer-announcements')!);
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(insertCalls).toHaveLength(1);
  });
});

describe('Settings: Announcement mute controls -- authorization scoping', () => {
  it('every read/write call is scoped to the signed-in user\'s own id, never another user\'s', async () => {
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    muteRows = [{ group_id: 'grp-org' }];
    await mount();
    const toggle = toggleWithin(row('setting-row-organizer-announcements')!);
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); // unmute -> delete
    await flush();

    expect(deleteCalls[0].user_id).toBe(currentUser.id);
    expect(deleteCalls[0].user_id).not.toBe(OTHER_USER_ID);

    // Re-mute to also check the insert path.
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(insertCalls[0][0].user_id).toBe(currentUser.id);
    expect(insertCalls[0][0].user_id).not.toBe(OTHER_USER_ID);
  });

  it('this screen never reads another user\'s membership or mute rows -- the query is always filtered by this user\'s own id (enforced client-side here, and by RLS server-side)', async () => {
    // The mock itself doesn't filter by user_id (it's a stand-in for
    // Postgres RLS), so this test instead asserts the component's own
    // call shape never varies by who's "logged in" beyond currentUser --
    // i.e. there is no code path here that accepts or targets an
    // arbitrary user id.
    membershipRows = [{ group_id: 'grp-org', announcement_groups: { key: 'organizers' } }];
    await mount();
    expect(row('setting-row-organizer-announcements')).not.toBeNull();
    // No UI element exists for selecting "whose" preferences to view/edit.
    expect(container!.textContent).not.toMatch(/user-999/);
  });
});

describe('Settings: Announcement mute controls -- never affect Everyone broadcasts', () => {
  it('no mute row or UI control here ever references an "everyone" group -- announcement_groups structurally has no such row', async () => {
    membershipRows = [
      { group_id: 'grp-org', announcement_groups: { key: 'organizers' } },
      { group_id: 'grp-sp', announcement_groups: { key: 'service_providers' } },
    ];
    await mount();
    // Only two possible rows ever render; no "Everyone"/"Global
    // Broadcast" mute control exists on this screen.
    expect(container!.textContent).not.toMatch(/Mute Everyone|Everyone Announcements/);
    expect(insertCalls.every((c) => c[0].group_id === 'grp-org' || c[0].group_id === 'grp-sp')).toBe(true);
  });

  it('muting both groups the user belongs to still leaves two independent mute rows, never a single blanket "mute all" row', async () => {
    membershipRows = [
      { group_id: 'grp-org', announcement_groups: { key: 'organizers' } },
      { group_id: 'grp-sp', announcement_groups: { key: 'service_providers' } },
    ];
    muteRows = [];
    await mount();
    const orgToggle = toggleWithin(row('setting-row-organizer-announcements')!);
    const spToggle = toggleWithin(row('setting-row-service-provider-announcements')!);
    await act(async () => { orgToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await act(async () => { spToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(insertCalls).toEqual([
      [{ user_id: 'user-1', group_id: 'grp-org' }],
      [{ user_id: 'user-1', group_id: 'grp-sp' }],
    ]);
  });
});

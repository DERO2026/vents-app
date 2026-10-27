import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// VENTS Representatives frontend (migration 0193's backend, not yet
// applied to production). These tests mock supabase entirely -- no real
// RPC or network call happens, and no commission amount/payout UI should
// ever render here, since that logic is intentionally not built yet.

const rpcCalls: { name: string; args: any }[] = [];
let recruiterRowExists = false;
let recruiterStatusError: string | null = null;
// Distinct from recruiterStatusError (a Supabase-returned {error} field):
// this simulates the query itself THROWING/rejecting -- a network failure
// or client-side exception, not a declared error -- which is the specific
// failure mode a bare `await` with no try/catch would leave unhandled.
let recruiterStatusThrows = false;
let targetRoleThrows = false;
let ownProviderId: string | null = null;
let partnershipsError: string | null = null;
let lastOrFilter: string | null = null;
let rpcResponses: Record<string, { data: any; error: any }> = {};
// Target-role resolution (invite flow): which search-result id, if any,
// has an events row (organizer) or a service_providers row (provider).
let organizerUserIds: string[] = [];
let providerByUserId: Record<string, string> = {};
let incomingRows: any[] = [];
let rpcDelayed: Record<string, any> = {};

// A thenable that also exposes .maybeSingle() -- mirrors the real
// supabase-js query builder, where `await qb.eq(...)` and
// `await qb.eq(...).maybeSingle()` are both valid.
function singleRowResult(result: { data: any; error: any }) {
  return {
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    maybeSingle: () => Promise.resolve(result),
  };
}

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: string) => {
          if (table === 'recruiters') {
            // Only ever queried by id (the PK, which IS the user's auth
            // id) -- never by a non-existent user_id column.
            if (recruiterStatusThrows) {
              return { then: () => { throw new Error('network unreachable'); }, maybeSingle: () => Promise.reject(new Error('network unreachable')) };
            }
            return singleRowResult(
              recruiterStatusError
                ? { data: null, error: { message: recruiterStatusError } }
                : { data: recruiterRowExists ? { id: 'u1' } : null, error: null }
            );
          }
          if (table === 'service_providers') {
            // Queried both for the current user's own id (the incoming-
            // invitations filter) and for an invite TARGET's id (the
            // target-role resolution) -- branch on which value was asked.
            if (column === 'user_id' && value === 'u1') {
              return singleRowResult({ data: ownProviderId ? { id: ownProviderId } : null, error: null });
            }
            if (targetRoleThrows) {
              return { then: () => { throw new Error('network unreachable'); }, maybeSingle: () => Promise.reject(new Error('network unreachable')) };
            }
            const resolved = providerByUserId[value];
            return singleRowResult({ data: resolved ? { id: resolved } : null, error: null });
          }
          if (table === 'events') {
            if (targetRoleThrows) {
              return { then: () => { throw new Error('network unreachable'); }, maybeSingle: () => Promise.reject(new Error('network unreachable')) };
            }
            const isOrganizer = organizerUserIds.includes(value);
            return singleRowResult({ data: isOrganizer ? { id: 'ev-1' } : null, error: null });
          }
          if (table === 'recruiter_partnerships') {
            // The recruiter-side list: select('*').eq('recruiter_id', ...)
            return partnershipsError
              ? Promise.resolve({ data: null, error: { message: partnershipsError } })
              : Promise.resolve({ data: [], error: null });
          }
          return singleRowResult({ data: null, error: null });
        },
        or: (filter: string) => {
          lastOrFilter = filter;
          return {
            // The recipient-side list: select('*').or(...).eq('status', 'pending')
            eq: () =>
              partnershipsError
                ? Promise.resolve({ data: null, error: { message: partnershipsError } })
                : Promise.resolve({ data: incomingRows, error: null }),
          };
        },
      }),
    }),
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (rpcDelayed[name]) {
        return new Promise((resolve) => { rpcDelayed[name] = { resolve }; });
      }
      return Promise.resolve(rpcResponses[name] ?? { data: null, error: null });
    },
  },
}));

let searchResults: { id: string; username: string; fullName: string; avatarUrl: null }[] = [
  { id: 'org-1', username: 'eventpro', fullName: 'Event Pro', avatarUrl: null },
];

vi.mock('../../lib/userSearch', () => ({
  searchUsers: (q: string) => Promise.resolve(q.length >= 2 ? searchResults : []),
}));

import { RepresentativesScreen } from './RepresentativesScreen';

let container: HTMLDivElement;
let root: Root;
const currentUser = { id: 'u1', role: 'attendee' };

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResponses = {};
  recruiterRowExists = false;
  recruiterStatusError = null;
  recruiterStatusThrows = false;
  targetRoleThrows = false;
  ownProviderId = null;
  partnershipsError = null;
  lastOrFilter = null;
  organizerUserIds = ['org-1'];
  providerByUserId = {};
  incomingRows = [];
  rpcDelayed = {};
  searchResults = [{ id: 'org-1', username: 'eventpro', fullName: 'Event Pro', avatarUrl: null }];
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  root = createRoot(container);
  act(() => {
    root.render(<RepresentativesScreen onBack={() => {}} currentUser={currentUser} />);
  });
  await flush();
}

describe('RepresentativesScreen', () => {
  it('prompts registration when the user is not yet a recruiter', async () => {
    await mount();
    expect(container.textContent).toContain('Become a Representative');
  });

  it('registering calls register_as_recruiter with a display name derived from the profile, hides the prompt on success', async () => {
    await mount();
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Become a Representative')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const call = rpcCalls.find((c) => c.name === 'register_as_recruiter');
    expect(call).toBeTruthy();
    // register_as_recruiter(p_display_name text, p_bio text DEFAULT NULL) has
    // no default for p_display_name -- it must always be passed explicitly.
    expect(call!.args).toEqual({ p_display_name: null, p_bio: null });
    expect(container.textContent).not.toContain('Become a Representative');
  });

  it('a registration RPC failure shows a visible error and keeps the prompt', async () => {
    rpcResponses = { register_as_recruiter: { data: null, error: { message: 'rate_limited' } } };
    await mount();
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Become a Representative')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toMatch(/rate_limited/);
    expect(container.textContent).toContain('Become a Representative');
  });

  it('a recruiter-status lookup failure surfaces a visible error instead of silently defaulting', async () => {
    recruiterStatusError = 'connection reset';
    await mount();
    expect(container.textContent).toMatch(/connection reset/);
    // Must not silently fall through to the registration prompt as if the
    // user were definitively not a recruiter.
    expect(container.textContent).not.toContain('Become a Representative');
  });

  it('a thrown exception in the recruiter-status check (not a declared Supabase error) resolves to a visible error, not a permanently blank/loading screen', async () => {
    // This is the specific gap the fix closes: checkRecruiterStatus()
    // previously had no try/catch, so a REJECTED promise (as opposed to a
    // resolved promise carrying a Supabase {error} field, already covered
    // above) would be an unhandled rejection that never updates isRecruiter
    // -- the component would stay stuck on its initial loading state
    // forever, indistinguishable from a true hang, with no visible
    // indication anything went wrong and nothing for either React error
    // boundary to catch (it never throws during render).
    recruiterStatusThrows = true;
    await mount();
    expect(container.textContent).toMatch(/network unreachable/);
    expect(container.querySelector('[data-testid="representatives-loading"]')).toBeNull();
    expect(container.textContent).not.toContain('Become a Representative');
  });

  it('a thrown exception while resolving an invite target\'s organizer/provider role shows a visible error instead of hanging on "Checking..." forever', async () => {
    recruiterRowExists = true;
    targetRoleThrows = true;
    await mount();
    await act(async () => {
      container.querySelector('input')!.dispatchEvent(new Event('focus'));
    });
    const input = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => {
      setter.call(input, 'eventpro');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invite');
    await act(async () => { inviteBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toMatch(/network unreachable/);
    expect(container.textContent).not.toContain('Checking organizer/provider status...');
  });

  it('an existing recruiter (recruiters.id = auth id) is detected correctly and the prompt does not render', async () => {
    recruiterRowExists = true;
    await mount();
    expect(container.textContent).not.toContain('Become a Representative');
  });

  it('searching by username surfaces a result with an Invite action', async () => {
    recruiterRowExists = true;
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => {
      setter.call(input, 'event');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="search-result"]')?.textContent).toContain('eventpro');
  });

  it('sending an invite rejects a commission split above 10%', async () => {
    recruiterRowExists = true;
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => { setter.call(input, 'event'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invite')!;
    await act(async () => { inviteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const splitInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    const setter2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(splitInput), 'value')!.set!;
    await act(async () => { setter2.call(splitInput, '25'); splitInput.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();

    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send Invitation')!;
    await act(async () => { sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toMatch(/between 0% and 10%/);
    expect(rpcCalls.some((c) => c.name === 'invite_recruiter_partnership')).toBe(false);
  });

  it('sending a valid invite calls invite_recruiter_partnership with bps, not a percentage', async () => {
    recruiterRowExists = true;
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => { setter.call(input, 'event'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invite')!;
    await act(async () => { inviteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send Invitation')!;
    await act(async () => { sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const call = rpcCalls.find((c) => c.name === 'invite_recruiter_partnership');
    expect(call?.args).toEqual({ p_organizer_id: 'org-1', p_provider_id: null, p_commission_split_bps: 500 });
  });

  it('resolves the caller\'s own service_providers.id before filtering incoming provider-side invitations', async () => {
    recruiterRowExists = true;
    ownProviderId = 'sp-42';
    await mount();
    await act(async () => {
      const tabBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => b.textContent?.includes('Invitations'))!;
      tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // The filter must reference the resolved service_providers.id
    // ('sp-42'), never the raw auth id ('u1'), for the provider_id side.
    expect(lastOrFilter).toContain('provider_id.eq.sp-42');
    expect(lastOrFilter).not.toContain('provider_id.eq.u1');
  });

  it('a user with no service_providers row sees organizer-side invitations without erroring on the provider filter', async () => {
    recruiterRowExists = true;
    ownProviderId = null;
    await mount();
    await act(async () => {
      const tabBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => b.textContent?.includes('Invitations'))!;
      tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.textContent).not.toMatch(/error|failed/i);
  });

  it('a partnerships-list fetch failure shows a visible error instead of silently showing an empty list', async () => {
    recruiterRowExists = true;
    partnershipsError = 'network error';
    await mount();
    await act(async () => {
      const tabBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => b.textContent?.includes('My Team'))!;
      tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toMatch(/network error/);
  });

  it('inviting a service-provider search result resolves their service_providers.id and sends p_provider_id, not their raw user id', async () => {
    recruiterRowExists = true;
    organizerUserIds = []; // not an organizer
    providerByUserId = { 'prov-1': 'sp-99' };
    searchResults = [{ id: 'prov-1', username: 'cleanco', fullName: 'Clean Co', avatarUrl: null }];
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => { setter.call(input, 'clean'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invite')!;
    await act(async () => { inviteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send Invitation')!;
    expect(sendBtn).toBeTruthy();
    await act(async () => { sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const call = rpcCalls.find((c) => c.name === 'invite_recruiter_partnership');
    expect(call?.args).toEqual({ p_organizer_id: null, p_provider_id: 'sp-99', p_commission_split_bps: 500 });
  });

  it('a search result that is neither an organizer nor a provider has no Send Invitation action, with a clear reason shown', async () => {
    recruiterRowExists = true;
    organizerUserIds = [];
    providerByUserId = {};
    searchResults = [{ id: 'nobody-1', username: 'justauser', fullName: 'Just A User', avatarUrl: null }];
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => { setter.call(input, 'justa'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invite')!;
    await act(async () => { inviteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.querySelector('[data-testid="invite-ineligible"]')?.textContent).toMatch(/not an organizer or a registered service provider/);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Send Invitation')).toBe(false);
    expect(rpcCalls.some((c) => c.name === 'invite_recruiter_partnership')).toBe(false);
  });

  it('Accept disables while the response is in flight, and a failed response leaves the row intact with a visible error', async () => {
    recruiterRowExists = true;
    incomingRows = [{ id: 'p1', recruiter_id: 'r1', organizer_id: 'u1', provider_id: null, status: 'pending', commission_split_bps: 500, invited_at: '' }];
    rpcDelayed['respond_to_recruiter_invitation'] = true;
    await mount();
    await act(async () => {
      const tabBtn = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => b.textContent?.includes('Invitations'))!;
      tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Accept')!;
    const declineBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Decline')!;
    await act(async () => { acceptBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    // In flight: both of this row's buttons are disabled (a second click
    // can't fire a duplicate RPC), and the row is still visible (no
    // optimistic removal before the response comes back).
    expect((acceptBtn as HTMLButtonElement).disabled).toBe(true);
    expect((declineBtn as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelectorAll('[data-testid="invitation-row"]').length).toBe(1);

    await act(async () => { rpcDelayed['respond_to_recruiter_invitation'].resolve({ data: null, error: { message: 'conflict' } }); });
    await flush();

    // Failure: error shown, row still intact (not silently removed),
    // button re-enabled so the user can retry.
    expect(container.textContent).toMatch(/conflict/);
    expect(container.querySelectorAll('[data-testid="invitation-row"]').length).toBe(1);
    expect((acceptBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('never renders a commission amount, earnings total, or payout control anywhere', async () => {
    recruiterRowExists = true;
    await mount();
    const text = container.textContent || '';
    expect(text).not.toMatch(/earned|payout|withdraw.*commission|\$\d/i);
  });
});

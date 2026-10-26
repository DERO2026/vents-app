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
let ownProviderId: string | null = null;
let partnershipsError: string | null = null;
let lastOrFilter: string | null = null;
let rpcResponses: Record<string, { data: any; error: any }> = {};

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
        eq: () => {
          if (table === 'recruiters') {
            // Only ever queried by id (the PK, which IS the user's auth
            // id) -- never by a non-existent user_id column.
            return singleRowResult(
              recruiterStatusError
                ? { data: null, error: { message: recruiterStatusError } }
                : { data: recruiterRowExists ? { id: 'u1' } : null, error: null }
            );
          }
          if (table === 'service_providers') {
            return singleRowResult({ data: ownProviderId ? { id: ownProviderId } : null, error: null });
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
                : Promise.resolve({ data: [], error: null }),
          };
        },
      }),
    }),
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResponses[name] ?? { data: null, error: null });
    },
  },
}));

vi.mock('../../lib/userSearch', () => ({
  searchUsers: (q: string) =>
    Promise.resolve(
      q.length >= 2
        ? [{ id: 'org-1', username: 'eventpro', fullName: 'Event Pro', avatarUrl: null }]
        : []
    ),
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
  ownProviderId = null;
  partnershipsError = null;
  lastOrFilter = null;
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

  it('never renders a commission amount, earnings total, or payout control anywhere', async () => {
    recruiterRowExists = true;
    await mount();
    const text = container.textContent || '';
    expect(text).not.toMatch(/earned|payout|withdraw.*commission|\$\d/i);
  });
});

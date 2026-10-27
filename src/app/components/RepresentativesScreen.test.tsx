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
  // The actual production "black screen": every prior round's tests here
  // only asserted on `container.textContent`, which passes even when text
  // is rendered in literally invisible ink -- a real headless-browser
  // screenshot showed the DOM/text/layout were all correct, but every
  // element inherited the app shell's `body { color: #000 }` with no
  // override, rendering solid black on the app's #060A14 background. This
  // asserts the actual fix: an explicit, non-black color set on the
  // screen's root container (CSS `color` is inherited, so one override
  // here covers every descendant -- no per-element color was ever needed
  // or added elsewhere in this component).
  it('sets an explicit, visible (non-black) text color on its root container', async () => {
    await mount();
    const root = container.querySelector('[data-testid="representatives-screen"]') as HTMLElement;
    expect(root).toBeTruthy();
    const color = root.style.color;
    expect(color).toBeTruthy();
    expect(color.replace(/\s/g, '')).not.toMatch(/^(#000(000)?|rgb\(0,0,0\)|black)$/i);
  });

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

  it('the invite form has no commission-split input or slider -- the arrangement is fixed, not negotiated', async () => {
    recruiterRowExists = true;
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => { setter.call(input, 'event'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Invite')!;
    await act(async () => { inviteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.querySelector('[data-testid="invite-form"] input[type="number"]')).toBeFalsy();
    expect(container.textContent).not.toMatch(/5%/);
    expect(container.textContent).not.toMatch(/[Cc]ommission split \(%\)/);
  });

  it('sending a valid invite always calls invite_recruiter_partnership with the fixed full commission (10000 bps), never a UI-derived value', async () => {
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
    expect(call?.args).toEqual({ p_organizer_id: 'org-1', p_provider_id: null, p_commission_split_bps: 10000 });
  });

  it('describes the commission arrangement as the full, fixed VENTS commission -- never "5%" or a negotiable split', async () => {
    recruiterRowExists = false;
    await mount();
    expect(container.textContent).toMatch(/full commission/i);
    expect(container.textContent).not.toMatch(/5%/);
    expect(container.textContent).not.toMatch(/agreed (commission )?split/i);
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
    expect(call?.args).toEqual({ p_organizer_id: null, p_provider_id: 'sp-99', p_commission_split_bps: 10000 });
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

  // Mobile UI fix: the root-container color override is necessary but not
  // sufficient -- a nested element setting its OWN `color` back to black
  // (or omitting it where a wrapper breaks inheritance) would reintroduce
  // the exact "data-correct, zero-errors, invisible text" failure mode on
  // just that element. These assert every major state's visible text is
  // explicitly non-black, not just the root.
  describe('mobile UI: explicit non-black text in every state', () => {
    const notBlack = (el: Element | null) => {
      expect(el).toBeTruthy();
      const color = (el as HTMLElement).style.color;
      expect(color).toBeTruthy();
      expect(color.replace(/\s/g, '')).not.toMatch(/^(#000(000)?|rgb\(0,0,0\)|black)$/i);
    };

    it('loading state: the "Loading..." text has an explicit non-black color', async () => {
      // Checked before the mocked status-check promise resolves (no flush),
      // since isRecruiter starts null and this is the one render pass where
      // that's still true.
      root = createRoot(container);
      act(() => {
        root.render(<RepresentativesScreen onBack={() => {}} currentUser={currentUser} />);
      });
      const loading = container.querySelector('[data-testid="representatives-loading"] p');
      notBlack(loading);
    });

    it('registration (empty/prompt) state: the prompt paragraph and button text have explicit non-black colors', async () => {
      await mount();
      const prompt = Array.from(container.querySelectorAll('p')).find((p) => p.textContent?.includes('Become a VENTS Representative'));
      notBlack(prompt ?? null);
      const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Become a Representative');
      expect(btn).toBeTruthy();
      notBlack(btn ?? null);
    });

    it('error state: a visible error message has an explicit non-black color', async () => {
      recruiterStatusError = 'connection reset';
      await mount();
      const alert = container.querySelector('[role="alert"]');
      notBlack(alert);
    });

    it('populated state: a search result row and its Invite button have explicit non-black colors', async () => {
      recruiterRowExists = true;
      await mount();
      const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
      await act(async () => {
        setter.call(input, 'event');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await flush();
      const row = container.querySelector('[data-testid="search-result"]');
      expect(row).toBeTruthy();
      notBlack(row?.querySelector('span') ?? null);
      notBlack(row?.querySelector('button') ?? null);
    });

    it('team/empty-list state: the "no partnerships" message has an explicit non-black color', async () => {
      recruiterRowExists = true;
      await mount();
      const teamTab = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) => b.textContent?.includes('My Team'))!;
      await act(async () => { teamTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();
      const empty = Array.from(container.querySelectorAll('[data-testid="team-list"] p')).find((p) => p.textContent?.includes('no partnerships'));
      notBlack(empty ?? null);
    });
  });

  // The three sub-tabs must be visually distinguishable, not just
  // semantically marked via aria-selected -- a real user scanning the
  // screen needs a visible active-state cue, not just an accessibility
  // attribute with no corresponding style difference.
  it('the active tab has a visually distinct style from inactive tabs', async () => {
    await mount();
    const tabs = Array.from(container.querySelectorAll('button[role="tab"]'));
    expect(tabs).toHaveLength(3);
    const findTab = tabs.find((t) => t.textContent?.includes('Find'))!;
    const invitationsTab = tabs.find((t) => t.textContent?.includes('Invitations'))!;
    expect((findTab as HTMLElement).getAttribute('aria-selected')).toBe('true');
    expect((invitationsTab as HTMLElement).getAttribute('aria-selected')).toBe('false');
    // The active tab's background must differ from an inactive tab's --
    // this is the actual visual cue, not merely the aria attribute.
    const activeBg = (findTab as HTMLElement).style.background;
    const inactiveBg = (invitationsTab as HTMLElement).style.background;
    expect(activeBg).toBeTruthy();
    expect(activeBg).not.toBe(inactiveBg);
  });

  // Mobile viewport width: nothing in this component should be able to
  // force horizontal overflow under realistic content -- a long username
  // in a search result is the one place free-form external text flows
  // into a fixed-width row next to a button, so it needs explicit
  // overflow handling rather than a fixed pixel width.
  it('a long username in a search result does not force a fixed width wider than its row (overflow-safe)', async () => {
    recruiterRowExists = true;
    await mount();
    const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    await act(async () => {
      setter.call(input, 'event');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const span = container.querySelector('[data-testid="search-result"] span') as HTMLElement;
    expect(span).toBeTruthy();
    // No fixed pixel width; overflow is handled via ellipsis/truncation
    // rather than letting the row grow wider than its mobile container.
    expect(span.style.width).toBe('');
    expect(span.style.overflow).toBe('hidden');
    expect(span.style.whiteSpace).toBe('nowrap');
  });
});

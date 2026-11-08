// @vitest-environment jsdom
// Regression tests for the Representative dashboard's Find tab search:
// the screen used to call search_users_for_request on every keystroke,
// swallow every error as "No matches found", and let a slow response for
// an older query overwrite newer results.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type RpcResult = { data: any; error: any };
const rpcCalls: { name: string; args: any }[] = [];
let rpcHandler: (name: string, args: any) => Promise<RpcResult>;

function chain(result: RpcResult) {
  const p: any = Promise.resolve(result);
  const self: any = {
    then: (res: any, rej: any) => p.then(res, rej),
    maybeSingle: () => Promise.resolve(result),
    eq: () => self, or: () => self, order: () => self, in: () => self, select: () => self,
  };
  return self;
}

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => chain(table === 'recruiters'
        ? { data: { id: 'u1', status: 'active' }, error: null }
        : { data: [], error: null }),
    }),
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return rpcHandler(name, args);
    },
  },
}));

import { RepresentativesScreen } from './RepresentativesScreen';

const currentUser = { id: 'u1', role: 'attendee' };
let container: HTMLDivElement;
let root: Root;

const ok = (rows: any[]): RpcResult => ({ data: rows, error: null });
const row = (id: string, username: string, isOrg: boolean, providerId: string | null = null) =>
  ({ id, username, full_name: username, avatar_url: null, target_is_organizer: isOrg, target_provider_id: providerId });

function defaultHandler(name: string, args: any): Promise<RpcResult> {
  if (name === 'get_recruiter_invite_target') {
    return Promise.resolve(ok([{ target_is_organizer: true, target_provider_id: null }]));
  }
  if (name === 'search_recruiter_invite_targets') {
    return Promise.resolve(ok(String(args.p_query).includes('bayo') ? [row('o1', 'adebayo_events', true), row('p1', 'glowbayo', false, 'sp-1')] : []));
  }
  return Promise.resolve({ data: null, error: null });
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }
}

async function mount(debounce = 0) {
  root = createRoot(container);
  act(() => { root.render(<RepresentativesScreen onBack={() => {}} currentUser={currentUser} searchDebounceMs={debounce} />); });
  await flush();
}

async function type(value: string) {
  const input = container.querySelector('input[placeholder="Search by VENTS username"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const resultNames = () => Array.from(container.querySelectorAll('[data-testid="search-result"]')).map((el) => el.textContent);
const searchCalls = () => rpcCalls.filter((c) => c.name === 'search_recruiter_invite_targets');

beforeEach(() => {
  rpcCalls.length = 0;
  rpcHandler = defaultHandler;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('Representative Find search', () => {
  it('uses the invite-target search with a partial username and shows each result\'s role', async () => {
    await mount();
    await type('bayo');
    await flush();
    expect(searchCalls()).toEqual([{ name: 'search_recruiter_invite_targets', args: { p_query: 'bayo' } }]);
    const names = resultNames();
    expect(names[0]).toContain('adebayo_events');
    expect(names[0]).toContain('Organizer');
    expect(names[1]).toContain('glowbayo');
    expect(names[1]).toContain('Provider');
  });

  it('strips a leading @ before searching', async () => {
    await mount();
    await type('@bayo');
    await flush();
    expect(searchCalls()[0].args).toEqual({ p_query: 'bayo' });
  });

  it('debounces typing into a single request', async () => {
    vi.useFakeTimers();
    await mount(300);
    await type('ba');
    await type('bay');
    await type('bayo');
    expect(searchCalls()).toHaveLength(0);
    expect(container.querySelector('[data-testid="search-loading"]')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(300); });
    await flush();
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0].args.p_query).toBe('bayo');
    expect(resultNames()).toHaveLength(2);
  });

  it('shows a loading state while the request is in flight, then the results', async () => {
    let release!: (r: RpcResult) => void;
    rpcHandler = (name, args) => name === 'search_recruiter_invite_targets'
      ? new Promise((res) => { release = res; })
      : defaultHandler(name, args);
    await mount();
    await type('bayo');
    await flush();
    expect(container.querySelector('[data-testid="search-loading"]')?.textContent).toMatch(/Searching/);
    expect(container.textContent).not.toContain('No matches found');
    await act(async () => { release(ok([row('o1', 'adebayo_events', true)])); });
    await flush();
    expect(container.querySelector('[data-testid="search-loading"]')).toBeNull();
    expect(resultNames()).toHaveLength(1);
  });

  it('a slower response for an older query never replaces newer results', async () => {
    const pending: Record<string, (r: RpcResult) => void> = {};
    rpcHandler = (name, args) => name === 'search_recruiter_invite_targets'
      ? new Promise((res) => { pending[args.p_query] = res; })
      : defaultHandler(name, args);
    await mount();
    await type('ad');
    await type('glow');
    await act(async () => { pending.glow(ok([row('p1', 'glowbayo', false, 'sp-1')])); });
    await flush();
    await act(async () => { pending.ad(ok([row('o1', 'adebayo_events', true), row('o2', 'adeola', true)])); });
    await flush();
    const names = resultNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('glowbayo');
  });

  it('a rate-limit error is shown as such (not "No matches found") and Retry recovers', async () => {
    let limited = true;
    rpcHandler = (name, args) => {
      if (name === 'search_recruiter_invite_targets' && limited) {
        return Promise.resolve({ data: null, error: { code: 'P0429', message: 'rate_limited' } });
      }
      return defaultHandler(name, args);
    };
    await mount();
    await type('bayo');
    await flush();
    expect(container.querySelector('[data-testid="search-error"]')?.textContent).toMatch(/Too many searches/);
    expect(container.textContent).not.toContain('No matches found');
    expect(resultNames()).toHaveLength(0);

    limited = false; // the window has rolled over
    const retry = container.querySelector('[data-testid="search-retry"]') as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await flush();
    expect(container.querySelector('[data-testid="search-error"]')).toBeNull();
    expect(resultNames()).toHaveLength(2);
  });

  it('a network failure (thrown) is surfaced with Retry', async () => {
    rpcHandler = (name, args) => name === 'search_recruiter_invite_targets'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : defaultHandler(name, args);
    await mount();
    await type('bayo');
    await flush();
    expect(container.querySelector('[data-testid="search-error"]')?.textContent).toMatch(/connection/);
    expect(container.querySelector('[data-testid="search-retry"]')).toBeTruthy();
  });

  it('in a read-only Preview build the blocked search says so, with no pointless Retry', async () => {
    rpcHandler = (name, args) => name === 'search_recruiter_invite_targets'
      ? Promise.resolve({ data: null, error: { code: 'PREVIEW_READ_ONLY', message: 'Disabled in Preview' } })
      : defaultHandler(name, args);
    await mount();
    await type('bayo');
    await flush();
    expect(container.querySelector('[data-testid="search-error"]')?.textContent).toMatch(/Preview/);
    expect(container.querySelector('[data-testid="search-retry"]')).toBeNull();
  });

  it('"No matches found" appears only after a successful empty response', async () => {
    await mount();
    await type('zzzz');
    await flush();
    expect(container.textContent).toContain('No matches found');
    expect(container.querySelector('[data-testid="search-error"]')).toBeNull();
  });

  it('clearing the box returns to the start state and drops any in-flight response', async () => {
    let release!: (r: RpcResult) => void;
    rpcHandler = (name, args) => name === 'search_recruiter_invite_targets'
      ? new Promise((res) => { release = res; })
      : defaultHandler(name, args);
    await mount();
    await type('bayo');
    await type('');
    await act(async () => { release(ok([row('o1', 'adebayo_events', true)])); });
    await flush();
    expect(resultNames()).toHaveLength(0);
    expect(container.textContent).toContain('Search to get started');
  });

  it('falls back to search_users_for_request while migration 0204 is not applied', async () => {
    rpcHandler = (name, args) => {
      if (name === 'search_recruiter_invite_targets') {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
      }
      if (name === 'search_users_for_request') {
        return Promise.resolve(ok([{ id: 'o1', username: 'adebayo_events', full_name: 'A', avatar_url: null }]));
      }
      return defaultHandler(name, args);
    };
    await mount();
    await type('ade');
    await flush();
    expect(rpcCalls.map((c) => c.name)).toContain('search_users_for_request');
    expect(resultNames()).toHaveLength(1);
    expect(resultNames()[0]).toContain('adebayo_events');
  });
});

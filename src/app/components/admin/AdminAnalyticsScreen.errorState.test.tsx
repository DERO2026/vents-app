import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminAnalyticsScreen } from './AdminAnalyticsScreen';

// Regression coverage for a confirmed bug: loadStats's single .catch()
// only cleared `loading` and never recorded what went wrong, and a
// per-query error (uRes.error, etc., as opposed to a rejected promise)
// wasn't checked at all -- Promise.all resolves even when one of its
// settled results carries a Supabase { error } instead of throwing. On
// a refresh triggered by the admin:stats broadcast, a transient failure
// silently kept showing the LAST successful numbers forever, with no
// indication the refresh had stopped working.

let failUsers = false;
const channelStub = { on: () => channelStub, subscribe: () => channelStub };

vi.mock('../../../lib/supabase', () => {
  function makeQuery(table: string) {
    const q: any = {
      select: () => q,
      eq: () => q,
      is: () => q,
      range: () => q,
      then: (resolve: any) => {
        if (table === 'users' && failUsers) return resolve({ data: null, error: { message: 'permission denied for table users' }, count: null });
        if (table === 'users') return resolve({ data: null, error: null, count: 10 });
        if (table === 'events') return resolve({ data: null, error: null, count: 3 });
        if (table === 'tickets') return resolve({ data: [{ amount: 5000 }], error: null, count: 2 });
        if (table === 'vc_transactions') return resolve({ data: [{ amount: 100 }], error: null });
        return resolve({ data: [], error: null });
      },
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => makeQuery(table),
      rpc: () => Promise.resolve({ data: [{ new_this_week: 1, new_this_month: 4 }], error: null }),
      channel: () => channelStub,
      removeChannel: () => {},
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  failUsers = false;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('AdminAnalyticsScreen: error state', () => {
  it('shows an explicit error when one of the underlying queries fails', async () => {
    failUsers = true;
    root = createRoot(container);
    act(() => { root.render(<AdminAnalyticsScreen />); });
    await flush();

    expect(container.textContent).toContain('Could not refresh analytics');
  });

  it('renders real numbers with no error banner on a successful load', async () => {
    failUsers = false;
    root = createRoot(container);
    act(() => { root.render(<AdminAnalyticsScreen />); });
    await flush();

    expect(container.textContent).not.toContain('Could not refresh analytics');
    expect(container.textContent).toContain('Total Users');
  });
});

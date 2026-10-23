import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminSystemScreen } from './AdminSystemScreen';

// Regression coverage for a confirmed bug: unlike every other action on
// this screen (Orphan Cleanup -> isCleaning, Broadcast -> isSending,
// Health Ping -> isPinging), "Suspend All Unverified Accounts" had no busy
// state at all and its button was never disabled. It fetches the current
// unverified+active user cohort and awaits one admin_suspend_user call per
// row in a sequential loop -- a second click (or a double-click on
// ConfirmModal's own Confirm button, which has no busy state of its own)
// while that loop is still running re-fetches the same cohort and re-fires
// admin_suspend_user for every row the first run hasn't reached yet. This
// test proves the fix: a synchronous isSuspendingAll guard makes a second,
// concurrent invocation of the handler a no-op, and the button reflects
// the busy state while the loop runs.

const UNVERIFIED_USERS = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
const suspendCalls: any[] = [];

vi.mock('../../../lib/supabase', () => {
  function makeUsersQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: UNVERIFIED_USERS, error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'users') return makeUsersQuery();
        return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) };
      },
      rpc: (name: string, args: any) => {
        if (name === 'admin_suspend_user') {
          suspendCalls.push(args);
          // Never resolves within one flush -- simulates the in-flight
          // window a real double-click/loop overlap would race against.
          return new Promise((resolve) => setTimeout(() => resolve({ data: null, error: null }), 30));
        }
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

vi.mock('./adminAuditLog', () => ({ writeAuditLog: () => Promise.resolve() }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  suspendCalls.length = 0;
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

async function mount() {
  root = createRoot(container);
  act(() => { root.render(<AdminSystemScreen currentUser={{ id: 'admin-1', role: 'root' }} />); });
  await flush();
}

describe('AdminSystemScreen: bulk suspend double-submission guard', () => {
  it('a rapid double-click on the Suspend All ConfirmModal Confirm button only runs the bulk suspend once', async () => {
    await mount();

    const triggerBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Suspend All Unverified Accounts'))!;
    await act(async () => { triggerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Suspend All')!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Let the sequential admin_suspend_user loop (3 users x 30ms each)
      // fully drain before asserting.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();

    // One full pass over the 3-user cohort, not two.
    expect(suspendCalls.length).toBe(3);
  });

  it('disables the trigger button while the bulk suspend is in flight', async () => {
    await mount();

    const triggerBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Suspend All Unverified Accounts'))!;
    await act(async () => { triggerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Suspend All')!;
    await act(async () => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const busyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Suspending'));
    expect(busyBtn).toBeTruthy();
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

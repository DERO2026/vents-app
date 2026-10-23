import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminUserDetail } from './AdminUserDetail';

// Regression coverage for a confirmed bug: the Wallet, VC, Reports and
// Audit tab effects used .then(...).finally(...) with NO .catch() at all.
// A rejected promise (or, for the Promise.all tabs, a resolved result
// whose `error` field was set without rejecting) skipped the success
// handler entirely, so state just stayed at its empty initial value --
// rendered as a confident "₦0.00" / "0 VC" balance or "no reports/audit
// entries" instead of an error. For Wallet/VC specifically, that's a
// financially misleading false signal: an admin investigating a dispute
// could read a failed query as "this user genuinely has zero balance."

const userData = { id: 'u1', email: 'a@x.com', full_name: 'Ada Lovelace', role: 'attendee', is_organizer: false, is_service_provider: false, username: 'ada', phone_number: null, state: 'Lagos', status: 'active', is_verified: true, created_at: '2026-01-01T00:00:00Z', banned_until: null, deleted_at: null };
const admin = { id: 'admin-1', role: 'admin' };

vi.mock('../../../lib/supabase', () => {
  function makeUsersQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: userData, error: null }),
    };
    return q;
  }
  function makeFailingQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
      then: (resolve: any) => resolve({ data: null, error: { message: 'permission denied' } }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'users') return makeUsersQuery();
        return makeFailingQuery();
      },
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  act(() => { root.render(<AdminUserDetail userId="u1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
  await flush();
}

function clickTab(el: Element, label: string) {
  const tab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === label) as HTMLElement;
  return act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('AdminUserDetail: tab error states', () => {
  it('Wallet tab shows an explicit error instead of a fabricated ₦0.00 balance when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-user-detail"]')!;
    await clickTab(el, 'Wallet');
    await flush();
    expect(el.textContent).toContain('could not load wallet data');
    expect(el.textContent).not.toContain('₦0.00');
  });

  it('VC tab shows an explicit error instead of a fabricated 0 VC balance when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-user-detail"]')!;
    await clickTab(el, 'VENTS Cents');
    await flush();
    expect(el.textContent).toContain('could not load VENTS Cents data');
    expect(el.textContent).not.toContain('0 VC');
  });

  it('Reports tab shows an explicit error instead of "no reports filed" when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-user-detail"]')!;
    await clickTab(el, 'Reports');
    await flush();
    expect(el.textContent).toContain('could not load reports');
    expect(el.textContent).not.toContain('no reports filed by or against this user');
  });

  it('Audit tab shows an explicit error instead of "No admin actions recorded" when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-user-detail"]')!;
    await clickTab(el, 'Audit');
    await flush();
    expect(el.textContent).toContain('could not load the audit trail');
    expect(el.textContent).not.toContain('No admin actions recorded');
  });
});

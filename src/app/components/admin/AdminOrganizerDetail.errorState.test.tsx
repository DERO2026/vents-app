import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminOrganizerDetail } from './AdminOrganizerDetail';

// Regression coverage for a confirmed bug: the Events, KYC and Audit tab
// effects used .then(...).finally(...) with no .catch() (KYC's loadVerif
// used try/finally with no catch at all, so a thrown error became an
// unhandled promise rejection). A failed fetch rendered as a confident
// "no events" / "no verification request" / "no admin actions recorded"
// instead of an error -- for KYC specifically, indistinguishable from an
// organizer who genuinely never applied for verification.

const organizerData = {
  id: 'o1', full_name: 'Promoter Co', username: 'promoterco', email: 'promoter@x.com',
  phone_number: '08010000000', state: 'Lagos', is_verified: true, created_at: '2026-01-01T00:00:00Z',
};

vi.mock('../../../lib/supabase', () => {
  function makeUsersQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: organizerData, error: null }),
    };
    return q;
  }
  function makeFailingQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      is: () => q,
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
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); await Promise.resolve(); await Promise.resolve(); });
}

async function mount() {
  root = createRoot(container);
  act(() => { root.render(<AdminOrganizerDetail organizerId="o1" isSuperAdmin={true} isMobile={false} onBack={() => {}} />); });
  await flush();
}

function clickTab(el: Element, label: string) {
  const tab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === label) as HTMLElement;
  return act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('AdminOrganizerDetail: tab error states', () => {
  it('Events tab shows an explicit error instead of "No events hosted yet." when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-organizer-detail"]')!;
    await clickTab(el, 'Events');
    await flush();
    expect(el.textContent).toContain('could not load events');
    expect(el.textContent).not.toContain('No events hosted yet.');
  });

  it('KYC tab shows an explicit error instead of claiming the organizer never applied', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-organizer-detail"]')!;
    await clickTab(el, 'KYC');
    await flush();
    expect(el.textContent).toContain('could not load verification status');
    expect(el.textContent).not.toContain('they have not submitted CAC verification');
  });

  it('Audit tab shows an explicit error instead of "No admin actions recorded" when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-organizer-detail"]')!;
    await clickTab(el, 'Audit');
    await flush();
    expect(el.textContent).toContain('could not load the audit trail');
    expect(el.textContent).not.toContain('No admin actions recorded for this organizer.');
  });
});

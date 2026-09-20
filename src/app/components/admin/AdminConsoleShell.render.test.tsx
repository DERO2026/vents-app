import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminConsoleShell } from './AdminConsoleShell';

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [], count: 3 }),
        is: () => Promise.resolve({ data: [], count: 5 }),
      }),
    }),
    rpc: () => Promise.resolve({ data: [{ circulation: 1000 }], error: null }),
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: w });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  setWidth(1440);
});

const subAdminUser = { id: 'sub-1', role: 'sub-admin' };
const adminUser = { id: 'admin-1', role: 'admin' };
const rootUser = { id: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', role: 'admin' };

describe('AdminConsoleShell', () => {
  it('renders the desktop sidebar with nav items and hides Communication for sub-admin', async () => {
    setWidth(1440);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={subAdminUser} onBack={() => {}} />);
    });
    const sidebar = container!.querySelector('[data-testid="admin-sidebar"]');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toContain('Users');
    expect(sidebar!.textContent).not.toContain('Communication');
  });

  it('shows Communication for a full admin', async () => {
    setWidth(1440);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={adminUser} onBack={() => {}} />);
    });
    const sidebar = container!.querySelector('[data-testid="admin-sidebar"]');
    expect(sidebar!.textContent).toContain('Communication');
  });

  it('shows a ROOT lock badge on root-only items for a non-root admin', async () => {
    setWidth(1440);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={adminUser} onBack={() => {}} />);
    });
    const sidebar = container!.querySelector('[data-testid="admin-sidebar"]');
    expect(sidebar!.textContent).toContain('ROOT');
  });

  it('does not show the ROOT lock badge for the root user', async () => {
    setWidth(1440);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={rootUser} onBack={() => {}} />);
    });
    const sidebar = container!.querySelector('[data-testid="admin-sidebar"]');
    expect(sidebar!.querySelectorAll('[aria-disabled="true"]').length).toBe(0);
  });

  it('renders the tablet icon-only collapsed sidebar (no labels)', async () => {
    setWidth(900);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={adminUser} onBack={() => {}} />);
    });
    const sidebar = container!.querySelector('[data-testid="admin-sidebar"]');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).not.toContain('Dashboard');
    expect(container!.querySelector('[data-testid="admin-topbar-desktop"]')).toBeTruthy();
  });

  it('renders mobile chrome (bottom nav, compact topbar, no sidebar) under 768px', async () => {
    setWidth(500);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={adminUser} onBack={() => {}} />);
    });
    expect(container!.querySelector('[data-testid="admin-sidebar"]')).toBeFalsy();
    expect(container!.querySelector('[data-testid="admin-topbar-mobile"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="admin-mobile-nav"]')).toBeTruthy();
  });

  it('opens the More sheet on mobile and can navigate from it', async () => {
    setWidth(500);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={adminUser} onBack={() => {}} />);
    });
    const moreBtn = Array.from(container!.querySelectorAll('[role="button"]')).find((el) => el.textContent?.includes('More')) as HTMLElement;
    expect(moreBtn).toBeTruthy();
    await act(async () => {
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="admin-more-sheet"]')).toBeTruthy();
  });

  it('renders the dashboard with real-data and empty-state tiles without crashing', async () => {
    setWidth(1440);
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={adminUser} onBack={() => {}} />);
    });
    // allow the dashboard's async load() to settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const dash = container!.querySelector('[data-testid="admin-dashboard"]');
    expect(dash).toBeTruthy();
    expect(dash!.textContent).toContain('Not yet available');
  });

  it('blocks access for a non-admin-tier user', async () => {
    await act(async () => {
      root!.render(<AdminConsoleShell currentUser={{ id: 'u1', role: 'attendee' }} onBack={() => {}} />);
    });
    expect(container!.textContent).toContain('do not have access');
  });
});

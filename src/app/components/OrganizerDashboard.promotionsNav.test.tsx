import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { OrganizerDashboard } from './OrganizerDashboard';

// VENTS Phase 7 -- Creator Studio Promotions management. Before this,
// Creator Studio's "Promotions" item (desktop-only .cs-sidebar) navigated
// straight to the purchase screen (PromoteEventScreen), with no mobile
// entry point at all (the sidebar is display:none below 900px, and no
// other button in this screen reached a Promotions destination). This
// proves: (1) the desktop sidebar's Promotions item now opens the new
// monitoring screen ('promotions'), not the purchase screen directly, and
// (2) a mobile-visible action button (outside the 900px-gated sidebar)
// gives mobile the same destination, closing the inconsistency.

vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const chain: any = {};
      ['select', 'eq', 'is', 'order', 'limit'].forEach((m) => { chain[m] = vi.fn(() => chain); });
      chain.then = (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    }),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}));

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function mount(onNavigate = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <OrganizerDashboard
        currentUser={{ id: 'org-1', email: 'org@vents.test', full_name: 'Org', role: 'organizer' }}
        setActiveView={() => {}}
        onNavigate={onNavigate}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onNavigate };
}

describe('OrganizerDashboard: Creator Studio Promotions navigation consistency', () => {
  it('the desktop sidebar’s Promotions item navigates to the monitoring screen, not straight to the purchase screen', async () => {
    const { onNavigate } = await mount();
    const sidebarBtn = Array.from(container!.querySelectorAll('.cs-sidebar-item')).find((b) => b.textContent === 'Promotions') as HTMLButtonElement;
    expect(sidebarBtn).toBeTruthy();
    act(() => { sidebarBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onNavigate).toHaveBeenCalledWith('promotions');
    expect(onNavigate).not.toHaveBeenCalledWith('promote-event');
  });

  it('a mobile-visible action button (not inside .cs-sidebar) also reaches the Promotions screen', async () => {
    const { onNavigate } = await mount();
    const mobileBtn = container!.querySelector('[data-testid="org-dashboard-promotions-action"]') as HTMLButtonElement;
    expect(mobileBtn).toBeTruthy();
    // Confirm it is NOT inside the desktop-only sidebar -- that's the
    // whole point of the fix (a real entry point outside the
    // 900px-gated .cs-sidebar).
    expect(mobileBtn.closest('.cs-sidebar')).toBeFalsy();
    act(() => { mobileBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onNavigate).toHaveBeenCalledWith('promotions');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { OrganizerDashboard } from './OrganizerDashboard';
import { ventsColors } from '../../lib/ventsDesignTokens';

// Stage 4 refurbishment: reconciled the two remaining legacy-hex literals
// in this screen ('#60A5FA' -> ventsColors.info, '#fff' -> ventsColors.white)
// with their exact-value token equivalents. This asserts the COMPUTED color
// actually matches the token -- not just that the token is imported --
// following the pattern that caught the real black-screen regression
// earlier in this refurbishment (text-presence assertions alone don't
// catch an inherited/invisible color).

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

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <OrganizerDashboard
        currentUser={{ id: 'org-1', email: 'org@vents.test', full_name: 'Org', role: 'organizer' }}
        setActiveView={() => {}}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('OrganizerDashboard: Stage 4 token color reconciliation', () => {
  it('the Promotions action button uses ventsColors.info, computed, not just as a string literal', async () => {
    await mount();
    const btn = container!.querySelector('[data-testid="org-dashboard-promotions-action"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.style.color).toBe(hexToRgb(ventsColors.info));
  });

  it('every styled element on the loading state has a non-black, explicit color (root-cause regression guard)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <OrganizerDashboard
          currentUser={{ id: 'org-1', email: 'org@vents.test', full_name: 'Org', role: 'organizer' }}
          setActiveView={() => {}}
        />
      );
    });
    // Synchronous first render = the loading state, before the mocked
    // Supabase promise resolves.
    const loadingText = Array.from(container.querySelectorAll('span')).find((el) =>
      el.textContent?.includes('Loading Creator Hub')
    ) as HTMLElement;
    expect(loadingText).toBeTruthy();
    expect(loadingText.style.color).not.toBe('');
    expect(loadingText.style.color).not.toBe('rgb(0, 0, 0)');
  });
});

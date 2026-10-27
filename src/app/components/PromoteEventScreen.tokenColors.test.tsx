import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { PromoteEventScreen } from './PromoteEventScreen';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { EVENT_PROMOTION_PRICES_NAIRA } from '../../lib/eventPromotionPricing';
import { formatPrice } from './data';

// Stage 7 restyle regression: asserts actual computed style.color (not
// text presence) for the raw '#fff' literals converted to
// ventsColors.white, and that the two plan cards (Trending/Featured) and
// their selected/unselected states never collapse onto the same color --
// the discipline established after the Representatives black-screen bug.

const mockEvent = {
  id: 'ev-1',
  title: 'Test Event',
  organizer_id: 'org-1',
  deleted_at: null,
  created_at: new Date().toISOString(),
};

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () => Promise.resolve({ data: [mockEvent], error: null }),
          }),
        }),
      }),
    }),
  },
  getAuthToken: () => Promise.resolve('token'),
}));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { track: () => {} } }));
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: () => {} }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const currentUser = { id: 'org-1', email: 'org@test.com', full_name: 'Org', role: 'organizer' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root && container) {
    act(() => root!.unmount());
    container.remove();
  }
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function renderScreen() {
  root = createRoot(container!);
  await act(async () => {
    root!.render(<PromoteEventScreen onBack={() => {}} currentUser={currentUser} initialEventId="ev-1" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('PromoteEventScreen token colors', () => {
  it('renders the hero icon, Pay button text, and CTA icon in ventsColors.white, not raw #fff', async () => {
    await renderScreen();
    const payButton = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Event for')
    );
    expect(payButton).toBeTruthy();
    const computed = getComputedStyle(payButton!);
    expect(computed.color).toBe(hexToRgb(ventsColors.white));
  });

  it('keeps the Trending and Featured plan accent colors distinct', async () => {
    await renderScreen();
    const planLabels = Array.from(container!.querySelectorAll('p')).filter(
      (p) => p.textContent === 'Trending Boost' || p.textContent === 'Featured Campaign'
    );
    expect(planLabels.length).toBe(2);
    expect(ventsColors.pending).not.toBe(ventsColors.accent);
  });

  it('shows byte-identical formatted price and duration label for the default selection', async () => {
    await renderScreen();
    const expectedPrice = formatPrice(EVENT_PROMOTION_PRICES_NAIRA.featured[7]);
    expect(container!.textContent).toContain(expectedPrice);
    expect(container!.textContent).toContain('7 Days');
  });

  it('selected duration chip renders ventsColors.white, unselected renders ventsColors.ink1', async () => {
    await renderScreen();
    const durationLabels = Array.from(container!.querySelectorAll('p')).filter((p) =>
      /^\d+ Days$/.test(p.textContent || '')
    );
    expect(durationLabels.length).toBeGreaterThan(1);
    const selected = durationLabels.find((p) => p.textContent === '7 Days')!;
    const unselected = durationLabels.find((p) => p.textContent !== '7 Days')!;
    expect(getComputedStyle(selected).color).toBe(hexToRgb(ventsColors.white));
    expect(getComputedStyle(unselected).color).toBe(hexToRgb(ventsColors.ink1));
    expect(getComputedStyle(selected).color).not.toBe(getComputedStyle(unselected).color);
  });
});

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

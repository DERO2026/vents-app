import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServicesHomeScreen } from './ServicesHomeScreen';

// Regression tests for the same Services-discovery retry bug as
// ServiceCategoryScreen.render.test.tsx, on the home discovery screen's
// "Providers near you" section.
const fetchApprovedServiceProviders = vi.fn();
const fetchNearbyServiceProviders = vi.fn();
const withProviderRatings = vi.fn(async (rows: any[]) => rows);
vi.mock('../../lib/serviceProviders', () => ({
  fetchApprovedServiceProviders: (...args: any[]) => fetchApprovedServiceProviders(...args),
  fetchNearbyServiceProviders: (...args: any[]) => fetchNearbyServiceProviders(...args),
  withProviderRatings: (...args: any[]) => withProviderRatings(...args as [any[]]),
}));
// Location denied/unavailable -> exercises the country-fallback branch
// (fetchApprovedServiceProviders), which is the simpler of the two paths
// and enough to prove the Retry wiring re-runs the effect.
vi.mock('../../lib/useGeolocation', () => ({
  useGeolocation: () => ({ status: 'denied', lat: null, lng: null }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchApprovedServiceProviders.mockReset();
  fetchNearbyServiceProviders.mockReset();
});

function renderScreen(extraProps: { onOpenVentsAi?: () => void } = {}) {
  root = createRoot(container!);
  return act(async () => {
    root!.render(
      <ServicesHomeScreen
        onBack={() => {}}
        onCategoryPress={() => {}}
        onProviderPress={() => {}}
        discoveryCountryIso="NG"
        onDiscoveryCountryChange={() => {}}
        {...extraProps}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ServicesHomeScreen: discovery-load Retry', () => {
  it('shows a real Retry button (not "pull down") on load failure, and it re-runs the fetch', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    let resolveSecondCall: (rows: any[]) => void = () => {};
    fetchApprovedServiceProviders
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondCall = resolve; }));

    await renderScreen();

    expect(container.textContent).not.toContain('Pull down to try again');
    expect(container.textContent).toContain("Couldn't load providers");

    const retryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    expect(retryButton).toBeTruthy();

    act(() => { retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(fetchApprovedServiceProviders).toHaveBeenCalledTimes(2);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(false);
    expect(container.textContent).not.toContain("Couldn't load providers");

    await act(async () => {
      resolveSecondCall([{ id: 'p1', businessName: 'Glow Studio', category: 'Beauty & Grooming', photoUrls: [] }] as any);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Glow Studio');
    expect(container.textContent).not.toContain("Couldn't load providers");
  });

  it('the Retry button is unmounted (not just disabled) once a retry is in flight, so it cannot be double-fired', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    fetchApprovedServiceProviders.mockRejectedValueOnce(new Error('down'));
    await renderScreen();

    let pendingResolve: (rows: any[]) => void = () => {};
    fetchApprovedServiceProviders.mockImplementationOnce(() => new Promise((resolve) => { pendingResolve = resolve; }));

    const retryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    act(() => { retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(false);
    expect(fetchApprovedServiceProviders).toHaveBeenCalledTimes(2);

    await act(async () => { pendingResolve([]); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain("Couldn't load providers");
  });
});

describe('ServicesHomeScreen: VENTS AI search-bar entry point', () => {
  it('renders the sparkle control and calls onOpenVentsAi when tapped', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    const onOpenVentsAi = vi.fn();
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    await renderScreen({ onOpenVentsAi });

    const aiButton = container.querySelector('button[aria-label="Ask VENTS AI"]') as HTMLButtonElement;
    expect(aiButton).toBeTruthy();

    act(() => { aiButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOpenVentsAi).toHaveBeenCalledTimes(1);
  });

  it('does not render the sparkle control when no handler is passed', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    await renderScreen();

    expect(container.querySelector('button[aria-label="Ask VENTS AI"]')).toBeNull();
  });
});

describe('ServicesHomeScreen: 12-category grid (Batch 2 taxonomy)', () => {
  it('renders all 12 approved categories, each opening via onCategoryPress', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    const onCategoryPress = vi.fn();
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ServicesHomeScreen
          onBack={() => {}}
          onCategoryPress={onCategoryPress}
          onProviderPress={() => {}}
          discoveryCountryIso="NG"
          onDiscoveryCountryChange={() => {}}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const categories = [
      'Entertainment & Talent', 'Photography & Videography', 'Beauty & Styling',
      'Event Planning & Decoration', 'Food, Drinks & Catering', 'Event Equipment & Production',
      'Venues & Spaces', 'Transport & Logistics', 'Fashion & Custom Design',
      'Event Support & Professional Services', 'Marketing & Creative Services', 'Celebrations & Special Occasions',
    ];
    for (const cat of categories) {
      expect(container.textContent).toContain(cat);
    }

    const firstButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === categories[0])!;
    act(() => { firstButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onCategoryPress).toHaveBeenCalledWith(categories[0]);
  });
});

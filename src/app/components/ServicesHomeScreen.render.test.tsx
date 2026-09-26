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

function renderScreen() {
  root = createRoot(container!);
  return act(async () => {
    root!.render(
      <ServicesHomeScreen
        onBack={() => {}}
        onCategoryPress={() => {}}
        onProviderPress={() => {}}
        discoveryCountryIso="NG"
        onDiscoveryCountryChange={() => {}}
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

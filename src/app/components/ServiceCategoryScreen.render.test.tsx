import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceCategoryScreen } from './ServiceCategoryScreen';

// Regression tests for the Services-discovery retry bug: this screen used
// to render "Couldn't load providers right now. Pull down to try again."
// on a load failure with no pull-to-refresh gesture implemented anywhere
// and no retry button -- a genuine dead end. These prove a real Retry
// control exists, that it actually re-runs the failed fetch, that a
// loading state is shown while it does, and that it can't be double-fired.
const fetchApprovedServiceProviders = vi.fn();
vi.mock('../../lib/serviceProviders', () => ({
  fetchApprovedServiceProviders: (...args: any[]) => fetchApprovedServiceProviders(...args),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchApprovedServiceProviders.mockReset();
});

describe('ServiceCategoryScreen: discovery-load Retry', () => {
  it('shows a real Retry button (not "pull down") on load failure, and it re-runs the fetch', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    let resolveSecondCall: (rows: any[]) => void = () => {};
    fetchApprovedServiceProviders
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondCall = resolve; }));

    root = createRoot(container);
    await act(async () => {
      root!.render(<ServiceCategoryScreen category="Photography" countryIso="NG" onBack={() => {}} onProviderPress={() => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Old, misleading copy must be gone.
    expect(container.textContent).not.toContain('Pull down to try again');
    expect(container.textContent).toContain("Couldn't load providers");

    const retryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
    expect(retryButton).toBeTruthy();

    act(() => { retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Retry actually re-invoked the fetch a second time.
    expect(fetchApprovedServiceProviders).toHaveBeenCalledTimes(2);
    // While the retry is in flight, the error/Retry UI is gone (replaced by
    // the loading skeleton) -- there is no button left to double-click.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(false);
    expect(container.textContent).not.toContain("Couldn't load providers");

    await act(async () => {
      resolveSecondCall([{ id: 'p1', businessName: 'Test Studio', category: 'Photography', offersHomeService: false, offersDelivery: false, offersSameDay: false, photoUrls: [] }] as any);
      await Promise.resolve();
      await Promise.resolve();
    });

    // A successful retry shows the real result, error state fully cleared.
    expect(container.textContent).toContain('Test Studio');
    expect(container.textContent).not.toContain("Couldn't load providers");
  });

  it('clicking Retry while a retry is already loading cannot fire a duplicate fetch (button is unmounted, not just disabled)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    fetchApprovedServiceProviders.mockRejectedValueOnce(new Error('down'));

    root = createRoot(container);
    await act(async () => {
      root!.render(<ServiceCategoryScreen category="Photography" countryIso="NG" onBack={() => {}} onProviderPress={() => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    let pendingResolve: (rows: any[]) => void = () => {};
    fetchApprovedServiceProviders.mockImplementationOnce(() => new Promise((resolve) => { pendingResolve = resolve; }));

    const retryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    act(() => { retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // No Retry button exists to click again while this request is in flight.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Retry')).toBe(false);
    expect(fetchApprovedServiceProviders).toHaveBeenCalledTimes(2);

    await act(async () => { pendingResolve([]); await Promise.resolve(); await Promise.resolve(); });
    // Empty-result state, not stuck loading or re-showing the stale error.
    expect(container.textContent).not.toContain("Couldn't load providers");
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ServiceCategoryScreen: in-category search (was entirely missing)', () => {
  const providers = [
    { id: 'p1', businessName: 'Glow Studio', category: 'Photography', description: 'Weddings and portraits', location: 'Lekki, Lagos', servicesOffered: ['Studio shoots'], offersHomeService: false, offersDelivery: false, offersSameDay: false, photoUrls: [] },
    { id: 'p2', businessName: 'Frame Masters', category: 'Photography', description: 'Corporate events', location: 'Abuja', servicesOffered: ['Drone photography'], offersHomeService: false, offersDelivery: false, offersSameDay: false, photoUrls: [] },
  ];

  async function renderWithProviders() {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce(providers as any);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ServiceCategoryScreen category="Photography" countryIso="NG" onBack={() => {}} onProviderPress={() => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('filters the real, already-fetched list by business name as the user types', async () => {
    await renderWithProviders();
    expect(container!.textContent).toContain('Glow Studio');
    expect(container!.textContent).toContain('Frame Masters');

    const input = container!.querySelector('input[aria-label="Search Photography providers"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'glow'); });

    expect(container!.textContent).toContain('Glow Studio');
    expect(container!.textContent).not.toContain('Frame Masters');
  });

  it('matches on description, location, and specialty tags -- not just the business name', async () => {
    await renderWithProviders();
    const input = container!.querySelector('input[aria-label="Search Photography providers"]') as HTMLInputElement;

    act(() => { setInputValue(input, 'drone'); });
    expect(container!.textContent).toContain('Frame Masters');
    expect(container!.textContent).not.toContain('Glow Studio');

    act(() => { setInputValue(input, 'lekki'); });
    expect(container!.textContent).toContain('Glow Studio');
    expect(container!.textContent).not.toContain('Frame Masters');
  });

  it('shows a distinct "no matches" message for a search miss, and the Clear button restores the full list', async () => {
    await renderWithProviders();
    const input = container!.querySelector('input[aria-label="Search Photography providers"]') as HTMLInputElement;

    act(() => { setInputValue(input, 'nonexistent'); });
    expect(container!.textContent).toContain('No matches for "nonexistent"');
    expect(container!.textContent).not.toContain('No Photography providers yet');

    const clearButton = container!.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement;
    expect(clearButton).toBeTruthy();
    act(() => { clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(input.value).toBe('');
    expect(container!.textContent).toContain('Glow Studio');
    expect(container!.textContent).toContain('Frame Masters');
  });

  it('search and the Home/Delivery/Same-day filter chips combine (AND), not override each other', async () => {
    const homeServiceProvider = { ...providers[0], offersHomeService: true };
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([homeServiceProvider, providers[1]] as any);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ServiceCategoryScreen category="Photography" countryIso="NG" onBack={() => {}} onProviderPress={() => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const homeChip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Home Service'))!;
    act(() => { homeChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // Only the offersHomeService provider survives the chip filter.
    expect(container.textContent).toContain('Glow Studio');
    expect(container.textContent).not.toContain('Frame Masters');

    const input = container.querySelector('input[aria-label="Search Photography providers"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'frame'); });
    // "frame" matches Frame Masters by name, but it's excluded by the
    // active Home Service chip -- search narrows further, it never
    // overrides the chip filter.
    expect(container.textContent).not.toContain('Frame Masters');
    expect(container.textContent).not.toContain('Glow Studio');
  });
});

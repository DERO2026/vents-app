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
      root!.render(<ServiceCategoryScreen category="Photography" onBack={() => {}} onProviderPress={() => {}} />);
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
      root!.render(<ServiceCategoryScreen category="Photography" onBack={() => {}} onProviderPress={() => {}} />);
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

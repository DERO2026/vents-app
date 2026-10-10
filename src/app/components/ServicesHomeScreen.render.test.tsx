import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServicesHomeScreen } from './ServicesHomeScreen';

// Regression tests for the same Services-discovery retry bug as
// ServiceCategoryScreen.render.test.tsx, on the home discovery screen's
// "Providers near you" section.
const fetchApprovedServiceProviders = vi.fn();
const fetchNearbyServiceProviders = vi.fn();
const searchServiceProviders = vi.fn();
const withProviderRatings = vi.fn(async (rows: any[]) => rows);
vi.mock('../../lib/serviceProviders', () => ({
  fetchApprovedServiceProviders: (...args: any[]) => fetchApprovedServiceProviders(...args),
  fetchNearbyServiceProviders: (...args: any[]) => fetchNearbyServiceProviders(...args),
  searchServiceProviders: (...args: any[]) => searchServiceProviders(...args),
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
  searchServiceProviders.mockReset();
});

function renderScreen(extraProps: { onOpenVentsAi?: () => void; onOfferServices?: () => void } = {}) {
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

    const firstButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(categories[0]))!;
    act(() => { firstButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onCategoryPress).toHaveBeenCalledWith(categories[0]);
  });
});

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ServicesHomeScreen: real search (not a client-side filter over the capped "near you" list)', () => {
  it('debounces typed input into a real searchServiceProviders call scoped to the active country, and renders real results', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    vi.useFakeTimers();
    try {
      await renderScreen();

      const input = container.querySelector('input[aria-label="Search a service"]') as HTMLInputElement;
      let resolveSearch: (rows: any[]) => void = () => {};
      searchServiceProviders.mockImplementationOnce(() => new Promise((resolve) => { resolveSearch = resolve; }));

      act(() => { setInputValue(input, 'mc'); });
      // Not called yet -- still inside the debounce window.
      expect(searchServiceProviders).not.toHaveBeenCalled();

      await act(async () => { vi.advanceTimersByTime(300); });
      expect(searchServiceProviders).toHaveBeenCalledWith({ query: 'mc', country: 'NG' });
      expect(container.textContent).toContain('Searching');

      await act(async () => {
        resolveSearch([{ id: 'p1', businessName: 'DJ Mc Real', category: 'Entertainment & Talent', photoUrls: [], servicesOffered: [] }] as any);
        await Promise.resolve();
      });
      expect(container.textContent).toContain('DJ Mc Real');
      expect(container.textContent).not.toContain('BROWSE BY PROFESSION');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pressing Enter runs the search immediately, without waiting for the debounce', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    searchServiceProviders.mockResolvedValueOnce([{ id: 'p2', businessName: 'MC Jollof', category: 'Entertainment & Talent', photoUrls: [], servicesOffered: [] }] as any);
    await renderScreen();

    const input = container.querySelector('input[aria-label="Search a service"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'mc'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(searchServiceProviders).toHaveBeenCalledWith({ query: 'mc', country: 'NG' });
    expect(container.textContent).toContain('MC Jollof');
  });

  it('shows a distinct "no matches" state for a search miss, not the generic empty-country copy', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    searchServiceProviders.mockResolvedValueOnce([]);
    await renderScreen();

    const input = container.querySelector('input[aria-label="Search a service"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'zzzznomatch'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('No providers matched "zzzznomatch"');
    expect(container.textContent).not.toContain('No providers in');
  });

  it('shows a real error + Retry on search failure, distinct from the discovery-load error', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    searchServiceProviders.mockRejectedValueOnce(new Error('network down'));
    await renderScreen();

    const input = container.querySelector('input[aria-label="Search a service"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'mc'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Couldn't search right now");
    const retryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Retry')!;
    expect(retryButton).toBeTruthy();

    searchServiceProviders.mockResolvedValueOnce([{ id: 'p3', businessName: 'MC Tunde', category: 'Entertainment & Talent', photoUrls: [], servicesOffered: [] }] as any);
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('MC Tunde');
  });

  it('the clear (X) button resets the search and returns to the browse view', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValue([]);
    searchServiceProviders.mockResolvedValueOnce([{ id: 'p4', businessName: 'MC Dayo', category: 'Entertainment & Talent', photoUrls: [], servicesOffered: [] }] as any);
    await renderScreen();

    const input = container.querySelector('input[aria-label="Search a service"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'mc'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('MC Dayo');

    const clearButton = container.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement;
    expect(clearButton).toBeTruthy();
    act(() => { clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(input.value).toBe('');
    expect(container.textContent).toContain('BROWSE BY PROFESSION');
    expect(container.textContent).not.toContain('MC Dayo');
  });
});

describe('ServicesHomeScreen: "Offer Your Services" provider-setup entry point (compact header button)', () => {
  it('renders a compact button at the top, next to the country selector, and calls onOfferServices when tapped', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    const onOfferServices = vi.fn();
    await renderScreen({ onOfferServices });

    const button = container.querySelector('[data-testid="services-offer-your-services"]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe('Offer Your Services');
    // The long sentence-style CTA ("Register as a provider under your
    // profession") further down the screen is removed -- this compact
    // button is the only entry point now.
    expect(container.textContent).not.toContain('Register as a provider under your profession');

    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOfferServices).toHaveBeenCalledTimes(1);
  });

  it('does not render the button when no handler is passed', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchApprovedServiceProviders.mockResolvedValueOnce([]);
    await renderScreen();

    expect(container.querySelector('[data-testid="services-offer-your-services"]')).toBeFalsy();
  });
});

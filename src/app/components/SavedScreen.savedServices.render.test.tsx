import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { SavedScreen } from './SavedScreen';

// Regression coverage for the new "Saved Services" tab (0118_saved_service_
// providers.sql) -- Saved previously covered events only.
const fetchServiceProvidersByIds = vi.fn(async (..._args: any[]) => []);
vi.mock('../../lib/serviceProviders', () => ({
  fetchServiceProvidersByIds: (...args: any[]) => fetchServiceProvidersByIds(...args),
}));
// SavedScreen imports mapDbEventToFrontend from ./HomeScreen, which imports
// the real supabase client module at load time -- stub it out the same way
// other tests in this file's directory already do, so module import doesn't
// try to construct a real client with no env vars set in the test process.
vi.mock('../../lib/supabase', () => ({ supabase: {}, getAuthToken: vi.fn(async () => 'token') }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchServiceProvidersByIds.mockClear();
});

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(ui); });
}

describe('SavedScreen: Saved Services tab', () => {
  it('does not show a Services tab when onProviderPress is not passed (backward compatible)', () => {
    render(
      <SavedScreen
        savedEventIds={[]}
        onEventPress={() => {}}
        onToggleSave={() => {}}
        dbEvents={[]}
        onBack={() => {}}
      />
    );
    expect(container!.textContent).not.toContain('Services');
    expect(fetchServiceProvidersByIds).not.toHaveBeenCalled();
  });

  it('fetches and lists saved providers when switching to the Services tab', async () => {
    fetchServiceProvidersByIds.mockResolvedValueOnce([
      { id: 'p1', userId: 'u1', businessName: 'Glow Studio', category: 'Beauty & Grooming', description: null, location: null, latitude: null, longitude: null, country: 'NG', photoUrls: [], startingPrice: null, startingPriceCurrency: null, servicesOffered: [], offersHomeService: false, offersDelivery: false, offersSameDay: false, status: 'approved', createdAt: '', updatedAt: '' },
    ] as any);

    const onProviderPress = vi.fn();
    await act(async () => {
      render(
        <SavedScreen
          savedEventIds={[]}
          onEventPress={() => {}}
          onToggleSave={() => {}}
          dbEvents={[]}
          onBack={() => {}}
          savedProviderIds={['p1']}
          onProviderPress={onProviderPress}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchServiceProvidersByIds).toHaveBeenCalledWith(['p1']);

    const servicesTab = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Services')!;
    await act(async () => {
      servicesTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('Glow Studio');

    const card = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Glow Studio'))!;
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onProviderPress).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no services are saved', async () => {
    const onProviderPress = vi.fn();
    await act(async () => {
      render(
        <SavedScreen
          savedEventIds={[]}
          onEventPress={() => {}}
          onToggleSave={() => {}}
          dbEvents={[]}
          onBack={() => {}}
          savedProviderIds={[]}
          onProviderPress={onProviderPress}
        />
      );
      await Promise.resolve();
    });

    const servicesTab = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Services')!;
    act(() => { servicesTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container!.textContent).toContain('No saved services');
  });
});

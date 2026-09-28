import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServicesHomeScreen } from './ServicesHomeScreen';
import { ServiceCategoryScreen } from './ServiceCategoryScreen';

// Regression coverage for the country-leak bug: a user who explicitly
// selected a discovery country (e.g. Afghanistan) while physically located
// in another country (e.g. Nigeria) still saw that other country's
// providers, because the GPS "near you" path called
// fetchNearbyServiceProviders() without ever passing the selected country
// through, and ServiceCategoryScreen's category browse didn't accept a
// country at all. These tests prove the country is actually threaded
// through in both cases, and that switching countries re-fetches.

const fetchApprovedServiceProviders = vi.fn(async (..._args: any[]) => []);
const fetchNearbyServiceProviders = vi.fn(async (..._args: any[]) => []);
const withProviderRatings = vi.fn(async (rows: any[]) => rows);
vi.mock('../../lib/serviceProviders', () => ({
  fetchApprovedServiceProviders: (...args: any[]) => fetchApprovedServiceProviders(...args),
  fetchNearbyServiceProviders: (...args: any[]) => fetchNearbyServiceProviders(...args),
  withProviderRatings: (...args: any[]) => withProviderRatings(...(args as [any[]])),
}));

let geoStatus: { status: string; lat: number | null; lng: number | null } = {
  status: 'granted',
  lat: 6.5,
  lng: 3.4,
};
vi.mock('../../lib/useGeolocation', () => ({
  useGeolocation: () => geoStatus,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchApprovedServiceProviders.mockClear();
  fetchNearbyServiceProviders.mockClear();
  geoStatus = { status: 'granted', lat: 6.5, lng: 3.4 };
});

describe('Services discovery: selected country is never overridden', () => {
  it('ServicesHomeScreen passes the selected discovery country into the GPS "near you" fetch, and re-fetches when it changes', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    function renderWithCountry(iso: string) {
      root = createRoot(container!);
      return act(async () => {
        root!.render(
          <ServicesHomeScreen
            onBack={() => {}}
            onCategoryPress={() => {}}
            onProviderPress={() => {}}
            discoveryCountryIso={iso}
            onDiscoveryCountryChange={() => {}}
          />
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    await renderWithCountry('AF');
    expect(fetchNearbyServiceProviders).toHaveBeenCalledTimes(1);
    expect(fetchNearbyServiceProviders.mock.calls[0][2]).toMatchObject({ country: 'AF' });

    act(() => { root!.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);

    await renderWithCountry('NG');
    expect(fetchNearbyServiceProviders).toHaveBeenCalledTimes(2);
    expect(fetchNearbyServiceProviders.mock.calls[1][2]).toMatchObject({ country: 'NG' });
  });

  it('ServiceCategoryScreen scopes category browsing to the active discovery country', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ServiceCategoryScreen
          category="Photography"
          countryIso="AF"
          onBack={() => {}}
          onProviderPress={() => {}}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchApprovedServiceProviders).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Photography', country: 'AF' })
    );
  });
});

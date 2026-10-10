import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { HomeScreen } from './HomeScreen';

// Task 2 (VENTS release sprint): "Home Near You" is HomeScreen.tsx's own
// "Providers Near You" rail (the only "Near You" surface on Home -- its
// quick-action chip scrolls to this exact section; Home has no separate
// nearby-events RPC). It calls fetchNearbyServiceProviders(), which calls
// the SAME get_nearby_service_providers RPC that Task 1 fixed (confirmed
// live via SET ROLE against production with this screen's own call shape:
// p_lat, p_lng, p_category=null, p_limit=10, p_country=<selected country>).
// That DB-level fix is what actually resolves Home's "Near You" too -- this
// test locks in that the FRONTEND side (already correct on inspection) never
// regresses: the exact call shape, the fallback to country-only discovery
// when location is denied/unavailable, and that a genuine fetch failure
// degrades gracefully (section simply doesn't render) rather than crashing
// or showing stale/invented data.

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

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
        in: () => Promise.resolve({ data: [], error: null }),
        order: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
    rpc: () => Promise.resolve({ data: [], error: null }),
  },
}));

vi.mock('../../lib/analyticsEvents', () => ({ analytics: new Proxy({}, { get: () => () => {} }) }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchApprovedServiceProviders.mockClear();
  fetchNearbyServiceProviders.mockClear();
  withProviderRatings.mockClear();
  geoStatus = { status: 'granted', lat: 6.5, lng: 3.4 };
});

function renderHome(countryFilter = 'NG') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(
      <HomeScreen
        onEventPress={() => {}}
        savedEvents={[]}
        onToggleSave={() => {}}
        dbEvents={[]}
        loading={false}
        fetchEvents={() => {}}
        countryFilter={countryFilter}
        onCountryFilterChange={() => {}}
      />
    );
  });
}

describe('HomeScreen "Providers Near You": frontend behavior around the fixed RPC', () => {
  it('calls fetchNearbyServiceProviders with lat/lng/limit/country when location is granted', async () => {
    geoStatus = { status: 'granted', lat: 6.5244, lng: 3.3792 };
    fetchNearbyServiceProviders.mockResolvedValue([
      { id: 'p1', businessName: 'Acme Catering', category: 'Catering', distanceKm: 2.1, photoUrls: [] },
    ]);
    await renderHome('NG');
    expect(fetchNearbyServiceProviders).toHaveBeenCalledWith(6.5244, 3.3792, { limit: 10, country: 'NG' });
    expect(fetchApprovedServiceProviders).not.toHaveBeenCalled();
  });

  it('falls back to country-approved providers (never an error) when location is denied', async () => {
    geoStatus = { status: 'denied', lat: null, lng: null };
    fetchApprovedServiceProviders.mockResolvedValue([
      { id: 'p2', businessName: 'City Events Co', category: 'Planning', photoUrls: [] },
    ]);
    await renderHome('NG');
    expect(fetchApprovedServiceProviders).toHaveBeenCalledWith({ limit: 10, country: 'NG' });
    expect(fetchNearbyServiceProviders).not.toHaveBeenCalled();
  });

  it('falls back to country-approved providers when location is unavailable', async () => {
    geoStatus = { status: 'unavailable', lat: null, lng: null };
    fetchApprovedServiceProviders.mockResolvedValue([]);
    await renderHome('NG');
    expect(fetchApprovedServiceProviders).toHaveBeenCalled();
    expect(fetchNearbyServiceProviders).not.toHaveBeenCalled();
  });

  it('does not call either fetch while location is still resolving (idle/requesting)', async () => {
    geoStatus = { status: 'requesting', lat: null, lng: null };
    await renderHome('NG');
    expect(fetchNearbyServiceProviders).not.toHaveBeenCalled();
    expect(fetchApprovedServiceProviders).not.toHaveBeenCalled();
  });

  it('degrades gracefully on a genuine RPC failure -- no crash, section simply does not render, never invented data', async () => {
    geoStatus = { status: 'granted', lat: 6.5244, lng: 3.3792 };
    fetchNearbyServiceProviders.mockRejectedValue(new Error('permission denied for function check_rate_limit'));
    await expect(renderHome('NG')).resolves.not.toThrow();
    expect(container!.textContent).not.toContain('Providers Near You');
  });

  it('re-fetches with the newly selected country when countryFilter changes (GPS path)', async () => {
    geoStatus = { status: 'granted', lat: 6.5244, lng: 3.3792 };
    fetchNearbyServiceProviders.mockResolvedValue([]);
    await renderHome('NG');
    expect(fetchNearbyServiceProviders).toHaveBeenCalledWith(6.5244, 3.3792, { limit: 10, country: 'NG' });
    fetchNearbyServiceProviders.mockClear();
    await act(async () => {
      root!.render(
        <HomeScreen
          onEventPress={() => {}}
          savedEvents={[]}
          onToggleSave={() => {}}
          dbEvents={[]}
          loading={false}
          fetchEvents={() => {}}
          countryFilter="GH"
          onCountryFilterChange={() => {}}
        />
      );
    });
    expect(fetchNearbyServiceProviders).toHaveBeenCalledWith(6.5244, 3.3792, { limit: 10, country: 'GH' });
  });
});

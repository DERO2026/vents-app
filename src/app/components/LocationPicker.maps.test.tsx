// @vitest-environment jsdom
// Regression tests for Google Maps behaviour shared by event creation and
// provider onboarding:
//   * an API-key rejection Google reports AFTER the libraries load used to
//     leave the picker "ready" with Google's error box and no manual-entry
//     message;
//   * a script that never loads kept the address input disabled forever;
//   * suggestions were hard-limited to Nigeria whatever country was chosen;
//   * map click / pin drag must still set coordinates.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } }));
vi.mock('../../lib/isOnline', () => ({ isOnline: async () => true }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {}, captureMessage: () => {} } }));

describe('LocationPicker', () => {
  let authListener: (() => void) | null;
  let suggestionRequests: any[];
  let mapClick: ((e: any) => void) | null;
  let markerDragEnd: (() => void) | null;
  let markerPos: { lat: number; lng: number };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetModules();
    authListener = null;
    suggestionRequests = [];
    mapClick = null;
    markerDragEnd = null;
    vi.doMock('../../lib/googleMaps', () => ({
      loadGoogleMaps: () => Promise.resolve(),
      onGoogleMapsAuthFailure: (l: () => void) => { authListener = l; return () => { authListener = null; }; },
    }));
    (window as any).google = {
      maps: {
        Map: class { constructor() {} addListener(ev: string, cb: any) { if (ev === 'click') mapClick = cb; } panTo() {} setZoom() {} getZoom() { return 10; } },
        Marker: class {
          constructor(o: any) { markerPos = o.position; }
          setPosition(p: any) { markerPos = p; }
          getPosition() { return { lat: () => markerPos.lat, lng: () => markerPos.lng }; }
          addListener(ev: string, cb: any) { if (ev === 'dragend') markerDragEnd = cb; }
        },
        Geocoder: class {
          geocode(_req: any, cb: any) {
            cb([{ formatted_address: 'Accra, Ghana', address_components: [{ types: ['locality'], long_name: 'Accra' }, { types: ['country'], long_name: 'Ghana' }] }], 'OK');
          }
        },
        places: {
          AutocompleteSessionToken: class {},
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: async (req: any) => { suggestionRequests.push(req); return { suggestions: [] }; },
          },
        },
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (window as any).google;
  });

  async function flush() {
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  }

  async function mount(props: Record<string, any> = {}) {
    const { LocationPicker } = await import('./LocationPicker');
    const onChange = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root.render(<LocationPicker value={{ address: '', lat: null, lng: null }} onChange={onChange} {...props} />);
    });
    await flush();
    return onChange;
  }

  async function typeAddress(text: string) {
    vi.useFakeTimers();
    const input = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
    await flush();
  }

  it('searches the selected country, not always Nigeria', async () => {
    await mount({ regionCode: 'GH' });
    await typeAddress('Osu');
    expect(suggestionRequests[0].includedRegionCodes).toEqual(['gh']);
  });

  it('defaults to Nigeria when no country is given (event creation)', async () => {
    await mount();
    await typeAddress('Lekki');
    expect(suggestionRequests[0].includedRegionCodes).toEqual(['ng']);
  });

  it('a map tap places the pin and sets coordinates and address', async () => {
    const onChange = await mount({ regionCode: 'GH' });
    await act(async () => { mapClick!({ latLng: { lat: () => 5.6, lng: () => -0.18 } }); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 5.6, lng: -0.18, address: 'Accra, Ghana', city: 'Accra', country: 'Ghana' }));
  });

  it('dragging the pin updates the coordinates', async () => {
    const onChange = await mount();
    await act(async () => { mapClick!({ latLng: { lat: () => 6.5, lng: () => 3.4 } }); });
    markerPos = { lat: 6.51, lng: 3.41 };
    await act(async () => { markerDragEnd!(); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 6.51, lng: 3.41 }));
  });

  it('a key rejection reported after load switches to manual entry', async () => {
    await mount();
    expect(container.textContent).toContain('drag the pin');
    expect(authListener).toBeTruthy();
    await act(async () => { authListener!(); });
    expect(container.querySelector('[data-testid="location-unavailable"]')).toBeTruthy();
    expect(container.textContent).not.toContain('drag the pin');
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
});

describe('loadGoogleMaps', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('../../lib/googleMaps');
    vi.stubEnv('VITE_GOOGLE_PLACES_API_KEY', 'test-places-key-for-unit-tests');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete (window as any).google;
    delete (window as any).gm_authFailure;
  });

  it('notifies subscribers of a rejection that arrives after the libraries resolved, and refuses later loads', async () => {
    (window as any).google = { maps: { importLibrary: () => Promise.resolve({}) } };
    const gm = await import('../../lib/googleMaps');
    await expect(gm.loadGoogleMaps()).resolves.toBeUndefined();
    const listener = vi.fn();
    gm.onGoogleMapsAuthFailure(listener);
    (window as any).gm_authFailure();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(gm.isGoogleMapsAuthFailed()).toBe(true);
    const late = vi.fn();
    gm.onGoogleMapsAuthFailure(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('gives up after a timeout instead of loading forever, and a retry gets a fresh attempt', async () => {
    vi.useFakeTimers();
    let calls = 0;
    (window as any).google = { maps: { importLibrary: () => { calls++; return new Promise(() => {}); } } };
    const gm = await import('../../lib/googleMaps');
    const p = gm.loadGoogleMaps();
    const settled = p.then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(gm.GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    expect(await settled).toMatch(/took too long/);
    const before = calls;
    gm.loadGoogleMaps().catch(() => {});
    expect(calls).toBeGreaterThan(before);
  });

  it('never sends the key anywhere but the official Maps script URL (no key in the app bundle source)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', '..', 'lib', 'googleMaps.ts'), 'utf8');
    expect(src).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(src).toMatch(/import\.meta\.env\.VITE_GOOGLE_PLACES_API_KEY/);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { useGeolocation } from './useGeolocation';

// Regression coverage for the GPS/Near You real-device verification pass.
// No test existed for this hook at all before this file -- these cover the
// specific behaviors that pass's checklist called out: a single
// getCurrentPosition call per mount (not one per render), a real fallback
// on denial/timeout/unavailable rather than a stuck "requesting" state, and
// state staying in sync with a fresh coordinate.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function TestHarness({ enabled, onState }: { enabled: boolean; onState: (s: any) => void }) {
  const state = useGeolocation(enabled);
  onState(state);
  return null;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
  delete (navigator as any).geolocation;
});

function render(enabled: boolean, onState: (s: any) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<TestHarness enabled={enabled} onState={onState} />); });
}

describe('useGeolocation', () => {
  it('calls getCurrentPosition exactly once per mount, not once per re-render', () => {
    const getCurrentPosition = vi.fn();
    (navigator as any).geolocation = { getCurrentPosition };
    let latest: any;
    render(true, (s) => { latest = s; });

    // A re-render (new onState identity, same enabled=true) must not
    // trigger a second location request -- this is the exact "requested
    // repeatedly on every render" failure mode called out in the brief.
    act(() => { root!.render(<TestHarness enabled={true} onState={(s) => { latest = s; }} />); });

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(latest.status).toBe('requesting');
  });

  it('resolves to granted with the real coordinates on success', () => {
    const getCurrentPosition = vi.fn((success: any) => {
      success({ coords: { latitude: 6.5244, longitude: 3.3792 } });
    });
    (navigator as any).geolocation = { getCurrentPosition };
    let latest: any;
    render(true, (s) => { latest = s; });

    expect(latest.status).toBe('granted');
    expect(latest.lat).toBe(6.5244);
    expect(latest.lng).toBe(3.3792);
  });

  it('falls back to denied (not stuck requesting) when permission is denied', () => {
    const getCurrentPosition = vi.fn((_success: any, error: any) => {
      error({ code: 1, message: 'User denied Geolocation' });
    });
    (navigator as any).geolocation = { getCurrentPosition };
    let latest: any;
    render(true, (s) => { latest = s; });

    expect(latest.status).toBe('denied');
    expect(latest.lat).toBeNull();
    expect(latest.lng).toBeNull();
  });

  it('falls back to denied (same graceful path) on a timeout/position-unavailable error, not a crash', () => {
    const getCurrentPosition = vi.fn((_success: any, error: any) => {
      error({ code: 3, message: 'Timeout expired' });
    });
    (navigator as any).geolocation = { getCurrentPosition };
    let latest: any;
    expect(() => render(true, (s) => { latest = s; })).not.toThrow();

    expect(latest.status).toBe('denied');
  });

  it('reports unavailable when the Geolocation API does not exist on navigator at all', () => {
    delete (navigator as any).geolocation;
    let latest: any;
    render(true, (s) => { latest = s; });

    expect(latest.status).toBe('unavailable');
  });

  it('never calls getCurrentPosition when disabled', () => {
    const getCurrentPosition = vi.fn();
    (navigator as any).geolocation = { getCurrentPosition };
    let latest: any;
    render(false, (s) => { latest = s; });

    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(latest.status).toBe('idle');
  });
});
